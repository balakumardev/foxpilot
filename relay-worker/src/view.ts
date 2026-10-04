import type { RelaySocket, RoomView } from "../../mcp-server/relay-room";
import type { RelayRole } from "../../mcp-server/relay-protocol";

export interface SocketAttachment {
  role: RelayRole;
  cid?: string;
  sid: string;
  at: number;
  rejected?: boolean;
  closed?: boolean;
}

export interface DurableWebSocket extends RelaySocket {
  readyState: number;
  deserializeAttachment(): unknown;
}

export function getSocketAttachment(
  ws: DurableWebSocket
): SocketAttachment | null {
  try {
    const data = ws.deserializeAttachment();
    if (data && typeof data === "object") {
      return data as SocketAttachment;
    }
    return null;
  } catch {
    return null;
  }
}

export class DurableRoomView<S extends DurableWebSocket = DurableWebSocket>
  implements RoomView<S>
{
  constructor(
    private readonly getWebSockets: (tag?: string) => S[],
    private readonly excluded?: S
  ) {}

  private isOpenAndNotExcluded(ws: S): boolean {
    if (ws.readyState !== 1) {
      return false;
    }
    if (this.excluded) {
      if (ws === this.excluded) {
        return false;
      }
      const wsMeta = getSocketAttachment(ws);
      const exMeta = getSocketAttachment(this.excluded);
      if (wsMeta && exMeta && wsMeta.sid === exMeta.sid) {
        return false;
      }
    }
    const meta = getSocketAttachment(ws);
    if (meta?.rejected || meta?.closed) {
      return false;
    }
    return true;
  }

  host(): S | undefined {
    const hosts = this.getWebSockets("host");
    let best: S | undefined;
    let bestMeta: SocketAttachment | undefined;

    for (const ws of hosts) {
      if (!this.isOpenAndNotExcluded(ws)) {
        continue;
      }
      const meta = getSocketAttachment(ws);
      if (!meta) {
        continue;
      }
      if (
        !bestMeta ||
        meta.at > bestMeta.at ||
        (meta.at === bestMeta.at && meta.sid > bestMeta.sid)
      ) {
        best = ws;
        bestMeta = meta;
      }
    }
    return best;
  }

  staleHosts(): S[] {
    const live = this.host();
    if (!live) {
      return [];
    }
    const liveMeta = getSocketAttachment(live);
    if (!liveMeta) {
      return [];
    }
    const hosts = this.getWebSockets("host");
    const result: S[] = [];
    for (const ws of hosts) {
      if (!this.isOpenAndNotExcluded(ws)) {
        continue;
      }
      const meta = getSocketAttachment(ws);
      if (!meta) {
        continue;
      }
      if (meta.sid !== liveMeta.sid) {
        result.push(ws);
      }
    }
    return result;
  }

  isLiveHost(socket: S): boolean {
    const live = this.host();
    if (!live) {
      return false;
    }
    const liveMeta = getSocketAttachment(live);
    const sockMeta = getSocketAttachment(socket);
    if (!liveMeta || !sockMeta) {
      return false;
    }
    return liveMeta.sid === sockMeta.sid;
  }

  clients(): Array<{ cid: string; socket: S }> {
    const sockets = this.getWebSockets("client");
    const result: Array<{ cid: string; socket: S }> = [];
    for (const ws of sockets) {
      if (!this.isOpenAndNotExcluded(ws)) {
        continue;
      }
      const meta = getSocketAttachment(ws);
      if (meta && typeof meta.cid === "string") {
        result.push({ cid: meta.cid, socket: ws });
      }
    }
    return result;
  }

  client(cid: string): S | undefined {
    const sockets = this.getWebSockets("cid:" + cid);
    for (const ws of sockets) {
      if (this.isOpenAndNotExcluded(ws)) {
        return ws;
      }
    }
    return undefined;
  }
}
