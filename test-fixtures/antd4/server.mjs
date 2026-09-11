// Minimal static file server for the antd 4.x fixture. Same zero-dependency
// node:http shape as test-fixtures/spa-widgets/server.mjs, with `.css` and the
// vendored UMD bundles served from ./vendor. Run: `node server.mjs [port]`
// (default 8879 — one above the spa-widgets e2e default so both can run at once).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.argv[2] || process.env.ANTD_FIXTURE_PORT || 8879);
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
  console.log(`antd4 fixture on http://localhost:${PORT}/`);
});
