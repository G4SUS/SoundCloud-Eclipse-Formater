/**
 * SoundCloud HLS -> M4A/MP3 converter (Render.com edition).
 *
 * GET /convert.m4a?url=<m3u8-or-audio-url>[&licenseAuthToken=<token>][&key=<secret>][&filename=<name>][&out=m4a|mp3][&sourceCodec=aac|mp3|opus][&trackId=<id>][&quality=<q>][&download=1][&prefetch=1]
 * (Also supports /convert and /convert.mp3)
 *
 * Downloads HLS playlists and segments concurrently in Node.js (avoiding
 * ffmpeg-static DNS/TLS segfaults on Linux containers), then remuxes locally
 * with ffmpeg (+faststart) or falls back to pure-JS fMP4 assembly if needed.
 * Serves the finished file with exact Content-Length and HTTP Range (206).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const PORT = Number(process.env.PORT) || 3000;
const KEY = process.env.CONVERTER_KEY || "";

const CACHE_DIR =
  process.env.CACHE_DIR || path.join(os.tmpdir(), "sc-hls-to-m4a-cache");
const MAX_CACHE_BYTES =
  Number(process.env.MAX_CACHE_BYTES) || 300 * 1024 * 1024;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 30 * 60 * 1000;
const CONVERSION_TIMEOUT_MS =
  Number(process.env.CONVERSION_TIMEOUT_MS) || 120 * 1000;
const SEGMENT_CONCURRENCY = 10;
const ERROR_CACHE_MS = 15 * 1000;

function resolveWorkingFfmpeg() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try {
    const ffmpegStatic = require("ffmpeg-static");
    if (ffmpegStatic) candidates.push(ffmpegStatic);
  } catch (_) {}
  candidates.push("ffmpeg");

  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ["-version"], {
        timeout: 4000,
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();
      const firstLine = out.split(/\r?\n/)[0] || "ok";
      return { bin, ok: true, version: firstLine };
    } catch (_) {}
  }
  return { bin: candidates[0] || "ffmpeg", ok: false, version: null };
}

const FFMPEG_INFO = resolveWorkingFfmpeg();
const FFMPEG = FFMPEG_INFO.bin;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Range, If-Range, If-None-Match, Cache-Control, Authorization, X-Eclipse-Access",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag, Last-Modified",
};

const inflight = new Map();
const inflightMeta = new Map();
const activeReads = new Map();
const recentErrors = new Map();

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function isAllowedSoundCloudHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "sndcdn.com" ||
    host.endsWith(".sndcdn.com") ||
    host === "soundcloud.com" ||
    host.endsWith(".soundcloud.com") ||
    host === "soundcloud.cloud" ||
    host.endsWith(".soundcloud.cloud")
  );
}

function sanitizeSource(rawUrl, token) {
  if (!rawUrl) return null;
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!isAllowedSoundCloudHost(u.hostname)) return null;
  if (token) u.searchParams.set("license_auth_token", token);
  return u.toString();
}

function sanitizeFilename(raw) {
  const cleaned = String(raw || "soundcloud-track")
    .replace(/[^\w.\s-]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || "soundcloud-track";
}

function buildCacheKey({ source, trackId, quality, out, sourceCodec }) {
  const safeTrackId = String(trackId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const safeQuality = String(quality || "sq").replace(/[^a-zA-Z0-9_-]/g, "");
  if (safeTrackId) {
    return crypto
      .createHash("sha256")
      .update(`track:${safeTrackId}|${safeQuality}|${out}|${sourceCodec}`)
      .digest("hex")
      .slice(0, 32);
  }
  return crypto
    .createHash("sha256")
    .update(`url:${source}|${out}|${sourceCodec}`)
    .digest("hex")
    .slice(0, 32);
}

function saveJobMeta(cacheKey, meta) {
  try {
    ensureCacheDir();
    fs.writeFileSync(
      path.join(CACHE_DIR, `${cacheKey}.json`),
      JSON.stringify({ ...meta, ts: Date.now() })
    );
  } catch (_) {}
}

function loadJobMeta(cacheKey) {
  try {
    const raw = fs.readFileSync(path.join(CACHE_DIR, `${cacheKey}.json`), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.source) return parsed;
  } catch (_) {}
  return null;
}

function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader) return null;
  const trimmed = String(rangeHeader).trim();
  const m = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!m) return { invalid: true };

  const startStr = m[1];
  const endStr = m[2];
  if (startStr === "" && endStr === "") return { invalid: true };

  let start;
  let end;

  if (startStr === "") {
    const suffixLen = Number(endStr);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return { invalid: true };
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? totalSize - 1 : Number(endStr);
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start >= totalSize ||
    end < start
  ) {
    return { unsatisfiable: true };
  }

  if (end >= totalSize) end = totalSize - 1;
  return { start, end };
}

function runFfmpeg(args, timeoutMs = CONVERSION_TIMEOUT_MS, ffmpegBin = FFMPEG) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args);
    let errBuf = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stderr.on("data", (d) => {
      errBuf += d.toString();
      if (errBuf.length > 8192) errBuf = errBuf.slice(-4096);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      const e = new Error(`ffmpeg spawn failed: ${err.message}`);
      e.code = "FFMPEG_SPAWN";
      reject(e);
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        const e = new Error("ffmpeg conversion timed out");
        e.code = "FFMPEG_TIMEOUT";
        return reject(e);
      }
      if (code === 0) return resolve();
      const why = signal ? `signal ${signal}` : `code ${code}`;
      const e = new Error(errBuf.trim() || `ffmpeg exited with ${why}`);
      e.code = "FFMPEG_FAILED";
      e.exitCode = code;
      e.signal = signal;
      reject(e);
    });
  });
}

async function fetchBufferOnce(url, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
    if (!resp.ok) {
      const err = new Error(
        `Upstream HTTP ${resp.status} for ${new URL(url).hostname}`
      );
      err.status = resp.status;
      throw err;
    }
    const ab = await resp.arrayBuffer();
    return {
      buf: Buffer.from(ab),
      contentType: (resp.headers.get("content-type") || "").toLowerCase(),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url, timeoutMs = 25000) {
  try {
    return await fetchBufferOnce(url, timeoutMs);
  } catch (err) {
    const status = err && err.status;
    if (status && status >= 400 && status < 500 && status !== 429) throw err;
    await new Promise((r) => setTimeout(r, 300));
    return fetchBufferOnce(url, timeoutMs);
  }
}

function pickMasterVariant(playlistText, baseUrl) {
  const lines = playlistText.split(/\r?\n/);
  let bestUrl = null;
  let bestBw = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const bwMatch = /BANDWIDTH=(\d+)/i.exec(line);
      const bw = bwMatch ? Number(bwMatch[1]) : 0;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next || next.startsWith("#")) continue;
        if (bw >= bestBw) {
          bestBw = bw;
          bestUrl = new URL(next, baseUrl).toString();
        }
        break;
      }
    }
  }
  return bestUrl;
}

function guessSegmentExt(segUrl) {
  try {
    const p = new URL(segUrl).pathname.toLowerCase();
    const ext = path.extname(p);
    if (ext && /^[.a-z0-9]{2,6}$/.test(ext)) return ext;
  } catch (_) {}
  return ".m4s";
}

async function downloadSourceToJobDir(sourceUrl, jobDir) {
  const first = await fetchBuffer(sourceUrl);
  const firstText = first.buf.slice(0, 512).toString("utf8");

  /* Direct audio file (non-HLS) */
  if (!firstText.includes("#EXTM3U")) {
    const ext = guessSegmentExt(sourceUrl) || ".bin";
    const inputPath = path.join(jobDir, `input${ext}`);
    fs.writeFileSync(inputPath, first.buf);
    return {
      mode: "direct",
      inputPath,
      initPath: null,
      segmentPaths: [],
      totalDurationSec: 0,
    };
  }

  let playlistUrl = sourceUrl;
  let playlistText = first.buf.toString("utf8");

  if (playlistText.includes("#EXT-X-STREAM-INF")) {
    const variantUrl = pickMasterVariant(playlistText, playlistUrl);
    if (!variantUrl) throw new Error("Empty HLS master playlist");
    const variant = await fetchBuffer(variantUrl);
    playlistUrl = variantUrl;
    playlistText = variant.buf.toString("utf8");
  }

  const lines = playlistText.split(/\r?\n/);
  const downloads = [];
  const rewrittenLines = [];
  let initPath = null;
  const segmentPaths = [];
  let totalDurationSec = 0;
  let segIndex = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      rewrittenLines.push(rawLine);
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      const m = /^#EXTINF:([0-9.]+)/.exec(line);
      if (m) totalDurationSec += Number(m[1]) || 0;
      rewrittenLines.push(rawLine);
      continue;
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const uriMatch = /URI="([^"]+)"/.exec(line);
      if (uriMatch) {
        const absUrl = new URL(uriMatch[1], playlistUrl).toString();
        const localName = `init${guessSegmentExt(absUrl)}`;
        initPath = path.join(jobDir, localName);
        downloads.push({ url: absUrl, dest: initPath });
        rewrittenLines.push(line.replace(uriMatch[1], localName));
        continue;
      }
    }

    if (line.startsWith("#EXT-X-KEY:")) {
      if (/METHOD=(SAMPLE-AES|FAIRPLAY|WIDEVINE)/i.test(line)) {
        throw new Error("DRM-encrypted HLS stream is not supported");
      }
      const uriMatch = /URI="([^"]+)"/.exec(line);
      if (uriMatch) {
        const absUrl = new URL(uriMatch[1], playlistUrl).toString();
        const localName = "key.bin";
        downloads.push({ url: absUrl, dest: path.join(jobDir, localName) });
        rewrittenLines.push(line.replace(uriMatch[1], localName));
        continue;
      }
    }

    if (line.startsWith("#")) {
      rewrittenLines.push(rawLine);
      continue;
    }

    const absSegUrl = new URL(line, playlistUrl).toString();
    const localName = `seg_${String(segIndex++).padStart(4, "0")}${guessSegmentExt(absSegUrl)}`;
    const dest = path.join(jobDir, localName);
    segmentPaths.push(dest);
    downloads.push({ url: absSegUrl, dest });
    rewrittenLines.push(localName);
  }

  if (segmentPaths.length === 0) {
    throw new Error("HLS playlist contained no media segments");
  }

  /* Download init + segments concurrently in small batches */
  let nextIdx = 0;
  const workers = Array.from(
    { length: Math.min(SEGMENT_CONCURRENCY, downloads.length) },
    async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= downloads.length) break;
        const item = downloads[idx];
        const { buf } = await fetchBuffer(item.url);
        fs.writeFileSync(item.dest, buf);
      }
    }
  );
  await Promise.all(workers);

  const localPlaylistPath = path.join(jobDir, "local.m3u8");
  fs.writeFileSync(localPlaylistPath, rewrittenLines.join("\n"));

  return {
    mode: "hls",
    inputPath: localPlaylistPath,
    initPath,
    segmentPaths,
    totalDurationSec,
  };
}

/**
 * Pure-JS fMP4 box duration patcher + concatenator fallback.
 * Used only if ffmpeg is unavailable or crashes on the host.
 */
function patchBoxDurations(buf, start, end, totalDurationSec, mvhdTimescale = 44100) {
  let offset = start;
  let ts = mvhdTimescale;

  while (offset + 8 <= end) {
    const size = buf.readUInt32BE(offset);
    if (size < 8 || offset + size > end) break;
    const type = buf.toString("ascii", offset + 4, offset + 8);

    if (type === "moov" || type === "trak" || type === "mdia" || type === "mvex") {
      ts = patchBoxDurations(buf, offset + 8, offset + size, totalDurationSec, ts);
    } else if (type === "mvhd" && size >= 28) {
      const version = buf[offset + 8];
      if (version === 0 && offset + 28 <= end) {
        ts = buf.readUInt32BE(offset + 20) || ts;
        buf.writeUInt32BE(Math.round(totalDurationSec * ts), offset + 24);
      } else if (version === 1 && offset + 40 <= end) {
        ts = buf.readUInt32BE(offset + 28) || ts;
        buf.writeBigUInt64BE(BigInt(Math.round(totalDurationSec * ts)), offset + 32);
      }
    } else if (type === "tkhd" && size >= 32) {
      const version = buf[offset + 8];
      if (version === 0 && offset + 32 <= end) {
        buf.writeUInt32BE(Math.round(totalDurationSec * ts), offset + 28);
      } else if (version === 1 && offset + 44 <= end) {
        buf.writeBigUInt64BE(BigInt(Math.round(totalDurationSec * ts)), offset + 36);
      }
    } else if (type === "mdhd" && size >= 28) {
      const version = buf[offset + 8];
      if (version === 0 && offset + 28 <= end) {
        const mdTs = buf.readUInt32BE(offset + 20) || ts;
        buf.writeUInt32BE(Math.round(totalDurationSec * mdTs), offset + 24);
      } else if (version === 1 && offset + 40 <= end) {
        const mdTs = buf.readUInt32BE(offset + 28) || ts;
        buf.writeBigUInt64BE(BigInt(Math.round(totalDurationSec * mdTs)), offset + 32);
      }
    } else if (type === "mehd" && size >= 16) {
      const version = buf[offset + 8];
      if (version === 0 && offset + 16 <= end) {
        buf.writeUInt32BE(Math.round(totalDurationSec * ts), offset + 12);
      } else if (version === 1 && offset + 20 <= end) {
        buf.writeBigUInt64BE(BigInt(Math.round(totalDurationSec * ts)), offset + 12);
      }
    }

    offset += size;
  }
  return ts;
}

function assembleFmp4Fallback({ initPath, segmentPaths, totalDurationSec, partPath }) {
  if (!initPath || !fs.existsSync(initPath) || !segmentPaths.length) {
    return false;
  }
  const initBuf = Buffer.from(fs.readFileSync(initPath));
  if (totalDurationSec > 0) {
    patchBoxDurations(initBuf, 0, initBuf.length, totalDurationSec);
  }
  const fd = fs.openSync(partPath, "w");
  try {
    fs.writeSync(fd, initBuf);
    for (const seg of segmentPaths) {
      const b = fs.readFileSync(seg);
      fs.writeSync(fd, b);
    }
  } finally {
    fs.closeSync(fd);
  }
  return fs.statSync(partPath).size > 0;
}

function buildFfmpegStrategies({ inputPath, isHlsInput, out, sourceCodec, partPath }) {
  const inputArgs = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...(isHlsInput ? ["-allowed_extensions", "ALL"] : []),
    "-i",
    inputPath,
    "-vn",
    "-map",
    "0:a:0",
  ];

  if (out === "mp3") {
    const strategies = [];
    if (sourceCodec !== "opus") {
      strategies.push([...inputArgs, "-c:a", "copy", "-f", "mp3", partPath]);
    }
    strategies.push([
      ...inputArgs,
      "-c:a",
      "libmp3lame",
      "-q:a",
      "2",
      "-f",
      "mp3",
      partPath,
    ]);
    return strategies;
  }

  const strategies = [];
  if (sourceCodec !== "opus") {
    strategies.push([
      ...inputArgs,
      "-c:a",
      "copy",
      "-f",
      "ipod",
      "-movflags",
      "+faststart",
      partPath,
    ]);
    strategies.push([
      ...inputArgs,
      "-c:a",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
      "-f",
      "ipod",
      "-movflags",
      "+faststart",
      partPath,
    ]);
    strategies.push([
      ...inputArgs,
      "-c:a",
      "copy",
      "-f",
      "mp4",
      "-movflags",
      "+faststart",
      partPath,
    ]);
  }
  strategies.push([
    ...inputArgs,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-f",
    "ipod",
    "-movflags",
    "+faststart",
    partPath,
  ]);
  return strategies;
}

function pruneCache() {
  try {
    ensureCacheDir();
    const now = Date.now();
    const entries = fs
      .readdirSync(CACHE_DIR)
      .filter((name) => name.endsWith(".m4a") || name.endsWith(".mp3"))
      .map((name) => {
        const full = path.join(CACHE_DIR, name);
        try {
          const st = fs.statSync(full);
          return { full, size: st.size, mtimeMs: st.mtimeMs };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);

    const kept = [];
    for (const entry of entries) {
      const readers = activeReads.get(entry.full) || 0;
      if (readers === 0 && now - entry.mtimeMs > CACHE_TTL_MS) {
        try {
          fs.unlinkSync(entry.full);
        } catch (_) {}
        try {
          const metaPath = entry.full.replace(/\.(m4a|mp3)$/, ".json");
          if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        } catch (_) {}
      } else {
        kept.push(entry);
      }
    }

    let totalBytes = kept.reduce((sum, e) => sum + e.size, 0);
    if (totalBytes <= MAX_CACHE_BYTES) return;

    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of kept) {
      if (totalBytes <= MAX_CACHE_BYTES) break;
      const readers = activeReads.get(entry.full) || 0;
      if (readers > 0 || now - entry.mtimeMs < 60 * 1000) continue;
      try {
        fs.unlinkSync(entry.full);
        totalBytes -= entry.size;
      } catch (_) {}
      try {
        const metaPath = entry.full.replace(/\.(m4a|mp3)$/, ".json");
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      } catch (_) {}
    }
  } catch (_) {}
}

async function ensureConverted({
  source,
  trackId,
  quality,
  out,
  sourceCodec,
  ffmpegBin = FFMPEG,
}) {
  ensureCacheDir();
  const ext = out === "mp3" ? "mp3" : "m4a";
  const contentType = out === "mp3" ? "audio/mpeg" : "audio/mp4";
  const cacheKey = buildCacheKey({ source, trackId, quality, out, sourceCodec });
  const finalPath = path.join(CACHE_DIR, `${cacheKey}.${ext}`);

  try {
    const st = fs.statSync(finalPath);
    if (st.size > 0 && Date.now() - st.mtimeMs < CACHE_TTL_MS) {
      const now = new Date();
      fs.utimes(finalPath, now, now, () => {});
      return { filePath: finalPath, size: st.size, contentType, ext };
    }
  } catch (_) {}

  if (inflight.has(cacheKey)) {
    return inflight.get(cacheKey);
  }

  const job = (async () => {
    const jobDir = fs.mkdtempSync(path.join(CACHE_DIR, "job-"));
    const partPath = `${finalPath}.${process.pid}.${Date.now()}.part`;

    try {
      const downloaded = await downloadSourceToJobDir(source, jobDir);
      inflightMeta.set(cacheKey, {
        totalDurationSec: downloaded.totalDurationSec || 0,
        segmentCount: downloaded.segmentPaths.length || 0,
      });

      /* If direct MP3 and out=mp3, no ffmpeg needed at all. */
      if (downloaded.mode === "direct" && out === "mp3" && sourceCodec === "mp3") {
        fs.renameSync(downloaded.inputPath, finalPath);
        setImmediate(pruneCache);
        return {
          filePath: finalPath,
          size: fs.statSync(finalPath).size,
          contentType,
          ext,
        };
      }

      const strategies = buildFfmpegStrategies({
        inputPath: downloaded.inputPath,
        isHlsInput: downloaded.mode === "hls",
        out,
        sourceCodec,
        partPath,
      });

      let lastErr = null;
      let convertedOk = false;

      if (FFMPEG_INFO.ok || ffmpegBin !== FFMPEG) {
        for (const args of strategies) {
          try {
            await runFfmpeg(args, CONVERSION_TIMEOUT_MS, ffmpegBin);
            const st = fs.statSync(partPath);
            if (st.size > 0) {
              convertedOk = true;
              break;
            }
            lastErr = new Error("ffmpeg produced empty output");
          } catch (err) {
            lastErr = err;
            try {
              fs.unlinkSync(partPath);
            } catch (_) {}
          }
        }
      }

      /* Pure-JS fMP4 fallback if ffmpeg crashed/missing and source is AAC fMP4 HLS */
      if (!convertedOk && out === "m4a" && sourceCodec !== "opus" && downloaded.initPath) {
        const ok = assembleFmp4Fallback({
          initPath: downloaded.initPath,
          segmentPaths: downloaded.segmentPaths,
          totalDurationSec: downloaded.totalDurationSec,
          partPath,
        });
        if (ok) convertedOk = true;
      }

      if (!convertedOk) {
        throw lastErr || new Error("conversion failed");
      }

      fs.renameSync(partPath, finalPath);
      recentErrors.delete(cacheKey);
      setImmediate(pruneCache);
      return {
        filePath: finalPath,
        size: fs.statSync(finalPath).size,
        contentType,
        ext,
      };
    } catch (err) {
      recentErrors.set(cacheKey, {
        message: String(err.message || err),
        ts: Date.now(),
      });
      throw err;
    } finally {
      try {
        if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
      } catch (_) {}
      try {
        fs.rmSync(jobDir, { recursive: true, force: true });
      } catch (_) {}
    }
  })();

  inflight.set(cacheKey, job);
  try {
    return await job;
  } finally {
    inflight.delete(cacheKey);
    inflightMeta.delete(cacheKey);
  }
}

function getCachedFileInfo({ source, trackId, quality, out, sourceCodec }) {
  ensureCacheDir();
  const ext = out === "mp3" ? "mp3" : "m4a";
  const contentType = out === "mp3" ? "audio/mpeg" : "audio/mp4";
  const cacheKey = buildCacheKey({ source, trackId, quality, out, sourceCodec });
  const finalPath = path.join(CACHE_DIR, `${cacheKey}.${ext}`);
  try {
    const st = fs.statSync(finalPath);
    if (st.size > 0 && Date.now() - st.mtimeMs < CACHE_TTL_MS) {
      return { filePath: finalPath, size: st.size, contentType, ext, cacheKey };
    }
  } catch (_) {}
  return { filePath: null, cacheKey };
}

function serveFile(req, res, fileInfo, { filename, isDownload }) {
  const { filePath, size, contentType, ext } = fileInfo;
  let mtimeUtc;
  try {
    mtimeUtc = fs.statSync(filePath).mtime.toUTCString();
  } catch (_) {}
  const etag = `"${path.basename(filePath)}-${size}"`;
  const baseHeaders = {
    ...CORS_HEADERS,
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=1800",
    ETag: etag,
    ...(mtimeUtc ? { "Last-Modified": mtimeUtc } : {}),
    ...(isDownload
      ? { "Content-Disposition": `attachment; filename="${filename}.${ext}"` }
      : {}),
  };

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const parsed = parseRange(rangeHeader, size);
    if (parsed && parsed.unsatisfiable) {
      res.writeHead(416, {
        ...CORS_HEADERS,
        "Content-Range": `bytes */${size}`,
      });
      return res.end();
    }
    if (parsed && !parsed.invalid) {
      const { start, end } = parsed;
      const chunkLen = end - start + 1;
      res.writeHead(206, {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(chunkLen),
      });
      if (req.method === "HEAD") return res.end();

      activeReads.set(filePath, (activeReads.get(filePath) || 0) + 1);
      const stream = fs.createReadStream(filePath, { start, end });
      let decremented = false;
      const done = () => {
        if (decremented) return;
        decremented = true;
        const n = (activeReads.get(filePath) || 1) - 1;
        if (n <= 0) activeReads.delete(filePath);
        else activeReads.set(filePath, n);
      };
      stream.on("close", done);
      stream.on("error", () => {
        done();
        if (!res.writableEnded) res.destroy();
      });
      res.on("close", () => stream.destroy());
      return stream.pipe(res);
    }
  }

  res.writeHead(200, {
    ...baseHeaders,
    "Content-Length": String(size),
  });
  if (req.method === "HEAD") return res.end();

  activeReads.set(filePath, (activeReads.get(filePath) || 0) + 1);
  const stream = fs.createReadStream(filePath);
  let decremented = false;
  const done = () => {
    if (decremented) return;
    decremented = true;
    const n = (activeReads.get(filePath) || 1) - 1;
    if (n <= 0) activeReads.delete(filePath);
    else activeReads.set(filePath, n);
  };
  stream.on("close", done);
  stream.on("error", () => {
    done();
    if (!res.writableEnded) res.destroy();
  });
  res.on("close", () => stream.destroy());
  return stream.pipe(res);
}

function createConverterServer(options = {}) {
  const ffmpegBin = options.ffmpegBin || FFMPEG;
  const keySecret = options.key !== undefined ? options.key : KEY;

  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      const reqHeaders = req.headers["access-control-request-headers"];
      res.writeHead(204, {
        ...CORS_HEADERS,
        ...(reqHeaders ? { "Access-Control-Allow-Headers": reqHeaders } : {}),
      });
      return res.end();
    }

    const u = new URL(req.url, "http://localhost");

    if (u.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "sc-hls-to-m4a",
        ffmpegOk: FFMPEG_INFO.ok,
        ffmpegVersion: FFMPEG_INFO.version,
      });
    }

    const audioMatch = /^\/audio\/([a-f0-9]{16,64})\.(m4a|mp3)$/i.exec(u.pathname);
    const isAudioTokenRoute = Boolean(audioMatch);
    const isPrepareRoute = u.pathname === "/prepare";
    const isConvertRoute =
      u.pathname === "/convert" ||
      u.pathname === "/convert.m4a" ||
      u.pathname === "/convert.mp3";
    if (!isConvertRoute && !isPrepareRoute && !isAudioTokenRoute) {
      return sendJson(res, 404, { error: "unknown endpoint" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "method not allowed" });
    }

    if (keySecret && u.searchParams.get("key") !== keySecret) {
      return sendJson(res, 401, { error: "invalid key" });
    }

    if (isAudioTokenRoute) {
      const token = audioMatch[1].toLowerCase();
      const ext = audioMatch[2].toLowerCase();
      const contentType = ext === "mp3" ? "audio/mpeg" : "audio/mp4";
      ensureCacheDir();
      const finalPath = path.join(CACHE_DIR, `${token}.${ext}`);
      const meta = loadJobMeta(token);
      const filename = sanitizeFilename(
        u.searchParams.get("filename") || (meta && meta.filename) || "soundcloud-track"
      );
      const isDownload = u.searchParams.get("download") === "1";

      try {
        const st = fs.statSync(finalPath);
        if (st.size > 0 && Date.now() - st.mtimeMs < CACHE_TTL_MS) {
          const now = new Date();
          fs.utimes(finalPath, now, now, () => {});
          return serveFile(
            req,
            res,
            { filePath: finalPath, size: st.size, contentType, ext },
            { filename, isDownload }
          );
        }
      } catch (_) {}

      if (inflight.has(token)) {
        try {
          const fileInfo = await inflight.get(token);
          if (res.writableEnded || res.destroyed) return;
          return serveFile(req, res, fileInfo, { filename, isDownload });
        } catch (err) {
          if (res.writableEnded || res.destroyed) return;
          return sendJson(res, 502, {
            error: "ffmpeg failed",
            detail: String((err && err.message) || err).slice(-800),
          });
        }
      }

      if (meta && meta.source) {
        try {
          const fileInfo = await ensureConverted({ ...meta, ffmpegBin });
          if (res.writableEnded || res.destroyed) return;
          return serveFile(req, res, fileInfo, { filename, isDownload });
        } catch (err) {
          if (res.writableEnded || res.destroyed) return;
          return sendJson(res, 502, {
            error: "ffmpeg failed",
            detail: String((err && err.message) || err).slice(-800),
          });
        }
      }

      return sendJson(res, 404, { error: "audio token not found or expired" });
    }

    const source = sanitizeSource(
      u.searchParams.get("url"),
      u.searchParams.get("licenseAuthToken")
    );
    if (!source) {
      return sendJson(res, 400, { error: "bad or disallowed url" });
    }

    const defaultOut = u.pathname === "/convert.mp3" ? "mp3" : "m4a";
    const out =
      u.searchParams.get("out") === "mp3"
        ? "mp3"
        : u.searchParams.get("out") === "m4a"
          ? "m4a"
          : defaultOut;
    const sourceCodec = (u.searchParams.get("sourceCodec") || "aac").toLowerCase();
    const trackId = u.searchParams.get("trackId") || "";
    const quality = u.searchParams.get("quality") || "sq";
    const filename = sanitizeFilename(u.searchParams.get("filename"));
    const isDownload = u.searchParams.get("download") === "1";
    const isPrefetch = u.searchParams.get("prefetch") === "1";

    if (isPrepareRoute) {
      const cached = getCachedFileInfo({
        source,
        trackId,
        quality,
        out,
        sourceCodec,
      });
      saveJobMeta(cached.cacheKey, {
        source,
        trackId,
        quality,
        out,
        sourceCodec,
        filename,
      });
      if (cached.filePath) {
        return sendJson(res, 200, {
          status: "ready",
          size: cached.size,
          token: cached.cacheKey,
        });
      }
      const prevErr = recentErrors.get(cached.cacheKey);
      if (prevErr && Date.now() - prevErr.ts < ERROR_CACHE_MS) {
        return sendJson(res, 200, { status: "error", error: prevErr.message });
      }

      const waitMs = Math.min(
        8000,
        Math.max(0, Number(u.searchParams.get("waitMs") || 2200))
      );
      const job = ensureConverted({
        source,
        trackId,
        quality,
        out,
        sourceCodec,
        ffmpegBin,
      });
      /* Prevent unhandled rejection if job fails after waitMs expires. */
      job.catch(() => {});

      const outcome = await Promise.race([
        job
          .then((info) => ({
            status: "ready",
            size: info.size,
            token: cached.cacheKey,
          }))
          .catch((err) => ({
            status: "error",
            error: String(err.message || err).slice(-300),
          })),
        new Promise((resolve) =>
          setTimeout(() => {
            const meta = inflightMeta.get(cached.cacheKey);
            const longTrack = Boolean(
              meta && (meta.totalDurationSec > 900 || meta.segmentCount > 90)
            );
            resolve({ status: "converting", longTrack, token: cached.cacheKey });
          }, waitMs)
        ),
      ]);

      return sendJson(res, outcome.status === "converting" ? 202 : 200, outcome);
    }

    if (isPrefetch) {
      ensureConverted({
        source,
        trackId,
        quality,
        out,
        sourceCodec,
        ffmpegBin,
      }).catch((err) => {
        console.error("prefetch conversion failed:", err.message);
      });
      return sendJson(res, 202, { ok: true, status: "prefetching" });
    }

    try {
      const fileInfo = await ensureConverted({
        source,
        trackId,
        quality,
        out,
        sourceCodec,
        ffmpegBin,
      });
      if (res.writableEnded || res.destroyed) return;
      return serveFile(req, res, fileInfo, { filename, isDownload });
    } catch (err) {
      console.error("convert failed:", err.message || err);
      if (res.writableEnded || res.destroyed) return;
      const status = err.code === "FFMPEG_SPAWN" ? 500 : 502;
      return sendJson(res, status, {
        error: err.code === "FFMPEG_SPAWN" ? "ffmpeg spawn failed" : "ffmpeg failed",
        detail: String(err.message || err).slice(-800),
      });
    }
  });
}

if (require.main === module) {
  ensureCacheDir();
  const server = createConverterServer();
  server.listen(PORT, () => {
    console.log(`sc-hls-to-m4a listening on :${PORT}`);
    console.log(`ffmpeg: ${FFMPEG} (ok=${FFMPEG_INFO.ok})`);
    console.log(`cache dir: ${CACHE_DIR}`);
  });
}

module.exports = {
  createConverterServer,
  parseRange,
  sanitizeSource,
  sanitizeFilename,
  buildCacheKey,
  buildFfmpegStrategies,
  isAllowedSoundCloudHost,
  assembleFmp4Fallback,
  patchBoxDurations,
};
