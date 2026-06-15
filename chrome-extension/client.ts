import type {
  ExtensionMessage,
  ExtensionError,
  ServerMessageRequest,
} from "@foxpilot/common";
import { getMessageSignature } from "./auth";
import {
  ExtensionTransport,
  ConnectionStateCallback,
  BrokerBrowserInfo,
  HealthcheckResult,
} from "./transport";
import { buildHello } from "./hello";

const RECONNECT_INTERVAL = 2000; // 2 seconds
const HEALTHCHECK_TIMEOUT = 3000; // 3 seconds

/** Flat `welcome` admission ack (broker.ts sendWelcome). */
interface WelcomeFrame {
  type: "welcome";
  browserId: string;
  activeBrowserId: string | null;
  browsers: BrokerBrowserInfo[];
}

/** Flat `healthcheck-result` snapshot (broker.ts healthcheck reply). */
interface HealthcheckResultFrame {
  type: "healthcheck-result";
  extensionConnected: boolean;
  browsers: BrokerBrowserInfo[];
  activeBrowserId: string | null;
}

export class WebsocketClient implements ExtensionTransport {
  private socket: WebSocket | null = null;
  private readonly port: number;
  private readonly secret: string;
  private reconnectTimer: number | null = null;
  private connectionAttempts: number = 0;
  private messageCallback: ((data: ServerMessageRequest) => void) | null = null;
  private statusCallback: ((active: boolean) => void) | null = null;
  private readonly onConnectionState?: ConnectionStateCallback;
  // True once the broker has ADMITTED this socket (welcome received). Reset on
  // every (re)connect so a fresh socket starts unproven again.
  private admitted = false;
  // True once the broker REJECTED this socket (rejected received). The broker
  // closes the socket right after; this flag lets the trailing close handler
  // preserve "blocked" instead of clobbering it with "disconnected". Reset on
  // every (re)connect.
  private blocked = false;
  // The browserId echoed in the latest welcome, used to derive ACTIVE/STANDBY.
  private myBrowserId: string | null = null;
  // Pending healthcheck resolver, set while a probe is in flight.
  private healthcheckResolver:
    | ((result: HealthcheckResult) => void)
    | null = null;
  private healthcheckTimer: number | null = null;

  /**
   * @param secret Empty string => origin mode (UNSIGNED frames; the broker
   *   admits by extension Origin). Non-empty => signed mode (HMAC every frame).
   * @param onConnectionState Truthful connection-state surface. "connected" is
   *   reported only on `welcome`, never merely on socket open.
   */
  constructor(
    port: number,
    secret: string,
    onConnectionState?: ConnectionStateCallback
  ) {
    this.port = port;
    this.secret = secret;
    this.onConnectionState = onConnectionState;
  }

  /** True when this client is in legacy signed mode (a secret is configured). */
  private get signed(): boolean {
    return this.secret.length > 0;
  }

  public connect(): void {
    console.log("Connecting to broker at port", this.port);

    // A new socket is unproven (and not yet blocked) until the broker responds.
    this.admitted = false;
    this.blocked = false;

    // Connect to the broker daemon's extension leg. The broker owns the single
    // browser connection and fans many MCP-client sessions in/out of it.
    this.socket = new WebSocket(`ws://localhost:${this.port}/extension`);

    this.socket.addEventListener("open", async () => {
      console.log("Connected to WebSocket server at port", this.port);
      this.connectionAttempts = 0;
      // Identity first: the broker decides admission from this first frame (a
      // valid signed hello in signed mode, or the extension Origin in origin
      // mode). We do NOT report connected here — an open socket only means the
      // broker is reachable, not that it admitted us. Connected is reported when
      // `welcome` arrives.
      try {
        this.socket?.send(await buildHello(this.secret));
      } catch (err) {
        console.error("Failed to send hello:", err);
      }
    });

    this.socket.addEventListener("close", () => {
      console.log("WebSocket connection closed event at port", this.port);
      this.connectionAttempts = 0;
      this.failPendingHealthcheck();
      // A close means the broker went away (admitted -> dropped) or was never
      // reachable (never admitted): either way, disconnected — UNLESS we were
      // just rejected. The broker closes the socket right after a `rejected`
      // frame, and that trailing close must not overwrite "blocked". The
      // reconnect loop will re-evaluate admission on the next attempt (which
      // clears `blocked`).
      this.admitted = false;
      if (!this.blocked) {
        this.onConnectionState?.("disconnected");
      }
    });

    this.socket.addEventListener("error", (event) => {
      console.error("WebSocket error:", event);
      this.failPendingHealthcheck();
      if (!this.admitted && !this.blocked) {
        this.onConnectionState?.("disconnected");
      }
    });

    this.socket.addEventListener("message", async (event) => {
      try {
        const frame = JSON.parse(event.data);

        // 1) FLAT control frames, dispatched by `type` BEFORE any signature
        //    logic — they are always unsigned, in both auth modes.
        if (frame && typeof frame === "object" && "type" in frame) {
          switch (frame.type) {
            case "welcome":
              this.handleWelcome(frame as WelcomeFrame);
              return;
            case "rejected":
              this.handleRejected(frame as { reason?: string });
              return;
            case "healthcheck-result":
              this.handleHealthcheckResult(frame as HealthcheckResultFrame);
              return;
          }
        }

        // 2) `{ payload, signature? }` envelopes — tool commands and the
        //    active-status push. In origin mode they are unsigned and accepted
        //    as-is; in signed mode the signature is verified.
        await this.handleEnvelope(frame);
      } catch (error) {
        console.error("Failed to parse message:", error);
      }
    });

    // Start reconnection timer if not already running
    if (this.reconnectTimer === null) {
      this.startReconnectTimer();
    }
  }

  /** Admission ack — the broker accepted this browser. */
  private handleWelcome(frame: WelcomeFrame): void {
    this.admitted = true;
    this.myBrowserId = frame.browserId;
    // Connected = admitted. This is the ONLY place we report it.
    this.onConnectionState?.("connected");
    // Derive ACTIVE/STANDBY immediately so a lone browser shows ACTIVE without
    // waiting for a separate active-status push.
    this.statusCallback?.(this.deriveActive(frame));
  }

  /** Admission refused — the server is running but rejected this browser. */
  private handleRejected(frame: { reason?: string }): void {
    this.admitted = false;
    this.blocked = true;
    this.onConnectionState?.("blocked", { reason: frame.reason });
  }

  /** Compute whether THIS browser is the active driver from a welcome roster. */
  private deriveActive(frame: WelcomeFrame): boolean {
    const mine = frame.browsers.find((b) => b.browserId === frame.browserId);
    if (mine) {
      return mine.active;
    }
    // No roster entry (shouldn't happen) — fall back to the activeBrowserId, and
    // treat a lone unnamed browser as active.
    if (frame.activeBrowserId) {
      return frame.activeBrowserId === frame.browserId;
    }
    return frame.browsers.length <= 1;
  }

  /** Process a `{ payload, signature? }` envelope (command or active-status). */
  private async handleEnvelope(frame: any): Promise<void> {
    const payload = frame?.payload;
    if (!payload) {
      return;
    }
    if (this.signed) {
      const expected = await getMessageSignature(
        JSON.stringify(payload),
        this.secret
      );
      if (expected.length === 0 || expected !== frame.signature) {
        console.error("Invalid message signature");
        // Only error back for correlated command frames; status frames carry an
        // empty correlationId and are not awaited by anyone.
        if (payload.correlationId) {
          await this.sendErrorToServer(
            payload.correlationId,
            "Invalid message signature - extension and server not in sync"
          );
        }
        return;
      }
    }
    // active-status is a server push, not a command — route it separately.
    if (payload.cmd === "active-status") {
      this.statusCallback?.(!!payload.active);
      return;
    }
    if (this.messageCallback === null) {
      return;
    }
    this.messageCallback(payload);
  }

  public addMessageListener(
    callback: (data: ServerMessageRequest) => void
  ): void {
    this.messageCallback = callback;
  }

  public addStatusListener(callback: (active: boolean) => void): void {
    this.statusCallback = callback;
  }

  /**
   * Ask the broker to make THIS browser the active driver. Sends a
   * { type:"select-active", browserId } frame on the extension->broker channel
   * (symmetric to the hello). In origin mode the frame is unsigned; in signed
   * mode it is HMAC-signed exactly like every other frame. The broker sets
   * activeBrowserId and pushes the new ACTIVE/STANDBY state to every browser.
   */
  public async sendSelectActive(browserId: string): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error("Socket not open; cannot select active");
      return;
    }
    const payload = { type: "select-active", browserId };
    this.socket.send(JSON.stringify(await this.frame(payload)));
  }

  /**
   * Probe the broker over the live socket and resolve with its roster snapshot.
   * Resolves (never rejects) with `serverReachable:false` when the socket is
   * not open or the broker does not answer within the timeout, so callers can
   * render a clear "server not running" result without a try/catch.
   */
  public healthcheck(): Promise<HealthcheckResult> {
    return new Promise((resolve) => {
      const notReachable: HealthcheckResult = {
        serverReachable: false,
        extensionConnected: false,
        browsers: [],
        activeBrowserId: null,
      };
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        resolve(notReachable);
        return;
      }
      // Only one probe in flight at a time — fail any prior one first.
      this.failPendingHealthcheck();
      this.healthcheckResolver = resolve;
      this.healthcheckTimer = self.setTimeout(() => {
        this.failPendingHealthcheck();
      }, HEALTHCHECK_TIMEOUT);
      try {
        this.socket.send(JSON.stringify({ type: "healthcheck" }));
      } catch {
        this.failPendingHealthcheck();
      }
    });
  }

  private handleHealthcheckResult(frame: HealthcheckResultFrame): void {
    if (!this.healthcheckResolver) {
      return;
    }
    const resolve = this.healthcheckResolver;
    this.clearHealthcheckState();
    resolve({
      serverReachable: true,
      extensionConnected: !!frame.extensionConnected,
      browsers: Array.isArray(frame.browsers) ? frame.browsers : [],
      activeBrowserId: frame.activeBrowserId ?? null,
    });
  }

  /** Resolve any pending healthcheck as not-reachable (timeout/close/error). */
  private failPendingHealthcheck(): void {
    if (!this.healthcheckResolver) {
      this.clearHealthcheckState();
      return;
    }
    const resolve = this.healthcheckResolver;
    this.clearHealthcheckState();
    resolve({
      serverReachable: false,
      extensionConnected: false,
      browsers: [],
      activeBrowserId: null,
    });
  }

  private clearHealthcheckState(): void {
    if (this.healthcheckTimer !== null) {
      self.clearTimeout(this.healthcheckTimer);
      this.healthcheckTimer = null;
    }
    this.healthcheckResolver = null;
  }

  private startReconnectTimer(): void {
    this.reconnectTimer = self.setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
        this.connectionAttempts++;

        if (this.connectionAttempts > 2) {
          // Avoid long retry backoff periods by resetting the connection
          this.socket.close();
        }
      }

      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
        this.connect();
      }
    }, RECONNECT_INTERVAL);
  }

  public async sendResourceToServer(resource: ExtensionMessage): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error("Socket is not open");
      return;
    }
    this.socket.send(JSON.stringify(await this.frame(resource)));
  }

  public async sendErrorToServer(
    correlationId: string,
    errorMessage: string
  ): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error("Socket is not open", this.socket);
      return;
    }
    const extensionError: ExtensionError = {
      correlationId,
      errorMessage: errorMessage,
    };
    // Error frames are sent raw (unsigned) in both modes.
    this.socket.send(JSON.stringify(extensionError));
  }

  /**
   * Wrap a payload in the wire envelope for the current auth mode: signed mode
   * attaches an HMAC signature; origin mode emits `{ payload }` with no
   * signature field, matching the broker's origin-mode contract.
   */
  private async frame(
    payload: unknown
  ): Promise<{ payload: unknown; signature?: string }> {
    if (!this.signed) {
      return { payload };
    }
    const signature = await getMessageSignature(
      JSON.stringify(payload),
      this.secret
    );
    return { payload, signature };
  }

  public disconnect(): void {
    if (this.reconnectTimer !== null) {
      self.clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.failPendingHealthcheck();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.admitted = false;
    this.onConnectionState?.("disconnected");
  }

  /**
   * True when there is no socket or the socket has fully closed. Used by the
   * keepalive alarm to decide whether to reconnect on SW wake.
   */
  public isClosed(): boolean {
    return !this.socket || this.socket.readyState === WebSocket.CLOSED;
  }

  /**
   * Sends a lightweight keepalive frame on each alarm wake so the socket stays
   * warm. The broker recognizes and silently ignores this frame (it does not
   * track liveness from it). Silent no-op if the socket is not open.
   */
  public ping(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* ignore — next alarm reconnects if the socket actually died */
      }
    }
  }
}
