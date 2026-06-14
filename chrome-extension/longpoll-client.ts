import type {
  ExtensionMessage,
  ServerMessageRequest,
} from "@foxpilot/common";
import { getMessageSignature } from "./auth";
import { ExtensionTransport } from "./transport";

const RECONNECT_INTERVAL = 2000;
const POLL_AUTH_STRING = "extension-poll";

/**
 * HTTP long-poll transport to the broker — a fallback for environments where a
 * persistent WebSocket is unreliable. Repeatedly GETs `/extension/poll` for
 * pending requests and POSTs responses to `/extension/respond`. Authenticates
 * every request with an HMAC of a fixed string (proving knowledge of the
 * shared secret), matching the broker's `BrokerLongPoll`.
 */
export class LongPollClient implements ExtensionTransport {
  private readonly port: number;
  private readonly secret: string;
  private messageCallback: ((data: ServerMessageRequest) => void) | null = null;
  private stopped = false;
  private abort: AbortController | null = null;

  constructor(port: number, secret: string) {
    this.port = port;
    this.secret = secret;
  }

  connect(): void {
    this.stopped = false;
    void this.pollLoop();
  }

  addMessageListener(
    callback: (data: ServerMessageRequest) => void
  ): void {
    this.messageCallback = callback;
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
        this.abort = new AbortController();
        const auth = await this.authParam();
        const res = await fetch(
          `${this.baseUrl()}/extension/poll?auth=${auth}`,
          { signal: this.abort.signal }
        );
        if (!res.ok) {
          await this.delay(RECONNECT_INTERVAL);
          continue;
        }
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
            this.messageCallback(entry.payload as ServerMessageRequest);
          }
        }
      } catch (error) {
        if (this.stopped) {
          break;
        }
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
  }

  /**
   * Long-poll is reconnect-driven by its own internal `pollLoop`, which retries
   * indefinitely until `disconnect()`. From the keepalive's perspective it is
   * therefore never "closed", so we report `false` and let the poll loop own
   * reconnection. (Reporting `true` would make the keepalive call `connect()`
   * and spawn a duplicate poll loop.)
   */
  isClosed(): boolean {
    return false;
  }

  /**
   * No-op: a long-poll request is itself the liveness signal the broker sees,
   * so there is nothing extra to ping. Kept to satisfy `ExtensionTransport`.
   */
  ping(): void {}
}
