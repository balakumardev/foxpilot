/**
 * End-to-end secure channel of the FoxPilot remote link.
 *
 * A remote MCP server (the CLIENT) drives the browser behind a local broker
 * (the HOST) through a relay that only forwards opaque strings by room id
 * (`relay-protocol.ts`, `relay-room.ts`). The relay is UNTRUSTED: everything in
 * this file exists so that it can never read, forge, replay, reorder or splice
 * what it carries. The only shared root of trust is the 32-byte secret inside
 * the link token the user copies from one machine to the other.
 *
 *   - Token:    `fpl1.<base64url secret>[.<base64url relay URL>]`.
 *   - Room id:  HKDF(secret, "room"). One-way, so the relay (which sees it in
 *               every URL) learns nothing about the secret.
 *   - Handshake: fresh X25519 ephemerals on both sides, every frame MACed with
 *               HKDF(secret, "auth"). The MACs bind each frame to everything
 *               said before it, so a relay cannot mix frames from two sessions
 *               or downgrade a field. Ephemerals give forward secrecy: a token
 *               leaked tomorrow does not decrypt a recording of today.
 *   - Data:     AES-256-GCM, one key per direction, the nonce IS the message
 *               sequence number. Replays, drops and reorders all surface as a
 *               seq mismatch or an auth failure, and the channel then refuses
 *               to continue rather than guess.
 *
 * Node built-ins only (`crypto`); unlike relay-protocol.ts this never runs in
 * the Cloudflare Worker, which must stay blind to all of it.
 */

import * as crypto from "crypto";
import { ROOM_ID_RE, isAllowedRelayUrl, parseJsonObject } from "./relay-protocol";

export const LINK_TOKEN_PREFIX = "fpl1";
export const LINK_PROTOCOL_VERSION = 1;
/** Max chars of ciphertext per data frame part; keeps every relay frame far below MAX_RELAY_FRAME_BYTES. */
export const LINK_CHUNK_CHARS = 256 * 1024;
/** Max parts per message: bounds what a peer can make the receiver buffer (~48 MB of plaintext). */
export const LINK_MAX_PARTS = 256;
export const LINK_LABEL_MAX = 64;

const SECRET_BYTES = 32;
const NONCE_BYTES = 16;
const NONCE_CHARS = 22; // base64url of 16 bytes, unpadded
const KEY_CHARS = 43; // base64url of 32 bytes, unpadded
const MAC_CHARS = 43; // base64url of an HMAC-SHA256
const VERSION_MAX = 32;
const REJECT_REASON_MAX = 200;
/**
 * Upper bound on a handshake frame before it is JSON-parsed. A legitimate
 * hello is a few hundred chars even with a maximal (multi-byte) label; the cap
 * stops a peer from making the host parse megabytes before the MAC check.
 */
const MAX_HANDSHAKE_FRAME_CHARS = 4096;

const KDF_SALT = Buffer.from("foxpilot-link-v1");
const SESSION_INFO = "foxpilot-link-v1 session";
const MAC_DOMAIN = "foxpilot-link";

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const DATA_FRAME_RE = /^D(\d+)\.(\d+)\.(\d+)\.([A-Za-z0-9_-]*)$/;

/**
 * Anything a peer (or the relay pretending to be one) sent that breaks the
 * protocol. Callers treat it as "drop this session", never as "retry the frame".
 */
export class LinkProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkProtocolError";
  }
}

export interface LinkToken {
  secret: Buffer;
  relayUrl?: string;
}

// ---- small helpers ----

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/**
 * Decodes base64url and insists the text was the canonical encoding of the
 * result. Node's decoder silently ignores stray trailing bits and a dangling
 * char, so without the round-trip check two different strings could stand for
 * the same bytes, which is a needless malleability for anything a MAC covers.
 */
function decodeCanonical(text: string, expectedBytes?: number): Buffer | null {
  if (!B64URL_RE.test(text)) {
    return null;
  }
  const bytes = Buffer.from(text, "base64url");
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    return null;
  }
  return b64url(bytes) === text ? bytes : null;
}

function hkdf(ikm: Buffer, salt: Buffer, info: string, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

function authKey(secret: Buffer): Buffer {
  return hkdf(secret, KDF_SALT, "auth", 32);
}

/** MAC over JSON.stringify of an array: unambiguous field boundaries for free. */
function mac(key: Buffer, fields: Array<string | number>): string {
  return crypto
    .createHmac("sha256", key)
    .update(JSON.stringify([MAC_DOMAIN, ...fields]))
    .digest("base64url");
}

function macEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Cut to `max` code points, so a surrogate pair is never split in half. */
function cutCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length > max ? points.slice(0, max).join("") : text;
}

function assertSecret(secret: Buffer): void {
  if (!Buffer.isBuffer(secret) || secret.length !== SECRET_BYTES) {
    throw new Error(`FoxPilot link secret must be exactly ${SECRET_BYTES} bytes`);
  }
}

// ---- token ----

export function generateLinkSecret(): Buffer {
  return crypto.randomBytes(SECRET_BYTES);
}

export function formatLinkToken(secret: Buffer, relayUrl?: string): string {
  assertSecret(secret);
  const parts = [LINK_TOKEN_PREFIX, b64url(secret)];
  if (relayUrl !== undefined) {
    parts.push(b64url(Buffer.from(relayUrl, "utf8")));
  }
  return parts.join(".");
}

/**
 * Parses a pasted link token. Error messages describe WHAT is wrong but never
 * echo the token or any part of it: they end up in logs and chat transcripts,
 * and the token is the whole key.
 */
export function parseLinkToken(token: string): LinkToken {
  const fail = (why: string): never => {
    throw new Error(`Invalid FoxPilot link token: ${why}`);
  };
  if (typeof token !== "string") {
    return fail("expected a string");
  }
  let text = token.trim();
  // People paste the token with the quotes from a shell line or a JSON config.
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text);
  if (quoted && text.length >= 2) {
    text = quoted[2].trim();
  }
  if (text.length === 0) {
    return fail("it is empty");
  }
  const parts = text.split(".");
  if (parts[0] !== LINK_TOKEN_PREFIX) {
    return fail(`it must start with "${LINK_TOKEN_PREFIX}."`);
  }
  if (parts.length < 2 || parts.length > 3) {
    return fail(
      `expected 2 or 3 dot-separated parts, got ${parts.length} (was it truncated or joined with other text?)`
    );
  }
  if (!B64URL_RE.test(parts[1])) {
    return fail("the secret part is not base64url");
  }
  const secret = Buffer.from(parts[1], "base64url");
  if (secret.length !== SECRET_BYTES) {
    return fail(
      `the secret must decode to ${SECRET_BYTES} bytes, got ${secret.length} (was it truncated?)`
    );
  }
  if (parts.length === 2) {
    return { secret };
  }
  if (!B64URL_RE.test(parts[2])) {
    return fail("the relay URL part is not base64url");
  }
  const relayUrl = Buffer.from(parts[2], "base64url").toString("utf8");
  if (!isAllowedRelayUrl(relayUrl)) {
    return fail(
      "the relay URL it names is not allowed (wss:// anywhere, ws:// only on loopback or a private network)"
    );
  }
  return { secret, relayUrl };
}

// ---- derived values ----

/** The relay room id: one-way from the secret, so publishing it is harmless. */
export function deriveRoomId(secret: Buffer): string {
  assertSecret(secret);
  const roomId = b64url(hkdf(secret, KDF_SALT, "room", 24));
  if (!ROOM_ID_RE.test(roomId)) {
    // 24 bytes are always 32 base64url chars; this guards a future edit.
    throw new Error("derived room id does not satisfy ROOM_ID_RE");
  }
  return roomId;
}

/**
 * Cleans the client's self-chosen label (shown to the user on the host side).
 * Whitespace of any kind becomes a plain space BEFORE control chars are
 * dropped, so "a\nb" reads "a b" instead of "ab". Idempotent, which verifyHello
 * relies on: a label is valid only if it is already its own sanitized form.
 */
export function sanitizeLabel(label: string): string {
  const cleaned = String(label)
    .replace(/\s/gu, " ")
    .replace(/\p{C}/gu, "")
    .replace(/ +/g, " ")
    .trim();
  return cutCodePoints(cleaned, LINK_LABEL_MAX).trim() || "remote";
}

export function sanitizeVersion(version: string): string {
  return (
    String(version)
      .replace(/[^0-9A-Za-z.+_-]/g, "")
      .slice(0, VERSION_MAX) || "unknown"
  );
}

function sanitizeReason(reason: string): string {
  const cleaned = String(reason)
    .replace(/\s/gu, " ")
    .replace(/\p{C}/gu, "")
    .replace(/ +/g, " ")
    .trim();
  return cutCodePoints(cleaned, REJECT_REASON_MAX).trim() || "rejected";
}

// ---- frames ----

export function isHandshakeFrame(frame: string): boolean {
  return typeof frame === "string" && frame.startsWith("H");
}

export function isDataFrame(frame: string): boolean {
  return typeof frame === "string" && frame.startsWith("D");
}

function parseHandshake(frame: string): Record<string, unknown> | null {
  if (!isHandshakeFrame(frame) || frame.length > MAX_HANDSHAKE_FRAME_CHARS) {
    return null;
  }
  return parseJsonObject(frame.slice(1));
}

function importPeerKey(x: string): crypto.KeyObject | null {
  try {
    return crypto.createPublicKey({
      key: { kty: "OKP", crv: "X25519", x },
      format: "jwk",
    });
  } catch {
    return null;
  }
}

function exportPublicKey(key: crypto.KeyObject): string {
  const x = key.export({ format: "jwk" }).x;
  if (typeof x !== "string" || x.length !== KEY_CHARS) {
    throw new Error("unexpected X25519 public key export");
  }
  return x;
}

/**
 * Both directions' keys from the DH result, the token secret and both nonces.
 * Mixing the secret into the IKM means a relay that somehow swapped in its own
 * ephemeral (impossible without the auth key, but defense in depth) still could
 * not compute the keys; the nonces make every session's keys distinct even if
 * an ephemeral were ever reused.
 */
function deriveSessionKeys(
  myPrivate: crypto.KeyObject,
  peerPublic: crypto.KeyObject,
  secret: Buffer,
  clientNonce: Buffer,
  hostNonce: Buffer
): { c2h: Buffer; h2c: Buffer } {
  let shared: Buffer;
  try {
    shared = crypto.diffieHellman({ privateKey: myPrivate, publicKey: peerPublic });
  } catch {
    throw new LinkProtocolError("link handshake failed: invalid peer key");
  }
  // A low-order peer point yields an all-zero secret that an attacker can predict.
  if (shared.every((b) => b === 0)) {
    throw new LinkProtocolError("link handshake failed: invalid peer key");
  }
  const keys = hkdf(
    Buffer.concat([shared, secret]),
    Buffer.concat([clientNonce, hostNonce]),
    SESSION_INFO,
    64
  );
  return { c2h: keys.subarray(0, 32), h2c: keys.subarray(32, 64) };
}

// ---- data channel ----

/**
 * One established session's data channel. Messages are sealed in order with a
 * per-direction counter used as the GCM nonce, so the counter both prevents
 * nonce reuse and authenticates the order: a frame opened at the wrong seq
 * simply fails to decrypt even if its header were rewritten.
 *
 * The part header (`idx`/`count`) is not authenticated, and does not need to
 * be: the parts are concatenated before decryption, so any reordering changes
 * the ciphertext and fails the tag, and a re-split that preserves the bytes
 * preserves the plaintext.
 */
export class SecureChannel {
  private readonly sendKey: Buffer;
  private readonly recvKey: Buffer;
  private sendSeq = 0;
  private recvSeq = 0;
  private parts: string[] = [];
  private partCount = 0;
  private dead = false;

  constructor(sendKey: Buffer, recvKey: Buffer) {
    if (
      !Buffer.isBuffer(sendKey) ||
      !Buffer.isBuffer(recvKey) ||
      sendKey.length !== 32 ||
      recvKey.length !== 32
    ) {
      throw new Error("SecureChannel keys must be 32-byte Buffers");
    }
    // Copies, so a caller zeroing or reusing its buffer cannot affect us.
    this.sendKey = Buffer.from(sendKey);
    this.recvKey = Buffer.from(recvKey);
  }

  seal(plaintext: string): string[] {
    this.assertAlive();
    if (this.sendSeq >= Number.MAX_SAFE_INTEGER) {
      throw this.fail("link channel sequence exhausted");
    }
    const bytes = Buffer.from(plaintext, "utf8");
    const cipherChars = Math.ceil(((bytes.length + 16) * 8) / 6);
    const count = Math.max(1, Math.ceil(cipherChars / LINK_CHUNK_CHARS));
    if (count > LINK_MAX_PARTS) {
      // Not a protocol error: nothing was sent and the seq is not consumed.
      throw new Error(
        `link message too large: ${count} parts exceeds the ${LINK_MAX_PARTS}-part limit`
      );
    }
    const seq = this.sendSeq;
    const cipher = crypto.createCipheriv("aes-256-gcm", this.sendKey, nonceFor(seq));
    const text = b64url(
      Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
    );
    this.sendSeq += 1;
    const frames: string[] = [];
    for (let idx = 0; idx < count; idx++) {
      const part = text.slice(idx * LINK_CHUNK_CHARS, (idx + 1) * LINK_CHUNK_CHARS);
      frames.push(`D${seq}.${idx}.${count}.${part}`);
    }
    return frames;
  }

  /**
   * Feeds one received frame. Returns the plaintext when it completes a
   * message, null while parts are still missing. Any deviation from the exact
   * expected stream kills the channel: after a gap or a forgery there is no
   * safe state to resume from.
   */
  open(frame: string): string | null {
    this.assertAlive();
    const m = typeof frame === "string" ? DATA_FRAME_RE.exec(frame) : null;
    if (!m) {
      throw this.fail("malformed link data frame");
    }
    const [, seqText, idxText, countText, part] = m;
    if (seqText !== String(this.recvSeq)) {
      throw this.fail("link data frame out of sequence (replayed, dropped or reordered)");
    }
    const idx = canonicalInt(idxText);
    const count = canonicalInt(countText);
    if (count === null || count < 1 || count > LINK_MAX_PARTS) {
      throw this.fail("link data frame has an invalid part count");
    }
    if (idx === null || idx !== this.parts.length) {
      throw this.fail("link data frame part out of order");
    }
    if (this.parts.length > 0 && count !== this.partCount) {
      throw this.fail("link data frame part count changed mid-message");
    }
    if (idx >= count || part.length > LINK_CHUNK_CHARS) {
      throw this.fail("link data frame part out of range");
    }
    this.parts.push(part);
    this.partCount = count;
    if (this.parts.length < count) {
      return null;
    }
    const text = this.parts.join("");
    this.parts = [];
    this.partCount = 0;
    const data = decodeCanonical(text);
    if (!data || data.length < 16) {
      throw this.fail("link data frame failed authentication");
    }
    let plaintext: Buffer;
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.recvKey,
        nonceFor(this.recvSeq)
      );
      decipher.setAuthTag(data.subarray(data.length - 16));
      plaintext = Buffer.concat([
        decipher.update(data.subarray(0, data.length - 16)),
        decipher.final(),
      ]);
    } catch {
      throw this.fail("link data frame failed authentication");
    }
    this.recvSeq += 1;
    return plaintext.toString("utf8");
  }

  private assertAlive(): void {
    if (this.dead) {
      throw new LinkProtocolError("link channel closed after a protocol error");
    }
  }

  private fail(message: string): LinkProtocolError {
    this.dead = true;
    this.parts = [];
    return new LinkProtocolError(message);
  }
}

/** 12-byte GCM nonce: 4 zero bytes, then the seq as uint64 big-endian. */
function nonceFor(seq: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

/** A decimal without leading zeros that fits a safe integer, else null. */
function canonicalInt(text: string): number | null {
  const n = Number(text);
  return Number.isSafeInteger(n) && String(n) === text ? n : null;
}

// ---- handshake: client ----

export interface HandshakeInfo {
  label: string;
  version: string;
}

export type ClientHandshakeResult =
  | { kind: "established"; channel: SecureChannel; peerVersion: string }
  | { kind: "rejected"; reason: string };

/**
 * The client side of one handshake attempt. Single use: once finish() has
 * settled (or failed), a new attempt needs a new instance and so fresh
 * ephemerals.
 */
export class ClientHandshake {
  private readonly secret: Buffer;
  private readonly key: Buffer;
  private readonly label: string;
  private readonly version: string;
  private readonly nonce: Buffer;
  private readonly nonceText: string;
  private readonly privateKey: crypto.KeyObject;
  private readonly ephemeral: string;
  private readonly helloFrame: string;
  private settled = false;

  constructor(secret: Buffer, info: HandshakeInfo) {
    assertSecret(secret);
    this.secret = Buffer.from(secret);
    this.key = authKey(this.secret);
    this.label = sanitizeLabel(info.label);
    this.version = sanitizeVersion(info.version);
    this.nonce = crypto.randomBytes(NONCE_BYTES);
    this.nonceText = b64url(this.nonce);
    const pair = crypto.generateKeyPairSync("x25519");
    this.privateKey = pair.privateKey;
    this.ephemeral = exportPublicKey(pair.publicKey);
    const m = mac(this.key, [
      "hello",
      LINK_PROTOCOL_VERSION,
      this.nonceText,
      this.ephemeral,
      this.label,
      this.version,
    ]);
    this.helloFrame =
      "H" +
      JSON.stringify({
        t: "hello",
        v: LINK_PROTOCOL_VERSION,
        n: this.nonceText,
        e: this.ephemeral,
        l: this.label,
        fv: this.version,
        m,
      });
  }

  hello(): string {
    return this.helloFrame;
  }

  finish(frame: string): ClientHandshakeResult {
    if (this.settled) {
      throw new LinkProtocolError("link handshake already finished");
    }
    this.settled = true;
    const msg = parseHandshake(frame);
    if (!msg) {
      throw new LinkProtocolError("malformed link handshake frame");
    }
    if (msg.v !== LINK_PROTOCOL_VERSION) {
      throw new LinkProtocolError(
        `unsupported link protocol version from host (expected ${LINK_PROTOCOL_VERSION})`
      );
    }
    if (msg.t === "welcome") {
      return this.finishWelcome(msg);
    }
    if (msg.t === "reject") {
      return this.finishReject(msg);
    }
    throw new LinkProtocolError("unexpected link handshake frame");
  }

  private finishWelcome(msg: Record<string, unknown>): ClientHandshakeResult {
    const { n, e, fv, m } = msg;
    if (
      typeof n !== "string" ||
      typeof e !== "string" ||
      typeof fv !== "string" ||
      typeof m !== "string"
    ) {
      throw new LinkProtocolError("malformed link welcome");
    }
    const hostNonce = n.length === NONCE_CHARS ? decodeCanonical(n, NONCE_BYTES) : null;
    if (
      !hostNonce ||
      e.length !== KEY_CHARS ||
      !decodeCanonical(e, 32) ||
      fv !== sanitizeVersion(fv) ||
      m.length !== MAC_CHARS
    ) {
      throw new LinkProtocolError("malformed link welcome");
    }
    const expected = mac(this.key, [
      "welcome",
      LINK_PROTOCOL_VERSION,
      this.nonceText,
      this.ephemeral,
      this.label,
      this.version,
      n,
      e,
      fv,
    ]);
    if (!macEqual(m, expected)) {
      throw new LinkProtocolError("link welcome failed authentication (wrong link token?)");
    }
    const peer = importPeerKey(e);
    if (!peer) {
      throw new LinkProtocolError("link handshake failed: invalid peer key");
    }
    const { c2h, h2c } = deriveSessionKeys(
      this.privateKey,
      peer,
      this.secret,
      this.nonce,
      hostNonce
    );
    return { kind: "established", channel: new SecureChannel(c2h, h2c), peerVersion: fv };
  }

  private finishReject(msg: Record<string, unknown>): ClientHandshakeResult {
    const { reason, m } = msg;
    if (
      typeof reason !== "string" ||
      typeof m !== "string" ||
      m.length !== MAC_CHARS ||
      Array.from(reason).length > REJECT_REASON_MAX
    ) {
      throw new LinkProtocolError("malformed link reject");
    }
    const expected = mac(this.key, [
      "reject",
      LINK_PROTOCOL_VERSION,
      this.nonceText,
      this.ephemeral,
      reason,
    ]);
    if (!macEqual(m, expected)) {
      throw new LinkProtocolError("link reject failed authentication (wrong link token?)");
    }
    return { kind: "rejected", reason };
  }
}

// ---- handshake: host ----

export interface VerifiedHello {
  nonce: string;
  ephemeral: string;
  label: string;
  version: string;
}

export type HelloCheck = { ok: true; hello: VerifiedHello } | { ok: false; reason: string };

/**
 * Checks a client's hello. Never throws: the host feeds it whatever the relay
 * delivered and answers a failure by dropping the client silently. It never
 * replies with a reject to an unverified hello, since that would hand an
 * unauthenticated party a MACed frame of its choosing.
 */
export function verifyHello(secret: Buffer, frame: string): HelloCheck {
  try {
    assertSecret(secret);
    const msg = parseHandshake(frame);
    if (!msg || msg.t !== "hello") {
      return { ok: false, reason: "malformed hello" };
    }
    if (msg.v !== LINK_PROTOCOL_VERSION) {
      return {
        ok: false,
        reason: `unsupported link protocol version (expected ${LINK_PROTOCOL_VERSION})`,
      };
    }
    const { n, e, l, fv, m } = msg;
    if (
      typeof n !== "string" ||
      typeof e !== "string" ||
      typeof l !== "string" ||
      typeof fv !== "string" ||
      typeof m !== "string"
    ) {
      return { ok: false, reason: "malformed hello" };
    }
    if (
      n.length !== NONCE_CHARS ||
      !decodeCanonical(n, NONCE_BYTES) ||
      e.length !== KEY_CHARS ||
      !decodeCanonical(e, 32) ||
      l !== sanitizeLabel(l) ||
      fv !== sanitizeVersion(fv) ||
      m.length !== MAC_CHARS
    ) {
      return { ok: false, reason: "malformed hello" };
    }
    const expected = mac(authKey(secret), ["hello", LINK_PROTOCOL_VERSION, n, e, l, fv]);
    if (!macEqual(m, expected)) {
      return { ok: false, reason: "hello failed authentication (wrong link token?)" };
    }
    if (!importPeerKey(e)) {
      return { ok: false, reason: "hello carries an invalid key" };
    }
    return { ok: true, hello: { nonce: n, ephemeral: e, label: l, version: fv } };
  } catch {
    return { ok: false, reason: "malformed hello" };
  }
}

/**
 * Answers a verified hello: generates the host ephemeral, derives the session
 * keys and returns the welcome frame plus the host's end of the channel.
 * Throws LinkProtocolError if the client's key is degenerate.
 */
export function buildWelcome(
  secret: Buffer,
  hello: VerifiedHello,
  info: { version: string }
): { welcome: string; channel: SecureChannel } {
  assertSecret(secret);
  const clientNonce = decodeCanonical(hello.nonce, NONCE_BYTES);
  const peer = importPeerKey(hello.ephemeral);
  if (!clientNonce || !peer) {
    throw new LinkProtocolError("link handshake failed: invalid hello");
  }
  const version = sanitizeVersion(info.version);
  const hostNonce = crypto.randomBytes(NONCE_BYTES);
  const n = b64url(hostNonce);
  const pair = crypto.generateKeyPairSync("x25519");
  const e = exportPublicKey(pair.publicKey);
  const { c2h, h2c } = deriveSessionKeys(pair.privateKey, peer, secret, clientNonce, hostNonce);
  const m = mac(authKey(secret), [
    "welcome",
    LINK_PROTOCOL_VERSION,
    hello.nonce,
    hello.ephemeral,
    hello.label,
    hello.version,
    n,
    e,
    version,
  ]);
  const welcome =
    "H" + JSON.stringify({ t: "welcome", v: LINK_PROTOCOL_VERSION, n, e, fv: version, m });
  return { welcome, channel: new SecureChannel(h2c, c2h) };
}

/** Refuses a verified hello with a reason the client can show its user. */
export function buildReject(secret: Buffer, hello: VerifiedHello, reason: string): string {
  assertSecret(secret);
  const clean = sanitizeReason(reason);
  const m = mac(authKey(secret), [
    "reject",
    LINK_PROTOCOL_VERSION,
    hello.nonce,
    hello.ephemeral,
    clean,
  ]);
  return "H" + JSON.stringify({ t: "reject", v: LINK_PROTOCOL_VERSION, reason: clean, m });
}
