import type {
  ExtensionMessage,
  ServerMessageRequest,
} from "@foxpilot/common";
import { getMessageSignature } from "./auth";
import {
  ExtensionTransport,
  ConnectionStateCallback,
  HealthcheckResult,
} from "./transport";
import { buildHello } from "./hello";

const RECONNECT_INTERVAL = 2000;
const POLL_AUTH_STRING = "extension-poll";
const HEALTHCHECK_TIMEOUT = 3000;

/**
 * HTTP long-poll transport to the broker — a fallback for environments where a
 * persistent WebSocket is unreliable. Repeatedly GETs `/extension/poll` for
 * pending requests and POSTs responses to `/extension/respond`. Authenticates
 * every request with an HMAC of a fixed string (proving knowledge of the
 * shared secret), matching the broker's `BrokerLongPoll`.
 *
 * Long-poll is a LEGACY/signed-only transport: the broker's origin-mode (zero
 * secret) admission is WebSocket-only, so a long-poll deployment always needs a
 * configured secret. It has no `welcome` frame, so it maps a successful poll
 * round-trip to "connected" and any failure to "disconnected". The one "blocked"
 * case is a no-secret config: signing would throw, so `connect()` refuses up
 * front with reason "longpoll-requires-secret" instead of spinning a throw/retry
 * loop.
 */
export class LongPollClient implements ExtensionTransport {
  private readonly port: number;
  private readonly secret: string;
  private messageCallback: ((data: ServerMessageRequest) => void) | null = null;
  private statusCallback: ((active: boolean) => void) | null = null;
  private helloSent = false;
  private stopped = false;
  private abort: AbortController | null = null;
  private readonly onConnectionState?: ConnectionStateCallback;

  constructor(
    port: number,
    secret: string,
    onConnectionState?: ConnectionStateCallback
  ) {
    this.port = port;
    this.secret = secret;
    this.onConnectionState = onConnectionState;
  }

  /** True when a secret is configured (the only mode long-poll can operate in). */
  private get signed(): boolean {
    return this.secret.length > 0;
  }

  connect(): void {
    this.stopped = false;
    // Long-poll is signed-only: every request is authed with an HMAC of the
    // shared secret, and getMessageSignature THROWS on an empty secret. Under
    // the zero-config default (no secret) the poll loop would otherwise spin a
    // failing throw/retry loop forever. Refuse cleanly instead: surface a
    // human-meaningful "blocked" state telling the user this transport needs a
    // secret, and never start the loop.
    if (!this.signed) {
      this.onConnectionState?.("blocked", {
        reason: "longpoll-requires-secret",
      });
      return;
    }
    void this.pollLoop();
  }

  addMessageListener(
    callback: (data: ServerMessageRequest) => void
  ): void {
    this.messageCallback = callback;
  }

  addStatusListener(callback: (active: boolean) => void): void {
    this.statusCallback = callback;
  }

  /**
   * Ask the broker to make THIS browser the active driver. POSTs a signed
   * { type:"select-active", browserId } frame to /respond (same ingest path as
   * the hello); the broker verifies it, sets activeBrowserId, and pushes the
   * new ACTIVE/STANDBY state back on the next poll batch.
   */
  async sendSelectActive(browserId: string): Promise<void> {
    const payload = { type: "select-active", browserId };
    const signature = await getMessageSignature(
      JSON.stringify(payload),
      this.secret
    );
    await this.post(JSON.stringify({ payload, signature }));
  }

  /**
   * Probe the broker with a single short-timeout authed poll. The long-poll
   * leg has no `welcome`/roster, so a 200 means the broker is reachable and this
   * (signed) browser is admitted; it cannot report the full multi-browser roster
   * that the WebSocket healthcheck does. Resolves (never rejects) with
   * `serverReachable:false` on any failure or timeout.
   */
  async healthcheck(): Promise<HealthcheckResult> {
    const notReachable: HealthcheckResult = {
      serverReachable: false,
      extensionConnected: false,
      browsers: [],
      activeBrowserId: null,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT);
    try {
      const auth = await this.authParam();
      const res = await fetch(
        `${this.baseUrl()}/extension/poll?auth=${auth}`,
        { signal: controller.signal }
      );
      if (!res.ok) {
        return notReachable;
      }
      // Drain the body so the long-park GET does not leave a dangling stream.
      try {
        await res.json();
      } catch {
        /* ignore — reachability is what matters */
      }
      return {
        serverReachable: true,
        extensionConnected: true,
        browsers: [],
        activeBrowserId: null,
      };
    } catch {
      return notReachable;
    } finally {
      clearTimeout(timer);
    }
  }

  private baseUrl(): string {
    return `http://localhost:${this.port}`;
  }

  private authParam(): Promise<string> {
    return getMessageSignature(POLL_AUTH_STRING, this.secret);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        if (!this.helloSent) {
          // Identity first: POST the signed hello so the broker registers this
          // browser before any poll long-parks. /respond ingests it like a WS
          // first frame.
          await this.post(await buildHello(this.secret));
          this.helloSent = true;
        }
        this.abort = new AbortController();
        const auth = await this.authParam();
        const res = await fetch(
          `${this.baseUrl()}/extension/poll?auth=${auth}`,
          { signal: this.abort.signal }
        );
        if (!res.ok) {
          // Connection considered dropped: the broker's stale timer may have
          // deleted our long-poll registry entry (onLongPollExtensionGone),
          // which only a hello POST recreates. Re-arm the hello so the next
          // iteration re-registers this browser before resuming polling.
          this.helloSent = false;
          // Liveness: a failed poll means the broker is not reachable.
          this.onConnectionState?.("disconnected");
          await this.delay(RECONNECT_INTERVAL);
          continue;
        }
        // A successful poll round-trip means the broker admitted us (long-poll
        // has no welcome frame; a successful authed poll is the admission proof).
        this.onConnectionState?.("connected");
        const data = await res.json();
        if (data && Array.isArray(data.requests) && this.messageCallback) {
          for (const entry of data.requests) {
            const sig = await getMessageSignature(
              JSON.stringify(entry.payload),
              this.secret
            );
            if (sig.length === 0 || sig !== entry.signature) {
              console.error(
                "LongPollClient: invalid request signature from broker"
              );
              continue;
            }
            if (entry.payload?.cmd === "active-status") {
              this.statusCallback?.(!!entry.payload.active);
              continue;
            }
            this.messageCallback(entry.payload as ServerMessageRequest);
          }
        }
      } catch (error) {
        if (this.stopped) {
          break;
        }
        // A failed poll round-trip means the connection dropped; the broker may
        // have stale-dropped our registry entry. Re-arm the hello so the next
        // iteration re-POSTs it and re-registers this browser before polling
        // resumes. A re-hello on a transient blip is harmless (registerExtension
        // just re-registers the same browserId).
        this.helloSent = false;
        // Liveness: the poll round-trip failed, so the broker is not reachable.
        this.onConnectionState?.("disconnected");
        await this.delay(RECONNECT_INTERVAL);
      }
    }
  }

  async sendResourceToServer(resource: ExtensionMessage): Promise<void> {
    const signature = await getMessageSignature(
      JSON.stringify(resource),
      this.secret
    );
    await this.post(JSON.stringify({ payload: resource, signature }));
  }

  async sendErrorToServer(
    correlationId: string,
    errorMessage: string
  ): Promise<void> {
    await this.post(JSON.stringify({ correlationId, errorMessage }));
  }

  private async post(body: string): Promise<void> {
    try {
      const auth = await this.authParam();
      await fetch(`${this.baseUrl()}/extension/respond?auth=${auth}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (error) {
      console.error("LongPollClient: failed to post to broker:", error);
    }
  }

  disconnect(): void {
    this.stopped = true;
    if (this.abort) {
      try {
        this.abort.abort();
      } catch {
        /* ignore */
      }
    }
    this.onConnectionState?.("disconnected");
  }
}
