import WebSocket from "ws";
import { z } from "zod";
import { BrokerServer } from "../broker";
import { createSignature } from "../signing";
import { getMessageTabId } from "../broker-protocol";
import type { ServerMessageRequest } from "@foxpilot/common";

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return { ...actual, spawn: jest.fn(() => ({ unref: jest.fn() })) };
});

// server.ts registers its tools on a McpServer and connects stdio the moment it
// is imported. Replace both: the fake records each tool the way the real
// McpServer sees it (name, description, zod SHAPE, handler) and, like the real
// one, runs the shape over the arguments before calling the handler, so a field
// missing from the shape is stripped exactly as it would be in production.
const mockTools = new Map<
  string,
  { description: string; shape: Record<string, z.ZodTypeAny>; handler: (args: any, extra?: any) => Promise<any> }
>();
jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool(name: string, description: string, shape: any, handler: any) {
      mockTools.set(name, { description, shape, handler });
    }
    connect() {
      return Promise.resolve();
    }
    close() {}
  },
}));
jest.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

const SECRET = "bft-secret";

function startMockExtension(
  port: number,
  onReq: (req: ServerMessageRequest) => object
): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    ws.on("open", () => {
      const hello = {
        type: "hello",
        browserId: "bft-ext",
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

describe("browser-fetch tool (real server.ts handler + zod shape, over the broker)", () => {
  let server: BrokerServer;
  let ext: WebSocket;
  let lastReq: Record<string, unknown> | null = null;
  let reply: (req: ServerMessageRequest) => object;
  const origSecret = process.env.EXTENSION_SECRET;
  const origPort = process.env.EXTENSION_PORT;

  // What the MCP SDK does: parse with the registered shape, then call the handler.
  async function callTool(args: Record<string, unknown>) {
    const tool = mockTools.get("browser-fetch")!;
    return await tool.handler(z.object(tool.shape).parse(args), {});
  }

  beforeAll(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    const port = server.getPort();
    ext = await startMockExtension(port, (req) => {
      lastReq = req as unknown as Record<string, unknown>;
      return reply(req);
    });
    process.env.EXTENSION_SECRET = SECRET;
    process.env.EXTENSION_PORT = String(port);

    // server.ts parks a listener on stdin's close that exits the process.
    const on = jest.spyOn(process.stdin, "on").mockImplementation(() => process.stdin);
    require("../server");
    on.mockRestore();
  }, 15000);

  afterAll(() => {
    ext.close();
    server.close();
    if (origSecret === undefined) delete process.env.EXTENSION_SECRET;
    else process.env.EXTENSION_SECRET = origSecret;
    if (origPort === undefined) delete process.env.EXTENSION_PORT;
    else process.env.EXTENSION_PORT = origPort;
  });

  beforeEach(() => {
    lastReq = null;
  });

  const okReply = (req: ServerMessageRequest, over: Record<string, unknown> = {}) => ({
    resource: "browser-fetch-result",
    correlationId: req.correlationId,
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    finalUrl: "https://app.example.test/api/v1/things",
    bodyText: '{"things":[]}',
    truncated: false,
    ...over,
  });

  it("registers browser-fetch with tabId in its zod shape", () => {
    const tool = mockTools.get("browser-fetch")!;
    expect(Object.keys(tool.shape)).toContain("tabId");
    expect(tool.shape.tabId.safeParse(7).success).toBe(true);
    expect(tool.shape.tabId.safeParse(undefined).success).toBe(true);
    expect(tool.shape.tabId.safeParse("7").success).toBe(false);
    // zod objects STRIP unknown keys, which is why the field must be in the shape.
    expect(z.object(tool.shape).parse({ url: "/x", tabId: 7, bogus: 1 })).toEqual({ url: "/x", tabId: 7 });
  });

  it("tabId survives the zod shape and reaches the extension; a tab-context reply is shown with its banner", async () => {
    reply = (req) =>
      okReply(req, { context: "tab", tabOrigin: "https://app.example.test" });
    const out = await callTool({
      url: "/api/v1/things",
      tabId: 7,
      method: "POST",
      headers: { "x-csrf-token": "fake-token-123" },
      body: "{}",
    });

    expect(lastReq).toMatchObject({
      cmd: "browser-fetch",
      tabId: 7,
      url: "/api/v1/things",
      method: "POST",
      headers: { "x-csrf-token": "fake-token-123" },
      body: "{}",
    });
    expect(out.isError).toBeUndefined();
    const text: string = out.content[0].text;
    expect(text.split("\n")[0]).toBe(
      "[ran inside tab 7 as the page: origin https://app.example.test]"
    );
    expect(text).toContain("200 OK  https://app.example.test/api/v1/things");
    expect(text).toContain('{"things":[]}');
  });

  it("without tabId the frame carries none and a bare background 403 gets the hint", async () => {
    reply = (req) =>
      okReply(req, {
        status: 403,
        statusText: "Forbidden",
        headers: {},
        bodyText: undefined,
        bodyBase64: "",
        context: "background",
      });
    const out = await callTool({ url: "https://app.example.test/api/v1/things" });

    expect("tabId" in (lastReq as object)).toBe(false);
    expect(out.isError).toBeUndefined();
    const text: string = out.content[0].text;
    expect(text.startsWith("403 Forbidden  ")).toBe(true);
    expect(text).toContain("[binary body: base64 length 0]");
    expect(text).toMatch(/Hint: .*extension's Origin.*tabId/s);
  });

  it("an extension that predates tabId (reply without context) is rejected as an error, not shown as a tab response", async () => {
    reply = (req) => okReply(req, { bodyText: "background-response" });
    const out = await callTool({ url: "/api/v1/things", tabId: 7, method: "POST" });

    // The old extension did receive tabId and ignored it.
    expect(lastReq).toMatchObject({ cmd: "browser-fetch", tabId: 7 });
    expect(out.isError).toBe(true);
    const text: string = out.content[0].text;
    expect(text).toMatch(/too old for tabId mode/);
    expect(text).toMatch(/nothing was sent in the page context/);
    // The POST went out from the background, so the agent is told not to resend it.
    expect(text).toMatch(/This POST may already have taken effect: check before sending it again/);
    expect(text).not.toMatch(/without tabId/);
    expect(text).not.toContain("background-response");
    expect(text).not.toContain("[ran inside tab");
  });

  it("a tab-mode transport failure is an ordinary Fetch failed error", async () => {
    reply = (req) => ({
      resource: "browser-fetch-result",
      correlationId: req.correlationId,
      ok: false,
      error: "Timed out after 30000 ms waiting for the response inside tab 7.",
      context: "tab",
      tabOrigin: "https://app.example.test",
    });
    const out = await callTool({ url: "/x", tabId: 7 });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe(
      "Fetch failed: Timed out after 30000 ms waiting for the response inside tab 7."
    );
  });

  it("the broker treats a tabId-carrying browser-fetch as tab-targeted (per-tab serialization), and not otherwise", () => {
    const base = { cmd: "browser-fetch", correlationId: "c", url: "https://app.example.test/x" } as const;
    expect(getMessageTabId({ ...base, tabId: 7 } as any)).toBe(7);
    expect(getMessageTabId({ ...base } as any)).toBeUndefined();
  });

  describe("tool description (no longer oversells)", () => {
    const description = () => mockTools.get("browser-fetch")!.description;

    it("does not claim to pass WAFs or to be browser-originated", () => {
      expect(description()).not.toMatch(/passes WAFs/i);
      expect(description()).not.toMatch(/browser-originated/i);
      expect(description()).toMatch(/not WAF-proof/i);
    });

    it("says the Origin is the extension's, with no page Referer, and that 403/401 with an empty body can result", () => {
      expect(description()).toMatch(/Origin is the extension's/);
      expect(description()).toMatch(/no page Referer/);
      expect(description()).toMatch(/403\/401, often with an EMPTY body/);
    });

    it("tells the agent to pass tabId of a tab on the site to call it as the page", () => {
      expect(description()).toMatch(/pass the tabId of a tab on that site/);
      expect(description()).toMatch(/normal CORS/);
      expect(description()).toMatch(/isolated content-script world/);
      expect(description()).toMatch(/content\.fetch/);
      // What is not verified is not promised: CSP may apply.
      expect(description()).toMatch(/CSP connect-src may also apply/);
      expect(description()).not.toMatch(/patched window\.fetch/);
    });

    it("keeps the non-2xx-is-success sentence", () => {
      expect(description()).toMatch(
        /a non-2xx status \(e\.g\. 403\) is a SUCCESSFUL result, not an error/
      );
    });

    it("stream-start no longer repeats the claim", () => {
      const d = mockTools.get("stream-start")!.description;
      expect(d).not.toMatch(/WAF/i);
      expect(d).toMatch(/extension's Origin and no page Referer/);
    });
  });
});
