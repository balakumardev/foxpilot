import WebSocket from "ws";
import * as childProcess from "child_process";
import { RelayServer } from "../relay-server";
import { relayEndpoint } from "../relay-protocol";
import { BrowserAPI } from "../browser-api";
import {
  generateLinkSecret,
  deriveRoomId,
  formatLinkToken,
  verifyHello,
  buildWelcome,
  SecureChannel,
  isHandshakeFrame,
  isDataFrame,
} from "../link-crypto";
import { BrokerClientFrame, BrokerServerFrame } from "../broker-protocol";

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    spawn: jest.fn(() => ({ unref: jest.fn() })),
  };
});
const spawnMock = childProcess.spawn as jest.Mock;

class TestHost {
  ws: WebSocket | null = null;
  channel: SecureChannel | null = null;
  cid: string | null = null;
  onClientFrame?: (frame: BrokerClientFrame) => void;

  constructor(
    readonly relayBase: string,
    readonly secret: Buffer,
    readonly roomId: string
  ) {}

  connect(): Promise<void> {
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
              const { welcome, channel } = buildWelcome(
                this.secret,
                check.hello,
                { version: "1.0.0" }
              );
              this.channel = channel;
              ws.send(JSON.stringify({ t: "msg", cid: msg.cid, d: welcome }));
            }
          } else if (this.channel && isDataFrame(msg.d)) {
            const plaintext = this.channel.open(msg.d);
            if (plaintext !== null) {
              const clientFrame = JSON.parse(plaintext) as BrokerClientFrame;
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

describe("BrowserAPI over remote link", () => {
  let relay: RelayServer;
  let relayBase: string;
  let secret: Buffer;
  let roomId: string;
  let token: string;
  let host: TestHost;
  let api: BrowserAPI;

  const origEnv = { ...process.env };

  beforeAll(async () => {
    relay = new RelayServer({ port: 0 });
    await relay.listen();
    relayBase = `ws://127.0.0.1:${relay.getPort()}`;

    secret = generateLinkSecret();
    roomId = deriveRoomId(secret);
    token = formatLinkToken(secret, relayBase);

    host = new TestHost(relayBase, secret, roomId);
    host.onClientFrame = (frame) => {
      if (frame.kind === "tool" && frame.message.cmd === "get-tab-list") {
        host.send({
          kind: "tool-result",
          requestId: frame.requestId,
          message: {
            resource: "tabs",
            correlationId: (frame.message as any).correlationId,
            tabs: [{ id: 1, url: "https://example.com", title: "Example" }],
          } as any,
        });
      } else if (
        frame.kind === "control" &&
        frame.control.control === "list-browsers"
      ) {
        host.send({
          kind: "control-result",
          requestId: frame.requestId,
          result: {
            ok: true,
            browsers: [
              {
                browserId: "b1",
                label: "Chrome",
                type: "chrome",
                connected: true,
                active: true,
              },
            ],
          },
        });
      }
    };
    await host.connect();

    process.env.FOXPILOT_LINK = token;
    spawnMock.mockClear();

    api = new BrowserAPI();
    await api.init();
  });

  afterAll(async () => {
    if (api) {
      api.close();
    }
    if (host) {
      host.close();
    }
    if (relay) {
      await relay.close();
    }
    process.env = { ...origEnv };
  });

  it("operates in link mode and never spawns a local broker or sidecar", () => {
    expect(api.isLinkMode()).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("api.getTabList() works through the remote link", async () => {
    const tabs = await api.getTabList();
    expect(tabs).toEqual([
      { id: 1, url: "https://example.com", title: "Example" },
    ]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("api.listBrowsers() works through the remote link", async () => {
    const browsers = await api.listBrowsers();
    expect(browsers).toEqual([
      {
        browserId: "b1",
        label: "Chrome",
        type: "chrome",
        connected: true,
        active: true,
      },
    ]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects an in-flight request with MISSING REPLY text when host drops", async () => {
    host.onClientFrame = (_frame) => {
      // Drop immediately without answering
      host.close();
    };

    const promise = api.getTabList();

    await expect(promise).rejects.toThrow(
      "The link to your computer's FoxPilot dropped (your computer went offline or stopped FoxPilot) before the reply arrived. This is a MISSING REPLY, not a confirmed failure — the command may already have run in the browser. Verify the page state before retrying."
    );
  });

  it("resolves init() but rejects calls with invalid-token text when FOXPILOT_LINK is invalid", async () => {
    process.env.FOXPILOT_LINK = "not-a-valid-token";
    const invalidApi = new BrowserAPI();

    // init() itself must resolve
    await expect(invalidApi.init()).resolves.toBeUndefined();
    expect(invalidApi.isLinkMode()).toBe(true);

    // getTabList() must reject with invalid token text
    await expect(invalidApi.getTabList()).rejects.toThrow(
      /FOXPILOT_LINK is not a valid FoxPilot link token/
    );

    invalidApi.close();
  });

  it("a failed link attempt reaches the caller and never becomes an unhandled rejection", async () => {
    // A relay port nothing listens on: every attempt fails fast.
    const closedRelay = new RelayServer({ port: 0 });
    await closedRelay.listen();
    const deadPort = closedRelay.getPort();
    await closedRelay.close();

    process.env.FOXPILOT_LINK = formatLinkToken(
      generateLinkSecret(),
      `ws://127.0.0.1:${deadPort}`
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const failingApi = new BrowserAPI();
    try {
      // init() starts a background attempt that fails; it must not throw.
      await expect(failingApi.init()).resolves.toBeUndefined();
      // Let that attempt fail with NO tool call waiting on it: this is the path
      // where a stray rejected promise used to crash the MCP server.
      await new Promise((r) => setTimeout(r, 500));
      expect(unhandled).toEqual([]);
      // Two concurrent calls share one attempt and both see its error.
      const results = await Promise.allSettled([
        failingApi.getTabList(),
        failingApi.listBrowsers(),
      ]);
      for (const r of results) {
        expect(r.status).toBe("rejected");
        expect(String((r as PromiseRejectedResult).reason)).toMatch(
          /Could not reach the FoxPilot relay/
        );
      }
      // Let any stray rejection surface before checking.
      await new Promise((r) => setTimeout(r, 200));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      failingApi.close();
    }
  });
});
