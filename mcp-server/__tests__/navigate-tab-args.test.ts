import WebSocket from "ws";
import { BrokerServer } from "../broker";
import { BrowserAPI } from "../browser-api";
import { createSignature } from "../signing";
import type { ServerMessageRequest } from "@foxpilot/common";

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return { ...actual, spawn: jest.fn(() => ({ unref: jest.fn() })) };
});

const SECRET = "nta-secret";

function startMockExtension(
  port: number,
  onReq: (req: ServerMessageRequest) => object
): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    ws.on("open", () => {
      const hello = { type: "hello", browserId: "nta-ext", browserType: "firefox", label: "Firefox" };
      ws.send(JSON.stringify({ payload: hello, signature: createSignature(SECRET, JSON.stringify(hello)) }));
      resolve(ws);
    });
    ws.on("message", (data) => {
      const env = JSON.parse(data.toString());
      if (env?.type === "welcome" || env?.type === "rejected") return;
      const cmd = env?.payload?.cmd;
      if (typeof cmd !== "string" || cmd === "active-status") return;
      const payload = onReq(env.payload as ServerMessageRequest);
      ws.send(JSON.stringify({ payload, signature: createSignature(SECRET, JSON.stringify(payload)) }));
    });
  });
}

describe("BrowserAPI.navigateTab params over the broker", () => {
  let server: BrokerServer;
  let ext: WebSocket;
  let api: BrowserAPI;
  let lastReq: ServerMessageRequest | null = null;
  const origSecret = process.env.EXTENSION_SECRET;
  const origPort = process.env.EXTENSION_PORT;

  beforeAll(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    const port = server.getPort();
    ext = await startMockExtension(port, (req) => {
      lastReq = req;
      // Echo the SETTLED (different) url the extension would re-read via tabs.get.
      return {
        resource: "navigated",
        correlationId: req.correlationId,
        tabId: (req as any).tabId,
        url: "https://dash.cloudflare.com/home",
      };
    });
    process.env.EXTENSION_SECRET = SECRET;
    process.env.EXTENSION_PORT = String(port);
    api = new BrowserAPI();
    await api.init();
  }, 15000);

  afterAll(() => {
    api.close();
    ext.close();
    server.close();
    if (origSecret === undefined) delete process.env.EXTENSION_SECRET; else process.env.EXTENSION_SECRET = origSecret;
    if (origPort === undefined) delete process.env.EXTENSION_PORT; else process.env.EXTENSION_PORT = origPort;
  });

  it("forwards the new optional params and surfaces the settled url", async () => {
    const result = await api.navigateTab(7, "https://dash.cloudflare.com/templates", {
      waitUntil: "complete",
      waitForText: "Create Token",
      waitForUrl: "/home",
      forceLoad: true,
      timeoutMs: 12000,
    });
    expect((lastReq as any).cmd).toBe("navigate-tab");
    expect((lastReq as any).waitUntil).toBe("complete");
    expect((lastReq as any).waitForText).toBe("Create Token");
    expect((lastReq as any).waitForUrl).toBe("/home");
    expect((lastReq as any).forceLoad).toBe(true);
    expect((lastReq as any).timeoutMs).toBe(12000);
    // The tool must report the ACCURATE settled url, not the requested one.
    expect(result.url).toBe("https://dash.cloudflare.com/home");
  });

  it("still works with no opts (back-compat)", async () => {
    const result = await api.navigateTab(7, "https://dash.cloudflare.com/x");
    expect((lastReq as any).cmd).toBe("navigate-tab");
    expect((lastReq as any).waitUntil).toBeUndefined();
    expect(result.url).toBe("https://dash.cloudflare.com/home");
  });
});
