import { WebSocket, type RawData } from "ws";
import {
  BrokerClientFrame,
  BrokerServerFrame,
  LinkStatus,
} from "./broker-protocol";
import { LinkConfig, linkSecret } from "./link-config";
import {
  SecureChannel,
  buildReject,
  buildWelcome,
  deriveRoomId,
  verifyHello,
} from "./link-crypto";
import { proxyForUrl, tunneledCreateConnection } from "./proxy-tunnel";
import {
  CLOSE_REPLACED,
  HostToRelayFrame,
  parseJsonObject,
  relayEndpoint,
} from "./relay-protocol";

export interface RemoteClientSink {
  send(frame: BrokerServerFrame): void;
  close(reason: string): void;
}

export interface LinkHostBroker {
  attachRemoteClient(
    sink: RemoteClientSink,
    info: { label: string; version: string }
  ): string;
  deliverRemoteFrame(clientId: string, frame: BrokerClientFrame): void;
  detachRemoteClient(clientId: string): void;
}

export interface LinkHostOptions {
  broker: LinkHostBroker;
  version: string;
  log?: (line: string) => void;
  maxSessions?: number;
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  deadAfterMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  connect?: (url: string) => WebSocket;
}

interface PendingSession {
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

interface EstablishedSession {
  cid: string;
  clientId: string;
  label: string;
  version: string;
  connectedAt: number;
  channel: SecureChannel;
  sink: RemoteClientSink;
}

export class LinkHost {
  private readonly broker: LinkHostBroker;
  private readonly version: string;
  private readonly log: (line: string) => void;
  private readonly maxSessions: number;
  private readonly handshakeTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly deadAfterMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly customConnect?: (url: string) => WebSocket;

  private currentConfig: LinkConfig | null = null;
  private ws: WebSocket | null = null;
  private relayConnected = false;
  private lastError?: string;
  /** The error event of the current relay socket, read by its close handler. */
  private socketError?: string;
  private closed = false;

  private lastFrameReceivedAt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  private currentReconnectDelay: number;
  private connectEpoch = 0;

  private readonly pendingSessions = new Map<string, PendingSession>();
  private readonly establishedSessions = new Map<string, EstablishedSession>();

  constructor(opts: LinkHostOptions) {
    this.broker = opts.broker;
    this.version = opts.version;
    this.log = opts.log ?? (() => {});
    this.maxSessions = opts.maxSessions ?? 8;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
    this.pingIntervalMs = opts.pingIntervalMs ?? 25_000;
    this.deadAfterMs = opts.deadAfterMs ?? 70_000;
    this.reconnectMinMs = opts.reconnectMinMs ?? 1_000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;
    this.customConnect = opts.connect;
    this.currentReconnectDelay = this.reconnectMinMs;
  }

  apply(config: LinkConfig | null): void {
    if (this.closed) {
      return;
    }

    if (!config || !config.enabled) {
      this.currentConfig = config;
      this.kickAllSessions("the remote link was turned off on this computer");
      this.stopRelayConnection();
      this.lastError = undefined;
      return;
    }

    if (
      this.currentConfig &&
      this.currentConfig.enabled &&
      this.currentConfig.secret === config.secret &&
      this.currentConfig.relayUrl === config.relayUrl
    ) {
      this.currentConfig = config;
      return;
    }

    const secretChanged =
      !this.currentConfig || this.currentConfig.secret !== config.secret;
    const relayChanged =
      !this.currentConfig || this.currentConfig.relayUrl !== config.relayUrl;

    this.currentConfig = config;
    const kickReason = secretChanged
      ? "the link token was rotated"
      : "reconnecting to new relay";

    this.kickAllSessions(kickReason);
    this.stopRelayConnection();
    this.currentReconnectDelay = this.reconnectMinMs;
    this.connectRelay();
  }

  status(): LinkStatus {
    const res: LinkStatus = {
      enabled: this.isActive(),
      relayConnected: this.relayConnected,
      sessions: [...this.establishedSessions.values()].map((s) => ({
        id: s.clientId,
        label: s.label,
        connectedAt: s.connectedAt,
        version: s.version,
      })),
    };
    if (this.currentConfig) {
      res.relayUrl = this.currentConfig.relayUrl;
      try {
        const sec = linkSecret(this.currentConfig);
        res.roomHint = deriveRoomId(sec).slice(0, 6);
      } catch {
        /* ignore */
      }
    }
    if (this.lastError) {
      res.lastError = this.lastError;
    }
    return res;
  }

  isActive(): boolean {
    return (
      !this.closed && this.currentConfig !== null && this.currentConfig.enabled
    );
  }

  close(): void {
    this.closed = true;
    this.connectEpoch++;
    this.clearTimers();
    this.kickAllSessions("FoxPilot on this computer is shutting down");
    this.stopRelayConnection();
  }

  private isRelaySocketOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.healthyTimer) {
      clearTimeout(this.healthyTimer);
      this.healthyTimer = null;
    }
  }

  private kickAllSessions(reason: string): void {
    for (const [cid, pending] of this.pendingSessions) {
      clearTimeout(pending.timer);
      this.sendToRelay({ t: "kick", cid, reason });
    }
    this.pendingSessions.clear();

    for (const [cid, session] of this.establishedSessions) {
      this.sendToRelay({ t: "kick", cid, reason });
      this.broker.detachRemoteClient(session.clientId);
    }
    this.establishedSessions.clear();
  }

  private stopRelayConnection(): void {
    this.connectEpoch++;
    this.clearTimers();
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    this.relayConnected = false;
  }

  private sendToRelay(frame: HostToRelayFrame): void {
    if (this.isRelaySocketOpen()) {
      try {
        this.ws!.send(JSON.stringify(frame));
      } catch {
        /* ignore */
      }
    }
  }

  private kickAndDetach(cid: string, reason: string): void {
    if (this.pendingSessions.has(cid)) {
      clearTimeout(this.pendingSessions.get(cid)!.timer);
      this.pendingSessions.delete(cid);
    }
    if (this.establishedSessions.has(cid)) {
      const session = this.establishedSessions.get(cid)!;
      this.establishedSessions.delete(cid);
      this.broker.detachRemoteClient(session.clientId);
      this.log(
        `Link: remote session ${session.clientId} "${session.label}" disconnected`
      );
    }
    this.sendToRelay({ t: "kick", cid, reason });
  }

  private connectRelay(): void {
    if (!this.isActive() || !this.currentConfig) {
      return;
    }

    const epoch = ++this.connectEpoch;
    this.clearTimers();

    let endpoint: string;
    try {
      const secret = linkSecret(this.currentConfig);
      const roomId = deriveRoomId(secret);
      endpoint = relayEndpoint(this.currentConfig.relayUrl, roomId, "host");
    } catch (err) {
      this.lastError = `Invalid link config: ${(err as Error).message}`;
      return;
    }

    if (this.customConnect) {
      const ws = this.customConnect(endpoint);
      this.attachWs(ws, epoch);
      return;
    }

    const proxy = proxyForUrl(endpoint);
    if (proxy) {
      tunneledCreateConnection(endpoint)
        .then((createConnection) => {
          if (this.closed || this.connectEpoch !== epoch || !this.isActive()) {
            return;
          }
          const ws = new WebSocket(endpoint, {
            perMessageDeflate: false,
            handshakeTimeout: 15_000,
            maxPayload: 8 * 1024 * 1024,
            createConnection,
          });
          this.attachWs(ws, epoch);
        })
        .catch((err) => {
          if (this.closed || this.connectEpoch !== epoch || !this.isActive()) {
            return;
          }
          this.handleConnectionFailure(
            `Proxy connection failed: ${(err as Error).message}`,
            epoch
          );
        });
    } else {
      const ws = new WebSocket(endpoint, {
        perMessageDeflate: false,
        handshakeTimeout: 15_000,
        maxPayload: 8 * 1024 * 1024,
      });
      this.attachWs(ws, epoch);
    }
  }

  private attachWs(ws: WebSocket, epoch: number): void {
    this.ws = ws;
    this.socketError = undefined;

    // Register message, close, and error handlers immediately before open
    ws.on("open", () => {
      if (this.connectEpoch !== epoch) return;
      this.onRelayOpen(ws, epoch);
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (this.connectEpoch !== epoch) return;
      this.onRelayMessage(data, isBinary);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      if (this.connectEpoch !== epoch) return;
      this.onRelayClose(code, reason.toString(), epoch);
    });

    ws.on("error", (err: Error) => {
      if (this.connectEpoch !== epoch) return;
      this.onRelayError(err);
    });
  }

  private onRelayOpen(ws: WebSocket, epoch: number): void {
    this.relayConnected = true;
    this.lastError = undefined;
    this.lastFrameReceivedAt = Date.now();

    const roomHint = this.status().roomHint ?? "";
    this.log(
      `Link: connected to relay ${this.currentConfig?.relayUrl} (room ${roomHint}…)`
    );

    this.pingTimer = setInterval(() => {
      if (this.isRelaySocketOpen()) {
        try {
          this.ws!.send("ping");
        } catch {
          /* ignore */
        }
        if (Date.now() - this.lastFrameReceivedAt > this.deadAfterMs) {
          this.log(
            "Link: relay connection timed out (no frames received); terminating"
          );
          this.ws!.terminate();
        }
      }
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();

    this.healthyTimer = setTimeout(() => {
      this.currentReconnectDelay = this.reconnectMinMs;
    }, 60_000);
    this.healthyTimer.unref?.();
  }

  private onRelayMessage(data: RawData, isBinary: boolean): void {
    this.lastFrameReceivedAt = Date.now();
    if (isBinary) {
      return;
    }
    const raw = data.toString();
    if (raw === "pong") {
      return;
    }

    const frame = parseJsonObject(raw);
    if (!frame || typeof frame.t !== "string") {
      return;
    }

    if (frame.t === "open") {
      const cid = typeof frame.cid === "string" ? frame.cid : "";
      if (!cid) return;
      if (this.pendingSessions.has(cid)) {
        clearTimeout(this.pendingSessions.get(cid)!.timer);
        this.pendingSessions.delete(cid);
      }
      if (this.establishedSessions.has(cid)) {
        const old = this.establishedSessions.get(cid)!;
        this.establishedSessions.delete(cid);
        this.broker.detachRemoteClient(old.clientId);
      }

      const timer = setTimeout(() => {
        this.pendingSessions.delete(cid);
        this.log(`Link: handshake timed out for client ${cid}`);
        this.sendToRelay({ t: "kick", cid, reason: "handshake timeout" });
      }, this.handshakeTimeoutMs);
      timer.unref?.();
      this.pendingSessions.set(cid, { timer, createdAt: Date.now() });
      return;
    }

    if (frame.t === "closed") {
      const cid = typeof frame.cid === "string" ? frame.cid : "";
      if (!cid) return;
      if (this.pendingSessions.has(cid)) {
        clearTimeout(this.pendingSessions.get(cid)!.timer);
        this.pendingSessions.delete(cid);
      }
      if (this.establishedSessions.has(cid)) {
        const session = this.establishedSessions.get(cid)!;
        this.establishedSessions.delete(cid);
        this.broker.detachRemoteClient(session.clientId);
        this.log(
          `Link: remote session ${session.clientId} "${session.label}" disconnected`
        );
      }
      return;
    }

    if (frame.t === "msg") {
      const cid = typeof frame.cid === "string" ? frame.cid : "";
      const d = typeof frame.d === "string" ? frame.d : "";
      if (!cid || !d) return;

      if (this.pendingSessions.has(cid)) {
        this.handlePendingMessage(cid, d);
        return;
      }

      if (this.establishedSessions.has(cid)) {
        this.handleEstablishedMessage(cid, d);
        return;
      }
    }
  }

  private handlePendingMessage(cid: string, d: string): void {
    const pending = this.pendingSessions.get(cid);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSessions.delete(cid);

    if (!this.currentConfig) return;
    let secret: Buffer;
    try {
      secret = linkSecret(this.currentConfig);
    } catch {
      return;
    }

    const check = verifyHello(secret, d);
    if (!check.ok) {
      this.log(`Link: client ${cid} failed handshake: ${check.reason}`);
      this.sendToRelay({ t: "kick", cid, reason: "invalid handshake" });
      return;
    }

    if (this.establishedSessions.size >= this.maxSessions) {
      const reason = `too many remote sessions (max ${this.maxSessions})`;
      const rejectFrame = buildReject(secret, check.hello, reason);
      this.sendToRelay({ t: "msg", cid, d: rejectFrame });
      this.sendToRelay({ t: "kick", cid, reason });
      return;
    }

    let welcome: string;
    let channel: SecureChannel;
    try {
      const built = buildWelcome(secret, check.hello, {
        version: this.version,
      });
      welcome = built.welcome;
      channel = built.channel;
    } catch (err) {
      this.log(
        `Link: client ${cid} handshake error: ${(err as Error).message}`
      );
      this.sendToRelay({ t: "kick", cid, reason: "invalid handshake" });
      return;
    }

    this.sendToRelay({ t: "msg", cid, d: welcome });

    const sink: RemoteClientSink = {
      send: (serverFrame: BrokerServerFrame) => {
        if (!this.isRelaySocketOpen()) return;
        try {
          const parts = channel.seal(JSON.stringify(serverFrame));
          for (const part of parts) {
            this.sendToRelay({ t: "msg", cid, d: part });
          }
        } catch (err) {
          this.log(
            `Link: failed to seal frame for ${cid}: ${(err as Error).message}`
          );
          // seal() refuses an oversized message without consuming a sequence
          // number, so the channel still works: answer the call with an error
          // instead of leaving the remote caller to time out.
          if (
            serverFrame.kind === "tool-result" ||
            serverFrame.kind === "tool-error"
          ) {
            try {
              const parts = channel.seal(
                JSON.stringify({
                  kind: "tool-error",
                  requestId: serverFrame.requestId,
                  errorMessage: `The browser's reply was too large to send over the remote link (${(err as Error).message}).`,
                })
              );
              for (const part of parts) {
                this.sendToRelay({ t: "msg", cid, d: part });
              }
            } catch {
              /* the channel is gone; the remote side reports a missing reply */
            }
          }
        }
      },
      close: (reason: string) => {
        this.kickAndDetach(cid, reason);
      },
    };

    const clientId = this.broker.attachRemoteClient(sink, {
      label: check.hello.label,
      version: check.hello.version,
    });

    this.establishedSessions.set(cid, {
      cid,
      clientId,
      label: check.hello.label,
      version: check.hello.version,
      connectedAt: Date.now(),
      channel,
      sink,
    });

    this.log(
      `Link: remote session ${clientId} "${check.hello.label}" connected (FoxPilot ${check.hello.version})`
    );
  }

  private handleEstablishedMessage(cid: string, d: string): void {
    const session = this.establishedSessions.get(cid);
    if (!session) return;

    let plaintext: string | null;
    try {
      plaintext = session.channel.open(d);
    } catch (err) {
      this.log(
        `Link: protocol error on session ${session.clientId}: ${(err as Error).message}`
      );
      this.kickAndDetach(cid, "protocol error");
      return;
    }

    if (plaintext === null) {
      return;
    }

    let frameObj: unknown;
    try {
      frameObj = JSON.parse(plaintext);
    } catch {
      this.log(`Link: invalid json on session ${session.clientId}`);
      this.kickAndDetach(cid, "protocol error");
      return;
    }

    if (
      !frameObj ||
      typeof frameObj !== "object" ||
      Array.isArray(frameObj)
    ) {
      this.log(`Link: malformed frame on session ${session.clientId}`);
      this.kickAndDetach(cid, "protocol error");
      return;
    }

    const obj = frameObj as Record<string, unknown>;
    const isValidTool =
      obj.kind === "tool" &&
      typeof obj.requestId === "string" &&
      typeof obj.message === "object" &&
      obj.message !== null &&
      typeof (obj.message as Record<string, unknown>).cmd === "string";

    const isValidControl =
      obj.kind === "control" &&
      typeof obj.requestId === "string" &&
      typeof obj.control === "object" &&
      obj.control !== null &&
      typeof (obj.control as Record<string, unknown>).control === "string";

    if (!isValidTool && !isValidControl) {
      this.log(`Link: invalid frame kind on session ${session.clientId}`);
      this.kickAndDetach(cid, "protocol error");
      return;
    }

    this.broker.deliverRemoteFrame(
      session.clientId,
      obj as unknown as BrokerClientFrame
    );
  }

  private onRelayError(err: Error): void {
    // ws emits "close" right after; keep the cause so the close handler does
    // not replace "getaddrinfo ENOTFOUND" or "Unexpected server response: 404"
    // with a bare "code 1006".
    this.socketError = err.message;
    this.lastError = `relay connection error: ${err.message}`;
  }

  private onRelayClose(code: number, reason: string, epoch: number): void {
    this.relayConnected = false;
    this.clearTimers();

    for (const [cid, pending] of this.pendingSessions) {
      clearTimeout(pending.timer);
    }
    this.pendingSessions.clear();

    for (const [cid, session] of this.establishedSessions) {
      this.broker.detachRemoteClient(session.clientId);
      this.log(
        `Link: remote session ${session.clientId} "${session.label}" disconnected`
      );
    }
    this.establishedSessions.clear();

    if (code === CLOSE_REPLACED) {
      this.lastError =
        "another FoxPilot host took over this link token (code 4000)";
    } else if (this.socketError) {
      this.lastError = `relay connection error: ${this.socketError}`;
    } else {
      this.lastError = `relay connection closed (code ${code}${reason ? `: ${reason}` : ""})`;
    }
    this.socketError = undefined;

    this.scheduleReconnect(code === CLOSE_REPLACED);
  }

  private handleConnectionFailure(reason: string, epoch: number): void {
    this.relayConnected = false;
    this.lastError = reason;
    this.scheduleReconnect(false);
  }

  private scheduleReconnect(replaced: boolean): void {
    if (this.closed || !this.isActive()) {
      return;
    }

    const baseDelay = this.currentReconnectDelay;
    this.currentReconnectDelay = Math.min(
      this.reconnectMaxMs,
      Math.round(this.currentReconnectDelay * 1.5)
    );

    const jitter = 1 + (Math.random() * 0.4 - 0.2); // +/-20%
    let delay = Math.round(baseDelay * jitter);
    if (replaced) {
      delay = Math.max(30_000, delay);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectRelay();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
