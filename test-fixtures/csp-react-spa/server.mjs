// Minimal static file server for the CSP-strict SPA fixture. Sets
// `Content-Security-Policy: script-src 'self'` on EVERY response so the
// fixture reproduces a strict-CSP page (inline scripts blocked; external
// same-origin scripts allowed). Run: `node server.mjs [port]` (default 877).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.argv[2] || process.env.FIXTURE_PORT || 877);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  // Strict CSP on every response — the whole point of the fixture.
  res.setHeader("Content-Security-Policy", "script-src 'self'");
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  // Contain path traversal to the fixture root.
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
  console.log(`CSP-strict SPA fixture on http://localhost:${PORT}/`);
});
