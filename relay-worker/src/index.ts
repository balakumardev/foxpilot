import { DurableObject } from "cloudflare:workers";
import { RELAY_PING, RELAY_PONG } from "../../mcp-server/relay-protocol";
import {
  formatClientId,
  onClientJoin,
  onClientLeave,
  onClientMessage,
  onHostJoin,
  onHostLeave,
  onHostMessage,
} from "../../mcp-server/relay-room";
import type { RelayRole } from "../../mcp-server/relay-protocol";
import {
  DurableRoomView,
  getSocketAttachment,
  type DurableWebSocket,
  type SocketAttachment,
} from "./view";
import { handleRelayRequest, type RelayEnv } from "./route";

export class RelayRoom extends DurableObject<RelayEnv> {
  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG)
    );
  }

  private createView(excluded?: DurableWebSocket): DurableRoomView {
    return new DurableRoomView(
      (tag?: string) =>
        (tag ? this.ctx.getWebSockets(tag) : this.ctx.getWebSockets()) as DurableWebSocket[],
      excluded
    );
  }

  async fetch(request: Request): Promise<Response> {
    const role = request.headers.get("X-Relay-Role") as RelayRole | null;
    if (role !== "host" && role !== "client") {
      return new Response("Invalid role", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const sid = crypto.randomUUID();

    if (role === "host") {
      let maxAt = 0;
      for (const ws of this.ctx.getWebSockets("host")) {
        const meta = getSocketAttachment(ws as DurableWebSocket);
        if (meta && meta.at > maxAt) {
          maxAt = meta.at;
        }
      }
      const at = Math.max(Date.now(), maxAt + 1);

      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({
        role: "host",
        sid,
        at,
      } satisfies SocketAttachment);
      const view = this.createView();
      onHostJoin(view, server as DurableWebSocket);
      return new Response(null, { status: 101, webSocket: client });
    } else {
      const at = Date.now();
      const cidBytes = crypto.getRandomValues(new Uint8Array(8));
      const cid = formatClientId(cidBytes);

      this.ctx.acceptWebSocket(server, ["client", "cid:" + cid]);
      server.serializeAttachment({
        role: "client",
        cid,
        sid,
        at,
      } satisfies SocketAttachment);
      const view = this.createView();
      const joined = onClientJoin(view, cid, server as DurableWebSocket);
      if (!joined) {
        server.serializeAttachment({
          role: "client",
          cid,
          sid,
          at,
          rejected: true,
        } satisfies SocketAttachment);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== "string") {
      return;
    }
    const attachment = getSocketAttachment(ws as DurableWebSocket);
    if (!attachment || attachment.rejected || attachment.closed) {
      return;
    }
    const view = this.createView();
    if (attachment.role === "host") {
      onHostMessage(view, ws as DurableWebSocket, message);
    } else if (attachment.role === "client" && attachment.cid) {
      onClientMessage(view, attachment.cid, ws as DurableWebSocket, message);
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    const attachment = getSocketAttachment(ws as DurableWebSocket);
    if (!attachment || attachment.rejected || attachment.closed) {
      return;
    }
    try {
      ws.serializeAttachment({ ...attachment, closed: true });
    } catch {
      /* ignore */
    }
    const view = this.createView(ws as DurableWebSocket);
    if (attachment.role === "host") {
      onHostLeave(view);
    } else if (attachment.role === "client" && attachment.cid) {
      onClientLeave(view, attachment.cid);
    }
    try {
      ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const attachment = getSocketAttachment(ws as DurableWebSocket);
    if (!attachment || attachment.rejected || attachment.closed) {
      return;
    }
    try {
      ws.serializeAttachment({ ...attachment, closed: true });
    } catch {
      /* ignore */
    }
    const view = this.createView(ws as DurableWebSocket);
    if (attachment.role === "host") {
      onHostLeave(view);
    } else if (attachment.role === "client" && attachment.cid) {
      onClientLeave(view, attachment.cid);
    }
    try {
      ws.close(1006, "WebSocket error");
    } catch {
      /* ignore */
    }
  }
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handleRelayRequest(request, env);
  },
};
