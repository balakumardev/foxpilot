/**
 * A self-hostable FoxPilot relay (`npx foxpilot-mcp relay`).
 *
 * Same protocol as the hosted Cloudflare relay: it pairs a link's host (the
 * local broker) with its remote clients by room id and forwards opaque,
 * end-to-end-encrypted strings. Rooms live in memory and disappear when the
 * last socket leaves. Useful behind a VPN/Tailscale/SSH tunnel, or on a VPS
 * when you'd rather not use the hosted relay. The tests also run links
 * through it.
 */

import * as crypto from "crypto";
import * as http from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  HEALTH_PATH,
  MAX_RELAY_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  parseRoomPath,
} from "./relay-protocol";
import {
  RoomView,
  formatClientId,
  onClientJoin,
  onClientLeave,
  onClientMessage,
  onHostJoin,
  onHostLeave,
  onHostMessage,
} from "./relay-room";

/** How often the relay pings each socket at the WebSocket level. */
const HEARTBEAT_MS = 30_000;

interface Room {
  /** Hosts in join order; the last open one is the live host. */
  hosts: WebSocket[];
  clients: Map<string, WebSocket>;
}

class MapRoomView implements RoomView<WebSocket> {
  constructor(private readonly room: Room) {}

  host(): WebSocket | undefined {
    for (let i = this.room.hosts.length - 1; i >= 0; i--) {
      if (this.room.hosts[i].readyState === WebSocket.OPEN) {
        return this.room.hosts[i];
      }
    }
    return undefined;
  }

  staleHosts(): WebSocket[] {
    const live = this.host();
    return this.room.hosts.filter(
      (ws) => ws !== live && ws.readyState === WebSocket.OPEN
    );
  }

  isLiveHost(socket: WebSocket): boolean {
    return this.host() === socket;
  }

  clients(): Array<{ cid: string; socket: WebSocket }> {
    return [...this.room.clients].map(([cid, socket]) => ({ cid, socket }));
  }

  client(cid: string): WebSocket | undefined {
    return this.room.clients.get(cid);
  }
}

export interface RelayServerOptions {
  port: number;
  /** Bind address. Defaults to 127.0.0.1; pass 0.0.0.0 to serve a network. */
  host?: string;
  /** Diagnostics sink (never receives payloads). Defaults to silence. */
  log?: (line: string) => void;
}

export class RelayServer {
  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, Room>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: RelayServerOptions) {
    this.log = opts.log ?? (() => {});
    this.httpServer = http.createServer((req, res) => this.onHttp(req, res));
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_RELAY_FRAME_BYTES,
      // Payloads are encrypted, so compression buys nothing and costs CPU.
      perMessageDeflate: false,
    });
    this.httpServer.on("upgrade", (req, socket, head) =>
      this.onUpgrade(req, socket, head)
    );
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.opts.port, this.opts.host ?? "127.0.0.1", () => {
        this.httpServer.removeListener("error", reject);
        resolve();
      });
    });
  }

  getPort(): number {
    const addr = this.httpServer.address();
    return addr && typeof addr === "object" ? addr.port : this.opts.port;
  }

  /** Counts for diagnostics and tests. */
  stats(): { rooms: number; hosts: number; clients: number } {
    let hosts = 0;
    let clients = 0;
    for (const room of this.rooms.values()) {
      hosts += room.hosts.length;
      clients += room.clients.size;
    }
    return { rooms: this.rooms.size, hosts, clients };
  }

  close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const room of this.rooms.values()) {
      for (const ws of [...room.hosts, ...room.clients.values()]) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
    }
    this.rooms.clear();
    this.wss.close();
    return new Promise((resolve) => this.httpServer.close(() => resolve()));
  }

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && (path === HEALTH_PATH || path === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "foxpilot-relay",
          protocol: RELAY_PROTOCOL_VERSION,
        })
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const route = parseRoomPath((req.url ?? "/").split("?")[0]);
    if (!route) {
      try {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.alive.set(ws, true);
      ws.on("pong", () => this.alive.set(ws, true));
      ws.on("error", () => {
        /* the close handler cleans up */
      });
      if (route.role === "host") {
        this.attachHost(route.roomId, ws);
      } else {
        this.attachClient(route.roomId, ws);
      }
    });
  }

  private room(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { hosts: [], clients: new Map() };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private dropIfEmpty(roomId: string, room: Room): void {
    if (room.hosts.length === 0 && room.clients.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  private attachHost(roomId: string, ws: WebSocket): void {
    const room = this.room(roomId);
    const view = new MapRoomView(room);
    room.hosts.push(ws);
    this.log(`relay: host joined room ${roomId.slice(0, 6)}…`);
    onHostJoin(view, ws);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        onHostMessage(view, ws, data.toString());
      }
    });
    ws.on("close", () => {
      const i = room.hosts.indexOf(ws);
      if (i >= 0) {
        room.hosts.splice(i, 1);
      }
      this.log(`relay: host left room ${roomId.slice(0, 6)}…`);
      onHostLeave(view);
      this.dropIfEmpty(roomId, room);
    });
  }

  private attachClient(roomId: string, ws: WebSocket): void {
    const room = this.room(roomId);
    const view = new MapRoomView(room);
    const cid = formatClientId(crypto.randomBytes(8));
    room.clients.set(cid, ws);
    if (!onClientJoin(view, cid, ws)) {
      room.clients.delete(cid);
      this.dropIfEmpty(roomId, room);
      return;
    }
    this.log(`relay: client joined room ${roomId.slice(0, 6)}…`);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        onClientMessage(view, cid, ws, data.toString());
      }
    });
    ws.on("close", () => {
      if (room.clients.get(cid) === ws) {
        room.clients.delete(cid);
        onClientLeave(view, cid);
      }
      this.log(`relay: client left room ${roomId.slice(0, 6)}…`);
      this.dropIfEmpty(roomId, room);
    });
  }

  /** Terminate sockets that missed a heartbeat, ping the rest. */
  private sweep(): void {
    for (const ws of this.wss.clients) {
      if (this.alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      this.alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* closing */
      }
    }
  }
}
