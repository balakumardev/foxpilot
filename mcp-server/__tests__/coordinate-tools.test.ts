import WebSocket from "ws";
import { BrokerServer } from "../broker";
import { BrowserAPI } from "../browser-api";
import { createSignature } from "../signing";
import type { ServerMessageRequest } from "@foxpilot/common";

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return { ...actual, spawn: jest.fn(() => ({ unref: jest.fn() })) };
});

const SECRET = "coord-secret";

function startMockExtension(
  port: number,
  onReq: (req: ServerMessageRequest) => object
): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    ws.on("open", () => {
      const hello = {
        type: "hello",
        browserId: "coord-ext",
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

describe("BrowserAPI coordinate tools over the broker", () => {
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
        resource: "point-action-result",
        correlationId: req.correlationId,
        ok: true,
        element: {
          tag: "div",
          id: "open-card",
          classes: ["card"],
          rect: { x: 0, y: 0, w: 0, h: 0 },
          editable: false,
        },
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

  it("forwards click-at coordinates and surfaces the element descriptor", async () => {
    const result = await api.clickAt(2, 100, 200, { button: "right" });
    expect((lastReq as any).cmd).toBe("click-at");
    expect((lastReq as any).x).toBe(100);
    expect((lastReq as any).y).toBe(200);
    expect((lastReq as any).button).toBe("right");
    expect(result.ok).toBe(true);
    expect(result.element!.id).toBe("open-card");
  });
});
