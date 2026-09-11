import WebSocket from "ws";
import { z } from "zod";
import { BrokerServer } from "../broker";
import { BrowserAPI } from "../browser-api";
import { createSignature } from "../signing";
import type { ServerMessageRequest } from "@foxpilot/common";

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return { ...actual, spawn: jest.fn(() => ({ unref: jest.fn() })) };
});

// --- Schema mirror test (kept in sync with server.ts) ----------------------
// wait-for-text is the tool that needs activateTab MOST: every other tab-scoped
// read returns whatever is on the page RIGHT NOW, but wait-for-text polls for a
// CHANGE. A background tab frozen by the browser never advances, so the text can
// never appear and the call is structurally guaranteed to burn its full deadline
// (default 30000ms) and report "Text did not appear". Before this fix the tool
// had no activateTab field at all, so an agent had no way to recover.
const waitForTextArgs = z.object({
  tabId: z.number(),
  text: z.union([z.string(), z.array(z.string()).nonempty()]),
  timeoutMs: z.number().optional(),
  activateTab: z.boolean().optional(),
});

test("wait-for-text schema accepts activateTab (and still accepts calls without it)", () => {
  expect(
    waitForTextArgs.parse({ tabId: 1, text: "Hello", activateTab: true })
  ).toMatchObject({ text: "Hello", activateTab: true });
  // Back-compat: the flag is optional and absent stays absent (not `false`), so
  // the wire message is byte-for-byte unchanged for existing callers.
  expect(waitForTextArgs.parse({ tabId: 1, text: "Hello" }).activateTab).toBe(
    undefined
  );
});

const SECRET = "wft-activate-secret";

function startMockExtension(
  port: number,
  onReq: (req: ServerMessageRequest) => object
): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    ws.on("open", () => {
      const hello = {
        type: "hello",
        browserId: "wft-activate-ext",
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

describe("wait-for-text activateTab reaches the extension", () => {
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
      return {
        resource: "wait-for-text-result",
        correlationId: req.correlationId,
        found: true,
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

  it("forwards activateTab:true onto the wire message", async () => {
    // The extension's dispatcher keys tab activation off the PRESENCE of
    // activateTab:true on the request (see message-handler.ts routeCommand),
    // so carrying the flag onto the wire is what actually foregrounds — and
    // thereby un-freezes — the target tab.
    await api.waitForText(7, "Hello", undefined, { activateTab: true });
    expect((lastReq as unknown as { activateTab?: boolean }).activateTab).toBe(
      true
    );
  });

  it("omits activateTab entirely when not requested (back-compat)", async () => {
    await api.waitForText(7, "Hello");
    expect("activateTab" in (lastReq as object)).toBe(false);
  });
});
