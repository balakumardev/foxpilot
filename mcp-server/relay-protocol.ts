/**
 * Wire protocol of the FoxPilot relay (remote link).
 *
 * The relay pairs two kinds of WebSocket by room id and forwards opaque
 * strings between them:
 *
 *   - the HOST: the local broker that owns the browser connection
 *     (`/v1/rooms/<roomId>/host`, at most one live; the newest wins), and
 *   - CLIENTS: remote MCP servers that want to drive that browser
 *     (`/v1/rooms/<roomId>/client`, many).
 *
 * Everything the relay forwards (`d`) is end-to-end encrypted by
 * `link-crypto.ts`; the relay never sees the link token, the keys or a
 * plaintext frame. The room id is derived from the token with HKDF, so knowing
 * it does not reveal the token.
 *
 * This module must stay free of Node built-ins: the Cloudflare Worker relay
 * (`relay-worker/`) imports it alongside `relay-room.ts`.
 */

export const RELAY_PROTOCOL_VERSION = 1;

/** The hosted relay every link uses unless the token or env names another. */
export const DEFAULT_RELAY_URL = "wss://foxpilot-relay.ghostwriter-api.workers.dev";

/** Room ids are base64url; anything else is refused before it reaches a room. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** Most remote sessions one room (one link token) may hold at once. */
export const MAX_CLIENTS_PER_ROOM = 16;

/**
 * Largest single relay frame either relay accepts. The secure channel splits
 * every message into parts of at most LINK_CHUNK_CHARS, so a legitimate frame
 * is far below this; the cap only bounds what a misbehaving peer can make the
 * relay buffer.
 */
export const MAX_RELAY_FRAME_BYTES = 4 * 1024 * 1024;

/** Keepalive text both legs send; the relay answers with RELAY_PONG. */
export const RELAY_PING = "ping";
export const RELAY_PONG = "pong";

/** Close codes the relay uses (4000-4999 is the application range). */
export const CLOSE_REPLACED = 4000;
export const CLOSE_KICKED = 4001;
export const CLOSE_ROOM_FULL = 4002;
export const CLOSE_PROTOCOL_ERROR = 4003;

export type RelayRole = "host" | "client";

// ---- host <-> relay ----

/** relay -> host: a client joined (or was already waiting when the host joined). */
export interface RelayOpenFrame {
  t: "open";
  cid: string;
}

/** relay -> host: a client sent `d`. host -> relay: deliver `d` to client `cid`. */
export interface RelayHostMsgFrame {
  t: "msg";
  cid: string;
  d: string;
}

/** relay -> host: client `cid` went away. */
export interface RelayClosedFrame {
  t: "closed";
  cid: string;
}

/** host -> relay: close client `cid` (CLOSE_KICKED). */
export interface RelayKickFrame {
  t: "kick";
  cid: string;
  reason?: string;
}

export type RelayToHostFrame = RelayOpenFrame | RelayHostMsgFrame | RelayClosedFrame;
export type HostToRelayFrame = RelayHostMsgFrame | RelayKickFrame;

// ---- client <-> relay ----

/** relay -> client: whether a host is in the room right now. */
export interface RelayHostStatusFrame {
  t: "host";
  online: boolean;
}

/** client <-> relay: one opaque message. */
export interface RelayClientMsgFrame {
  t: "msg";
  d: string;
}

export type RelayToClientFrame = RelayHostStatusFrame | RelayClientMsgFrame;
export type ClientToRelayFrame = RelayClientMsgFrame;

/** Paths of the relay's HTTP surface. */
export function hostPath(roomId: string): string {
  return `/v1/rooms/${roomId}/host`;
}

export function clientPath(roomId: string): string {
  return `/v1/rooms/${roomId}/client`;
}

export const HEALTH_PATH = "/v1/health";

/**
 * Parses `/v1/rooms/<roomId>/<role>`. Returns null for any other path or a
 * room id that fails ROOM_ID_RE, so a caller can answer 404 without ever
 * touching a room.
 */
export function parseRoomPath(
  pathname: string
): { roomId: string; role: RelayRole } | null {
  const m = /^\/v1\/rooms\/([^/]+)\/(host|client)\/?$/.exec(pathname);
  if (!m || !ROOM_ID_RE.test(m[1])) {
    return null;
  }
  return { roomId: m[1], role: m[2] as RelayRole };
}

/**
 * The URL a host or client dials, from the relay's base URL. Accepts ws(s)://
 * and http(s)://, keeps any path prefix the base carries (a self-hosted relay
 * behind a reverse proxy at /foxpilot), and drops a trailing slash.
 */
export function relayEndpoint(
  relayUrl: string,
  roomId: string,
  role: RelayRole
): string {
  const url = new URL(relayUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error(`Unsupported relay URL scheme: ${relayUrl}`);
  }
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname =
    prefix + (role === "host" ? hostPath(roomId) : clientPath(roomId));
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * True when a relay URL is acceptable: wss:// anywhere, ws:// only for a
 * loopback or private-network host (a self-hosted relay on the LAN or behind an
 * SSH/Tailscale tunnel). Plain ws:// over the internet would still be
 * end-to-end encrypted, but it leaks the room id to every hop.
 */
export function isAllowedRelayUrl(relayUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return false;
  }
  if (url.protocol === "wss:" || url.protocol === "https:") {
    return true;
  }
  if (url.protocol !== "ws:" && url.protocol !== "http:") {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || // CGNAT / Tailscale
    host.endsWith(".ts.net") ||
    host.endsWith(".local")
  );
}

/** JSON.parse that returns null instead of throwing, for untrusted frames. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
