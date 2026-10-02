// Static server for the composer fixture, same zero-dependency node:http shape
// as test-fixtures/shadow-dom/server.mjs, plus two navigation routes for
// navigate-tab:
//   /nav/slow?ms=N&label=X  answers after N ms (default 1500, capped at 15000),
//                           so the window between tabs.update() resolving and
//                           the new document committing is wide and repeatable.
//                           The page left behind keeps reporting itself as
//                           "complete" with its own url for that whole window.
//   /nav/spa?ms=N           a page that, N ms after it loads (default 400),
//                           moves itself to /nav/spa-final with
//                           history.pushState, the way a client-side router
//                           does.
// No CSP header, for the reason the shadow-DOM server gives: the e2e harness
// evaluates the injected functions in the page main world.
// Run: `node server.mjs [port]` (default 8882, after the other e2e fixtures).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.argv[2] || process.env.COMPOSER_FIXTURE_PORT || 8882);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function page(title, body) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>' +
    title +
    "</title></head><body><h1>" +
    title +
    "</h1>" +
    body +
    "</body></html>"
  );
}

function boundedMs(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 15000) : fallback;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const urlPath = decodeURIComponent(url.pathname);

  if (urlPath === "/nav/slow") {
    const ms = boundedMs(url.searchParams.get("ms"), 1500);
    const label = (url.searchParams.get("label") || "Slow page").replace(/[<>&"]/g, "");
    setTimeout(() => {
      res.setHeader("Content-Type", TYPES[".html"]);
      res.setHeader("Cache-Control", "no-store");
      res.end(page(label, "<p>Served after " + ms + " ms.</p>"));
    }, ms);
    return;
  }
  if (urlPath === "/nav/spa" || urlPath === "/nav/spa-final") {
    const ms = boundedMs(url.searchParams.get("ms"), 400);
    res.setHeader("Content-Type", TYPES[".html"]);
    res.setHeader("Cache-Control", "no-store");
    res.end(
      page(
        "Client-routed page",
        '<p id="where"></p><script src="/nav-spa.js" data-ms="' + ms + '"></script>'
      )
    );
    return;
  }

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
  console.log(`Composer fixture on http://localhost:${PORT}/`);
});
