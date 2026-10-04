/**
 * Remote link client for FoxPilot.
 *
 * Connects to the relay as a CLIENT of a link room, runs the end-to-end
 * encrypted handshake with the user's local broker (the HOST), and exposes
 * send() / onFrame() for BrokerClientFrames / BrokerServerFrames over the
 * established SecureChannel.
 */

import * as net from "net";
import WebSocket from "ws";
import {
  BrokerClientFrame,
  BrokerServerFrame,
} from "./broker-protocol";
import {
  ClientHandshake,
  ClientHandshakeResult,
  SecureChannel,
  deriveRoomId,
  isHandshakeFrame,
  parseLinkToken,
} from "./link-crypto";
import {
  proxyForUrl,
  redactProxyUrl,
  tunneledCreateConnection,
} from "./proxy-tunnel";
import {
  CLOSE_KICKED,
  CLOSE_ROOM_FULL,
  DEFAULT_RELAY_URL,
  RELAY_PING,
  RELAY_PONG,
  parseJsonObject,
  relayEndpoint,
} from "./relay-protocol";

export type LinkCloseReason =
  | "host-offline"
  | "kicked"
  | "network"
  | "protocol"
  | "closed-by-client";

export class LinkConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkConnectError";
  }
}

export interface LinkClientOptions {
  token: string;
  relayUrl?: string;
  label: string;
  version: string;
  onFrame: (frame: BrokerServerFrame) => void;
  onClose: (reason: LinkCloseReason, detail: string) => void;
  hostWaitMs?: number;
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  deadAfterMs?: number;
  connect?: (url: string) => WebSocket;
}

function formatRelayUnreachable(
  relayBase: string,
  relayHost: string,
  cause: string,
  proxy?: string
): string {
  const proxyPart = proxy ? ` (connected through proxy ${redactProxyUrl(proxy)})` : "";
  return `Could not reach the FoxPilot relay at ${relayBase}: ${cause}.${proxyPart} If this machine can only reach the internet through a proxy, set HTTPS_PROXY. In a Claude Code cloud environment, allow the host ${relayHost} in the environment's network access settings.`;
}

/**
 * Whether this process should run as a remote-link client: FOXPILOT_LINK is
 * set to something other than blanks or an unexpanded "${...}" placeholder
 * (an MCP host that did not substitute its config variable).
 */
export function linkTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.FOXPILOT_LINK;
  if (typeof token !== "string" || token.trim() === "" || token.includes("${")) {
    return null;
  }
  return token.trim();
}

export function linkTokenError(token: string): string | null {
  try {
    parseLinkToken(token);
    return null;
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const prefix = "Invalid FoxPilot link token: ";
    const reason = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    return `FOXPILOT_LINK is not a valid FoxPilot link token (${reason}). On the computer with your browser run \`npx foxpilot-mcp link\` and copy the token it prints.`;
  }
}

export class LinkClientConnection {
  readonly peerVersion: string;
  private readonly ws: WebSocket;
  private readonly channel: SecureChannel;
  private readonly opts: LinkClientOptions;
  private readonly pingIntervalMs: number;
  private readonly deadAfterMs: number;
  private openState = true;
  private closed = false;
  private clientClosed = false;
  private lastReceived = Date.now();
  private pingTimer: NodeJS.Timeout | null = null;
  private deadTimer: NodeJS.Timeout | null = null;

  constructor(
    ws: WebSocket,
    channel: SecureChannel,
    peerVersion: string,
    opts: LinkClientOptions,
    pingIntervalMs: number,
    deadAfterMs: number
  ) {
    this.ws = ws;
    this.channel = channel;
    this.peerVersion = peerVersion;
    this.opts = opts;
    this.pingIntervalMs = pingIntervalMs;
    this.deadAfterMs = deadAfterMs;

    this.ws.on("message", (data) => this.onMessage(data.toString()));
    this.ws.on("close", (code, reason) => this.onSocketClose(code, reason));
    this.ws.on("error", () => {
      /* close listener runs */
    });

    this.pingTimer = setInterval(() => {
      if (this.isOpen()) {
        try {
          this.ws.send(RELAY_PING);
        } catch {
          /* ignore */
        }
      }
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();

    this.deadTimer = setInterval(() => {
      if (Date.now() - this.lastReceived >= this.deadAfterMs) {
        try {
          this.ws.terminate();
        } catch {
          /* ignore */
        }
        this.triggerClose("network", "dead keepalive");
      }
    }, Math.min(this.pingIntervalMs, 5000));
    this.deadTimer.unref?.();
  }

  static async open(opts: LinkClientOptions): Promise<LinkClientConnection> {
    const tokenErr = linkTokenError(opts.token);
    if (tokenErr) {
      throw new LinkConnectError(tokenErr);
    }

    const parsedToken = parseLinkToken(opts.token);
    const roomId = deriveRoomId(parsedToken.secret);
    const relay = opts.relayUrl ?? parsedToken.relayUrl ?? DEFAULT_RELAY_URL;
    const url = relayEndpoint(relay, roomId, "client");
    const relayBase = relay;

    let relayHost: string;
    try {
      relayHost = new URL(url).host;
    } catch {
      relayHost = relay;
    }

    const proxy = proxyForUrl(url);
    const hostWaitMs = opts.hostWaitMs ?? 8_000;
    const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 15_000;
    const pingIntervalMs = opts.pingIntervalMs ?? 25_000;
    const deadAfterMs = opts.deadAfterMs ?? 70_000;

    let createConnection: ((options?: unknown) => net.Socket) | undefined;
    if (!opts.connect && proxy) {
      try {
        createConnection = await tunneledCreateConnection(url);
      } catch (err: unknown) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new LinkConnectError(
          formatRelayUnreachable(relayBase, relayHost, cause, proxy)
        );
      }
    }

    let ws: WebSocket;
    try {
      ws = opts.connect
        ? opts.connect(url)
        : new WebSocket(url, {
            perMessageDeflate: false,
            maxPayload: 8 * 1024 * 1024,
            ...(createConnection ? { createConnection } : {}),
          });
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new LinkConnectError(
        formatRelayUnreachable(relayBase, relayHost, cause, proxy)
      );
    }

    const handshake = new ClientHandshake(parsedToken.secret, {
      label: opts.label,
      version: opts.version,
    });

    return new Promise<LinkClientConnection>((resolve, reject) => {
      let settled = false;
      let lastError: Error | null = null;
      let hostWaitTimer: NodeJS.Timeout | null = null;
      let handshakeTimer: NodeJS.Timeout | null = null;
      let helloSent = false;

      const cleanupPreEstablish = () => {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        if (hostWaitTimer) {
          clearTimeout(hostWaitTimer);
          hostWaitTimer = null;
        }
        ws.removeListener("message", onPreMessage);
        ws.removeListener("close", onPreClose);
        ws.removeListener("error", onPreError);
      };

      handshakeTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanupPreEstablish();
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          reject(
            new LinkConnectError(
              `Timed out connecting to your computer's FoxPilot through the relay at ${relayBase}.`
            )
          );
        }
      }, handshakeTimeoutMs);
      handshakeTimer.unref?.();

      function onPreError(err: Error) {
        lastError = err;
      }

      function onPreClose(code: number, reasonBuf: Buffer) {
        if (settled) return;
        settled = true;
        cleanupPreEstablish();
        if (code === CLOSE_KICKED) {
          reject(
            new LinkConnectError(
              "Your computer's FoxPilot did not accept this link token — it was probably rotated or the link was turned off. Run `npx foxpilot-mcp link` there and update FOXPILOT_LINK."
            )
          );
          return;
        }
        if (code === CLOSE_ROOM_FULL) {
          reject(
            new LinkConnectError(
              "Too many remote sessions are using this link token right now."
            )
          );
          return;
        }
        const cause = lastError
          ? lastError.message
          : reasonBuf && reasonBuf.length > 0
          ? reasonBuf.toString("utf8")
          : `connection closed with code ${code}`;
        reject(
          new LinkConnectError(
            formatRelayUnreachable(relayBase, relayHost, cause, proxy)
          )
        );
      }

      function onPreMessage(data: WebSocket.RawData) {
        if (settled) return;
        const raw = data.toString();
        if (raw === RELAY_PONG || raw === "pong") return;
        const frame = parseJsonObject(raw);
        if (!frame) return;

        if (frame.t === "host") {
          if (frame.online === true) {
            if (hostWaitTimer) {
              clearTimeout(hostWaitTimer);
              hostWaitTimer = null;
            }
            if (!helloSent) {
              helloSent = true;
              try {
                ws.send(JSON.stringify({ t: "msg", d: handshake.hello() }));
              } catch (err: unknown) {
                settled = true;
                cleanupPreEstablish();
                const cause = err instanceof Error ? err.message : String(err);
                reject(
                  new LinkConnectError(
                    formatRelayUnreachable(relayBase, relayHost, cause, proxy)
                  )
                );
              }
            }
          } else {
            if (!helloSent && !hostWaitTimer) {
              hostWaitTimer = setTimeout(() => {
                if (!settled) {
                  settled = true;
                  cleanupPreEstablish();
                  try {
                    ws.terminate();
                  } catch {
                    /* ignore */
                  }
                  reject(
                    new LinkConnectError(
                      "Your computer's FoxPilot is not connected to the relay. On the computer with your browser, run `npx foxpilot-mcp link` (or start any local FoxPilot session) and keep the browser with the FoxPilot extension open, then retry."
                    )
                  );
                }
              }, hostWaitMs);
              hostWaitTimer.unref?.();
            }
          }
          return;
        }

        if (frame.t === "msg" && typeof frame.d === "string") {
          if (isHandshakeFrame(frame.d)) {
            let result: ClientHandshakeResult;
            try {
              result = handshake.finish(frame.d);
            } catch {
              settled = true;
              cleanupPreEstablish();
              try {
                ws.close();
              } catch {
                /* ignore */
              }
              reject(
                new LinkConnectError(
                  "Your computer's FoxPilot did not accept this link token — it was probably rotated or the link was turned off. Run `npx foxpilot-mcp link` there and update FOXPILOT_LINK."
                )
              );
              return;
            }

            if (result.kind === "rejected") {
              settled = true;
              cleanupPreEstablish();
              try {
                ws.close();
              } catch {
                /* ignore */
              }
              reject(
                new LinkConnectError(
                  `Your computer's FoxPilot refused this session: ${result.reason}.`
                )
              );
              return;
            }

            settled = true;
            cleanupPreEstablish();

            const conn = new LinkClientConnection(
              ws,
              result.channel,
              result.peerVersion,
              opts,
              pingIntervalMs,
              deadAfterMs
            );
            resolve(conn);
          }
        }
      }

      ws.on("message", onPreMessage);
      ws.on("close", onPreClose);
      ws.on("error", onPreError);
    });
  }

  isOpen(): boolean {
    return (
      this.openState &&
      !this.clientClosed &&
      !this.closed &&
      this.ws.readyState === WebSocket.OPEN
    );
  }

  send(frame: BrokerClientFrame): void {
    if (!this.isOpen()) {
      throw new Error("FoxPilot link is not connected");
    }
    const plaintext = JSON.stringify(frame);
    const parts = this.channel.seal(plaintext);
    for (const part of parts) {
      this.ws.send(JSON.stringify({ t: "msg", d: part }));
    }
  }

  close(): void {
    if (this.clientClosed || this.closed) {
      return;
    }
    this.clientClosed = true;
    this.closed = true;
    this.openState = false;
    this.cleanup();
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.deadTimer) {
      clearInterval(this.deadTimer);
      this.deadTimer = null;
    }
  }

  private triggerClose(reason: LinkCloseReason, detail: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.openState = false;
    this.cleanup();
    if (!this.clientClosed) {
      this.opts.onClose(reason, detail);
    }
  }

  private failProtocol(detail: string): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.triggerClose("protocol", detail);
  }

  private onMessage(raw: string): void {
    this.lastReceived = Date.now();
    if (raw === RELAY_PONG || raw === "pong") {
      return;
    }
    const frame = parseJsonObject(raw);
    if (!frame) {
      // Relay frames this build does not understand are ignored, like the
      // relay ignores ours, so a newer relay can add frame types. Anything
      // that matters is inside "msg" and authenticated by the channel.
      return;
    }
    if (frame.t === "host") {
      if (frame.online === false) {
        try {
          this.ws.close();
        } catch {
          /* ignore */
        }
        this.triggerClose("host-offline", "host disconnected");
      }
      return;
    }
    if (frame.t === "msg" && typeof frame.d === "string") {
      let plaintext: string | null;
      try {
        plaintext = this.channel.open(frame.d);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.failProtocol(msg);
        return;
      }
      if (plaintext !== null) {
        let serverFrame: any;
        try {
          serverFrame = JSON.parse(plaintext);
        } catch {
          this.failProtocol("invalid JSON plaintext");
          return;
        }
        if (
          serverFrame &&
          typeof serverFrame.requestId === "string" &&
          (serverFrame.kind === "tool-result" ||
            serverFrame.kind === "tool-error" ||
            serverFrame.kind === "control-result")
        ) {
          this.opts.onFrame(serverFrame as BrokerServerFrame);
        } else {
          this.failProtocol("invalid broker frame kind or missing requestId");
        }
      }
      return;
    }
    // Unknown relay frame type: ignored (see above).
  }

  private onSocketClose(code: number, reasonBuf: Buffer): void {
    if (this.clientClosed) {
      return;
    }
    const detail = reasonBuf.toString("utf8");
    if (code === CLOSE_KICKED) {
      this.triggerClose("kicked", detail || "closed by the host");
    } else {
      this.triggerClose(
        "network",
        detail || `socket closed with code ${code}`
      );
    }
  }
}
