/**
 * The relay's per-room routing, independent of any socket library.
 *
 * Both relays drive it: the Node relay (`relay-server.ts`, `ws` sockets in a
 * Map) and the Cloudflare Worker (`relay-worker/`, hibernatable Durable Object
 * sockets that it re-reads from `ctx.getWebSockets()` on every wake). That is
 * why every handler takes a {@link RoomView} instead of owning state: a
 * hibernated Durable Object loses its memory, so the room's state has to be
 * whatever sockets are still attached.
 *
 * Contract for a view: a socket that has joined is visible through the view
 * BEFORE its join handler runs (so a joining host IS the live host when
 * `onHostJoin` runs), and a host that is leaving is no longer returned by
 * `host()` once it has closed.
 *
 * Must stay free of Node built-ins (imported by the Worker).
 */

import {
  CLOSE_KICKED,
  CLOSE_PROTOCOL_ERROR,
  CLOSE_REPLACED,
  CLOSE_ROOM_FULL,
  MAX_CLIENTS_PER_ROOM,
  MAX_RELAY_FRAME_BYTES,
  RELAY_PING,
  RELAY_PONG,
  parseJsonObject,
} from "./relay-protocol";

/** The two socket operations the room needs. */
export interface RelaySocket {
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface RoomView<S extends RelaySocket> {
  /** The live host: the most recent host to join that is still open. */
  host(): S | undefined;
  /** Open host sockets OTHER than the live one (older hosts being replaced). */
  staleHosts(): S[];
  /**
   * Whether `socket` is the live host. A method rather than `host() === socket`
   * because a hibernating Durable Object is not guaranteed to hand back the
   * same JS object for the same socket; the Worker compares attachment ids.
   */
  isLiveHost(socket: S): boolean;
  /** Every attached client with its relay-assigned id. */
  clients(): Array<{ cid: string; socket: S }>;
  /** The client with this id, if attached. */
  client(cid: string): S | undefined;
}

function safeSend(socket: RelaySocket, data: string): void {
  try {
    socket.send(data);
  } catch {
    // A socket that died between lookup and send is reaped by its own close.
  }
}

function safeClose(socket: RelaySocket, code: number, reason: string): void {
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {
    /* already closing */
  }
}

/** A relay-assigned client id: 16 hex chars from 8 random bytes. */
export function formatClientId(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes.slice(0, 8)) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * A host joined. It replaces any older host (a laptop waking from sleep often
 * reconnects before the relay notices the old socket is dead), learns about
 * every client already waiting, and those clients learn a host is back.
 */
export function onHostJoin<S extends RelaySocket>(room: RoomView<S>, host: S): void {
  for (const other of room.staleHosts()) {
    safeClose(other, CLOSE_REPLACED, "replaced by a newer host connection");
  }
  const online = JSON.stringify({ t: "host", online: true });
  for (const { cid, socket } of room.clients()) {
    safeSend(host, JSON.stringify({ t: "open", cid }));
    safeSend(socket, online);
  }
}

/**
 * A host left. Clients stay connected and are told the host is offline; they
 * hear `online:true` when a host joins again.
 */
export function onHostLeave<S extends RelaySocket>(room: RoomView<S>): void {
  if (room.host()) {
    return; // a newer host already took over
  }
  const offline = JSON.stringify({ t: "host", online: false });
  for (const { socket } of room.clients()) {
    safeSend(socket, offline);
  }
}

/**
 * A client joined. Returns false (and closes it) when the room is full. The
 * client always hears the host's current status first.
 */
export function onClientJoin<S extends RelaySocket>(
  room: RoomView<S>,
  cid: string,
  socket: S
): boolean {
  if (room.clients().length > MAX_CLIENTS_PER_ROOM) {
    safeClose(socket, CLOSE_ROOM_FULL, "too many remote sessions on this link");
    return false;
  }
  const host = room.host();
  safeSend(socket, JSON.stringify({ t: "host", online: !!host }));
  if (host) {
    safeSend(host, JSON.stringify({ t: "open", cid }));
  }
  return true;
}

/** A client left; the host (if any) forgets it. */
export function onClientLeave<S extends RelaySocket>(room: RoomView<S>, cid: string): void {
  const host = room.host();
  if (host) {
    safeSend(host, JSON.stringify({ t: "closed", cid }));
  }
}

/** True when the frame is the keepalive (answered here, never routed). */
function answerPing(socket: RelaySocket, raw: string): boolean {
  if (raw === RELAY_PING) {
    safeSend(socket, RELAY_PONG);
    return true;
  }
  return false;
}

function oversized(socket: RelaySocket, raw: string): boolean {
  // UTF-16 length is a lower bound of the UTF-8 size; frames are base64/JSON
  // (ASCII) in practice, so the two agree.
  if (raw.length > MAX_RELAY_FRAME_BYTES) {
    safeClose(socket, CLOSE_PROTOCOL_ERROR, "frame too large");
    return true;
  }
  return false;
}

/**
 * A text frame from a host. `msg` is delivered to its client (or answered with
 * `closed` when that client is gone), `kick` closes a client. Frames from a
 * host that has been replaced are dropped. Malformed and unknown frames are
 * ignored, so a newer host can add frame types without breaking older relays.
 */
export function onHostMessage<S extends RelaySocket>(
  room: RoomView<S>,
  host: S,
  raw: string
): void {
  if (answerPing(host, raw) || oversized(host, raw)) {
    return;
  }
  if (!room.isLiveHost(host)) {
    return;
  }
  const frame = parseJsonObject(raw);
  if (!frame || typeof frame.cid !== "string") {
    return;
  }
  if (frame.t === "msg" && typeof frame.d === "string") {
    const client = room.client(frame.cid);
    if (client) {
      safeSend(client, JSON.stringify({ t: "msg", d: frame.d }));
    } else {
      safeSend(host, JSON.stringify({ t: "closed", cid: frame.cid }));
    }
    return;
  }
  if (frame.t === "kick") {
    const client = room.client(frame.cid);
    if (client) {
      const reason =
        typeof frame.reason === "string" ? frame.reason : "closed by the host";
      safeClose(client, CLOSE_KICKED, reason);
    }
  }
}

/**
 * A text frame from a client. `msg` goes to the live host; with no host it is
 * dropped (the client was told `online:false` and must wait for `online:true`
 * before it talks).
 */
export function onClientMessage<S extends RelaySocket>(
  room: RoomView<S>,
  cid: string,
  socket: S,
  raw: string
): void {
  if (answerPing(socket, raw) || oversized(socket, raw)) {
    return;
  }
  const frame = parseJsonObject(raw);
  if (!frame || frame.t !== "msg" || typeof frame.d !== "string") {
    return;
  }
  const host = room.host();
  if (host) {
    safeSend(host, JSON.stringify({ t: "msg", cid, d: frame.d }));
  }
}
