// server.js — minimal HTTP server for Glyphter (for Docker).
// No dependencies (Node's http + fs only). Serves the static app and a tiny
// persistence API so uploaded fonts survive restarts:
//   GET  /api/fonts          -> {"fonts":[{"name": "..."}, ...]}
//   POST /api/fonts          (X-File-Name header, binary body) -> writes to data/fonts/<name>
//   GET  /api/fonts/<name>   -> the stored font bytes
// Uploaded fonts are written to ./data/fonts (a mounted volume in Docker keeps
// them across container restarts).

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const FONT_DIR = path.join(ROOT, "data", "fonts");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function sanitizeFontName(name) {
  name = (name || "").trim();
  if (!name || name.length > 128) return null;
  const safe = name
    .split("")
    .map((c) =>
      /[A-Za-z0-9._-]/.test(c) ? c : "-"
    )
    .join("");
  if (safe.length > 64 || safe === "-" || safe.startsWith(".")) return null;
  return safe;
}

function listFonts() {
  try {
    const names = fs
      .readdirSync(FONT_DIR)
      .filter((n) => fs.statSync(path.join(FONT_DIR, n)).isFile());
    names.sort();
    return { fonts: names.map((n) => ({ name: n })) };
  } catch (e) {
    return { fonts: [] };
  }
}

const server = http.createServer((req, res) => {
  const send = (status, ctype, body) => {
    res.writeHead(status, {
      "Content-Type": ctype,
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    });
    res.end(body);
  };

  // ---- persistence API ----
  if (req.url === "/api/fonts" && req.method === "GET") {
    return send(200, "application/json; charset=utf-8", JSON.stringify(listFonts()));
  }
  if (req.url === "/api/fonts" && req.method === "POST") {
    const raw = decodeURIComponent((req.headers["x-file-name"] || "").toString());
    const name = sanitizeFontName(raw);
    if (!name) {
      return send(400, "text/plain", "bad file name");
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= 64 * 1024 * 1024) chunks.push(c);
      else req.destroy();
    });
    req.on("end", () => {
      try {
        fs.mkdirSync(FONT_DIR, { recursive: true });
        fs.writeFileSync(path.join(FONT_DIR, decodeURIComponent(name)), Buffer.concat(chunks));
        send(200, "application/json", '{"ok":true}');
      } catch (e) {
        send(500, "text/plain", "write failed: " + e.message);
      }
    });
    return;
  }
  if (req.url.startsWith("/api/fonts/") && req.method === "GET") {
    const name = sanitizeFontName(decodeURIComponent(req.url.slice("/api/fonts/".length)));
    if (!name) return send(400, "text/plain", "bad file name");
    try {
      return send(200, "application/octet-stream", fs.readFileSync(path.join(FONT_DIR, name)));
    } catch (e) {
      return send(404, "text/plain", "not found");
    }
  }

  // ---- static files ----
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(405, "text/plain", "method not allowed");
  }
  let rel;
  try {
    rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  } catch (e) {
    return send(400, "text/plain", "bad request");
  }
  if (rel === "") rel = "index.html";
  if (rel.split("/").some((s) => s === "..")) return send(403, "text/plain", "forbidden");
  const full = path.join(ROOT, rel);
  fs.readFile(full, (err, data) => {
    if (err) return send(404, "text/plain", "not found");
    send(200, MIME[path.extname(full).toLowerCase()] || "application/octet-stream", data);
  });
});

const port = parseInt(process.env.PORT || "80", 10);
server.listen(port, "0.0.0.0", () => {
  console.log("Glyphter serving " + ROOT + " on port " + port);
});
