import {
  CLOSE_KICKED,
  CLOSE_PROTOCOL_ERROR,
  CLOSE_REPLACED,
  CLOSE_ROOM_FULL,
  MAX_CLIENTS_PER_ROOM,
  MAX_RELAY_FRAME_BYTES,
  isAllowedRelayUrl,
  parseRoomPath,
  relayEndpoint,
} from "../relay-protocol";
import {
  RoomView,
  formatClientId,
  onClientJoin,
  onClientLeave,
  onClientMessage,
  onHostJoin,
  onHostLeave,
  onHostMessage,
} from "../relay-room";

class FakeSocket {
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(readonly name: string) {}
  send(data: string) {
    if (this.closed) throw new Error("closed");
    this.sent.push(data);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  json() {
    return this.sent.map((s) => (s === "pong" ? s : JSON.parse(s)));
  }
}

class FakeRoom implements RoomView<FakeSocket> {
  hostList: FakeSocket[] = [];
  clientMap = new Map<string, FakeSocket>();
  host() {
    for (let i = this.hostList.length - 1; i >= 0; i--) {
      if (!this.hostList[i].closed) return this.hostList[i];
    }
    return undefined;
  }
  staleHosts() {
    const live = this.host();
    return this.hostList.filter((h) => h !== live && !h.closed);
  }
  isLiveHost(s: FakeSocket) {
    return this.host() === s;
  }
  clients() {
    return [...this.clientMap].map(([cid, socket]) => ({ cid, socket }));
  }
  client(cid: string) {
    return this.clientMap.get(cid);
  }
  addHost(s: FakeSocket) {
    this.hostList.push(s);
    onHostJoin(this, s);
  }
  removeHost(s: FakeSocket) {
    this.hostList = this.hostList.filter((h) => h !== s);
    onHostLeave(this);
  }
  addClient(cid: string, s: FakeSocket) {
    this.clientMap.set(cid, s);
    const ok = onClientJoin(this, cid, s);
    if (!ok) this.clientMap.delete(cid);
    return ok;
  }
  removeClient(cid: string) {
    this.clientMap.delete(cid);
    onClientLeave(this, cid);
  }
}

describe("relay room routing", () => {
  it("tells a client the host is offline, then online when a host joins", () => {
    const room = new FakeRoom();
    const c = new FakeSocket("c");
    room.addClient("c1", c);
    expect(c.json()).toEqual([{ t: "host", online: false }]);

    const h = new FakeSocket("h");
    room.addHost(h);
    expect(c.json()).toEqual([
      { t: "host", online: false },
      { t: "host", online: true },
    ]);
    expect(h.json()).toEqual([{ t: "open", cid: "c1" }]);
  });

  it("routes msg frames both ways with the client id", () => {
    const room = new FakeRoom();
    const h = new FakeSocket("h");
    room.addHost(h);
    const c = new FakeSocket("c");
    room.addClient("c1", c);
    expect(h.json()).toEqual([{ t: "open", cid: "c1" }]);
    expect(c.json()).toEqual([{ t: "host", online: true }]);

    onClientMessage(room, "c1", c, JSON.stringify({ t: "msg", d: "hello" }));
    expect(h.json()[1]).toEqual({ t: "msg", cid: "c1", d: "hello" });

    onHostMessage(room, h, JSON.stringify({ t: "msg", cid: "c1", d: "back" }));
    expect(c.json()[1]).toEqual({ t: "msg", d: "back" });
  });

  it("answers a host message for an unknown client with closed", () => {
    const room = new FakeRoom();
    const h = new FakeSocket("h");
    room.addHost(h);
    onHostMessage(room, h, JSON.stringify({ t: "msg", cid: "gone", d: "x" }));
    expect(h.json()).toEqual([{ t: "closed", cid: "gone" }]);
  });

  it("drops client messages while no host is present", () => {
    const room = new FakeRoom();
    const c = new FakeSocket("c");
    room.addClient("c1", c);
    onClientMessage(room, "c1", c, JSON.stringify({ t: "msg", d: "x" }));
    expect(c.json()).toEqual([{ t: "host", online: false }]);
  });

  it("replaces an older host and ignores its late frames", () => {
    const room = new FakeRoom();
    const c = new FakeSocket("c");
    room.addClient("c1", c);
    const h1 = new FakeSocket("h1");
    room.addHost(h1);
    const h2 = new FakeSocket("h2");
    room.addHost(h2);
    expect(h1.closed?.code).toBe(CLOSE_REPLACED);
    expect(h2.json()).toEqual([{ t: "open", cid: "c1" }]);

    onHostMessage(room, h1, JSON.stringify({ t: "msg", cid: "c1", d: "late" }));
    expect(c.json().filter((f: any) => f.t === "msg")).toEqual([]);

    // The replaced host leaving must not announce the room offline.
    room.removeHost(h1);
    expect(c.json().filter((f: any) => f.online === false)).toEqual([
      { t: "host", online: false },
    ]);
  });

  it("announces offline when the live host leaves", () => {
    const room = new FakeRoom();
    const h = new FakeSocket("h");
    room.addHost(h);
    const c = new FakeSocket("c");
    room.addClient("c1", c);
    h.closed = { code: 1006, reason: "" };
    room.removeHost(h);
    expect(c.json().pop()).toEqual({ t: "host", online: false });
  });

  it("tells the host when a client leaves", () => {
    const room = new FakeRoom();
    const h = new FakeSocket("h");
    room.addHost(h);
    const c = new FakeSocket("c");
    room.addClient("c1", c);
    room.removeClient("c1");
    expect(h.json().pop()).toEqual({ t: "closed", cid: "c1" });
  });

  it("lets the host kick a client", () => {
    const room = new FakeRoom();
    const h = new FakeSocket("h");
    room.addHost(h);
    const c = new FakeSocket("c");
    room.addClient("c1", c);
    onHostMessage(room, h, JSON.stringify({ t: "kick", cid: "c1", reason: "rotated" }));
    expect(c.closed).toEqual({ code: CLOSE_KICKED, reason: "rotated" });
  });

  it("refuses clients beyond the room limit", () => {
    const room = new FakeRoom();
    for (let i = 0; i < MAX_CLIENTS_PER_ROOM; i++) {
      expect(room.addClient(`c${i}`, new FakeSocket(`c${i}`))).toBe(true);
    }
    const extra = new FakeSocket("extra");
    expect(room.addClient("extra", extra)).toBe(false);
    expect(extra.closed?.code).toBe(CLOSE_ROOM_FULL);
  });

  it("answers ping with pong on both legs without routing", () => {
    const room = new FakeRoom();
    const h = new FakeSocket("h");
    room.addHost(h);
    const c = new FakeSocket("c");
    room.addClient("c1", c);
    onClientMessage(room, "c1", c, "ping");
    onHostMessage(room, h, "ping");
    expect(c.sent.pop()).toBe("pong");
    expect(h.sent.pop()).toBe("pong");
    expect(h.json()).toEqual([{ t: "open", cid: "c1" }]);
  });

  it("ignores malformed and unknown frames", () => {
    const room = new FakeRoom();
    const h = new FakeSocket("h");
    room.addHost(h);
    const c = new FakeSocket("c");
    room.addClient("c1", c);
    onClientMessage(room, "c1", c, "{nope");
    onClientMessage(room, "c1", c, JSON.stringify({ t: "future", d: 1 }));
    onHostMessage(room, h, JSON.stringify({ t: "future", cid: "c1" }));
    onHostMessage(room, h, "[]");
    expect(h.json()).toEqual([{ t: "open", cid: "c1" }]);
    expect(c.json()).toEqual([{ t: "host", online: true }]);
    expect(h.closed).toBeNull();
    expect(c.closed).toBeNull();
  });

  it("closes a sender whose frame exceeds the size cap", () => {
    const room = new FakeRoom();
    const c = new FakeSocket("c");
    room.addClient("c1", c);
    onClientMessage(room, "c1", c, "x".repeat(MAX_RELAY_FRAME_BYTES + 1));
    expect(c.closed?.code).toBe(CLOSE_PROTOCOL_ERROR);
  });

  it("formats client ids as 16 hex chars", () => {
    expect(formatClientId(new Uint8Array([0, 1, 2, 255, 16, 32, 64, 128, 9]))).toBe(
      "000102ff10204080"
    );
  });
});

describe("relay paths and URLs", () => {
  const room = "A".repeat(32);

  it("parses room paths and rejects bad room ids", () => {
    expect(parseRoomPath(`/v1/rooms/${room}/host`)).toEqual({ roomId: room, role: "host" });
    expect(parseRoomPath(`/v1/rooms/${room}/client/`)).toEqual({ roomId: room, role: "client" });
    expect(parseRoomPath(`/v1/rooms/short/host`)).toBeNull();
    expect(parseRoomPath(`/v1/rooms/${room}/admin`)).toBeNull();
    expect(parseRoomPath(`/v1/rooms/${"a".repeat(30)}%2F/host`)).toBeNull();
    expect(parseRoomPath(`/v2/rooms/${room}/host`)).toBeNull();
  });

  it("builds endpoints from https, wss and prefixed bases", () => {
    expect(relayEndpoint("https://relay.example.com", room, "host")).toBe(
      `wss://relay.example.com/v1/rooms/${room}/host`
    );
    expect(relayEndpoint("wss://relay.example.com/", room, "client")).toBe(
      `wss://relay.example.com/v1/rooms/${room}/client`
    );
    expect(relayEndpoint("ws://127.0.0.1:8787/foxpilot/", room, "client")).toBe(
      `ws://127.0.0.1:8787/foxpilot/v1/rooms/${room}/client`
    );
    expect(() => relayEndpoint("ftp://x", room, "host")).toThrow();
  });

  it("allows wss anywhere but plain ws only on private networks", () => {
    expect(isAllowedRelayUrl("wss://foxpilot-relay.example.workers.dev")).toBe(true);
    expect(isAllowedRelayUrl("https://relay.example.com")).toBe(true);
    expect(isAllowedRelayUrl("ws://127.0.0.1:8787")).toBe(true);
    expect(isAllowedRelayUrl("ws://localhost:8787")).toBe(true);
    expect(isAllowedRelayUrl("ws://[::1]:8787")).toBe(true);
    expect(isAllowedRelayUrl("ws://192.168.1.20:8787")).toBe(true);
    expect(isAllowedRelayUrl("ws://100.101.102.103:8787")).toBe(true);
    expect(isAllowedRelayUrl("ws://my-box.tail1234.ts.net:8787")).toBe(true);
    expect(isAllowedRelayUrl("ws://relay.example.com")).toBe(false);
    expect(isAllowedRelayUrl("ws://8.8.8.8")).toBe(false);
    expect(isAllowedRelayUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedRelayUrl("not a url")).toBe(false);
  });
});
