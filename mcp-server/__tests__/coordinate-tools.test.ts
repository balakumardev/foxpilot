import WebSocket from "ws";
import { BrokerServer } from "../broker";
import { BrowserAPI } from "../browser-api";
import { createSignature } from "../signing";
import { formatPointResult } from "../point-format";
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
      if (req.cmd === "scroll-to" || req.cmd === "scroll-into-view") {
        return {
          resource: "action-result",
          correlationId: req.correlationId,
          ok: true,
        };
      }
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

  it("forwards type-at text/submit", async () => {
    await api.typeAt(2, 50, 60, "hello", true);
    expect((lastReq as any).cmd).toBe("type-at");
    expect((lastReq as any).text).toBe("hello");
    expect((lastReq as any).submit).toBe(true);
  });

  it("forwards hover-at coords", async () => {
    await api.hoverAt(2, 11, 22);
    expect((lastReq as any).cmd).toBe("hover-at");
    expect((lastReq as any).x).toBe(11);
    expect((lastReq as any).y).toBe(22);
  });

  it("forwards scroll-at deltas", async () => {
    await api.scrollAt(2, 30, 40, { dx: 0, dy: 250 });
    expect((lastReq as any).cmd).toBe("scroll-at");
    expect((lastReq as any).dy).toBe(250);
  });

  it("forwards scroll-to and scroll-into-view", async () => {
    const r1 = await api.scrollTo(2, 0, 900);
    expect((lastReq as any).cmd).toBe("scroll-to");
    expect((lastReq as any).y).toBe(900);
    expect(r1.ok).toBe(true);
    const r2 = await api.scrollIntoView(2, "e7");
    expect((lastReq as any).cmd).toBe("scroll-into-view");
    expect((lastReq as any).uid).toBe("e7");
    expect(r2.ok).toBe(true);
  });
});

// Rider #3: exercise the pure formatter directly (the wire test above only
// drives api.typeAt/clickAt, so the role/name/editable formatting branches of
// formatPointResult were otherwise unexercised).
describe("formatPointResult", () => {
  type FormatResult = {
    content: { type: string; text: string }[];
    isError?: boolean;
  };

  it("renders role, quoted name, and (editable) for an editable descriptor", () => {
    const out = formatPointResult("Typed", 7, 10, 20, {
      ok: true,
      element: {
        tag: "textarea",
        id: "msg",
        role: "textbox",
        name: "Message",
        editable: true,
      },
    }) as FormatResult;
    expect(out.isError).toBeUndefined();
    const text = out.content[0].text;
    expect(text).toContain("Typed at (10, 20) on tab 7");
    expect(text).toContain('<textarea #msg role="textbox">');
    expect(text).toContain('"Message"');
    expect(text).toContain("(editable)");
  });

  it("omits the id/role/name/editable adornments when they are absent", () => {
    const out = formatPointResult("Clicked", 3, 1, 2, {
      ok: true,
      element: { tag: "div" },
    }) as FormatResult;
    const text = out.content[0].text;
    expect(text).toBe("Clicked at (1, 2) on tab 3 — element: <div>");
    expect(text).not.toContain("role=");
    expect(text).not.toContain("(editable)");
  });

  it("returns isError with the miss reason when ok is false", () => {
    const out = formatPointResult("Typed", 5, 8, 9, {
      ok: false,
      error: "No element at point (8, 9)",
    }) as FormatResult;
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe(
      "Typed failed at (8, 9) on tab 5: No element at point (8, 9)"
    );
  });
});
