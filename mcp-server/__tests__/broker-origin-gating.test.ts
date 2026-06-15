import WebSocket from "ws";
import * as http from "http";
import { BrokerServer } from "../broker";
import { createSignature } from "../signing";

const SECRET = "control-secret";

function signedHello(browserId: string): string {
  const payload = { type: "hello", browserId, browserType: "chrome", label: "Chrome" };
  return JSON.stringify({ payload, signature: createSignature(SECRET, JSON.stringify(payload)) });
}

function unsignedHello(browserId: string): string {
  const payload = { type: "hello", browserId, browserType: "chrome", label: "Chrome" };
  return JSON.stringify({ payload });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));
}

function getHealth(port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });
}

describe("BrokerServer origin gating", () => {
  let server: BrokerServer;
  let port: number;

  beforeEach(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    port = server.getPort();
  });

  afterEach(() => server.close());

  it("admits an unsigned hello from an extension origin and sends welcome", async () => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      origin: "chrome-extension://abcdefghijklmnop",
    });
    await waitOpen(ext);
    const welcomePromise = nextMessage(ext);
    ext.send(unsignedHello("ext-origin-1"));
    const welcome = await welcomePromise;
    expect(welcome).toMatchObject({ type: "welcome", browserId: "ext-origin-1" });
    expect(Array.isArray(welcome.browsers)).toBe(true);
    const health = await getHealth(port);
    expect(health.browsers).toBe(1);
    ext.close();
  }, 10000);

  it("rejects a webpage origin with a typed rejected frame and does not register", async () => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      origin: "https://evil.example.com",
    });
    await waitOpen(ext);
    const msgPromise = nextMessage(ext);
    ext.send(unsignedHello("evil-1"));
    const msg = await msgPromise;
    expect(msg).toMatchObject({ type: "rejected", reason: "origin_not_allowed" });
    const health = await getHealth(port);
    expect(health.browsers).toBe(0);
  }, 10000);

  it("admits a legacy signed hello with no extension origin", async () => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ext);
    const welcomePromise = nextMessage(ext);
    ext.send(signedHello("ext-signed-1"));
    const welcome = await welcomePromise;
    expect(welcome).toMatchObject({ type: "welcome", browserId: "ext-signed-1" });
    const health = await getHealth(port);
    expect(health.browsers).toBe(1);
    ext.close();
  }, 10000);

  it("enforces strictExtensionIds when configured", async () => {
    server.close();
    server = new BrokerServer({
      port: 0,
      host: "127.0.0.1",
      secret: SECRET,
      strictExtensionIds: ["allowed-id"],
    });
    await server.listen();
    port = server.getPort();

    const denied = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      origin: "chrome-extension://denied-id",
    });
    await waitOpen(denied);
    const deniedMsg = nextMessage(denied);
    denied.send(unsignedHello("d1"));
    expect(await deniedMsg).toMatchObject({ type: "rejected" });

    const allowed = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      origin: "chrome-extension://allowed-id",
    });
    await waitOpen(allowed);
    const allowedMsg = nextMessage(allowed);
    allowed.send(unsignedHello("a1"));
    expect(await allowedMsg).toMatchObject({ type: "welcome" });
    allowed.close();
  }, 10000);

  it("sends an UNSIGNED active-status to an origin-admitted browser", async () => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      origin: "chrome-extension://abcdefghijklmnop",
    });
    await waitOpen(ext);
    // The hello triggers admission; the broker replies with welcome.
    ext.send(unsignedHello("origin-status-1"));
    await nextMessage(ext); // welcome
    // The sole browser is implicitly active; an active-status push is broadcast
    // on registration. Capture the next active-status frame.
    const frame = await new Promise<any>((resolve) => {
      const onMsg = (d: WebSocket.RawData) => {
        const m = JSON.parse(d.toString());
        if (m?.payload?.cmd === "active-status") {
          ext.off("message", onMsg);
          resolve(m);
        }
      };
      ext.on("message", onMsg);
      // Trigger a re-broadcast by opening a second browser then closing it.
      const ext2 = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
        origin: "chrome-extension://second",
      });
      ext2.on("open", () => ext2.send(unsignedHello("second")));
    });
    expect(frame.payload.cmd).toBe("active-status");
    expect(frame.signature).toBeUndefined();
    ext.close();
  }, 10000);

  it("answers a healthcheck frame with a healthcheck-result snapshot", async () => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      origin: "chrome-extension://abcdefghijklmnop",
    });
    await waitOpen(ext);
    // The hello triggers admission; the broker replies with welcome.
    ext.send(unsignedHello("hc-1"));
    await nextMessage(ext); // welcome
    const resultPromise = new Promise<any>((resolve) => {
      const onMsg = (d: WebSocket.RawData) => {
        const m = JSON.parse(d.toString());
        if (m?.type === "healthcheck-result") {
          ext.off("message", onMsg);
          resolve(m);
        }
      };
      ext.on("message", onMsg);
    });
    ext.send(JSON.stringify({ type: "healthcheck" }));
    const result = await resultPromise;
    expect(result).toMatchObject({ type: "healthcheck-result", extensionConnected: true });
    expect(Array.isArray(result.browsers)).toBe(true);
    ext.close();
  }, 10000);
});
