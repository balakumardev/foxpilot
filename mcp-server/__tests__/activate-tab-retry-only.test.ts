import WebSocket from "ws";
import { BrokerServer } from "../broker";
import { BrowserAPI } from "../browser-api";
import { createSignature } from "../signing";
import { timeoutMessageFor } from "../broker-core";
import type { ServerMessageRequest } from "@foxpilot/common";
import * as fs from "fs";
import * as path from "path";

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return { ...actual, spawn: jest.fn(() => ({ unref: jest.fn() })) };
});

// Why this file exists: the click-at / type-at / hover-at / scroll-at /
// scroll-to / scroll-into-view tools had NO activateTab field, so when a
// background tab stalled input, the timeout hint could only send the agent to
// `select-tab` -- which takes the user's window focus and never switches back.
// They now accept activateTab (foreground for ONE call, then restore), and the
// guidance everywhere is retry-only so agents stop adding it to every call.

const SECRET = "activate-tab-retry-only-secret";

function startMockExtension(
  port: number,
  onReq: (req: ServerMessageRequest) => object
): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    ws.on("open", () => {
      const hello = {
        type: "hello",
        browserId: "activate-retry-ext",
        browserType: "chrome",
        label: "Chrome",
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

describe("coordinate + scroll tools forward activateTab to the extension", () => {
  let server: BrokerServer;
  let ext: WebSocket;
  let api: BrowserAPI;
  let lastReq: Record<string, unknown> | null = null;
  const origSecret = process.env.EXTENSION_SECRET;
  const origPort = process.env.EXTENSION_PORT;

  beforeAll(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    const port = server.getPort();
    ext = await startMockExtension(port, (req) => {
      lastReq = req as unknown as Record<string, unknown>;
      const isPoint = ["click-at", "type-at", "hover-at", "scroll-at"].includes(
        req.cmd
      );
      return isPoint
        ? { resource: "point-action-result", correlationId: req.correlationId, ok: true }
        : { resource: "action-result", correlationId: req.correlationId, ok: true };
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

  // [cmd, call with activateTab:true, call without it]
  const cases: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
    [
      "click-at",
      () => api.clickAt(7, 10, 20, { activateTab: true }),
      () => api.clickAt(7, 10, 20),
    ],
    [
      "type-at",
      () => api.typeAt(7, 10, 20, "hi", undefined, undefined, undefined, true),
      () => api.typeAt(7, 10, 20, "hi"),
    ],
    [
      "hover-at",
      () => api.hoverAt(7, 10, 20, undefined, true),
      () => api.hoverAt(7, 10, 20),
    ],
    [
      "scroll-at",
      () => api.scrollAt(7, 10, 20, { dy: 50, activateTab: true }),
      () => api.scrollAt(7, 10, 20, { dy: 50 }),
    ],
    [
      "scroll-to",
      () => api.scrollTo(7, 0, 100, true),
      () => api.scrollTo(7, 0, 100),
    ],
    [
      "scroll-into-view",
      () => api.scrollIntoView(7, "e1", true),
      () => api.scrollIntoView(7, "e1"),
    ],
  ];

  it.each(cases)("%s carries activateTab:true onto the wire", async (cmd, withFlag) => {
    await withFlag();
    expect(lastReq?.cmd).toBe(cmd);
    expect(lastReq?.activateTab).toBe(true);
  });

  it.each(cases)(
    "%s omits activateTab entirely when not requested (back-compat)",
    async (cmd, _withFlag, withoutFlag) => {
      await withoutFlag();
      expect(lastReq?.cmd).toBe(cmd);
      // JSON drops undefined, so an older extension sees no new field at all.
      expect("activateTab" in (lastReq as object)).toBe(false);
    }
  );
});

describe("timeout hint no longer sends agents to select-tab first", () => {
  it("leads with activateTab:true and demotes select-tab to a last resort", () => {
    const msg = timeoutMessageFor("click-at", 15000);
    const a = msg.indexOf("activateTab:true");
    const s = msg.indexOf("select-tab");
    expect(a).toBeGreaterThan(-1);
    expect(s).toBeGreaterThan(-1);
    expect(a).toBeLessThan(s);
    // The reason the order matters: select-tab does not switch back.
    expect(msg).toMatch(/last resort/);
    expect(msg).toMatch(/does not switch back/);
    expect(msg).toMatch(/restores the user's previous tab/);
  });
});

describe("agent-facing guidance is retry-only", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.ts"), "utf8");

  it("the server instructions tell agents NOT to pass activateTab up front", () => {
    expect(serverSrc).toMatch(/Do NOT pass activateTab:true up front/);
    // The old wording that taught agents to add it everywhere.
    expect(serverSrc).not.toMatch(/PASS activateTab:true on take-snapshot/);
    expect(serverSrc).not.toMatch(/its content is frozen by/);
  });

  it("the shared field description is retry-only", () => {
    expect(serverSrc).toMatch(/RETRY-ONLY\. Do NOT set this on the first attempt/);
  });

  it("wait-for-text no longer says to pass it whenever the tab is in the background", () => {
    expect(serverSrc).not.toMatch(
      /If the target tab is in the BACKGROUND, pass activateTab:true/
    );
    expect(serverSrc).toMatch(/Do not pass activateTab:true up front/);
  });

  it("all six newly-flagged tools declare the field", () => {
    for (const tool of [
      "click-at",
      "type-at",
      "hover-at",
      "scroll-at",
      "scroll-to",
      "scroll-into-view",
    ]) {
      const start = serverSrc.indexOf(`"${tool}",`);
      expect(start).toBeGreaterThan(-1);
      const block = serverSrc.slice(start, start + 3500);
      const end = block.indexOf("mcpServer.tool(");
      const body = end === -1 ? block : block.slice(0, end);
      expect([tool, body.includes("...activateTabField")]).toEqual([tool, true]);
    }
  });
});
