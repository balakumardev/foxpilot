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

import WebSocket from "ws";
import * as http from "http";
import type {
  ExtensionError,
  ExtensionMessage,
  ServerMessageRequest,
} from "@foxpilot/common";
import { BrokerCore } from "./broker-core";
import { BrokerClientFrame, BrokerServerFrame } from "./broker-protocol";
import { createSignature, verifySignature } from "./signing";
import { getCommandTimeout } from "./timeouts";

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export interface BrokerServerOptions {
  port: number;
  host?: string;
  secret: string;
  /** Called once the broker has been idle (no clients, no extension) for idleTimeoutMs. */
  onIdle?: () => void;
  idleTimeoutMs?: number;
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

  private readonly httpServer: http.Server;
  private readonly wss: WebSocket.Server;
  private readonly core: BrokerCore;

  private extensionWs: WebSocket | null = null;
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

    this.core = new BrokerCore({
      sendToExtension: (req) => this.sendToExtension(req),
      sendToClient: (clientId, frame) => this.sendToClient(clientId, frame),
      getTimeoutMs: getCommandTimeout,
    });

    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocket.Server({ server: this.httpServer });
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
    if (this.extensionWs) {
      try {
        this.extensionWs.terminate();
      } catch {
        /* ignore */
      }
    }
    this.wss.close();
    this.httpServer.close();
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
    // Single extension; a new connection supersedes any previous one.
    if (this.extensionWs && this.extensionWs !== ws) {
      const old = this.extensionWs;
      this.extensionWs = null;
      this.core.onExtensionDisconnect();
      try {
        old.terminate();
      } catch {
        /* ignore */
      }
    }
    this.extensionWs = ws;
    this.clearIdleTimer();

    ws.on("message", (data) => this.onExtensionMessage(data.toString()));
    ws.on("close", () => {
      if (this.extensionWs === ws) {
        this.extensionWs = null;
        this.core.onExtensionDisconnect();
        this.maybeScheduleIdle();
      }
    });
    ws.on("error", () => {
      /* close handler will run */
    });
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
    return (
      !!this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN
    );
  }

  private sendToExtension(req: ServerMessageRequest): void {
    // Prefer the live WebSocket; fall back to the long-poll sink if registered.
    if (this.extensionConnected()) {
      const payload = JSON.stringify(req);
      const signature = createSignature(this.secret, payload);
      this.extensionWs!.send(JSON.stringify({ payload: req, signature }));
      return;
    }
    if (this.longPollSink && this.longPollSink(req)) {
      return;
    }
    // No transport available; the core's timeout will fail the request.
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
      if (!this.extensionConnected() && !this.longPollSink) {
        this.sendToClient(clientId, {
          kind: "tool-error",
          requestId: frame.requestId,
          errorMessage:
            "No browser extension is connected to the broker. Open Firefox with the FoxPilot extension installed and connected, then retry.",
        });
        return;
      }
      this.core.submitTool(clientId, frame.requestId, frame.message);
    } else if (frame.kind === "control") {
      const control = frame.control;
      const result =
        control.control === "acquire-lease"
          ? this.core.acquireLease(clientId, control.tabId)
          : this.core.releaseLease(clientId, control.tabId);
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
    this.core.onExtensionDisconnect();
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
    if (this.clients.size === 0 && !this.extensionConnected() && !this.longPollSink) {
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
