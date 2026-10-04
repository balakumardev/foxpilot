import { describe, it, expect } from "vitest";
import {
  DurableRoomView,
  type DurableWebSocket,
  type SocketAttachment,
} from "../src/view";
import {
  CLOSE_KICKED,
  CLOSE_REPLACED,
  CLOSE_ROOM_FULL,
} from "../../mcp-server/relay-protocol";
import {
  onClientJoin,
  onClientLeave,
  onClientMessage,
  onHostJoin,
  onHostLeave,
  onHostMessage,
} from "../../mcp-server/relay-room";

class FakeSocket implements DurableWebSocket {
  readyState = 1;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  tags: string[] = [];
  attachment: SocketAttachment | null = null;

  constructor(tags: string[] = [], attachment: SocketAttachment | null = null) {
    this.tags = tags;
    this.attachment = attachment;
  }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error("Socket is not open");
    }
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.readyState = 3;
    this.closed = { code, reason };
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  serializeAttachment(meta: SocketAttachment): void {
    this.attachment = meta;
  }
}

describe("view.ts DurableRoomView", () => {
  it("selects live host by greatest (at, sid)", () => {
    const s1 = new FakeSocket(["host"], { role: "host", sid: "sid-1", at: 100 });
    const s2 = new FakeSocket(["host"], { role: "host", sid: "sid-2", at: 200 });
    const s3 = new FakeSocket(["host"], { role: "host", sid: "sid-0", at: 200 });

    const all = [s1, s2, s3];
    const getSockets = (tag?: string) =>
      tag ? all.filter((s) => s.tags.includes(tag)) : all;

    const view = new DurableRoomView(getSockets);
    // s2 and s3 have same at (200), s2 has sid "sid-2" > s3 "sid-0"
    expect(view.host()).toBe(s2);
  });

  it("ignores closed and excluded sockets when selecting live host", () => {
    const s1 = new FakeSocket(["host"], { role: "host", sid: "sid-1", at: 100 });
    const s2 = new FakeSocket(["host"], { role: "host", sid: "sid-2", at: 200 });
    s2.readyState = 3; // closed

    const all = [s1, s2];
    const getSockets = (tag?: string) =>
      tag ? all.filter((s) => s.tags.includes(tag)) : all;

    const view = new DurableRoomView(getSockets);
    expect(view.host()).toBe(s1);

    // If s1 is excluded, no host
    const viewExcluded = new DurableRoomView(getSockets, s1);
    expect(viewExcluded.host()).toBeUndefined();
  });

  it("returns staleHosts excluding the live host", () => {
    const s1 = new FakeSocket(["host"], { role: "host", sid: "sid-1", at: 100 });
    const s2 = new FakeSocket(["host"], { role: "host", sid: "sid-2", at: 200 });
    const s3 = new FakeSocket(["host"], { role: "host", sid: "sid-3", at: 300 });

    const all = [s1, s2, s3];
    const getSockets = (tag?: string) =>
      tag ? all.filter((s) => s.tags.includes(tag)) : all;

    const view = new DurableRoomView(getSockets);
    expect(view.host()).toBe(s3);
    expect(view.staleHosts()).toEqual([s1, s2]);
  });

  it("isLiveHost compares sid and works with different object for same socket", () => {
    const live = new FakeSocket(["host"], { role: "host", sid: "sid-live", at: 100 });
    const other = new FakeSocket(["host"], { role: "host", sid: "sid-old", at: 50 });

    const all = [live, other];
    const getSockets = (tag?: string) =>
      tag ? all.filter((s) => s.tags.includes(tag)) : all;

    const view = new DurableRoomView(getSockets);
    expect(view.isLiveHost(live)).toBe(true);
    expect(view.isLiveHost(other)).toBe(false);

    // Reconstructed instance with the same attachment sid (hibernation simulation)
    const reconstituted = new FakeSocket(["host"], {
      role: "host",
      sid: "sid-live",
      at: 100,
    });
    expect(view.isLiveHost(reconstituted)).toBe(true);
  });

  it("handles socket exclusion by identity and by sid", () => {
    const client = new FakeSocket(["client", "cid:c1"], {
      role: "client",
      cid: "c1",
      sid: "sid-c1",
      at: 100,
    });
    const clientClone = new FakeSocket(["client", "cid:c1"], {
      role: "client",
      cid: "c1",
      sid: "sid-c1",
      at: 100,
    });

    const all = [client];
    const getSockets = (tag?: string) =>
      tag ? all.filter((s) => s.tags.includes(tag)) : all;

    // Excluded by clone's sid
    const view = new DurableRoomView(getSockets, clientClone);
    expect(view.client("c1")).toBeUndefined();
    expect(view.clients()).toEqual([]);
  });

  it("looks up client by cid and returns all open clients", () => {
    const c1 = new FakeSocket(["client", "cid:c1"], {
      role: "client",
      cid: "c1",
      sid: "sid-c1",
      at: 100,
    });
    const c2 = new FakeSocket(["client", "cid:c2"], {
      role: "client",
      cid: "c2",
      sid: "sid-c2",
      at: 200,
    });
    const c3 = new FakeSocket(["client", "cid:c3"], {
      role: "client",
      cid: "c3",
      sid: "sid-c3",
      at: 300,
    });
    c3.readyState = 3; // closed

    const all = [c1, c2, c3];
    const getSockets = (tag?: string) =>
      tag ? all.filter((s) => s.tags.includes(tag)) : all;

    const view = new DurableRoomView(getSockets);
    expect(view.client("c1")).toBe(c1);
    expect(view.client("c2")).toBe(c2);
    expect(view.client("c3")).toBeUndefined();
    expect(view.client("unknown")).toBeUndefined();

    expect(view.clients()).toEqual([
      { cid: "c1", socket: c1 },
      { cid: "c2", socket: c2 },
    ]);
  });
});

describe("relay-room routing through DurableRoomView", () => {
  it("routes bidirectional messages between host and client", () => {
    const sockets: FakeSocket[] = [];
    const getSockets = (tag?: string) =>
      tag ? sockets.filter((s) => s.tags.includes(tag)) : sockets;

    // 1. Client joins waiting
    const client = new FakeSocket(["client", "cid:c1"], {
      role: "client",
      cid: "c1",
      sid: "sid-c1",
      at: 100,
    });
    sockets.push(client);
    const view1 = new DurableRoomView(getSockets);
    expect(onClientJoin(view1, "c1", client)).toBe(true);
    expect(client.sent).toEqual([JSON.stringify({ t: "host", online: false })]);

    // 2. Host joins
    const host = new FakeSocket(["host"], {
      role: "host",
      sid: "sid-h1",
      at: 200,
    });
    sockets.push(host);
    const view2 = new DurableRoomView(getSockets);
    onHostJoin(view2, host);
    expect(host.sent).toEqual([JSON.stringify({ t: "open", cid: "c1" })]);
    expect(client.sent).toContain(JSON.stringify({ t: "host", online: true }));

    // 3. Client sends msg -> Host receives
    onClientMessage(
      view2,
      "c1",
      client,
      JSON.stringify({ t: "msg", d: "hello-from-client" })
    );
    expect(host.sent).toContain(
      JSON.stringify({ t: "msg", cid: "c1", d: "hello-from-client" })
    );

    // 4. Host sends msg -> Client receives
    onHostMessage(
      view2,
      host,
      JSON.stringify({ t: "msg", cid: "c1", d: "hello-from-host" })
    );
    expect(client.sent).toContain(
      JSON.stringify({ t: "msg", d: "hello-from-host" })
    );
  });

  it("handles host replacement and closes older host with 4000", () => {
    const sockets: FakeSocket[] = [];
    const getSockets = (tag?: string) =>
      tag ? sockets.filter((s) => s.tags.includes(tag)) : sockets;

    const client = new FakeSocket(["client", "cid:c1"], {
      role: "client",
      cid: "c1",
      sid: "sid-c1",
      at: 100,
    });
    sockets.push(client);

    const h1 = new FakeSocket(["host"], { role: "host", sid: "sid-h1", at: 200 });
    sockets.push(h1);
    onHostJoin(new DurableRoomView(getSockets), h1);

    const h2 = new FakeSocket(["host"], { role: "host", sid: "sid-h2", at: 300 });
    sockets.push(h2);
    onHostJoin(new DurableRoomView(getSockets), h2);

    expect(h1.closed).toEqual({
      code: CLOSE_REPLACED,
      reason: "replaced by a newer host connection",
    });
    expect(h2.sent).toEqual([JSON.stringify({ t: "open", cid: "c1" })]);
  });

  it("notifies clients with host online:false when live host leaves", () => {
    const sockets: FakeSocket[] = [];
    const getSockets = (tag?: string) =>
      tag ? sockets.filter((s) => s.tags.includes(tag)) : sockets;

    const client = new FakeSocket(["client", "cid:c1"], {
      role: "client",
      cid: "c1",
      sid: "sid-c1",
      at: 100,
    });
    sockets.push(client);

    const host = new FakeSocket(["host"], { role: "host", sid: "sid-h1", at: 200 });
    sockets.push(host);
    onHostJoin(new DurableRoomView(getSockets), host);

    // Host disconnects
    const leavingView = new DurableRoomView(getSockets, host);
    onHostLeave(leavingView);
    expect(client.sent[client.sent.length - 1]).toBe(
      JSON.stringify({ t: "host", online: false })
    );
  });

  it("kicks client with 4001 when requested by host", () => {
    const sockets: FakeSocket[] = [];
    const getSockets = (tag?: string) =>
      tag ? sockets.filter((s) => s.tags.includes(tag)) : sockets;

    const client = new FakeSocket(["client", "cid:c1"], {
      role: "client",
      cid: "c1",
      sid: "sid-c1",
      at: 100,
    });
    sockets.push(client);

    const host = new FakeSocket(["host"], { role: "host", sid: "sid-h1", at: 200 });
    sockets.push(host);
    const view = new DurableRoomView(getSockets);
    onHostJoin(view, host);

    onHostMessage(
      view,
      host,
      JSON.stringify({ t: "kick", cid: "c1", reason: "session terminated" })
    );
    expect(client.closed).toEqual({
      code: CLOSE_KICKED,
      reason: "session terminated",
    });
  });

  it("rejects 17th client with 4002 when room is full", () => {
    const sockets: FakeSocket[] = [];
    const getSockets = (tag?: string) =>
      tag ? sockets.filter((s) => s.tags.includes(tag)) : sockets;

    const host = new FakeSocket(["host"], { role: "host", sid: "sid-h", at: 10 });
    sockets.push(host);

    // Join 16 clients (MAX_CLIENTS_PER_ROOM = 16)
    for (let i = 1; i <= 16; i++) {
      const cid = `c${i}`;
      const c = new FakeSocket(["client", `cid:${cid}`], {
        role: "client",
        cid,
        sid: `sid-${cid}`,
        at: 100 + i,
      });
      sockets.push(c);
      const view = new DurableRoomView(getSockets);
      const ok = onClientJoin(view, cid, c);
      expect(ok).toBe(true);
      expect(c.closed).toBeNull();
    }

    // 17th client joins
    const c17 = new FakeSocket(["client", "cid:c17"], {
      role: "client",
      cid: "c17",
      sid: "sid-c17",
      at: 200,
    });
    sockets.push(c17);
    const view17 = new DurableRoomView(getSockets);
    const ok17 = onClientJoin(view17, "c17", c17);

    expect(ok17).toBe(false);
    expect(c17.closed).toEqual({
      code: CLOSE_ROOM_FULL,
      reason: "too many remote sessions on this link",
    });
  });
});
