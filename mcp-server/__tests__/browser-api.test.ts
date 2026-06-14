import WebSocket from "ws";
import * as childProcess from "child_process";
import { BrokerServer } from "../broker";
import { BrowserAPI } from "../browser-api";
import { createSignature } from "../signing";
import type { ServerMessageRequest } from "@foxpilot/common";

// Wrap child_process so spawn is a jest mock we can assert on. The real module
// is preserved (the broker server runs in-process and does not spawn); only
// spawn is observable. ensureSidecar / spawnBroker are the only spawn callers
// in these tests, and the broker is already listening so spawnBroker is skipped.
jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    spawn: jest.fn(() => ({ unref: jest.fn() })),
  };
});
const spawnMock = childProcess.spawn as jest.Mock;

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
        case "get-network-requests":
          return {
            payload: {
              resource: "network-requests",
              correlationId: req.correlationId,
              requests: [
                {
                  requestId: "r1",
                  url: "https://a.com/api",
                  method: "GET",
                  type: "xmlhttprequest",
                  timeStamp: 1,
                  statusCode: 200,
                },
              ],
              // Mirror the Chrome MV3 extension, which sets this to false when
              // bodies were requested but cannot be captured.
              bodyCaptureSupported: false,
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

  it("surfaces bodyCaptureSupported from the network-requests reply", async () => {
    const result = await api.getNetworkRequests(1, { includeBody: true });
    expect(result.bodyCaptureSupported).toBe(false);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      url: "https://a.com/api",
      method: "GET",
      statusCode: 200,
    });
  });

  it("propagates an extension error as a rejection", async () => {
    await expect(api.findHighlight(5, "q")).rejects.toThrow("boom");
  });
});

describe("BrowserAPI sidecar auto-spawn gate", () => {
  let server: BrokerServer;
  let ext: WebSocket;
  let api: BrowserAPI;
  const origSecret = process.env.EXTENSION_SECRET;
  const origPort = process.env.EXTENSION_PORT;
  const origSidecarEntry = process.env.INPUT_SIDECAR_ENTRY;

  beforeAll(async () => {
    // Default behavior: INPUT_SIDECAR_ENTRY unset => ensureSidecar must no-op.
    delete process.env.INPUT_SIDECAR_ENTRY;

    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    const port = server.getPort();
    ext = await startMockExtension(port, SECRET, () => ({
      error: "unused",
    }));

    process.env.EXTENSION_SECRET = SECRET;
    process.env.EXTENSION_PORT = String(port);

    // Clear after the broker/extension are up so any earlier (unrelated) spawn
    // calls don't count; we only assert on init()/ensureSidecar() behavior.
    spawnMock.mockClear();
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
    if (origSidecarEntry === undefined) delete process.env.INPUT_SIDECAR_ENTRY;
    else process.env.INPUT_SIDECAR_ENTRY = origSidecarEntry;
  });

  it("does not spawn the sidecar when INPUT_SIDECAR_ENTRY is unset", () => {
    // The broker was already listening, so spawnBroker is skipped; with the
    // env var unset ensureSidecar is a no-op, so spawn must never be called.
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
