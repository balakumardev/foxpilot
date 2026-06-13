import WebSocket from "ws";
import { SidecarServer } from "../server";
import { MockInputBackend } from "../input-backend";
import * as crypto from "crypto";

const SECRET = "test-secret";
const sign = (p: string) => crypto.createHmac("sha256", SECRET).update(p).digest("hex");
const open = (ws: WebSocket) => new Promise<void>((r) => ws.on("open", () => r()));

describe("SidecarServer", () => {
  let backend: MockInputBackend;
  let server: SidecarServer;
  let port: number;

  beforeEach(async () => {
    backend = new MockInputBackend();
    server = new SidecarServer({ port: 0, host: "127.0.0.1", secret: SECRET, backend });
    await server.listen();
    port = server.getPort();
  });
  afterEach(async () => { await server.close(); });

  it("executes a signed move-click and replies ok", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sidecar`);
    await open(ws);
    const reqPayload = { id: "g1", gesture: { kind: "move-click", waypoints: [{ x: 5, y: 6, delayMs: 1 }] } };
    const got = new Promise<any>((res) => ws.on("message", (d) => res(JSON.parse(d.toString()))));
    ws.send(JSON.stringify({ payload: reqPayload, signature: sign(JSON.stringify(reqPayload)) }));
    const reply = await got;
    expect(reply.payload).toEqual(expect.objectContaining({ id: "g1", ok: true }));
    expect(backend.calls.some((c) => c.kind === "click")).toBe(true);
    ws.close();
  });

  it("rejects an unsigned frame", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sidecar`);
    await open(ws);
    const reqPayload = { id: "g2", gesture: { kind: "probe" } };
    const got = new Promise<any>((res) => ws.on("message", (d) => res(JSON.parse(d.toString()))));
    ws.send(JSON.stringify({ payload: reqPayload, signature: "bad" }));
    const reply = await got;
    expect(reply.payload.ok).toBe(false);
    ws.close();
  });
});
