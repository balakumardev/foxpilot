import { WebSocket } from "ws";
import {
  BrokerClientFrame,
  BrokerControlRequest,
  BrokerControlResult,
  BrokerServerFrame,
} from "./broker-protocol";
import { createSignature, verifySignature } from "./signing";

function tryConnectWs(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err);
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onError);
    };

    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ws);
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error(`Connection to ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

export class BrokerControlClient {
  private ws: WebSocket | null;
  private readonly secret: string;
  private requestCounter = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (result: BrokerControlResult) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(ws: WebSocket, secret: string) {
    this.ws = ws;
    this.secret = secret;

    this.ws.on("message", (data) => {
      this.onMessage(data.toString());
    });

    this.ws.on("close", () => {
      this.rejectAll("Broker connection closed");
      this.ws = null;
    });

    this.ws.on("error", () => {
      /* close handler will run */
    });
  }

  static async connect(
    port: number,
    secret: string,
    timeoutMs: number = 3000
  ): Promise<BrokerControlClient> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;

    const remaining1 = Math.max(100, deadline - Date.now());
    try {
      const ws = await tryConnectWs(`ws://127.0.0.1:${port}/mcp`, remaining1);
      return new BrokerControlClient(ws, secret);
    } catch (err) {
      lastErr = err;
    }

    const remaining2 = Math.max(100, deadline - Date.now());
    try {
      const ws = await tryConnectWs(`ws://[::1]:${port}/mcp`, remaining2);
      return new BrokerControlClient(ws, secret);
    } catch (err) {
      lastErr = err;
    }

    throw new Error(
      `Could not connect to FoxPilot broker on port ${port}: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`
    );
  }

  private onMessage(raw: string): void {
    let decoded: { payload?: BrokerServerFrame; signature?: string };
    try {
      decoded = JSON.parse(raw);
    } catch {
      return;
    }
    if (!decoded || !decoded.payload || typeof decoded.signature !== "string") {
      return;
    }
    if (
      !verifySignature(
        this.secret,
        JSON.stringify(decoded.payload),
        decoded.signature
      )
    ) {
      console.error("BrokerControlClient: invalid broker message signature");
      return;
    }

    if (decoded.payload.kind === "control-result") {
      const resolver = this.pending.get(decoded.payload.requestId);
      if (resolver) {
        clearTimeout(resolver.timer);
        this.pending.delete(decoded.payload.requestId);
        resolver.resolve(decoded.payload.result);
      }
    }
  }

  private rejectAll(reason: string): void {
    for (const [requestId, resolver] of this.pending) {
      clearTimeout(resolver.timer);
      resolver.reject(new Error(reason));
      this.pending.delete(requestId);
    }
  }

  request(
    control: BrokerControlRequest,
    timeoutMs: number = 60000
  ): Promise<BrokerControlResult> {
    return new Promise<BrokerControlResult>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to the broker"));
        return;
      }
      const requestId = `${process.pid}-${++this.requestCounter}`;
      const timer = setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error("Timed out waiting for broker control response"));
        }
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      this.pending.set(requestId, { resolve, reject, timer });

      const frame: BrokerClientFrame = { kind: "control", requestId, control };
      try {
        const payloadStr = JSON.stringify(frame);
        const signature = createSignature(this.secret, payloadStr);
        this.ws.send(JSON.stringify({ payload: frame, signature }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    this.rejectAll("BrokerControlClient closed");
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}
