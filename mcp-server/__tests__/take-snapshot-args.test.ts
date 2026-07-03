import WebSocket from "ws";
import { BrokerServer } from "../broker";
import { BrowserAPI } from "../browser-api";
import { createSignature } from "../signing";
import type { ServerMessageRequest } from "@foxpilot/common";

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return { ...actual, spawn: jest.fn(() => ({ unref: jest.fn() })) };
});

const SECRET = "tsa-secret";

function startMockExtension(
  port: number,
  onReq: (req: ServerMessageRequest) => object
): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    ws.on("open", () => {
      const hello = {
        type: "hello",
        browserId: "tsa-ext",
        browserType: "firefox",
        label: "Firefox",
      };
      ws.send(
        JSON.stringify({
          payload: hello,
          signature: createSignature(SECRET, JSON.stringify(hello)),
        })
      );
      resolve(ws);
    });
    ws.on("message", (data) => {
      const env = JSON.parse(data.toString());
      if (env?.type === "welcome" || env?.type === "rejected") return;
      const cmd = env?.payload?.cmd;
      if (typeof cmd !== "string" || cmd === "active-status") return;
      const payload = onReq(env.payload as ServerMessageRequest);
      ws.send(
        JSON.stringify({
          payload,
          signature: createSignature(SECRET, JSON.stringify(payload)),
        })
      );
    });
  });
}

describe("BrowserAPI.takeSnapshot query args over the broker", () => {
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
      if ((req as any).rootSelector === "#missing") {
        return {
          resource: "snapshot",
          correlationId: req.correlationId,
          tabId: (req as any).tabId,
          snapshot: "",
          isTruncated: false,
          total: 0,
          hasMore: false,
          error: "rootSelector matched no element: #missing",
        };
      }
      return {
        resource: "snapshot",
        correlationId: req.correlationId,
        tabId: (req as any).tabId,
        snapshot: 'textbox "Message input" [uid=e1]',
        isTruncated: false,
        total: 1,
        hasMore: false,
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
    if (origSecret === undefined) delete process.env.EXTENSION_SECRET;
    else process.env.EXTENSION_SECRET = origSecret;
    if (origPort === undefined) delete process.env.EXTENSION_PORT;
    else process.env.EXTENSION_PORT = origPort;
  });

  it("forwards the selector query field and surfaces total/hasMore", async () => {
    const result = await api.takeSnapshot(9, { selector: "[contenteditable]" });
    expect((lastReq as any).selector).toBe("[contenteditable]");
    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.snapshot).toContain("uid=e1");
  });

  it("surfaces a rootSelector miss as an error field", async () => {
    const result = await api.takeSnapshot(9, { rootSelector: "#missing" });
    expect((lastReq as any).rootSelector).toBe("#missing");
    expect(result.error).toMatch(/rootSelector matched no element/);
  });
});
