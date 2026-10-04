import WebSocket from "ws";
import * as net from "net";
import { RelayServer } from "../relay-server";
import { relayEndpoint } from "../relay-protocol";
import {
  LinkClientConnection,
  LinkConnectError,
  linkTokenError,
  LinkCloseReason,
} from "../link-client";
import {
  generateLinkSecret,
  deriveRoomId,
  formatLinkToken,
  verifyHello,
  buildWelcome,
  buildReject,
  SecureChannel,
  isHandshakeFrame,
  isDataFrame,
} from "../link-crypto";
import { BrokerClientFrame, BrokerServerFrame } from "../broker-protocol";

class TestHost {
  ws: WebSocket | null = null;
  channel: SecureChannel | null = null;
  cid: string | null = null;
  receivedFrames: BrokerClientFrame[] = [];
  onClientFrame?: (frame: BrokerClientFrame) => void;

  constructor(
    readonly relayBase: string,
    readonly secret: Buffer,
    readonly roomId: string
  ) {}

  connect(opts?: {
    onHello?: (
      cid: string,
      hello: any
    ) => "welcome" | "reject" | "kick" | "drop";
    rejectReason?: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = relayEndpoint(this.relayBase, this.roomId, "host");
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));

      ws.on("message", (data) => {
        const raw = data.toString();
        if (raw === "pong" || raw === "ping") return;
        let msg: any;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }

        if (msg.t === "open") {
          this.cid = msg.cid;
        } else if (msg.t === "msg" && msg.cid && typeof msg.d === "string") {
          this.cid = msg.cid;
          if (isHandshakeFrame(msg.d)) {
            const check = verifyHello(this.secret, msg.d);
            if (check.ok) {
              const action = opts?.onHello
                ? opts.onHello(msg.cid, check.hello)
                : "welcome";
              if (action === "welcome") {
                const { welcome, channel } = buildWelcome(
                  this.secret,
                  check.hello,
                  { version: "1.0.0" }
                );
                this.channel = channel;
                ws.send(JSON.stringify({ t: "msg", cid: msg.cid, d: welcome }));
              } else if (action === "reject") {
                const rejectFrame = buildReject(
                  this.secret,
                  check.hello,
                  opts?.rejectReason || "host refused"
                );
                ws.send(
                  JSON.stringify({ t: "msg", cid: msg.cid, d: rejectFrame })
                );
              } else if (action === "kick") {
                ws.send(
                  JSON.stringify({
                    t: "kick",
                    cid: msg.cid,
                    reason: "kicked by host",
                  })
                );
              }
            }
          } else if (this.channel && isDataFrame(msg.d)) {
            const plaintext = this.channel.open(msg.d);
            if (plaintext !== null) {
              const clientFrame = JSON.parse(plaintext) as BrokerClientFrame;
              this.receivedFrames.push(clientFrame);
              this.onClientFrame?.(clientFrame);
            }
          }
        }
      });
    });
  }

  send(frame: BrokerServerFrame): void {
    if (!this.ws || !this.channel || !this.cid) {
      throw new Error("TestHost cannot send: not connected/established");
    }
    const plaintext = JSON.stringify(frame);
    const parts = this.channel.seal(plaintext);
    for (const part of parts) {
      this.ws.send(JSON.stringify({ t: "msg", cid: this.cid, d: part }));
    }
  }

  kick(reason?: string): void {
    if (!this.ws || !this.cid) {
      throw new Error("TestHost cannot kick: no cid");
    }
    this.ws.send(JSON.stringify({ t: "kick", cid: this.cid, reason }));
  }

  close(): void {
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

describe("LinkClientConnection", () => {
  let relay: RelayServer;
  let relayBase: string;

  beforeEach(async () => {
    relay = new RelayServer({ port: 0 });
    await relay.listen();
    relayBase = `ws://127.0.0.1:${relay.getPort()}`;
  });

  afterEach(async () => {
    await relay.close();
  });

  it("established + tool frame round trip", async () => {
    const secret = generateLinkSecret();
    const roomId = deriveRoomId(secret);
    const token = formatLinkToken(secret, relayBase);

    const host = new TestHost(relayBase, secret, roomId);
    await host.connect();

    let clientReceivedFrame: BrokerServerFrame | null = null;
    let closeReason: LinkCloseReason | null = null;

    const conn = await LinkClientConnection.open({
      token,
      label: "test-client",
      version: "1.0.0",
      onFrame: (frame) => {
        clientReceivedFrame = frame;
      },
      onClose: (reason) => {
        closeReason = reason;
      },
      hostWaitMs: 2000,
      handshakeTimeoutMs: 3000,
    });

    expect(conn.isOpen()).toBe(true);
    expect(conn.peerVersion).toBe("1.0.0");

    const toolRequestPromise = new Promise<BrokerClientFrame>((resolve) => {
      host.onClientFrame = (frame) => resolve(frame);
    });

    conn.send({
      kind: "tool",
      requestId: "req-1",
      message: { cmd: "open-tab", url: "https://example.com" },
    });

    const receivedByHost = await toolRequestPromise;
    expect(receivedByHost).toEqual({
      kind: "tool",
      requestId: "req-1",
      message: { cmd: "open-tab", url: "https://example.com" },
    });

    host.send({
      kind: "tool-result",
      requestId: "req-1",
      message: { resource: "opened-tab-id", correlationId: "c1", tabId: 42 } as any,
    });

    await new Promise<void>((r) => {
      const check = setInterval(() => {
        if (clientReceivedFrame) {
          clearInterval(check);
          r();
        }
      }, 20);
    });

    expect(clientReceivedFrame).toEqual({
      kind: "tool-result",
      requestId: "req-1",
      message: { resource: "opened-tab-id", correlationId: "c1", tabId: 42 },
    });

    conn.close();
    host.close();
    expect(closeReason).toBeNull();
  });

  it("a 2 MB result frame (multi-part) arrives intact", async () => {
    const secret = generateLinkSecret();
    const roomId = deriveRoomId(secret);
    const token = formatLinkToken(secret, relayBase);

    const host = new TestHost(relayBase, secret, roomId);
    await host.connect();

    let clientReceivedFrame: BrokerServerFrame | null = null;

    const conn = await LinkClientConnection.open({
      token,
      label: "test-client",
      version: "1.0.0",
      onFrame: (frame) => {
        clientReceivedFrame = frame;
      },
      onClose: () => {},
      hostWaitMs: 2000,
      handshakeTimeoutMs: 3000,
    });

    const bigString = "x".repeat(2 * 1024 * 1024);
    host.send({
      kind: "tool-result",
      requestId: "big-1",
      message: { resource: "snapshot", text: bigString } as any,
    });

    await new Promise<void>((r) => {
      const check = setInterval(() => {
        if (clientReceivedFrame) {
          clearInterval(check);
          r();
        }
      }, 20);
    });

    expect((clientReceivedFrame as any)?.message?.text?.length).toBe(
      2 * 1024 * 1024
    );
    expect((clientReceivedFrame as any)?.message?.text).toBe(bigString);

    conn.close();
    host.close();
  });

  it("host offline → LinkConnectError with host-offline text after short hostWaitMs", async () => {
    const secret = generateLinkSecret();
    const token = formatLinkToken(secret, relayBase);

    await expect(
      LinkClientConnection.open({
        token,
        label: "test-client",
        version: "1.0.0",
        onFrame: () => {},
        onClose: () => {},
        hostWaitMs: 100,
        handshakeTimeoutMs: 1000,
      })
    ).rejects.toThrow(
      "Your computer's FoxPilot is not connected to the relay. On the computer with your browser, run `npx foxpilot-mcp link` (or start any local FoxPilot session) and keep the browser with the FoxPilot extension open, then retry."
    );
  });

  it("host joining DURING the wait → success", async () => {
    const secret = generateLinkSecret();
    const roomId = deriveRoomId(secret);
    const token = formatLinkToken(secret, relayBase);

    const host = new TestHost(relayBase, secret, roomId);

    const openPromise = LinkClientConnection.open({
      token,
      label: "test-client",
      version: "1.0.0",
      onFrame: () => {},
      onClose: () => {},
      hostWaitMs: 2000,
      handshakeTimeoutMs: 3000,
    });

    await new Promise((r) => setTimeout(r, 100));
    await host.connect();

    const conn = await openPromise;
    expect(conn.isOpen()).toBe(true);

    conn.close();
    host.close();
  });

  it("host sends an authenticated reject → rejected text", async () => {
    const secret = generateLinkSecret();
    const roomId = deriveRoomId(secret);
    const token = formatLinkToken(secret, relayBase);

    const host = new TestHost(relayBase, secret, roomId);
    await host.connect({
      onHello: () => "reject",
      rejectReason: "session denied by policy",
    });

    await expect(
      LinkClientConnection.open({
        token,
        label: "test-client",
        version: "1.0.0",
        onFrame: () => {},
        onClose: () => {},
        hostWaitMs: 1000,
        handshakeTimeoutMs: 2000,
      })
    ).rejects.toThrow(
      "Your computer's FoxPilot refused this session: session denied by policy."
    );

    host.close();
  });

  it("host kicks during handshake → the token text", async () => {
    const secret = generateLinkSecret();
    const roomId = deriveRoomId(secret);
    const token = formatLinkToken(secret, relayBase);

    const host = new TestHost(relayBase, secret, roomId);
    await host.connect({
      onHello: () => "kick",
    });

    await expect(
      LinkClientConnection.open({
        token,
        label: "test-client",
        version: "1.0.0",
        onFrame: () => {},
        onClose: () => {},
        hostWaitMs: 1000,
        handshakeTimeoutMs: 2000,
      })
    ).rejects.toThrow(
      "Your computer's FoxPilot did not accept this link token — it was probably rotated or the link was turned off. Run `npx foxpilot-mcp link` there and update FOXPILOT_LINK."
    );

    host.close();
  });

  it("relay not listening (closed port) → relay-unreachable text containing the relay URL", async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(port));
      });
    });

    const deadRelay = `ws://127.0.0.1:${closedPort}`;
    const secret = generateLinkSecret();
    const token = formatLinkToken(secret, deadRelay);

    try {
      await LinkClientConnection.open({
        token,
        label: "test-client",
        version: "1.0.0",
        onFrame: () => {},
        onClose: () => {},
        handshakeTimeoutMs: 1000,
      });
      throw new Error("expected open to reject");
    } catch (err: any) {
      expect(err).toBeInstanceOf(LinkConnectError);
      expect(err.message).toContain(deadRelay);
      expect(err.message).toContain(
        `Could not reach the FoxPilot relay at ${deadRelay}:`
      );
    }
  });

  it("established then the test host disconnects → onClose('host-offline')", async () => {
    const secret = generateLinkSecret();
    const roomId = deriveRoomId(secret);
    const token = formatLinkToken(secret, relayBase);

    const host = new TestHost(relayBase, secret, roomId);
    await host.connect();

    let closeReason: LinkCloseReason | null = null;
    const closedPromise = new Promise<LinkCloseReason>((resolve) => {
      LinkClientConnection.open({
        token,
        label: "test-client",
        version: "1.0.0",
        onFrame: () => {},
        onClose: (reason) => {
          closeReason = reason;
          resolve(reason);
        },
        hostWaitMs: 2000,
        handshakeTimeoutMs: 3000,
      });
    });

    await new Promise((r) => setTimeout(r, 100));
    host.close();

    const reason = await closedPromise;
    expect(reason).toBe("host-offline");
    expect(closeReason).toBe("host-offline");
  });

  it("kick after establishment → onClose('kicked')", async () => {
    const secret = generateLinkSecret();
    const roomId = deriveRoomId(secret);
    const token = formatLinkToken(secret, relayBase);

    const host = new TestHost(relayBase, secret, roomId);
    await host.connect();

    let closeReason: LinkCloseReason | null = null;
    let closeDetail: string | null = null;

    const closedPromise = new Promise<{ reason: LinkCloseReason; detail: string }>(
      (resolve) => {
        LinkClientConnection.open({
          token,
          label: "test-client",
          version: "1.0.0",
          onFrame: () => {},
          onClose: (reason, detail) => {
            closeReason = reason;
            closeDetail = detail;
            resolve({ reason, detail });
          },
          hostWaitMs: 2000,
          handshakeTimeoutMs: 3000,
        });
      }
    );

    await new Promise((r) => setTimeout(r, 100));
    host.kick("token revoked");

    const result = await closedPromise;
    expect(result.reason).toBe("kicked");
    expect(closeReason).toBe("kicked");
    expect(closeDetail).toBe("token revoked");

    host.close();
  });

  it("send() when closed throws", async () => {
    const secret = generateLinkSecret();
    const roomId = deriveRoomId(secret);
    const token = formatLinkToken(secret, relayBase);

    const host = new TestHost(relayBase, secret, roomId);
    await host.connect();

    const conn = await LinkClientConnection.open({
      token,
      label: "test-client",
      version: "1.0.0",
      onFrame: () => {},
      onClose: () => {},
    });

    conn.close();
    host.close();

    expect(() =>
      conn.send({
        kind: "tool",
        requestId: "r-closed",
        message: { cmd: "open-tab", url: "https://example.com" },
      })
    ).toThrow("FoxPilot link is not connected");
  });

  it("invalid token → linkTokenError text and open() rejects", async () => {
    const badToken = "invalid-token";
    const errText = linkTokenError(badToken);
    expect(errText).not.toBeNull();
    expect(errText).toMatch(/FOXPILOT_LINK is not a valid FoxPilot link token/);

    await expect(
      LinkClientConnection.open({
        token: badToken,
        label: "test-client",
        version: "1.0.0",
        onFrame: () => {},
        onClose: () => {},
      })
    ).rejects.toThrow(LinkConnectError);

    await expect(
      LinkClientConnection.open({
        token: badToken,
        label: "test-client",
        version: "1.0.0",
        onFrame: () => {},
        onClose: () => {},
      })
    ).rejects.toThrow(errText!);
  });
});
