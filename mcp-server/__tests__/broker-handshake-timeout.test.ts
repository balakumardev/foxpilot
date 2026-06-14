import WebSocket from "ws";
import * as http from "http";
import { BrokerServer } from "../broker";
import { createSignature } from "../signing";

const SECRET = "integration-secret";

function envelope(payload: unknown): string {
  return JSON.stringify({
    payload,
    signature: createSignature(SECRET, JSON.stringify(payload)),
  });
}

function hello(
  browserId: string,
  browserType: "chrome" | "firefox",
  label: string
): string {
  return envelope({ type: "hello", browserId, browserType, label });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
}

function getHealth(port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/health`, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d)));
      })
      .on("error", reject);
  });
}

describe("BrokerServer anonymous-handshake timeout", () => {
  let server: BrokerServer;
  let port: number;

  beforeEach(async () => {
    // A short handshake timeout so the anonymous-socket path can be exercised
    // within the test window.
    server = new BrokerServer({
      port: 0,
      host: "127.0.0.1",
      secret: SECRET,
      handshakeTimeoutMs: 150,
    });
    await server.listen();
    port = server.getPort();
  });

  afterEach(() => {
    server.close();
  });

  it("exposes the resolved handshake timeout", () => {
    expect(server.getHandshakeTimeoutMs()).toBe(150);
  });

  it("closes an anonymous /extension socket that never sends a hello", async () => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ext);

    // Send NO hello. The broker must terminate the socket once the handshake
    // window (150ms) lapses.
    const closed = await new Promise<string>((resolve) => {
      ext.on("close", () => resolve("closed"));
      setTimeout(() => resolve("still-open"), 500);
    });
    expect(closed).toBe("closed");

    // No browser was ever registered.
    const health = await getHealth(port);
    expect(health.browsers).toBe(0);
  }, 10000);

  it("keeps a socket that completes the hello before the timeout, and registers it", async () => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ext);
    // Promptly send a valid signed hello — the timer must be cleared on
    // registration so this socket is never terminated.
    ext.send(hello("chrome-1", "chrome", "Chrome"));

    // Watch for an unexpected close within a window that comfortably exceeds the
    // 150ms handshake timeout.
    const outcome = await new Promise<string>((resolve) => {
      ext.on("close", () => resolve("closed"));
      setTimeout(() => resolve("still-open"), 500);
    });
    expect(outcome).toBe("still-open");
    expect(ext.readyState).toBe(WebSocket.OPEN);

    // And it is registered in the broker registry.
    const health = await getHealth(port);
    expect(health.browsers).toBe(1);

    ext.close();
  }, 10000);
});
