import WebSocket from "ws";
import { BrokerServer } from "../broker";
import { BrowserAPI } from "../browser-api";
import { createSignature } from "../signing";
import { listOpenTabs } from "../tab-list-format";
import type { ServerMessageRequest } from "@foxpilot/common";

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return { ...actual, spawn: jest.fn(() => ({ unref: jest.fn() })) };
});

const SECRET = "tla-secret";

const RAW_TABS = [
  {
    id: 1,
    windowId: 7,
    url: "https://app.example.test/inbox?token=fake-token-123#access_token=fake-token-456",
    title: "Inbox",
    lastAccessed: 1000,
  },
  { id: 2, windowId: 7, url: "https://docs.example.test/guide", title: "Guide" },
  { id: 3, windowId: 8, url: "https://app.example.test/settings", title: "Settings" },
];

function startMockExtension(
  port: number,
  onReq: (req: ServerMessageRequest) => object
): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    ws.on("open", () => {
      const hello = {
        type: "hello",
        browserId: "tla-ext",
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

describe("get-list-of-open-tabs over the broker", () => {
  let server: BrokerServer;
  let ext: WebSocket;
  let api: BrowserAPI;
  let lastReq: ServerMessageRequest | null = null;
  // "old" = an extension that predates the text filters: it ignores them,
  // returns every tab with raw URLs and sends no filtersApplied marker.
  let mode: "old" | "new" = "old";
  const origSecret = process.env.EXTENSION_SECRET;
  const origPort = process.env.EXTENSION_PORT;

  beforeAll(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    const port = server.getPort();
    ext = await startMockExtension(port, (req) => {
      lastReq = req;
      if (mode === "new") {
        return {
          resource: "tabs",
          correlationId: req.correlationId,
          tabs: [{ id: 2, windowId: 7, url: "https://docs.example.test/guide", title: "Guide" }],
          filtersApplied: true,
        };
      }
      return { resource: "tabs", correlationId: req.correlationId, tabs: RAW_TABS };
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

  const texts = (items: { text: string }[]) => items.map((i) => i.text);

  it("carries urlContains, titleContains and redactUrls in the get-tab-list message", async () => {
    mode = "new";
    await listOpenTabs(api, {
      offset: 0,
      limit: 10,
      windowId: 7,
      urlContains: "example.test",
      titleContains: "guide",
    });
    expect(lastReq).toMatchObject({
      cmd: "get-tab-list",
      windowId: 7,
      urlContains: "example.test",
      titleContains: "guide",
      redactUrls: true,
    });
  });

  it("asks for raw URLs when fullUrls is set", async () => {
    mode = "new";
    await listOpenTabs(api, { offset: 0, limit: 10, fullUrls: true });
    expect((lastReq as any).redactUrls).toBe(false);
  });

  it("sends no text filter fields when none were given", async () => {
    mode = "new";
    await listOpenTabs(api, { offset: 0, limit: 10, urlContains: "", titleContains: "" });
    expect(lastReq).not.toHaveProperty("urlContains");
    expect(lastReq).not.toHaveProperty("titleContains");
  });

  it("getTabListResult surfaces the filtersApplied marker, and its absence", async () => {
    mode = "new";
    expect((await api.getTabListResult()).filtersApplied).toBe(true);
    mode = "old";
    expect((await api.getTabListResult()).filtersApplied).toBe(false);
  });

  it("an extension that ignores the filters is still filtered and redacted by the server", async () => {
    mode = "old";
    const out = texts(
      await listOpenTabs(api, {
        offset: 0,
        limit: 10,
        windowId: 7,
        urlContains: "APP.EXAMPLE",
      })
    );
    expect(out[0]).toBe("Showing tabs 1-1 of 1 matching tabs");
    expect(out[1]).toContain(
      "tab id=1, tab url=https://app.example.test/inbox?[redacted]#[redacted], tab title=Inbox, last accessed="
    );
    expect(out.join("\n")).not.toMatch(/fake-token/);
    // windowId and urlContains were verified by the server, so no NOTE.
    expect(out.some((l) => l.startsWith("NOTE:"))).toBe(false);
  });

  it("the server also keeps urlContains from probing a token on an old extension", async () => {
    mode = "old";
    const out = texts(
      await listOpenTabs(api, { offset: 0, limit: 10, urlContains: "fake-token-123" })
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/no open tabs match/i);
  });

  it("an old extension plus activeOnly gets a NOTE that it could not be confirmed", async () => {
    mode = "old";
    const out = texts(
      await listOpenTabs(api, { offset: 0, limit: 10, activeOnly: true, compact: true })
    );
    expect(out[0]).toBe("Showing tabs 1-3 of 3 matching tabs");
    expect(out[1]).toBe("id=1 win=7 app.example.test/inbox?[redacted]#[redacted] | Inbox");
    expect(out[out.length - 1]).toMatch(/^NOTE: activeOnly could not be confirmed/);
  });

  it("a current extension's reply is listed as is, with no NOTE", async () => {
    mode = "new";
    const out = texts(
      await listOpenTabs(api, { offset: 0, limit: 10, activeOnly: true, visibleOnly: true })
    );
    expect(out[0]).toBe("Showing tabs 1-1 of 1 matching tabs");
    expect(out.some((l) => l.startsWith("NOTE:"))).toBe(false);
  });
});
