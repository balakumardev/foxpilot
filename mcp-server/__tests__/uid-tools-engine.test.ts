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

// --- Schema mirror tests (kept in sync with server.ts) ---------------------
// The five uid tools that gained engine:"synthetic"|"cdp" in Wave 2 C15. The
// engine field is an optional enum on each — this mirrors the shared shape.
const engineField = z.enum(["synthetic", "cdp"]).optional();

const uidToolSchemas = {
  "click-element": z.object({
    tabId: z.number(),
    uid: z.string(),
    doubleClick: z.boolean().optional(),
    failIfIntercepted: z.boolean().optional(),
    engine: engineField,
  }),
  "hover-element": z.object({ tabId: z.number(), uid: z.string(), engine: engineField }),
  "fill-element": z.object({
    tabId: z.number(),
    uid: z.string(),
    value: z.string(),
    engine: engineField,
  }),
  "fill-form": z.object({
    tabId: z.number(),
    fields: z.array(z.object({ uid: z.string(), value: z.string() })),
    engine: engineField,
  }),
  "press-key": z.object({
    tabId: z.number(),
    key: z.string(),
    modifiers: z.array(z.enum(["ctrl", "shift", "alt", "meta"])).optional(),
    engine: engineField,
  }),
} as const;

// A minimal valid payload for each tool (no engine) — used to exercise the
// default-undefined and invalid-rejection branches uniformly.
const baseArgs: Record<keyof typeof uidToolSchemas, Record<string, unknown>> = {
  "click-element": { tabId: 1, uid: "e1" },
  "hover-element": { tabId: 1, uid: "e1" },
  "fill-element": { tabId: 1, uid: "e1", value: "x" },
  "fill-form": { tabId: 1, fields: [{ uid: "e1", value: "x" }] },
  "press-key": { tabId: 1, key: "Enter" },
};

describe("uid tools — engine schema (Wave 2 C15)", () => {
  (Object.keys(uidToolSchemas) as (keyof typeof uidToolSchemas)[]).forEach(
    (tool) => {
      const schema = uidToolSchemas[tool];
      const base = baseArgs[tool];

      it(`${tool}: accepts engine:"cdp" and engine:"synthetic"`, () => {
        expect(schema.safeParse({ ...base, engine: "cdp" }).success).toBe(true);
        expect(
          schema.safeParse({ ...base, engine: "synthetic" }).success
        ).toBe(true);
      });

      it(`${tool}: engine is optional (default undefined) — back-compat`, () => {
        const parsed = schema.safeParse(base);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect((parsed.data as { engine?: unknown }).engine).toBeUndefined();
        }
      });

      it(`${tool}: rejects an invalid engine value`, () => {
        expect(
          schema.safeParse({ ...base, engine: "native" }).success
        ).toBe(false);
        expect(schema.safeParse({ ...base, engine: 1 }).success).toBe(false);
      });
    }
  );
});

// --- Wire-forwarding tests -------------------------------------------------
// Prove browser-api actually puts `engine` on the outgoing frame for the uid
// tools (mirrors coordinate-tools.test.ts's click-at engine forwarding test).
const SECRET = "uid-engine-secret";

function startMockExtension(
  port: number,
  onReq: (req: ServerMessageRequest) => void
): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    ws.on("open", () => {
      const hello = {
        type: "hello",
        browserId: "uid-ext",
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
      onReq(env.payload as ServerMessageRequest);
      // All uid tools reply with a uniform action-result; ok:true so the
      // BrowserAPI wrappers that throw on ok:false resolve normally.
      const payload = {
        resource: "action-result",
        correlationId: env.payload.correlationId,
        ok: true,
      };
      ws.send(
        JSON.stringify({
          payload,
          signature: createSignature(SECRET, JSON.stringify(payload)),
        })
      );
    });
  });
}

describe("BrowserAPI uid tools forward engine over the broker", () => {
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

  it("clickElement forwards engine:'cdp' on the frame", async () => {
    await api.clickElement(2, "e1", undefined, undefined, undefined, "cdp");
    expect((lastReq as any).cmd).toBe("click-element");
    expect((lastReq as any).engine).toBe("cdp");
  });

  it("hoverElement forwards engine:'cdp' on the frame", async () => {
    await api.hoverElement(2, "e1", undefined, "cdp");
    expect((lastReq as any).cmd).toBe("hover-element");
    expect((lastReq as any).engine).toBe("cdp");
  });

  it("fillElement forwards engine:'cdp' on the frame", async () => {
    await api.fillElement(2, "e1", "v", undefined, "cdp");
    expect((lastReq as any).cmd).toBe("fill-element");
    expect((lastReq as any).engine).toBe("cdp");
  });

  it("fillForm forwards engine:'cdp' on the frame", async () => {
    await api.fillForm(2, [{ uid: "e1", value: "v" }], undefined, "cdp");
    expect((lastReq as any).cmd).toBe("fill-form");
    expect((lastReq as any).engine).toBe("cdp");
  });

  it("pressKey forwards engine:'cdp' on the frame", async () => {
    await api.pressKey(2, "Enter", undefined, undefined, "cdp");
    expect((lastReq as any).cmd).toBe("press-key");
    expect((lastReq as any).engine).toBe("cdp");
  });

  it("omitting engine leaves it undefined on the frame (back-compat)", async () => {
    await api.clickElement(2, "e1");
    expect((lastReq as any).cmd).toBe("click-element");
    expect((lastReq as any).engine).toBeUndefined();
  });
});
