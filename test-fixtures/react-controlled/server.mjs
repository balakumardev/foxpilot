// Static server for the real-React controlled-input fixture. Sets
// `Content-Security-Policy: script-src 'self'` on every response so the fixture
// reproduces a strict-CSP React SPA (inline scripts blocked; same-origin
// vendored React + app.js allowed). Run: `node server.mjs [port]` (default 8771).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.argv[2] || process.env.FIXTURE_PORT || 8771);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy", "script-src 'self'");
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = normalize(join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.setHeader("Content-Type", TYPES[extname(filePath)] || "application/octet-stream");
    res.statusCode = 200;
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`React controlled-input fixture on http://localhost:${PORT}/`);
});
