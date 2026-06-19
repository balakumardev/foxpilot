/**
 * The broker daemon's transport layer.
 *
 * A single long-lived process that owns the one connection to the browser
 * extension and accepts many MCP-client connections, routing between them via
 * {@link BrokerCore}.
 *
 * Connection roles are distinguished by URL path:
 *   - `/extension` — the Firefox extension (at most one; last connection wins)
 *   - `/mcp`       — an MCP-client session (many)
 *
 * Both legs are HMAC-signed. The extension leg reuses the existing wire format
 * (`{ payload, signature }` for responses; a raw unsigned object for errors),
 * so existing extension code interoperates unchanged.
 *
 * An HTTP server backs the same port; `/health` reports status and the
 * long-poll fallback transport (see `broker-longpoll.ts`) attaches to it.
 */

import { WebSocket, WebSocketServer } from "ws";
import * as http from "http";
import type {
  ExtensionError,
  ExtensionMessage,
  ServerMessageRequest,
} from "@foxpilot/common";
import { BrokerCore } from "./broker-core";
import {
  BrokerClientFrame,
  BrokerControlResult,
  BrokerServerFrame,
  BrowserInfo,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "./broker-protocol";
import type { HelloPayload } from "./broker-protocol";
import { createSignature, verifySignature } from "./signing";
import { getCommandTimeout } from "./timeouts";

const EXTENSION_ORIGIN_RE = /^(?:chrome|moz)-extension:\/\/([^/]+)\/?$/i;

/** Returns the extension id if `origin` is a browser-extension origin, else null. */
export function parseExtensionOrigin(origin: string | undefined): string | null {
  if (!origin) {
    return null;
  }
  const m = EXTENSION_ORIGIN_RE.exec(origin.trim());
  return m ? m[1] : null;
}

function isAllowedExtensionOrigin(
  origin: string | undefined,
  strictIds: string[] | undefined
): boolean {
  const id = parseExtensionOrigin(origin);
  if (id === null) {
    return false;
  }
  if (strictIds && strictIds.length > 0) {
    return strictIds.includes(id);
  }
  return true;
}

/**
 * True when the WebSocket handshake carried no usable Origin. Firefox sends
 * `Origin: null` (or omits it) on WebSockets opened from a background script —
 * it hides the per-install moz-extension UUID for privacy (bugzilla 1257989) —
 * so a Firefox extension cannot be origin-matched the way Chrome/Edge can.
 */
export function isNullOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") {
    return true;
  }
  return origin.trim().toLowerCase() === "null";
}

/** True for loopback peers (127.0.0.0/8 and ::1, including IPv4-mapped). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) {
    return false;
  }
  return (
    addr === "::1" ||
    addr.startsWith("127.") ||
    addr.startsWith("::ffff:127.")
  );
}

type HelloDecision =
  | {
      kind: "admit";
      browserId: string;
      type: "chrome" | "firefox";
      label: string;
      authMode: "signed" | "origin";
    }
  | { kind: "reject"; reason: string }
  | { kind: "ignore" };

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10 * 1000;

/** A connected browser extension and the transport it arrived on. */
interface ExtensionConn {
  browserId: string;
  ws: WebSocket | null;
  transport: "ws" | "longpoll";
  type: "chrome" | "firefox";
  label: string;
  /** How this connection authenticated; governs whether its frames are HMAC-signed. */
  authMode: "signed" | "origin";
  /** Timestamp of the last frame from this browser; informational (not yet consumed by routing or health). */
  lastSeen: number;
}

export interface BrokerServerOptions {
  port: number;
  host?: string;
  secret: string;
  /** Called once the broker has been idle (no clients, no extension) for idleTimeoutMs. */
  onIdle?: () => void;
  idleTimeoutMs?: number;
  /**
   * How long a freshly-accepted `/extension` socket may stay anonymous (no valid
   * signed hello) before the broker closes it. Bounds the unauthenticated
   * resource pin a silent peer could otherwise hold open. Defaults to
   * DEFAULT_HANDSHAKE_TIMEOUT_MS.
   */
  handshakeTimeoutMs?: number;
  /**
   * Optional allowlist of extension ids. When non-empty, only `/extension`
   * connections whose Origin id is in this list are admitted via the origin
   * path. Empty/undefined accepts any chrome-/moz-extension origin.
   */
  strictExtensionIds?: string[];
  /**
   * When true, origin-gating is disabled and ONLY a valid signed hello admits an
   * extension. Set for remote/CONTAINERIZED deployments where loopback + Origin
   * guarantees do not hold. Default false.
   */
  requireSignature?: boolean;
}

/** Distinguishes the extension's raw (unsigned) error frame from a signed response envelope. */
export function isExtensionErrorFrame(value: unknown): value is ExtensionError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ExtensionError).errorMessage === "string" &&
    typeof (value as ExtensionError).correlationId === "string"
  );
}

export class BrokerServer {
  private readonly host: string;
  private readonly port: number;
  private readonly secret: string;
  private readonly onIdle?: () => void;
  private readonly idleTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly strictExtensionIds: string[] | undefined;
  private readonly requireSignature: boolean;

  /**
   * One HTTP server per bind host. When `host` is `localhost` we bind BOTH
   * loopback families (`127.0.0.1` and `::1`) so a peer connecting to either
   * literal succeeds — macOS resolves `localhost` to `::1` only, which otherwise
   * left `127.0.0.1` clients with ECONNREFUSED. All servers share the same
   * `handleHttp` request handler and feed the single `noServer` WebSocketServer.
   */
  private readonly httpServers: http.Server[];
  private readonly wss: WebSocketServer;
  private readonly core: BrokerCore;

  private readonly extensions = new Map<string, ExtensionConn>();
  private activeBrowserId: string | null = null;
  private readonly clients = new Map<string, WebSocket>();
  private clientCounter = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Hook for the long-poll transport to register the current extension request sink. */
  private longPollSink: ((req: ServerMessageRequest) => boolean) | null = null;

  constructor(opts: BrokerServerOptions) {
    this.host = opts.host ?? "localhost";
    this.port = opts.port;
    this.secret = opts.secret;
    this.onIdle = opts.onIdle;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.handshakeTimeoutMs =
      opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.strictExtensionIds = opts.strictExtensionIds;
    this.requireSignature = opts.requireSignature ?? false;

    this.core = new BrokerCore({
      sendToExtension: (req) => this.sendToExtension(req),
      sendToClient: (clientId, frame) => this.sendToClient(clientId, frame),
      getTimeoutMs: getCommandTimeout,
    });

    // A single shared WebSocketServer in noServer mode; each per-host http.Server
    // hands accepted upgrades to it. This lets us listen on multiple loopback
    // addresses (see resolveBindHosts) while keeping one connection pipeline.
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));

    this.httpServers = this.resolveBindHosts().map(() => {
      const httpServer = http.createServer((req, res) =>
        this.handleHttp(req, res)
      );
      httpServer.on("upgrade", (req, socket, head) => {
        // Loopback enforcement, formerly done by the ws `verifyClient` hook.
        // Reject non-loopback peers before any WebSocket exists. Skipped under
        // requireSignature (remote/CONTAINERIZED), where the signed hello is the
        // gate instead. Read the peer address from req.socket (the upgrade
        // `socket` arg is typed as a bare Duplex and omits remoteAddress).
        if (
          !this.requireSignature &&
          !isLoopbackAddress(req.socket.remoteAddress)
        ) {
          try {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          } catch {
            /* ignore */
          }
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit("connection", ws, req);
        });
      });
      return httpServer;
    });
  }

  /**
   * The loopback addresses to bind. `localhost` expands to BOTH IPv4 and IPv6
   * loopback so connecting to either literal works regardless of how the OS
   * resolves `localhost` (macOS resolves it to `::1` only). An explicit host
   * (e.g. tests' `127.0.0.1`, or `0.0.0.0` under CONTAINERIZED) is bound as-is
   * — single-bind, behaviour unchanged.
   */
  private resolveBindHosts(): string[] {
    return this.host === "localhost" ? ["127.0.0.1", "::1"] : [this.host];
  }

  listen(): Promise<void> {
    const hosts = this.resolveBindHosts();
    const [first, ...rest] = this.httpServers;

    const listenOn = (server: http.Server, port: number, host: string) =>
      new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => reject(err);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });

    // Bind the first server on the requested port; with port 0 (tests) this
    // resolves an ephemeral port that the remaining servers then reuse so the
    // whole loopback set shares one port. 127.0.0.1 and ::1 can share a port
    // number (different address families) — expected, not a conflict.
    return listenOn(first, this.port, hosts[0])
      .then(() => {
        const addr = first.address();
        const resolvedPort =
          addr && typeof addr === "object" ? addr.port : this.port;
        return Promise.all(
          rest.map((server, i) => listenOn(server, resolvedPort, hosts[i + 1]))
        ).then(() => undefined);
      })
      .catch((err) => {
        // Partial-bind cleanup: tear down anything that did come up so a failed
        // listen leaves no half-open servers. Preserve the original error
        // (notably err.code === "EADDRINUSE") so broker-main's exit(0) race
        // handling still triggers.
        for (const server of this.httpServers) {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        }
        throw err;
      });
  }

  close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const ws of this.clients.values()) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    for (const conn of this.extensions.values()) {
      if (conn.ws) {
        try {
          conn.ws.terminate();
        } catch {
          /* ignore */
        }
      }
    }
    this.extensions.clear();
    this.wss.close();
    for (const server of this.httpServers) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** The resolved anonymous-socket handshake timeout (ms); useful for tests. */
  getHandshakeTimeoutMs(): number {
    return this.handshakeTimeoutMs;
  }

  /** The actually-bound port (useful when constructed with port 0 for tests). */
  getPort(): number {
    const addr = this.httpServers[0]?.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return this.port;
  }

  // ---- connection routing ----

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const path = (req.url ?? "/").split("?")[0];
    if (path.startsWith("/extension")) {
      this.onExtensionConnection(ws, req);
    } else {
      this.onClientConnection(ws);
    }
  }

  private onExtensionConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const origin = req.headers.origin;
    this.clearIdleTimer();
    let conn: ExtensionConn | null = null;

    // While the socket is anonymous (conn === null) it pins a file descriptor
    // and, because every connect calls clearIdleTimer(), suppresses idle
    // shutdown. A peer that connects and sends nothing must not hold that open
    // forever — reachable off-host under CONTAINERIZED — so bound the anonymous
    // window with a one-shot timer that terminates a still-anonymous socket.
    let handshakeTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => {
        handshakeTimer = null;
        if (conn === null) {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
        }
      },
      this.handshakeTimeoutMs
    );
    (handshakeTimer as { unref?: () => void }).unref?.();
    const clearHandshakeTimer = () => {
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
    };

    ws.on("message", (data) => {
      const raw = data.toString();
      if (!conn) {
        const decision = this.evaluateHello(raw, origin);
        if (decision.kind === "admit") {
          // Register without broadcasting so the welcome ack lands first; the
          // active-status broadcast (to this socket and any others) follows.
          conn = this.registerExtension(
            {
              browserId: decision.browserId,
              ws,
              transport: "ws",
              type: decision.type,
              label: decision.label,
              authMode: decision.authMode,
              lastSeen: Date.now(),
            },
            false
          );
          clearHandshakeTimer();
          this.sendWelcome(ws, decision.browserId);
          this.broadcastActiveStatus();
        } else if (decision.kind === "reject") {
          try {
            ws.send(JSON.stringify({ type: "rejected", reason: decision.reason }));
          } catch {
            /* ignore */
          }
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        } else {
          // Malformed/non-hello frame: close silently, leave the handshake timer
          // armed (the close handler clears it).
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      conn.lastSeen = Date.now();
      this.onExtensionMessage(raw, conn);
    });

    ws.on("close", () => {
      // A normally-closing anonymous socket must not leave a dangling timer.
      clearHandshakeTimer();
      if (conn) {
        this.removeExtension(conn.browserId, ws);
      }
      this.maybeScheduleIdle();
    });
    ws.on("error", () => {
      clearHandshakeTimer();
      /* close handler will run */
    });
  }

  /**
   * Decide how to handle the first frame on an anonymous /extension socket:
   *  - "admit" via a valid signed hello (legacy/secured path), or
   *  - "admit" via an allowed extension Origin (zero-config path), or
   *  - "reject" a structurally-valid hello that is neither (typed reason), or
   *  - "ignore" anything that is not a hello at all (caller closes silently).
   */
  private evaluateHello(raw: string, origin: string | undefined): HelloDecision {
    let decoded: { payload?: HelloPayload; signature?: string };
    try {
      decoded = JSON.parse(raw);
    } catch {
      return { kind: "ignore" };
    }
    const payload = decoded?.payload;
    if (
      !payload ||
      payload.type !== "hello" ||
      typeof payload.browserId !== "string"
    ) {
      return { kind: "ignore" };
    }
    const base = {
      browserId: payload.browserId,
      type: (payload.browserType === "firefox" ? "firefox" : "chrome") as
        | "chrome"
        | "firefox",
      label: payload.label || payload.browserType,
    };
    // Reject an explicitly-versioned hello whose protocol the broker can't speak
    // so a mismatched extension/server pair gets a readable "update both" error
    // instead of a silent never-admit. A legacy hello that omits the field is
    // still allowed through (it falls to the signed/origin checks below).
    if (
      typeof payload.protocolVersion === "number" &&
      (payload.protocolVersion < MIN_SUPPORTED_PROTOCOL_VERSION ||
        payload.protocolVersion > PROTOCOL_VERSION)
    ) {
      return { kind: "reject", reason: "protocol_version_unsupported" };
    }
    if (
      this.secret &&
      typeof decoded.signature === "string" &&
      verifySignature(this.secret, JSON.stringify(payload), decoded.signature)
    ) {
      return { kind: "admit", ...base, authMode: "signed" };
    }
    if (!this.requireSignature) {
      // Zero-config admission over loopback. The upgrade handler already
      // rejected non-loopback peers; CONTAINERIZED (the only exception) forces
      // requireSignature=true, so this branch never runs off-host.
      if (isAllowedExtensionOrigin(origin, this.strictExtensionIds)) {
        return { kind: "admit", ...base, authMode: "origin" };
      }
      // Firefox background-script WebSockets send `Origin: null` (see
      // isNullOrigin), so there is no extension origin to match — admit such a
      // hello when no strict allowlist is configured. Residual risk: a
      // sandboxed/null-origin local page over plain http could also present a
      // null Origin, so set FOXPILOT_STRICT_EXTENSION_IDS or an EXTENSION_SECRET
      // to harden a shared/multi-user machine.
      if (
        base.type === "firefox" &&
        isNullOrigin(origin) &&
        !(this.strictExtensionIds && this.strictExtensionIds.length > 0)
      ) {
        return { kind: "admit", ...base, authMode: "origin" };
      }
    }
    return { kind: "reject", reason: "origin_not_allowed" };
  }

  /** Send the unsigned admission ack with the current browser roster. */
  private sendWelcome(ws: WebSocket, browserId: string): void {
    const welcome = {
      type: "welcome",
      browserId,
      activeBrowserId: this.activeBrowserId,
      browsers: this.listBrowserInfo(),
    };
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(welcome));
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Register (or re-attach) a browser by browserId. A reconnect under the same
   * id replaces the stale socket without disturbing other browsers. Pushes the
   * active-status to every browser whenever the set changes.
   *
   * `broadcast` defaults to true. The WS admission flow passes false so it can
   * send the `welcome` ack as the FIRST frame the joining socket sees, then
   * broadcast active-status to everyone — otherwise the synchronous broadcast
   * here would beat the welcome onto the wire.
   */
  private registerExtension(
    conn: ExtensionConn,
    broadcast = true
  ): ExtensionConn {
    const prev = this.extensions.get(conn.browserId);
    if (prev && prev.ws && prev.ws !== conn.ws) {
      try {
        prev.ws.terminate();
      } catch {
        /* ignore */
      }
    }
    this.extensions.set(conn.browserId, conn);
    this.clearIdleTimer();
    if (broadcast) {
      this.broadcastActiveStatus();
    }
    return conn;
  }

  private removeExtension(browserId: string, ws: WebSocket): void {
    const conn = this.extensions.get(browserId);
    if (!conn || conn.ws !== ws) {
      return; // a newer socket already replaced this one
    }
    this.extensions.delete(browserId);
    if (this.activeBrowserId === browserId) {
      this.activeBrowserId = null;
    }
    this.core.onExtensionDisconnect();
    this.broadcastActiveStatus();
  }

  private onClientConnection(ws: WebSocket): void {
    const clientId = `c${++this.clientCounter}`;
    this.clients.set(clientId, ws);
    this.clearIdleTimer();

    ws.on("message", (data) => this.onClientMessage(clientId, data.toString()));
    ws.on("close", () => {
      this.clients.delete(clientId);
      this.core.onClientDisconnect(clientId);
      this.maybeScheduleIdle();
    });
    ws.on("error", () => {
      /* close handler will run */
    });
  }

  // ---- extension leg ----

  private onExtensionMessage(raw: string, conn?: ExtensionConn): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      console.error("Broker: unparseable extension message");
      return;
    }

    // A connection that authed by Origin carries no shared secret; its frames
    // are unsigned. Long-poll (no conn here) keeps the legacy signed contract.
    const signed = conn ? conn.authMode === "signed" : true;

    // Keepalive frame (chrome-extension/client.ts ping()). Nothing to do.
    if (
      decoded &&
      typeof decoded === "object" &&
      (decoded as { type?: unknown }).type === "ping"
    ) {
      return;
    }

    // Honest-status probe from the options page. Reply over the same socket with
    // a roster snapshot (unsigned — same leg).
    if (
      decoded &&
      typeof decoded === "object" &&
      (decoded as { type?: unknown }).type === "healthcheck"
    ) {
      if (conn?.ws && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(
            JSON.stringify({
              type: "healthcheck-result",
              extensionConnected: this.extensionConnected(),
              browsers: this.listBrowserInfo(),
              activeBrowserId: this.activeBrowserId,
            })
          );
        } catch {
          /* ignore */
        }
      }
      return;
    }

    // A long-poll hello arrives here (the WS leg registers in
    // onExtensionConnection before any message reaches this method).
    const maybeHello = decoded as { payload?: HelloPayload; signature?: string };
    if (
      maybeHello?.payload?.type === "hello" &&
      typeof maybeHello.signature === "string"
    ) {
      if (
        verifySignature(
          this.secret,
          JSON.stringify(maybeHello.payload),
          maybeHello.signature
        )
      ) {
        this.registerExtension({
          browserId: maybeHello.payload.browserId,
          ws: null,
          transport: "longpoll",
          type:
            maybeHello.payload.browserType === "firefox" ? "firefox" : "chrome",
          label: maybeHello.payload.label || maybeHello.payload.browserType,
          authMode: "signed",
          lastSeen: Date.now(),
        });
      }
      return;
    }

    // "Make this browser active" from the options page. Signature is required
    // only for signed connections; origin connections send it unsigned.
    const maybeSelect = decoded as {
      payload?: { type?: string; browserId?: string };
      signature?: string;
    };
    if (maybeSelect?.payload?.type === "select-active") {
      const sigOk = signed
        ? typeof maybeSelect.signature === "string" &&
          verifySignature(
            this.secret,
            JSON.stringify(maybeSelect.payload),
            maybeSelect.signature
          )
        : true;
      if (
        sigOk &&
        maybeSelect.payload.browserId &&
        this.extensions.has(maybeSelect.payload.browserId)
      ) {
        this.activeBrowserId = maybeSelect.payload.browserId;
        this.broadcastActiveStatus();
      }
      return;
    }

    // Error frames are sent raw (unsigned) in both modes.
    if (isExtensionErrorFrame(decoded)) {
      this.core.handleExtensionError(decoded);
      return;
    }

    const envelope = decoded as {
      payload?: ExtensionMessage;
      signature?: string;
    };
    if (!envelope || !envelope.payload) {
      console.error("Broker: malformed extension envelope");
      return;
    }
    if (signed) {
      if (
        typeof envelope.signature !== "string" ||
        !verifySignature(
          this.secret,
          JSON.stringify(envelope.payload),
          envelope.signature
        )
      ) {
        console.error("Broker: invalid extension message signature");
        return;
      }
    }
    this.core.handleExtensionResponse(envelope.payload);
  }

  private extensionConnected(): boolean {
    for (const conn of this.extensions.values()) {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        return true;
      }
    }
    // A pure long-poll deployment registers an ExtensionConn (ws null) from its
    // signed hello and routes tools via the sink. The `extensions.size > 0`
    // clause requires a registered browser, so a sink armed before any hello has
    // arrived does not report connected. Do not "simplify" to `!!this.longPollSink`.
    return !!this.longPollSink && this.extensions.size > 0;
  }

  private sendToExtension(req: ServerMessageRequest): void {
    const target = this.resolveTarget();
    if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
      if (target.authMode === "signed") {
        const payload = JSON.stringify(req);
        const signature = createSignature(this.secret, payload);
        target.ws.send(JSON.stringify({ payload: req, signature }));
      } else {
        target.ws.send(JSON.stringify({ payload: req }));
      }
      return;
    }
    if (this.longPollSink && this.longPollSink(req)) {
      return;
    }
  }

  /**
   * Resolve the single active driver:
   *   0 connected            -> null
   *   exactly 1              -> that one (implicit active)
   *   2+ with activeBrowserId -> that browser
   *   2+ without active      -> optional DEFAULT_BROWSER match (type or label),
   *                             else null (caller fails loud)
   */
  private resolveTarget(): ExtensionConn | null {
    const conns = [...this.extensions.values()];
    if (conns.length === 0) {
      return null;
    }
    if (conns.length === 1) {
      return conns[0];
    }
    if (this.activeBrowserId) {
      return this.extensions.get(this.activeBrowserId) ?? null;
    }
    const def = process.env.DEFAULT_BROWSER;
    if (def) {
      const match = conns.find(
        (c) => c.type === def || c.label === def
      );
      if (match) {
        return match;
      }
    }
    return null;
  }

  /** Human-readable label list for fail-loud messages. */
  private connectedLabels(): string {
    return [...this.extensions.values()].map((c) => c.label).join(", ");
  }

  /**
   * Snapshot of the connected browsers for `list-browsers` / the status badge.
   * `active` reflects the sole-connected implicit-active rule so this agrees
   * with {@link resolveTarget} (a lone browser is active even with no explicit
   * `activeBrowserId`).
   */
  private listBrowserInfo(): BrowserInfo[] {
    const soleId =
      this.extensions.size === 1 ? [...this.extensions.keys()][0] : null;
    return [...this.extensions.values()].map((c) => ({
      browserId: c.browserId,
      label: c.label,
      type: c.type,
      connected: !!c.ws ? c.ws.readyState === WebSocket.OPEN : true,
      active: c.browserId === this.activeBrowserId || c.browserId === soleId,
    }));
  }

  /**
   * Push the current ACTIVE/STANDBY state to every connected browser. A browser
   * is active if it is the sole connected one (implicit) or its id ===
   * activeBrowserId. Sent as a signed { cmd:"active-status", correlationId:"",
   * active } frame so it rides the existing signed-frame path; the extension
   * short-circuits it before its command switch.
   */
  private broadcastActiveStatus(): void {
    const soleId =
      this.extensions.size === 1 ? [...this.extensions.keys()][0] : null;
    for (const conn of this.extensions.values()) {
      const active =
        conn.browserId === this.activeBrowserId || conn.browserId === soleId;
      const payload = {
        cmd: "active-status",
        correlationId: "",
        active,
      };
      // Guard each connection's delivery independently: a socket can transition
      // to CLOSING between the readyState check and the send (a TOCTOU), making
      // `ws.send` throw. Without this catch one such throw would abort the loop
      // and starve EVERY remaining browser of the active-status update. Skip the
      // bad connection and keep delivering to the rest.
      try {
        if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
          if (conn.authMode === "signed") {
            const signature = createSignature(
              this.secret,
              JSON.stringify(payload)
            );
            conn.ws.send(JSON.stringify({ payload, signature }));
          } else {
            conn.ws.send(JSON.stringify({ payload }));
          }
        } else if (conn.transport === "longpoll" && this.longPollSink) {
          // Long-poll browsers receive it on their next poll batch (the sink
          // signs each queued payload itself).
          this.longPollSink(payload as unknown as ServerMessageRequest);
        }
      } catch {
        // One misbehaving sink/socket must not drop the broadcast to others.
      }
    }
  }

  // ---- client leg ----

  private onClientMessage(clientId: string, raw: string): void {
    let decoded: { payload?: BrokerClientFrame; signature?: string };
    try {
      decoded = JSON.parse(raw);
    } catch {
      console.error("Broker: unparseable client message");
      return;
    }
    if (!decoded || !decoded.payload || typeof decoded.signature !== "string") {
      console.error("Broker: malformed client envelope");
      return;
    }
    if (
      !verifySignature(
        this.secret,
        JSON.stringify(decoded.payload),
        decoded.signature
      )
    ) {
      console.error("Broker: invalid client message signature");
      return;
    }

    const frame = decoded.payload;
    if (frame.kind === "tool") {
      if (this.extensions.size === 0 && !this.longPollSink) {
        this.sendToClient(clientId, {
          kind: "tool-error",
          requestId: frame.requestId,
          errorMessage:
            "No browser extension is connected to the broker. Open Chrome or Firefox with the FoxPilot extension installed and connected (same EXTENSION_SECRET), then retry.",
        });
        return;
      }
      if (this.extensions.size > 1 && this.resolveTarget() === null) {
        this.sendToClient(clientId, {
          kind: "tool-error",
          requestId: frame.requestId,
          errorMessage: `Multiple browsers connected (${this.connectedLabels()}); call select-browser to choose one.`,
        });
        return;
      }
      this.core.submitTool(clientId, frame.requestId, frame.message);
    } else if (frame.kind === "control") {
      const control = frame.control;
      let result: BrokerControlResult;
      switch (control.control) {
        case "acquire-lease":
          result = this.core.acquireLease(clientId, control.tabId);
          break;
        case "release-lease":
          result = this.core.releaseLease(clientId, control.tabId);
          break;
        case "list-browsers":
          result = { ok: true, browsers: this.listBrowserInfo() };
          if (this.activeBrowserId) {
            result.activeBrowserId = this.activeBrowserId;
          }
          break;
        case "select-browser": {
          const conn = this.extensions.get(control.browserId);
          if (!conn) {
            result = {
              ok: false,
              error: `Browser '${control.browserId}' is not connected.`,
              browsers: this.listBrowserInfo(),
            };
          } else {
            this.activeBrowserId = control.browserId;
            this.broadcastActiveStatus();
            result = {
              ok: true,
              activeBrowserId: this.activeBrowserId,
              browsers: this.listBrowserInfo(),
            };
          }
          break;
        }
        default: {
          const _exhaustive: never = control;
          result = { ok: false, error: "Unknown control" };
        }
      }
      this.sendToClient(clientId, {
        kind: "control-result",
        requestId: frame.requestId,
        result,
      });
    }
  }

  private sendToClient(clientId: string, frame: BrokerServerFrame): void {
    const ws = this.clients.get(clientId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = JSON.stringify(frame);
    const signature = createSignature(this.secret, payload);
    ws.send(JSON.stringify({ payload: frame, signature }));
  }

  // ---- HTTP / health (long-poll transport attaches here) ----

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health" || path === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          extensionConnected: this.extensionConnected(),
          browsers: this.extensions.size,
          clients: this.clients.size,
        })
      );
      return;
    }
    if (this.httpHandlers) {
      for (const handler of this.httpHandlers) {
        if (handler(req, res, path)) {
          return;
        }
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  // ---- extensibility hooks (used by the long-poll transport) ----

  private httpHandlers:
    | Array<
        (
          req: http.IncomingMessage,
          res: http.ServerResponse,
          path: string
        ) => boolean
      >
    | null = null;

  /** Register an additional HTTP route handler (returns true if it handled the request). */
  addHttpHandler(
    handler: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
      path: string
    ) => boolean
  ): void {
    if (!this.httpHandlers) {
      this.httpHandlers = [];
    }
    this.httpHandlers.push(handler);
  }

  /** Register (or clear) the long-poll request sink used when no WS extension is connected. */
  setLongPollSink(sink: ((req: ServerMessageRequest) => boolean) | null): void {
    this.longPollSink = sink;
    if (sink) {
      this.clearIdleTimer();
    } else {
      this.maybeScheduleIdle();
    }
  }

  /** Feed an extension message received over the long-poll transport into the core. */
  ingestExtensionMessage(raw: string): void {
    this.onExtensionMessage(raw);
  }

  /** Fail in-flight requests when the long-poll extension is detected gone. */
  onLongPollExtensionGone(): void {
    // A long-poll browser can no longer be reached once its transport
    // deactivates, so drop its registry entries (and clear active if it was
    // the active one) before failing in-flight requests.
    for (const [id, conn] of [...this.extensions]) {
      if (conn.transport === "longpoll") {
        this.extensions.delete(id);
        if (this.activeBrowserId === id) {
          this.activeBrowserId = null;
        }
      }
    }
    this.core.onExtensionDisconnect();
    this.broadcastActiveStatus();
    this.maybeScheduleIdle();
  }

  // ---- idle shutdown ----

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private maybeScheduleIdle(): void {
    if (this.clients.size === 0 && this.extensions.size === 0 && !this.longPollSink) {
      if (!this.idleTimer && this.onIdle) {
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          this.onIdle?.();
        }, this.idleTimeoutMs);
        (this.idleTimer as { unref?: () => void }).unref?.();
      }
    } else {
      this.clearIdleTimer();
    }
  }
}
