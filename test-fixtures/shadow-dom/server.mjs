// Minimal static file server for the shadow-DOM fixture. Same zero-dependency
// node:http shape as test-fixtures/antd4/server.mjs. No CSP header on purpose:
// the e2e harness evaluates the injected functions in the page main world via
// eval, which a strict `script-src` would refuse. The page itself stays
// strict-CSP clean (one external same-origin script, no inline scripts or
// handlers), so it can be served under one when driving the real extension.
// Run: `node server.mjs [port]` (default 8880 — two above the spa-widgets e2e
// default, so all the e2e fixtures can run at once).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.argv[2] || process.env.SHADOW_FIXTURE_PORT || 8880);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel =
    urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "") || "index.html";
  const filePath = normalize(join(ROOT, rel));
  // Contain path traversal to the fixture root.
  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.setHeader(
      "Content-Type",
      TYPES[extname(filePath)] || "application/octet-stream"
    );
    res.statusCode = 200;
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Shadow DOM fixture on http://localhost:${PORT}/`);
});
