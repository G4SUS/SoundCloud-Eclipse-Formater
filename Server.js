/**
 * SoundCloud HLS -> m4a converter (render.com edition).
 *
 * GET /convert?url=<m3u8-url>[&licenseAuthToken=<token>][&key=<secret>]
 *
 * Fetches the SoundCloud HLS playlist via ffmpeg and remuxes it to a single
 * fragmented MP4 (m4a) with the AAC audio stream copied — no re-encode,
 * so it's fast and lossless. Output is streamed to the client as it converts.
 *
 * Env vars:
 *   PORT            - listen port (render.com sets this automatically)
 *   CONVERTER_KEY   - optional shared secret; if set, every request must pass ?key=
 */

const http = require("http");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3000;
const KEY = process.env.CONVERTER_KEY || "";

/* Only allow SoundCloud media hosts as conversion sources. */
const ALLOWED_HOSTS = [
  "cf-hls-media.sndcdn.com",
  "cf-media.sndcdn.com",
  "ec-hls-media.sndcdn.com",
  "ec-media.sndcdn.com",
  "api-v2.soundcloud.com",
];

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
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
  if (!ALLOWED_HOSTS.includes(u.hostname)) return null;
  /* Signed URLs from SoundCloud carry Expires/Signature params — keep them. */
  if (token) u.searchParams.set("license_auth_token", token);
  return u.toString();
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "sc-hls-to-m4a" });
  }

  if (u.pathname !== "/convert") {
    return sendJson(res, 404, { error: "unknown endpoint" });
  }

  if (KEY && u.searchParams.get("key") !== KEY) {
    return sendJson(res, 401, { error: "invalid key" });
  }

  const source = sanitizeSource(u.searchParams.get("url"), u.searchParams.get("licenseAuthToken"));
  if (!source) {
    return sendJson(res, 400, { error: "bad or disallowed url" });
  }

  const filename = (u.searchParams.get("filename") || "soundcloud-track").replace(/[^\w.-]+/g, "_");

  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-user_agent", UA,
    "-i", source,
    "-vn",                 /* drop video */
    "-map", "0:a:0",       /* first audio stream */
    "-c:a", "copy",        /* copy AAC — no re-encode */
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov",  /* streamable mp4 (m4a) */
    "pipe:1",
  ]);

  let headerSent = false;
  ffmpeg.stdout.once("data", () => {
    if (headerSent) return;
    headerSent = true;
    res.writeHead(200, {
      "Content-Type": "audio/mp4",
      "Content-Disposition": `attachment; filename="${filename}.m4a"`,
      "Access-Control-Allow-Origin": "*",
    });
  });

  /* Fallback headers in case ffmpeg produced no output at all. */
  ffmpeg.on("spawn", () => {
    setTimeout(() => {
      if (!headerSent && !res.headersSent) {
        headerSent = true;
        res.writeHead(200, {
          "Content-Type": "audio/mp4",
          "Content-Disposition": `attachment; filename="${filename}.m4a"`,
          "Access-Control-Allow-Origin": "*",
        });
      }
    }, 4000);
  });

  ffmpeg.stdout.pipe(res);

  let errBuf = "";
  ffmpeg.stderr.on("data", (d) => {
    errBuf += d.toString();
  });

  /* Client hung up — kill ffmpeg so we don't leak processes. */
  res.on("close", () => {
    if (!res.writableEnded) ffmpeg.kill("SIGKILL");
  });

  ffmpeg.on("close", (code) => {
    if (res.writableEnded) return;
    if (!headerSent) {
      headerSent = true;
      if (code === 0) {
        res.writeHead(200, {
          "Content-Type": "audio/mp4",
          "Content-Disposition": `attachment; filename="${filename}.m4a"`,
          "Access-Control-Allow-Origin": "*",
        });
        res.end();
      } else {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ffmpeg failed", detail: errBuf.slice(-800) }));
      }
    } else if (code !== 0) {
      console.error("ffmpeg exit", code, errBuf.slice(-800));
    }
  });
});

server.listen(PORT, () => {
  console.log(`sc-hls-to-m4a listening on :${PORT}`);
});
