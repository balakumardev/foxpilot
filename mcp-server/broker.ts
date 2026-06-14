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
} from "./broker-protocol";
import type { HelloPayload } from "./broker-protocol";
import { createSignature, verifySignature } from "./signing";
import { getCommandTimeout } from "./timeouts";

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10 * 1000;

/** A connected browser extension and the transport it arrived on. */
interface ExtensionConn {
  browserId: string;
  ws: WebSocket | null;
  transport: "ws" | "longpoll";
  type: "chrome" | "firefox";
  label: string;
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

  private readonly httpServer: http.Server;
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

    this.core = new BrokerCore({
      sendToExtension: (req) => this.sendToExtension(req),
      sendToClient: (clientId, frame) => this.sendToClient(clientId, frame),
      getTimeoutMs: getCommandTimeout,
    });

    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => reject(err);
      this.httpServer.once("error", onError);
      this.httpServer.listen(this.port, this.host, () => {
        this.httpServer.removeListener("error", onError);
        resolve();
      });
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
    this.httpServer.close();
  }

  /** The resolved anonymous-socket handshake timeout (ms); useful for tests. */
  getHandshakeTimeoutMs(): number {
    return this.handshakeTimeoutMs;
  }

  /** The actually-bound port (useful when constructed with port 0 for tests). */
  getPort(): number {
    const addr = this.httpServer.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return this.port;
  }

  // ---- connection routing ----

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const path = (req.url ?? "/").split("?")[0];
    if (path.startsWith("/extension")) {
      this.onExtensionConnection(ws);
    } else {
      this.onClientConnection(ws);
    }
  }

  private onExtensionConnection(ws: WebSocket): void {
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
        conn = this.tryRegisterHello(raw, ws);
        if (conn) {
          // Registered: the socket is no longer anonymous, disarm the timer.
          clearHandshakeTimer();
        } else {
          // Invalid/absent hello — never admit; close without echoing. Leave the
          // handshake timer armed (the close handler clears it) in case the peer
          // keeps the socket open after the rejected frame.
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      conn.lastSeen = Date.now();
      this.onExtensionMessage(raw);
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
   * Verify a signed `hello` and register the connection. Returns the new
   * ExtensionConn on success, or null if the frame is not a valid signed hello
   * (caller closes the socket without admitting it).
   */
  private tryRegisterHello(raw: string, ws: WebSocket): ExtensionConn | null {
    let decoded: { payload?: HelloPayload; signature?: string };
    try {
      decoded = JSON.parse(raw);
    } catch {
      return null;
    }
    const payload = decoded?.payload;
    if (
      !payload ||
      payload.type !== "hello" ||
      typeof payload.browserId !== "string" ||
      typeof decoded.signature !== "string"
    ) {
      return null;
    }
    if (
      !verifySignature(
        this.secret,
        JSON.stringify(payload),
        decoded.signature
      )
    ) {
      return null;
    }
    return this.registerExtension({
      browserId: payload.browserId,
      ws,
      transport: "ws",
      type: payload.browserType === "firefox" ? "firefox" : "chrome",
      label: payload.label || payload.browserType,
      lastSeen: Date.now(),
    });
  }

  /**
   * Register (or re-attach) a browser by browserId. A reconnect under the same
   * id replaces the stale socket without disturbing other browsers. Pushes the
   * active-status to every browser whenever the set changes.
   */
  private registerExtension(conn: ExtensionConn): ExtensionConn {
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
    this.broadcastActiveStatus();
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

  private onExtensionMessage(raw: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      console.error("Broker: unparseable extension message");
      return;
    }

    // Extension keepalive frame from `chrome-extension/client.ts ping()`, sent
    // on each SW alarm wake to keep the socket warm. Nothing to do server-side;
    // recognized here so it isn't logged as a malformed envelope below.
    if (
      decoded &&
      typeof decoded === "object" &&
      (decoded as { type?: unknown }).type === "ping"
    ) {
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
            maybeHello.payload.browserType === "firefox"
              ? "firefox"
              : "chrome",
          label: maybeHello.payload.label || maybeHello.payload.browserType,
          lastSeen: Date.now(),
        });
      }
      return;
    }

    // "Make this browser active" sent from the options page: a signed
    // { type:"select-active", browserId } frame on the extension->broker channel,
    // symmetric to the hello. Verify the signature, and only honor it if the
    // named browser is actually connected (id-checked), then push the new state.
    const maybeSelect = decoded as {
      payload?: { type?: string; browserId?: string };
      signature?: string;
    };
    if (
      maybeSelect?.payload?.type === "select-active" &&
      typeof maybeSelect.signature === "string"
    ) {
      if (
        verifySignature(
          this.secret,
          JSON.stringify(maybeSelect.payload),
          maybeSelect.signature
        ) &&
        maybeSelect.payload.browserId &&
        this.extensions.has(maybeSelect.payload.browserId)
      ) {
        this.activeBrowserId = maybeSelect.payload.browserId;
        this.broadcastActiveStatus();
      }
      return;
    }

    // Error frames are sent raw (unsigned), matching the existing protocol.
    if (isExtensionErrorFrame(decoded)) {
      this.core.handleExtensionError(decoded);
      return;
    }

    const envelope = decoded as { payload?: ExtensionMessage; signature?: string };
    if (!envelope || !envelope.payload || typeof envelope.signature !== "string") {
      console.error("Broker: malformed extension envelope");
      return;
    }
    if (
      !verifySignature(
        this.secret,
        JSON.stringify(envelope.payload),
        envelope.signature
      )
    ) {
      console.error("Broker: invalid extension message signature");
      return;
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
      const payload = JSON.stringify(req);
      const signature = createSignature(this.secret, payload);
      target.ws.send(JSON.stringify({ payload: req, signature }));
      return;
    }
    // Long-poll target (an ExtensionConn whose ws is null) or no resolvable ws
    // target: fall back to the long-poll sink if one is registered — the sink
    // itself is the routable transport for the long-poll leg. Else the core's
    // timeout fails the request.
    if (this.longPollSink && this.longPollSink(req)) {
      return;
    }
    // No resolvable transport; the core's timeout will fail the request.
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
          const signature = createSignature(
            this.secret,
            JSON.stringify(payload)
          );
          conn.ws.send(JSON.stringify({ payload, signature }));
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
