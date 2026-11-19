// Fixture server for the live-browser probe (probe.mjs). Plain Node http, no dependencies.
//
// The probe maps *.example.test to 127.0.0.1 inside the browser, so one server on one port
// plays several sites (a.example.test, b.example.test) and, via the raw IP, a true cross-site one.
//
//   GET /page?csp=<none|self|self-eval|self-inline-eval|connect-none>
//        trivial HTML + a Content-Security-Policy header + Set-Cookie sid=fake-session-1
//   GET|POST|OPTIONS /api/echo[?cors=1]
//        JSON of the request headers; CORS (caller's Origin + credentials) only with ?cors=1
//   GET|POST /api/guarded[?strict=1|?lenient=1]
//        200 {"ok":true} only when the cookie sid=fake-session-1 is present AND the Origin
//        request header equals "http://<Host header>"; otherwise an EMPTY-BODY 403.
//        This literal rule also rejects a same-origin GET (browsers send no Origin on a
//        same-origin GET) - that is intentional and is itself an observation. A same-origin POST
//        does carry Origin. ?lenient=1 additionally accepts an absent Origin when the request is
//        provably same-origin (Sec-Fetch-Site: same-origin, or a Referer on this very host).
//        ?strict=1 is accepted and means the default rule.
//
//   GET /slow?ms=<n>[&mode=delay|stream]
//        HTML (h1#first + p#second) whose response is slow. mode=delay (default): nothing is sent
//        for <n> ms, then headers + the whole page. mode=stream: headers and the first chunk go out
//        at once, the rest (p#second, closing tags) after <n> ms.
//
// Routes added for foxpilot-e2e.mjs (the default /page output is unchanged, probe.mjs pins it):
//   GET /page|/p/<slug>[?title=<t>][&ui=1]   optional <title>, optional <button id=ok>OK</button>
//   GET /spa?ms=<n>      complete-at-once shell, "Late Button" rendered by a script after n ms
//   GET /empty           10 empty divs, no script
//   GET /slow-ui?ms=<n>  /slow's delay mode, but with a "Slow Button"
//
// Run directly (`node server.mjs`) to start it by hand; probe.mjs imports startServer().
import http from "node:http";
import { pathToFileURL } from "node:url";

const CSP = {
  none: null,
  self: "script-src 'self'",
  "self-eval": "script-src 'self' 'unsafe-eval'",
  "self-inline-eval": "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-none": "default-src 'self'; connect-src 'none'",
};

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Default output (no title, no ui) is byte-identical to the original constant that probe.mjs pins.
function pageHtml(title = "probe page", ui = false) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>' +
    escapeHtml(title) +
    "</title></head>" +
    '<body><h1 id="h">probe page</h1>' +
    (ui ? '<button id="ok" type="button">OK</button>' : "") +
    "</body></html>"
  );
}

const h = (req, name) => {
  const v = req.headers[name];
  return v === undefined ? null : Array.isArray(v) ? v.join(", ") : v;
};

function corsHeaders(req, url) {
  if (url.searchParams.get("cors") !== "1") return {};
  const origin = h(req, "origin");
  if (origin === null) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

function handler(req, res) {
  const url = new URL(req.url, "http://placeholder.invalid");
  const noStore = { "cache-control": "no-store" };

  if (url.pathname === "/page" || /^\/p\/[A-Za-z0-9._-]+$/.test(url.pathname)) {
    const key = url.searchParams.get("csp") ?? "none";
    if (!(key in CSP)) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end(`unknown csp variant: ${key}`);
      return;
    }
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "sid=fake-session-1; Path=/; SameSite=Lax",
      ...noStore,
    };
    if (CSP[key] !== null) headers["content-security-policy"] = CSP[key];
    res.writeHead(200, headers);
    res.end(pageHtml(url.searchParams.get("title") || undefined, url.searchParams.get("ui") === "1"));
    return;
  }

  // GET /spa?ms=<n>: a document that is "complete" at once but whose app renders later (an empty
  // <div id=root>, then a "Late Button" after n ms). Records window.__loadedAt / __renderedAt.
  if (url.pathname === "/spa") {
    const ms = Math.max(0, Math.floor(Number(url.searchParams.get("ms") ?? 2500)) || 0);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...noStore });
    res.end(
      '<!doctype html><html><head><meta charset="utf-8"><title>spa page</title></head>' +
        '<body><div id="root"></div><script>window.__loadedAt=performance.now();' +
        `setTimeout(function(){var b=document.createElement("button");b.id="late";b.type="button";` +
        `b.textContent="Late Button";document.getElementById("root").appendChild(b);` +
        `window.__renderedAt=performance.now();},${ms});</script></body></html>`,
    );
    return;
  }

  // GET /empty: a genuinely empty, script-free page (10 empty divs): nothing to wait for.
  if (url.pathname === "/empty") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...noStore });
    res.end(
      '<!doctype html><html><head><meta charset="utf-8"><title>empty page</title></head><body>' +
        "<div></div>".repeat(10) +
        "</body></html>",
    );
    return;
  }

  // GET /slow-ui?ms=<n>: like /slow (delay mode) but the page has a "Slow Button" to snapshot.
  if (url.pathname === "/slow-ui") {
    const ms = Math.max(0, Number(url.searchParams.get("ms") ?? 3000) || 0);
    const timer = setTimeout(() => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...noStore });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>slow ui page</title></head>' +
          '<body><h1>slow ui</h1><button id="slowbtn" type="button">Slow Button</button></body></html>',
      );
    }, ms);
    res.on("close", () => clearTimeout(timer));
    return;
  }

  if (url.pathname === "/api/echo") {
    const cors = corsHeaders(req, url);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, ...noStore });
      res.end();
      return;
    }
    req.resume();
    req.on("end", () => {
      const body = JSON.stringify({
        origin: h(req, "origin"),
        referer: h(req, "referer"),
        cookie: h(req, "cookie"),
        secFetchSite: h(req, "sec-fetch-site"),
        secFetchMode: h(req, "sec-fetch-mode"),
        host: h(req, "host"),
        method: req.method,
      });
      res.writeHead(200, { "content-type": "application/json", ...cors, ...noStore });
      res.end(body);
    });
    return;
  }

  if (url.pathname === "/api/guarded") {
    req.resume();
    req.on("end", () => {
      const cookie = h(req, "cookie") ?? "";
      const hasCookie = /(?:^|;\s*)sid=fake-session-1(?:;|$)/.test(cookie);
      const origin = h(req, "origin");
      const sameOrigin = origin !== null && origin === `http://${h(req, "host")}`;
      const referer = h(req, "referer");
      const lenientOk =
        url.searchParams.get("lenient") === "1" &&
        origin === null &&
        (h(req, "sec-fetch-site") === "same-origin" || (referer !== null && referer.startsWith(`http://${h(req, "host")}/`)));
      if (hasCookie && (sameOrigin || lenientOk)) {
        res.writeHead(200, { "content-type": "application/json", ...noStore });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(403, { "content-length": "0", ...noStore });
        res.end();
      }
    });
    return;
  }

  if (url.pathname === "/slow") {
    const ms = Math.max(0, Number(url.searchParams.get("ms") ?? 3000) || 0);
    const mode = url.searchParams.get("mode") === "stream" ? "stream" : "delay";
    const headers = { "content-type": "text/html; charset=utf-8", ...noStore };
    const head =
      '<!doctype html><html><head><meta charset="utf-8"><title>slow page</title></head><body><h1 id="first">first chunk</h1>';
    const tail = '<p id="second">second chunk</p></body></html>';
    let timer;
    if (mode === "stream") {
      res.writeHead(200, headers);
      res.write(head);
      timer = setTimeout(() => res.end(tail), ms);
    } else {
      timer = setTimeout(() => {
        res.writeHead(200, headers);
        res.end(head + tail);
      }, ms);
    }
    res.on("close", () => clearTimeout(timer));
    return;
  }

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

export function startServer({ port = 0, host = "127.0.0.1" } = {}) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve({
        server,
        port: server.address().port,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startServer({ port: Number(process.env.PORT ?? 0) });
  console.log(JSON.stringify({ port }));
}
