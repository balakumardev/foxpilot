import WebSocket from "ws";
import { BrokerServer } from "../broker";
import { BrowserAPI } from "../browser-api";
import { createSignature } from "../signing";
import type { ServerMessageRequest } from "@browser-control-mcp/common";

const SECRET = "client-test-secret";

type Reply = { payload: object } | { error: string };

function startMockExtension(
  port: number,
  secret: string,
  replyFn: (req: ServerMessageRequest) => Reply
): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    ws.on("open", () => resolve(ws));
    ws.on("message", (data) => {
      const env = JSON.parse(data.toString());
      const req = env.payload as ServerMessageRequest;
      const reply = replyFn(req);
      if ("error" in reply) {
        ws.send(
          JSON.stringify({
            correlationId: req.correlationId,
            errorMessage: reply.error,
          })
        );
      } else {
        ws.send(
          JSON.stringify({
            payload: reply.payload,
            signature: createSignature(secret, JSON.stringify(reply.payload)),
          })
        );
      }
    });
  });
}

describe("BrowserAPI over the broker", () => {
  let server: BrokerServer;
  let ext: WebSocket;
  let api: BrowserAPI;
  const origSecret = process.env.EXTENSION_SECRET;
  const origPort = process.env.EXTENSION_PORT;

  beforeAll(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    const port = server.getPort();

    ext = await startMockExtension(port, SECRET, (req) => {
      switch (req.cmd) {
        case "open-tab":
          return {
            payload: {
              resource: "opened-tab-id",
              correlationId: req.correlationId,
              tabId: 42,
            },
          };
        case "get-tab-list":
          return {
            payload: {
              resource: "tabs",
              correlationId: req.correlationId,
              tabs: [{ id: 1, url: "https://a.com", title: "A" }],
            },
          };
        case "get-console-messages":
          return {
            payload: {
              resource: "console-messages",
              correlationId: req.correlationId,
              entries: [
                { level: "log", text: "hello", timestamp: 1 },
                { level: "error", text: "boom", timestamp: 2 },
              ],
            },
          };
        case "find-highlight":
          return { error: "boom" };
        default:
          return { error: `unhandled cmd ${req.cmd}` };
      }
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

  it("openTab returns the tab id from the extension", async () => {
    expect(await api.openTab("https://x.com")).toBe(42);
  });

  it("getTabList returns the extension's tab list", async () => {
    const tabs = await api.getTabList();
    expect(tabs).toEqual([{ id: 1, url: "https://a.com", title: "A" }]);
  });

  it("getConsoleMessages returns the extension's buffered entries", async () => {
    const entries = await api.getConsoleMessages(9);
    expect(entries).toEqual([
      { level: "log", text: "hello", timestamp: 1 },
      { level: "error", text: "boom", timestamp: 2 },
    ]);
  });

  it("propagates an extension error as a rejection", async () => {
    await expect(api.findHighlight(5, "q")).rejects.toThrow("boom");
  });
});
