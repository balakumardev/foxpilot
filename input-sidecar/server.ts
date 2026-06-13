import { WebSocketServer, WebSocket } from "ws";
import * as http from "http";
import * as crypto from "crypto";
import { NativeInputRequest, NativeInputResponse } from "@foxpilot/common";
import { InputBackend, runGesture } from "./input-backend";

function sign(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}
function verify(secret: string, payload: string, signature: string): boolean {
  if (typeof signature !== "string" || !signature) return false;
  const exp = Buffer.from(sign(secret, payload), "utf8");
  const act = Buffer.from(signature, "utf8");
  return exp.length === act.length && crypto.timingSafeEqual(exp, act);
}

export interface SidecarOptions { port: number; host?: string; secret: string; backend: InputBackend }

export class SidecarServer {
  private http: http.Server;
  private wss: WebSocketServer;
  private opts: SidecarOptions;
  constructor(opts: SidecarOptions) {
    this.opts = opts;
    this.http = http.createServer();
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path !== "/sidecar") { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConn(ws));
    });
  }
  private onConn(ws: WebSocket) {
    ws.on("message", async (data) => {
      let env: { payload?: NativeInputRequest; signature?: string };
      try { env = JSON.parse(data.toString()); } catch { return; }
      const payloadStr = JSON.stringify(env.payload);
      const reply = (r: NativeInputResponse) => ws.send(JSON.stringify({ payload: r, signature: sign(this.opts.secret, JSON.stringify(r)) }));
      if (!env.payload || !verify(this.opts.secret, payloadStr, env.signature || "")) {
        reply({ id: env.payload?.id ?? "?", ok: false, error: "bad signature" });
        return;
      }
      const res = await runGesture(this.opts.backend, env.payload.gesture);
      reply({ id: env.payload.id, ...res });
    });
  }
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.opts.port, this.opts.host ?? "127.0.0.1", () => resolve());
    });
  }
  getPort(): number { const a = this.http.address(); return typeof a === "object" && a ? a.port : this.opts.port; }
  close(): Promise<void> { return new Promise((r) => { this.wss.close(); this.http.close(() => r()); }); }
}
