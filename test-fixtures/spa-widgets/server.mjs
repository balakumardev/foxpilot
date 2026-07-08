// Minimal static file server for the SPA-widgets fixture. Mirrors
// test-fixtures/csp-react-spa/server.mjs (zero-dependency node:http static
// server) but WITHOUT the strict-CSP header — this fixture exercises portal
// dropdowns, a re-mounting consent overlay, repeated buttons, and pushState
// routing, none of which depend on CSP. Unknown (extension-less) paths fall back
// to index.html so client-side deep routes load. Run: `node server.mjs [port]`
// (default 878).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.argv[2] || process.env.FIXTURE_PORT || 878);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  // SPA fallback: serve index.html for "/" and any path without a known asset
  // extension so client-side pushState deep routes (/home, /templates) resolve.
  let rel;
  if (urlPath === "/") {
    rel = "index.html";
  } else if (/\.(html|js|css)$/.test(urlPath)) {
    rel = urlPath.replace(/^\/+/, "");
  } else {
    rel = "index.html";
  }
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
  console.log(`SPA-widgets fixture on http://localhost:${PORT}/`);
});
