/**
 * SoundCloud HLS -> M4A/MP3 converter (Render.com edition).
 *
 * GET /convert?url=<m3u8-or-audio-url>[&licenseAuthToken=<token>][&key=<secret>][&filename=<name>][&out=m4a|mp3][&sourceCodec=aac|mp3|opus][&trackId=<id>][&quality=<q>][&download=1][&prefetch=1]
 *
 * Converts SoundCloud HLS playlists into a complete, +faststart .m4a (or .mp3)
 * file on disk BEFORE serving, with full Content-Length and HTTP Range (206)
 * support. This fixes iOS AVPlayer / Eclipse playback stalling ("just loading")
 * and ensures offline downloads receive a single valid, seekable audio file.
 *
 * Env vars:
 *   PORT                - listen port (Render sets this automatically)
 *   CONVERTER_KEY       - optional shared secret; if set, requests must pass ?key=
 *   FFMPEG_PATH         - optional path to an ffmpeg binary (overrides bundled one)
 *   CACHE_DIR           - optional cache directory (defaults to os.tmpdir()/sc-hls-to-m4a-cache)
 *   MAX_CACHE_BYTES     - optional max disk cache size in bytes (default 300MB)
 *   CACHE_TTL_MS        - optional cache entry TTL in ms (default 30 min)
 *   CONVERSION_TIMEOUT_MS - optional ffmpeg timeout in ms (default 120s)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT) || 3000;
const KEY = process.env.CONVERTER_KEY || "";

const CACHE_DIR =
  process.env.CACHE_DIR || path.join(os.tmpdir(), "sc-hls-to-m4a-cache");
const MAX_CACHE_BYTES =
  Number(process.env.MAX_CACHE_BYTES) || 300 * 1024 * 1024;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 30 * 60 * 1000;
const CONVERSION_TIMEOUT_MS =
  Number(process.env.CONVERSION_TIMEOUT_MS) || 120 * 1000;

/* Find ffmpeg: env override, bundled ffmpeg-static (npm), or system PATH. */
let FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
if (!process.env.FFMPEG_PATH) {
  try {
    const ffmpegStatic = require("ffmpeg-static");
    if (ffmpegStatic) FFMPEG = ffmpegStatic;
  } catch (_) {}
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range, X-Eclipse-Access",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges, Content-Disposition",
};

const inflight = new Map();
const activeReads = new Map();

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
    host.endsWith(".soundcloud.com")
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

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const e = new Error("ffmpeg conversion timed out");
        e.code = "FFMPEG_TIMEOUT";
        return reject(e);
      }
      if (code === 0) return resolve();
      const e = new Error(errBuf.trim() || `ffmpeg exited with code ${code}`);
      e.code = "FFMPEG_FAILED";
      e.exitCode = code;
      reject(e);
    });
  });
}

function buildFfmpegStrategies({ source, out, sourceCodec, partPath }) {
  const inputArgs = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-user_agent",
    UA,
    "-i",
    source,
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

  /* Default: M4A (AAC in MP4 with moov atom moved to byte 0 via +faststart) */
  const strategies = [];
  if (sourceCodec !== "opus") {
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
    strategies.push([
      ...inputArgs,
      "-c:a",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
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
    "mp4",
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

    /* Delete expired entries first (never delete files actively being read or <60s old). */
    const kept = [];
    for (const entry of entries) {
      const readers = activeReads.get(entry.full) || 0;
      if (readers === 0 && now - entry.mtimeMs > CACHE_TTL_MS) {
        try {
          fs.unlinkSync(entry.full);
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

  /* Fast path: hit warm disk cache. */
  try {
    const st = fs.statSync(finalPath);
    if (st.size > 0 && Date.now() - st.mtimeMs < CACHE_TTL_MS) {
      const now = new Date();
      fs.utimes(finalPath, now, now, () => {});
      return { filePath: finalPath, size: st.size, contentType, ext };
    }
  } catch (_) {}

  /* Deduplicate concurrent requests (e.g. AVPlayer probe + range + prefetch). */
  if (inflight.has(cacheKey)) {
    return inflight.get(cacheKey);
  }

  const job = (async () => {
    const partPath = `${finalPath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}.part`;

    const strategies = buildFfmpegStrategies({
      source,
      out,
      sourceCodec,
      partPath,
    });

    let lastErr = null;
    try {
      for (const args of strategies) {
        try {
          await runFfmpeg(args, CONVERSION_TIMEOUT_MS, ffmpegBin);
          const st = fs.statSync(partPath);
          if (st.size > 0) {
            fs.renameSync(partPath, finalPath);
            setImmediate(pruneCache);
            return { filePath: finalPath, size: st.size, contentType, ext };
          }
          lastErr = new Error("ffmpeg produced empty output");
        } catch (err) {
          lastErr = err;
          try {
            fs.unlinkSync(partPath);
          } catch (_) {}
          if (err.code === "FFMPEG_SPAWN") throw err;
        }
      }
      throw lastErr || new Error("ffmpeg conversion failed");
    } finally {
      try {
        if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
      } catch (_) {}
    }
  })();

  inflight.set(cacheKey, job);
  try {
    return await job;
  } finally {
    inflight.delete(cacheKey);
  }
}

function serveFile(req, res, fileInfo, { filename, isDownload }) {
  const { filePath, size, contentType, ext } = fileInfo;
  const disposition = isDownload ? "attachment" : "inline";
  const baseHeaders = {
    ...CORS_HEADERS,
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Content-Disposition": `${disposition}; filename="${filename}.${ext}"`,
    "Cache-Control": "public, max-age=1800",
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
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }

    const u = new URL(req.url, "http://localhost");

    if (u.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "sc-hls-to-m4a" });
    }

    if (u.pathname !== "/convert") {
      return sendJson(res, 404, { error: "unknown endpoint" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "method not allowed" });
    }

    if (keySecret && u.searchParams.get("key") !== keySecret) {
      return sendJson(res, 401, { error: "invalid key" });
    }

    const source = sanitizeSource(
      u.searchParams.get("url"),
      u.searchParams.get("licenseAuthToken")
    );
    if (!source) {
      return sendJson(res, 400, { error: "bad or disallowed url" });
    }

    const out = u.searchParams.get("out") === "mp3" ? "mp3" : "m4a";
    const sourceCodec = (u.searchParams.get("sourceCodec") || "aac").toLowerCase();
    const trackId = u.searchParams.get("trackId") || "";
    const quality = u.searchParams.get("quality") || "sq";
    const filename = sanitizeFilename(u.searchParams.get("filename"));
    const isDownload = u.searchParams.get("download") === "1";
    const isPrefetch = u.searchParams.get("prefetch") === "1";

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
    console.log(`using ffmpeg: ${FFMPEG}`);
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
};
