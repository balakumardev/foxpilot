import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as path from "path";
import WebSocket, { WebSocketServer } from "ws";
import {
  openTunnel,
  proxyForUrl,
  redactProxyUrl,
  tunneledCreateConnection,
} from "../proxy-tunnel";

const FIXTURES = path.join(__dirname, "fixtures");
const CERT = fs.readFileSync(path.join(FIXTURES, "relay-test-cert.pem"));
const KEY = fs.readFileSync(path.join(FIXTURES, "relay-test-key.pem"));

describe("proxyForUrl", () => {
  const P = "http://proxy.example:3128";

  test("scheme selection", () => {
    const env = { HTTPS_PROXY: "http://s:1", HTTP_PROXY: "http://p:2" };
    expect(proxyForUrl("wss://relay.example/x", env)).toBe("http://s:1");
    expect(proxyForUrl("https://relay.example/x", env)).toBe("http://s:1");
    expect(proxyForUrl("ws://relay.example/x", env)).toBe("http://p:2");
    expect(proxyForUrl("http://relay.example/x", env)).toBe("http://p:2");
  });

  test("HTTPS_PROXY does not apply to ws:, HTTP_PROXY does not apply to wss:", () => {
    expect(proxyForUrl("ws://relay.example", { HTTPS_PROXY: P })).toBeUndefined();
    expect(proxyForUrl("wss://relay.example", { HTTP_PROXY: P })).toBeUndefined();
  });

  test("lowercase fallbacks and precedence", () => {
    expect(proxyForUrl("wss://relay.example", { https_proxy: P })).toBe(P);
    expect(proxyForUrl("ws://relay.example", { http_proxy: P })).toBe(P);
    expect(
      proxyForUrl("wss://relay.example", { HTTPS_PROXY: "http://upper:1", https_proxy: "http://lower:2" })
    ).toBe("http://upper:1");
    expect(proxyForUrl("wss://relay.example", { HTTPS_PROXY: "", https_proxy: P })).toBe(P);
  });

  test("ALL_PROXY fallback", () => {
    expect(proxyForUrl("wss://relay.example", { ALL_PROXY: P })).toBe(P);
    expect(proxyForUrl("ws://relay.example", { all_proxy: P })).toBe(P);
    expect(
      proxyForUrl("wss://relay.example", { HTTPS_PROXY: "http://specific:1", ALL_PROXY: P })
    ).toBe("http://specific:1");
  });

  test("unsupported proxy schemes and junk are ignored", () => {
    expect(proxyForUrl("wss://relay.example", { HTTPS_PROXY: "socks5://p:1080" })).toBeUndefined();
    expect(proxyForUrl("wss://relay.example", { HTTPS_PROXY: "socks5h://p:1080" })).toBeUndefined();
    expect(proxyForUrl("wss://relay.example", { HTTPS_PROXY: "not a url" })).toBeUndefined();
    expect(proxyForUrl("wss://relay.example", { HTTPS_PROXY: "https://secure-proxy:443" })).toBe(
      "https://secure-proxy:443"
    );
  });

  test("unsupported target schemes and invalid targets", () => {
    expect(proxyForUrl("ftp://relay.example", { ALL_PROXY: P })).toBeUndefined();
    expect(proxyForUrl("nonsense", { ALL_PROXY: P })).toBeUndefined();
  });

  test("loopback is never proxied", () => {
    const env = { HTTPS_PROXY: P, HTTP_PROXY: P };
    for (const t of [
      "ws://localhost:8089",
      "wss://localhost",
      "ws://foo.localhost:1",
      "ws://127.0.0.1:8089",
      "ws://127.5.6.7",
      "ws://[::1]:8089",
      "wss://[::1]",
    ]) {
      expect(proxyForUrl(t, env)).toBeUndefined();
    }
    expect(proxyForUrl("ws://128.0.0.1", env)).toBe(P);
    expect(proxyForUrl("ws://notlocalhost", env)).toBe(P);
  });

  describe("NO_PROXY", () => {
    const base = { HTTPS_PROXY: P, HTTP_PROXY: P };
    const withNo = (v: string, key = "NO_PROXY") => ({ ...base, [key]: v });

    test("exact match, case-insensitive, lowercase var", () => {
      expect(proxyForUrl("wss://Relay.Example", withNo("relay.example"))).toBeUndefined();
      expect(proxyForUrl("wss://relay.example", withNo("RELAY.EXAMPLE"))).toBeUndefined();
      expect(proxyForUrl("wss://relay.example", withNo("relay.example", "no_proxy"))).toBeUndefined();
      expect(proxyForUrl("wss://other.example", withNo("relay.example"))).toBe(P);
    });

    test("suffix match requires a dot boundary", () => {
      expect(proxyForUrl("wss://a.relay.example", withNo("relay.example"))).toBeUndefined();
      expect(proxyForUrl("wss://xrelay.example", withNo("relay.example"))).toBe(P);
    });

    test("leading dot and *. are stripped", () => {
      expect(proxyForUrl("wss://a.relay.example", withNo(".relay.example"))).toBeUndefined();
      expect(proxyForUrl("wss://relay.example", withNo(".relay.example"))).toBeUndefined();
      expect(proxyForUrl("wss://a.relay.example", withNo("*.relay.example"))).toBeUndefined();
      expect(proxyForUrl("wss://relay.example", withNo("*.relay.example"))).toBeUndefined();
    });

    test("comma and whitespace separated lists, empty entries ignored", () => {
      const v = " ,foo.example,, bar.example \t baz.example,";
      expect(proxyForUrl("wss://bar.example", withNo(v))).toBeUndefined();
      expect(proxyForUrl("wss://baz.example", withNo(v))).toBeUndefined();
      expect(proxyForUrl("wss://foo.example", withNo(v))).toBeUndefined();
      expect(proxyForUrl("wss://qux.example", withNo(v))).toBe(P);
      expect(proxyForUrl("wss://relay.example", withNo(" , ,"))).toBe(P);
    });

    test("port matching with default ports", () => {
      expect(proxyForUrl("wss://relay.example:8443", withNo("relay.example:8443"))).toBeUndefined();
      expect(proxyForUrl("wss://relay.example:9999", withNo("relay.example:8443"))).toBe(P);
      expect(proxyForUrl("wss://relay.example", withNo("relay.example:443"))).toBeUndefined();
      expect(proxyForUrl("ws://relay.example", withNo("relay.example:80"))).toBeUndefined();
      expect(proxyForUrl("ws://relay.example", withNo("relay.example:443"))).toBe(P);
      expect(proxyForUrl("wss://relay.example", withNo("relay.example:80"))).toBe(P);
    });

    test("* bypasses everything", () => {
      expect(proxyForUrl("wss://relay.example", withNo("*"))).toBeUndefined();
      expect(proxyForUrl("ws://relay.example", withNo("foo.example, *"))).toBeUndefined();
    });

    test("IP literals match exactly", () => {
      expect(proxyForUrl("wss://10.1.2.3", withNo("10.1.2.3"))).toBeUndefined();
      expect(proxyForUrl("wss://10.1.2.4", withNo("10.1.2.3"))).toBe(P);
      expect(proxyForUrl("wss://10.1.2.3", withNo("2.3"))).toBe(P);
      expect(proxyForUrl("wss://10.1.2.3", withNo("10.1.2.3:443"))).toBeUndefined();
    });

    test("IPv6 literals, bracketed or not", () => {
      expect(proxyForUrl("wss://[2001:db8::1]", withNo("2001:db8::1"))).toBeUndefined();
      expect(proxyForUrl("wss://[2001:db8::1]", withNo("[2001:db8::1]"))).toBeUndefined();
      expect(proxyForUrl("wss://[2001:db8::1]:8443", withNo("[2001:db8::1]:8443"))).toBeUndefined();
      expect(proxyForUrl("wss://[2001:db8::1]:9", withNo("[2001:db8::1]:8443"))).toBe(P);
      expect(proxyForUrl("wss://[2001:db8::2]", withNo("2001:db8::1"))).toBe(P);
    });
  });

  test("empty env", () => {
    expect(proxyForUrl("wss://relay.example", {})).toBeUndefined();
    expect(proxyForUrl("ws://relay.example", {})).toBeUndefined();
  });

  test("defaults to process.env", () => {
    const saved = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) {
        if (/proxy/i.test(k)) delete process.env[k];
      }
      process.env.HTTPS_PROXY = P;
      expect(proxyForUrl("wss://relay.example")).toBe(P);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("redactProxyUrl", () => {
  test("hides user and password", () => {
    const r = redactProxyUrl("http://alice:s3cr3t@proxy.example:3128");
    expect(r).not.toContain("alice");
    expect(r).not.toContain("s3cr3t");
    expect(r).toContain("***");
    expect(r).toContain("proxy.example:3128");
  });

  test("hides username-only credentials (e.g. JWT as user)", () => {
    const r = redactProxyUrl("http://eyJhbGciOi.payload.sig@proxy.example:3128");
    expect(r).not.toContain("eyJhbGciOi");
    expect(r).toContain("proxy.example");
  });

  test("leaves credential-free URLs readable and handles garbage", () => {
    expect(redactProxyUrl("http://proxy.example:3128")).toBe("http://proxy.example:3128");
    expect(redactProxyUrl("garbage")).not.toContain("garbage:");
  });
});

// ---------------------------------------------------------------------------
// Integration helpers
// ---------------------------------------------------------------------------

interface TestProxy {
  server: net.Server;
  port: number;
  requests: { authority: string; headers: Record<string, string> }[];
  close(): Promise<void>;
}

/**
 * Minimal CONNECT proxy. Host names in `hostMap` resolve to the mapped address,
 * so a fake name like "relay.test" can reach a loopback server through it.
 */
async function startProxy(
  opts: { auth?: string; hostMap?: Record<string, string>; hang?: boolean } = {}
): Promise<TestProxy> {
  const sockets = new Set<net.Socket>();
  const requests: TestProxy["requests"] = [];
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => {});
    if (opts.hang) return;
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.removeListener("data", onData);
      const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
      const rest = buf.subarray(end + 4);
      const m = /^CONNECT (\S+) HTTP\/1\.1$/.exec(lines[0]);
      const headers: Record<string, string> = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(":");
        headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
      }
      if (!m) {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      requests.push({ authority: m[1], headers });
      if (opts.auth !== undefined && headers["proxy-authorization"] !== opts.auth) {
        client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
        return;
      }
      const idx = m[1].lastIndexOf(":");
      const host = m[1].slice(0, idx);
      const port = Number(m[1].slice(idx + 1));
      const upstream = net.connect({ host: opts.hostMap?.[host] ?? host, port });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on("data", onData);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    server,
    port: (server.address() as net.AddressInfo).port,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

async function echoRoundTrip(
  url: string,
  createConnection: (options?: unknown) => net.Socket,
  msg: string
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(url, { createConnection } as WebSocket.ClientOptions);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("echo timed out"));
    }, 5000);
    ws.on("open", () => ws.send(msg));
    ws.on("message", (data) => {
      clearTimeout(timer);
      ws.close();
      resolve(data.toString());
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function attachEcho(wss: WebSocketServer) {
  wss.on("connection", (sock) => sock.on("message", (d) => sock.send(`echo:${d.toString()}`)));
}

describe("tunnel integration (plain ws://)", () => {
  let proxy: TestProxy;
  let httpServer: http.Server;
  let wss: WebSocketServer;
  let port: number;

  beforeAll(async () => {
    httpServer = http.createServer();
    wss = new WebSocketServer({ server: httpServer });
    attachEcho(wss);
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    port = (httpServer.address() as net.AddressInfo).port;
    proxy = await startProxy({ hostMap: { "relay.test": "127.0.0.1" } });
  });
  afterAll(async () => {
    await proxy.close();
    for (const c of wss.clients) c.terminate();
    wss.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  test("tunneledCreateConnection + ws echoes through the proxy", async () => {
    const url = `ws://relay.test:${port}/v1/rooms/abc/client`;
    const env = { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
    const cc = await tunneledCreateConnection(url, { env, timeoutMs: 3000 });
    expect(cc).toBeDefined();
    expect(await echoRoundTrip(url, cc!, "hello")).toBe("echo:hello");
    const last = proxy.requests[proxy.requests.length - 1];
    expect(last.authority).toBe(`relay.test:${port}`);
    expect(last.headers.host).toBe(`relay.test:${port}`);
    expect(last.headers["proxy-authorization"]).toBeUndefined();
  });

  test("returns undefined when no proxy applies", async () => {
    expect(await tunneledCreateConnection(`ws://relay.test:${port}`, { env: {} })).toBeUndefined();
    expect(
      await tunneledCreateConnection(`ws://127.0.0.1:${port}`, {
        env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` },
      })
    ).toBeUndefined();
  });

  test("createConnection is single-use", async () => {
    const url = `ws://relay.test:${port}/`;
    const cc = await tunneledCreateConnection(url, {
      env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` },
    });
    const sock = cc!();
    expect(() => cc!()).toThrow(/single-use/);
    sock.destroy();
  });

  test("data sent right behind the proxy head is not lost (unshift)", async () => {
    const srv = net.createServer((c) => {
      c.write("HTTP/1.1 200 OK\r\n\r\nEARLY");
      c.on("error", () => {});
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const p = (srv.address() as net.AddressInfo).port;
    const sock = await openTunnel("ws://relay.test:80", `http://127.0.0.1:${p}`);
    const got = await new Promise<string>((resolve) => sock.once("data", (d) => resolve(d.toString())));
    expect(got).toBe("EARLY");
    sock.destroy();
    await new Promise<void>((r) => srv.close(() => r()));
  });
});

describe("tunnel integration (wss:// over TLS)", () => {
  let proxy: TestProxy;
  let server: https.Server;
  let wss: WebSocketServer;
  let port: number;

  beforeAll(async () => {
    server = https.createServer({ cert: CERT, key: KEY });
    wss = new WebSocketServer({ server });
    attachEcho(wss);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as net.AddressInfo).port;
    proxy = await startProxy({ hostMap: { "relay.test": "127.0.0.1" } });
  });
  afterAll(async () => {
    await proxy.close();
    for (const c of wss.clients) c.terminate();
    wss.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("wss echoes through the tunnel with TLS to the target", async () => {
    const url = `wss://relay.test:${port}/v1/rooms/abc/client`;
    const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
    const cc = await tunneledCreateConnection(url, { env, timeoutMs: 3000, tlsOptions: { ca: CERT } });
    expect(cc).toBeDefined();
    expect(await echoRoundTrip(url, cc!, "secure-hello")).toBe("echo:secure-hello");
    expect(proxy.requests[proxy.requests.length - 1].authority).toBe(`relay.test:${port}`);
  });

  test("TLS verification still applies (untrusted cert is rejected)", async () => {
    const url = `wss://relay.test:${port}/`;
    const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
    const cc = await tunneledCreateConnection(url, { env, timeoutMs: 3000 });
    await expect(echoRoundTrip(url, cc!, "x")).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i);
  });
});

describe("proxy authentication", () => {
  const PASS = "p@ss";
  const expected = "Basic " + Buffer.from(`user:${PASS}`).toString("base64");
  let proxy: TestProxy;
  let httpServer: http.Server;
  let wss: WebSocketServer;
  let port: number;

  beforeAll(async () => {
    httpServer = http.createServer();
    wss = new WebSocketServer({ server: httpServer });
    attachEcho(wss);
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    port = (httpServer.address() as net.AddressInfo).port;
    proxy = await startProxy({ auth: expected, hostMap: { "relay.test": "127.0.0.1" } });
  });
  afterAll(async () => {
    await proxy.close();
    for (const c of wss.clients) c.terminate();
    wss.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  test("correct percent-encoded credentials are accepted", async () => {
    const url = `ws://relay.test:${port}/`;
    const env = { HTTP_PROXY: `http://user:p%40ss@127.0.0.1:${proxy.port}` };
    const cc = await tunneledCreateConnection(url, { env, timeoutMs: 3000 });
    expect(await echoRoundTrip(url, cc!, "authed")).toBe("echo:authed");
    expect(proxy.requests[proxy.requests.length - 1].headers["proxy-authorization"]).toBe(expected);
  });

  test("wrong credentials -> 407, message does not leak the password", async () => {
    const bad = `http://user:wr0ng-secret@127.0.0.1:${proxy.port}`;
    const err = await openTunnel(`ws://relay.test:${port}`, bad, { timeoutMs: 3000 }).then(
      () => null,
      (e: Error) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("407");
    expect(err!.message).not.toContain("wr0ng-secret");
    expect(err!.message).toContain("***");
  });

  test("no credentials at all -> 407", async () => {
    await expect(
      openTunnel(`ws://relay.test:${port}`, `http://127.0.0.1:${proxy.port}`, { timeoutMs: 3000 })
    ).rejects.toThrow(/407/);
  });

  test("username-only (JWT style) credentials are sent as user:", async () => {
    const jwtProxy = await startProxy({
      auth: "Basic " + Buffer.from("jwt.tok.en:").toString("base64"),
      hostMap: { "relay.test": "127.0.0.1" },
    });
    try {
      const sock = await openTunnel(`ws://relay.test:${port}`, `http://jwt.tok.en@127.0.0.1:${jwtProxy.port}`, {
        timeoutMs: 3000,
      });
      sock.destroy();
    } finally {
      await jwtProxy.close();
    }
  });
});

describe("openTunnel failure modes", () => {
  test("proxy that never answers rejects within timeoutMs", async () => {
    const proxy = await startProxy({ hang: true });
    try {
      const t0 = Date.now();
      const err = await openTunnel("ws://relay.test:80", `http://u:topsecret@127.0.0.1:${proxy.port}`, {
        timeoutMs: 300,
      }).then(
        () => null,
        (e: Error) => e
      );
      const dt = Date.now() - t0;
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/timed out after 300 ms/);
      expect(err!.message).not.toContain("topsecret");
      expect(dt).toBeLessThan(2000);
    } finally {
      await proxy.close();
    }
  });

  test("proxy closing before the head rejects naming the redacted proxy", async () => {
    const srv = net.createServer((c) => c.destroy());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const p = (srv.address() as net.AddressInfo).port;
    try {
      const err = await openTunnel("ws://relay.test:80", `http://u:topsecret@127.0.0.1:${p}`, {
        timeoutMs: 3000,
      }).then(
        () => null,
        (e: Error) => e
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain("127.0.0.1");
      expect(err!.message).not.toContain("topsecret");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  test("connection refused rejects without leaking credentials", async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const p = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const err = await openTunnel("ws://relay.test:80", `http://u:topsecret@127.0.0.1:${p}`, {
      timeoutMs: 3000,
    }).then(
      () => null,
      (e: Error) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain("topsecret");
    expect(err!.message).toMatch(/ECONNREFUSED/);
  });

  test("oversized response head is rejected", async () => {
    const srv = net.createServer((c) => {
      c.on("error", () => {});
      c.write("HTTP/1.1 200 OK\r\nX-Junk: " + "a".repeat(20 * 1024));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const p = (srv.address() as net.AddressInfo).port;
    try {
      await expect(
        openTunnel("ws://relay.test:80", `http://127.0.0.1:${p}`, { timeoutMs: 3000 })
      ).rejects.toThrow(/oversized/);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  test("brackets IPv6 targets in the CONNECT authority", async () => {
    const proxy = await startProxy({ hostMap: {} });
    try {
      // The proxy cannot reach [::1]:1 (refused) but records the request line first.
      await openTunnel("ws://[2001:db8::5]:4000", `http://127.0.0.1:${proxy.port}`, {
        timeoutMs: 500,
      }).catch(() => undefined);
      expect(proxy.requests[0].authority).toBe("[2001:db8::5]:4000");
      expect(proxy.requests[0].headers.host).toBe("[2001:db8::5]:4000");
    } finally {
      await proxy.close();
    }
  });

  test("default target ports: 80 for ws, 443 for wss", async () => {
    const proxy = await startProxy({ hang: false, hostMap: {} });
    try {
      await openTunnel("ws://a.invalid", `http://127.0.0.1:${proxy.port}`, { timeoutMs: 300 }).catch(() => undefined);
      await openTunnel("wss://b.invalid", `http://127.0.0.1:${proxy.port}`, { timeoutMs: 300 }).catch(() => undefined);
      expect(proxy.requests.map((r) => r.authority)).toEqual(["a.invalid:80", "b.invalid:443"]);
    } finally {
      await proxy.close();
    }
  });
});
