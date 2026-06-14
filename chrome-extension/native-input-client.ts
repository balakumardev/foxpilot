import { getMessageSignature } from "./auth";
import {
  NativeGesture,
  NativeInputRequest,
  NativeInputResponse,
} from "@foxpilot/common";

const REQUEST_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 3000;

// Client for the standalone native-input sidecar. Connects directly to the
// sidecar's signed WS endpoint, signs each request with the shared secret, and
// awaits the correlated response. By contract, EVERY failure path resolves
// { ok: false } (never rejects, never hangs) so the caller can fall back to the
// synthetic input path.
export class NativeInputClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<boolean> | null = null;
  private pending = new Map<
    string,
    { resolve: (r: NativeInputResponse) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(private port: number, private secret: string) {}

  private failAll(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ id: "", ok: false, error: "sidecar unavailable" });
    }
    this.pending.clear();
  }

  private ensureConnected(): Promise<boolean> {
    if (this.ws && this.ws.readyState === 1) return Promise.resolve(true);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (!settled) {
          settled = true;
          this.connecting = null;
          resolve(ok);
        }
      };
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${this.port}/sidecar`);
        this.ws = ws;
        const t = setTimeout(() => {
          try {
            ws.close();
          } catch {}
          done(false);
        }, CONNECT_TIMEOUT_MS);
        ws.onopen = () => {
          clearTimeout(t);
          done(true);
        };
        ws.onerror = () => {
          clearTimeout(t);
          this.ws = null;
          this.failAll();
          done(false);
        };
        ws.onclose = () => {
          this.ws = null;
          this.failAll();
        };
        ws.onmessage = (e: MessageEvent) => {
          let env: { payload?: NativeInputResponse };
          try {
            env = JSON.parse((e as { data: string }).data);
          } catch {
            return;
          }
          const r = env.payload;
          if (!r) return;
          const p = this.pending.get(r.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(r.id);
          p.resolve(r);
        };
      } catch {
        this.ws = null;
        done(false);
      }
    });
    return this.connecting;
  }

  async sendGesture(gesture: NativeGesture): Promise<NativeInputResponse> {
    const ok = await this.ensureConnected();
    if (!ok || !this.ws) return { id: "", ok: false, error: "sidecar unavailable" };
    const id = crypto.randomUUID();
    const req: NativeInputRequest = { id, gesture };
    const payloadStr = JSON.stringify(req);
    const signature = await getMessageSignature(payloadStr, this.secret);
    return new Promise<NativeInputResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: "sidecar timeout" });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        this.ws!.send(JSON.stringify({ payload: req, signature }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ id, ok: false, error: "sidecar send failed" });
      }
    });
  }
}
