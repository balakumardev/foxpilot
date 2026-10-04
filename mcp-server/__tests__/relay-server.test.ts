import WebSocket from "ws";
import * as http from "http";
import { RelayServer } from "../relay-server";
import { CLOSE_KICKED, CLOSE_REPLACED } from "../relay-protocol";

const ROOM = "relayservertestroom_0123456789AB";

/**
 * Opens a socket with its recorder attached BEFORE the handshake completes:
 * the relay's first frame can arrive in the same packet as the 101 response,
 * and ws emits it synchronously right after "open".
 */
function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    recorders.set(ws, recorder(ws));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

const recorders = new Map<WebSocket, ReturnType<typeof recorder>>();
function rec(ws: WebSocket) {
  return recorders.get(ws)!;
}

/** Collects every text frame a socket receives, parsed. */
function recorder(ws: WebSocket) {
  const frames: any[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (data) => {
    const raw = data.toString();
    frames.push(raw === "pong" ? raw : JSON.parse(raw));
    waiters.splice(0).forEach((w) => w());
  });
  return {
    frames,
    async until(pred: (f: any[]) => boolean, ms = 2000) {
      const deadline = Date.now() + ms;
      while (!pred(frames)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out; frames=${JSON.stringify(frames)}`);
        }
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
  };
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

describe("RelayServer", () => {
  let relay: RelayServer;
  let base: string;

  beforeEach(async () => {
    relay = new RelayServer({ port: 0 });
    await relay.listen();
    base = `ws://127.0.0.1:${relay.getPort()}`;
  });

  afterEach(async () => {
    await relay.close();
  });

  it("serves health", async () => {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${relay.getPort()}/v1/health`, (res) => {
          let s = "";
          res.on("data", (c) => (s += c));
          res.on("end", () => resolve(s));
        })
        .on("error", reject);
    });
    expect(JSON.parse(body)).toEqual({ ok: true, service: "foxpilot-relay", protocol: 1 });
  });

  it("refuses upgrades on unknown paths", async () => {
    await expect(open(`${base}/v1/rooms/x/host`)).rejects.toThrow(/404/);
    await expect(open(`${base}/whatever`)).rejects.toThrow(/404/);
  });

  it("pairs a host and a client and forwards both ways", async () => {
    const host = await open(`${base}/v1/rooms/${ROOM}/host`);
    const hostRec = rec(host);
    const client = await open(`${base}/v1/rooms/${ROOM}/client`);
    const clientRec = rec(client);

    await clientRec.until((f) => f.length >= 1);
    expect(clientRec.frames[0]).toEqual({ t: "host", online: true });
    await hostRec.until((f) => f.length >= 1);
    const cid = hostRec.frames[0].cid;
    expect(hostRec.frames[0]).toEqual({ t: "open", cid });

    client.send(JSON.stringify({ t: "msg", d: "up" }));
    await hostRec.until((f) => f.some((x) => x.t === "msg"));
    expect(hostRec.frames.find((x) => x.t === "msg")).toEqual({ t: "msg", cid, d: "up" });

    host.send(JSON.stringify({ t: "msg", cid, d: "down" }));
    await clientRec.until((f) => f.some((x) => x.t === "msg"));
    expect(clientRec.frames.find((x) => x.t === "msg")).toEqual({ t: "msg", d: "down" });

    client.send("ping");
    await clientRec.until((f) => f.includes("pong"));

    const closed = hostRec.until((f) => f.some((x) => x.t === "closed"));
    client.close();
    await closed;
    expect(relay.stats().clients).toBe(0);
    host.close();
  });

  it("keeps a waiting client across a host coming and going", async () => {
    const client = await open(`${base}/v1/rooms/${ROOM}/client`);
    const clientRec = rec(client);
    await clientRec.until((f) => f.length >= 1);
    expect(clientRec.frames[0]).toEqual({ t: "host", online: false });

    const host = await open(`${base}/v1/rooms/${ROOM}/host`);
    const hostRec = rec(host);
    await clientRec.until((f) => f.some((x) => x.online === true));
    await hostRec.until((f) => f.some((x) => x.t === "open"));

    host.close();
    await clientRec.until((f) => f.filter((x) => x.online === false).length === 2);
    client.close();
  });

  it("replaces the older host and kicks on request", async () => {
    const h1 = await open(`${base}/v1/rooms/${ROOM}/host`);
    const h1Closed = closeCode(h1);
    const h2 = await open(`${base}/v1/rooms/${ROOM}/host`);
    expect(await h1Closed).toBe(CLOSE_REPLACED);

    const h2Rec = rec(h2);
    const client = await open(`${base}/v1/rooms/${ROOM}/client`);
    const clientClosed = closeCode(client);
    await h2Rec.until((f) => f.some((x) => x.t === "open"));
    const cid = h2Rec.frames.find((x) => x.t === "open").cid;
    h2.send(JSON.stringify({ t: "kick", cid, reason: "revoked" }));
    expect(await clientClosed).toBe(CLOSE_KICKED);
    h2.close();
  });
});
