/**
 * Tests for the WebSocket transport's zero-config pairing protocol.
 *
 * The broker no longer signs every frame. After the socket opens the extension
 * sends a hello and the broker replies with a FLAT, UNSIGNED `welcome` (admit)
 * or `rejected` (refuse). Status must be TRUTHFUL: connected only on `welcome`,
 * blocked on `rejected`, disconnected on close/error without a prior welcome.
 */
import { WebsocketClient } from "../client";
import { getMessageSignature } from "../auth";
import type { ConnectionState, ConnectionStateDetail } from "../transport";

/**
 * Minimal controllable WebSocket. The real DOM WebSocket connects for real;
 * here we drive open/message/close/error by hand and capture what the client
 * sends. Installed on the global before each test.
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners: Record<string, ((ev: any) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: any) => void): void {
    (this.listeners[type] ||= []).push(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  // --- test drivers ---
  emit(type: string, ev: any): void {
    for (const cb of this.listeners[type] || []) {
      cb(ev);
    }
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(obj: unknown): void {
    this.emit("message", { data: JSON.stringify(obj) });
  }
}

function lastInstance(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

/**
 * Let the client's async open/message handlers settle. buildHello in signed
 * mode chains storage reads + HMAC crypto across several async hops, so flush a
 * few macrotask turns rather than a single one.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const BROWSER_ID = "bid-1";

function welcome(overrides: Record<string, unknown> = {}): any {
  return {
    type: "welcome",
    browserId: BROWSER_ID,
    activeBrowserId: BROWSER_ID,
    browsers: [
      {
        browserId: BROWSER_ID,
        label: "My Firefox",
        type: "firefox",
        connected: true,
        active: true,
      },
    ],
    ...overrides,
  };
}

describe("WebsocketClient zero-config protocol", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ["setTimeout"] });
    FakeWebSocket.instances = [];
    (global as any).WebSocket = FakeWebSocket;
    // Identity for buildHello.
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: {
        secret: "",
        ports: [8089],
        browserId: BROWSER_ID,
        browserLabel: "My Firefox",
      },
    });
    (browser as any).runtime.getBrowserInfo = undefined; // chrome-family default
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does NOT report connected merely because the socket opened", async () => {
    const states: ConnectionState[] = [];
    const client = new WebsocketClient(8089, "", (s) => states.push(s));
    client.connect();
    lastInstance().open();
    await flush();
    expect(states).not.toContain("connected");
  });

  it("reports connected ONLY when a welcome frame arrives", async () => {
    const states: ConnectionState[] = [];
    const client = new WebsocketClient(8089, "", (s) => states.push(s));
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    ws.receive(welcome());
    await flush();
    expect(states).toContain("connected");
  });

  it("reports blocked with the broker reason on a rejected frame", async () => {
    const events: { state: ConnectionState; detail?: ConnectionStateDetail }[] =
      [];
    const client = new WebsocketClient(8089, "", (state, detail) =>
      events.push({ state, detail })
    );
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    ws.receive({ type: "rejected", reason: "origin_not_allowed" });
    await flush();
    const blocked = events.find((e) => e.state === "blocked");
    expect(blocked).toBeDefined();
    expect(blocked!.detail?.reason).toBe("origin_not_allowed");
  });

  it("keeps blocked through the close the broker sends right after rejecting", async () => {
    // The broker closes the socket immediately after a `rejected` frame. That
    // trailing close must NOT overwrite "blocked" with "disconnected", or the
    // user never sees the real reason.
    const events: { state: ConnectionState; detail?: ConnectionStateDetail }[] =
      [];
    const client = new WebsocketClient(8089, "", (state, detail) =>
      events.push({ state, detail })
    );
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    ws.receive({ type: "rejected", reason: "origin_not_allowed" });
    await flush();
    ws.close(); // broker drops the socket after rejecting
    await flush();
    expect(events[events.length - 1].state).toBe("blocked");
    expect(events.filter((e) => e.state === "disconnected")).toHaveLength(0);
  });

  it("reports disconnected on close without a prior welcome", async () => {
    const states: ConnectionState[] = [];
    const client = new WebsocketClient(8089, "", (s) => states.push(s));
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    ws.close();
    await flush();
    expect(states[states.length - 1]).toBe("disconnected");
    expect(states).not.toContain("connected");
  });

  it("origin mode (no secret) sends an UNSIGNED hello", async () => {
    const client = new WebsocketClient(8089, "");
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    expect(ws.sent.length).toBeGreaterThanOrEqual(1);
    const hello = JSON.parse(ws.sent[0]);
    expect(hello.payload.type).toBe("hello");
    expect("signature" in hello).toBe(false);
  });

  it("origin mode accepts UNSIGNED command frames (no signature required)", async () => {
    const received: any[] = [];
    const client = new WebsocketClient(8089, "");
    client.addMessageListener((m) => received.push(m));
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    ws.receive(welcome());
    await flush();
    // Unsigned command — no `signature` field at all.
    ws.receive({ payload: { cmd: "get-tab-list", correlationId: "c1" } });
    await flush();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ cmd: "get-tab-list", correlationId: "c1" });
  });

  it("origin mode routes an UNSIGNED active-status push to the status listener", async () => {
    const actives: boolean[] = [];
    const client = new WebsocketClient(8089, "");
    client.addStatusListener((a) => actives.push(a));
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    ws.receive(welcome());
    await flush();
    ws.receive({ payload: { cmd: "active-status", correlationId: "", active: false } });
    await flush();
    // welcome derives active:true (lone active browser), the push flips to false.
    expect(actives[actives.length - 1]).toBe(false);
  });

  it("derives ACTIVE for a lone browser from the welcome roster (no push needed)", async () => {
    const actives: boolean[] = [];
    const client = new WebsocketClient(8089, "");
    client.addStatusListener((a) => actives.push(a));
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    ws.receive(welcome());
    await flush();
    expect(actives[actives.length - 1]).toBe(true);
  });

  it("derives STANDBY when another browser is the active one", async () => {
    const actives: boolean[] = [];
    const client = new WebsocketClient(8089, "");
    client.addStatusListener((a) => actives.push(a));
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    ws.receive(
      welcome({
        activeBrowserId: "other-browser",
        browsers: [
          {
            browserId: BROWSER_ID,
            label: "My Firefox",
            type: "firefox",
            connected: true,
            active: false,
          },
          {
            browserId: "other-browser",
            label: "Other",
            type: "chrome",
            connected: true,
            active: true,
          },
        ],
      })
    );
    await flush();
    expect(actives[actives.length - 1]).toBe(false);
  });

  it("signed mode (secret set) sends a SIGNED hello and verifies incoming frames", async () => {
    const received: any[] = [];
    const client = new WebsocketClient(8089, "shared");
    client.addMessageListener((m) => received.push(m));
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    const hello = JSON.parse(ws.sent[0]);
    expect(typeof hello.signature).toBe("string");
    expect(hello.signature.length).toBeGreaterThan(0);

    // welcome is always flat/unsigned and must still admit in signed mode.
    ws.receive(welcome());
    await flush();

    const payload = { cmd: "get-tab-list", correlationId: "c2" };
    const signature = await getMessageSignature(
      JSON.stringify(payload),
      "shared"
    );
    ws.receive({ payload, signature });
    await flush();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
  });

  it("signed mode DROPS a command frame with a bad signature", async () => {
    const received: any[] = [];
    const client = new WebsocketClient(8089, "shared");
    client.addMessageListener((m) => received.push(m));
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    ws.receive(welcome());
    await flush();
    ws.receive({
      payload: { cmd: "get-tab-list", correlationId: "c3" },
      signature: "deadbeef",
    });
    await flush();
    expect(received).toHaveLength(0);
  });

  it("sendSelectActive sends an UNSIGNED frame in origin mode", async () => {
    const client = new WebsocketClient(8089, "");
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    ws.sent.length = 0; // drop the hello
    await client.sendSelectActive(BROWSER_ID);
    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0]);
    expect(frame.payload).toEqual({ type: "select-active", browserId: BROWSER_ID });
    expect("signature" in frame).toBe(false);
  });

  it("sendSelectActive signs the frame in signed mode", async () => {
    const client = new WebsocketClient(8089, "shared");
    client.connect();
    const ws = lastInstance();
    ws.open();
    await flush();
    ws.sent.length = 0;
    await client.sendSelectActive(BROWSER_ID);
    const frame = JSON.parse(ws.sent[0]);
    expect(frame.payload).toEqual({ type: "select-active", browserId: BROWSER_ID });
    const expected = await getMessageSignature(
      JSON.stringify(frame.payload),
      "shared"
    );
    expect(frame.signature).toBe(expected);
  });

  describe("healthcheck()", () => {
    it("sends {type:'healthcheck'} and resolves with the result snapshot", async () => {
      const client = new WebsocketClient(8089, "");
      client.connect();
      const ws = lastInstance();
      ws.open();
      await flush();
      ws.sent.length = 0;

      const promise = client.healthcheck();
      // The probe frame went out.
      expect(JSON.parse(ws.sent[0])).toEqual({ type: "healthcheck" });

      ws.receive({
        type: "healthcheck-result",
        extensionConnected: true,
        browsers: welcome().browsers,
        activeBrowserId: BROWSER_ID,
      });
      const result = await promise;
      expect(result.extensionConnected).toBe(true);
      expect(result.activeBrowserId).toBe(BROWSER_ID);
      expect(result.browsers).toHaveLength(1);
    });

    it("resolves with a not-reachable result when the socket is not open", async () => {
      const client = new WebsocketClient(8089, "");
      // never connected
      const result = await client.healthcheck();
      expect(result.extensionConnected).toBe(false);
      expect(result.serverReachable).toBe(false);
    });

    it("resolves with a not-reachable result on timeout (no reply)", async () => {
      jest.useFakeTimers();
      const client = new WebsocketClient(8089, "");
      client.connect();
      const ws = lastInstance();
      ws.readyState = FakeWebSocket.OPEN;

      const promise = client.healthcheck();
      // No reply — advance past the 3s timeout.
      jest.advanceTimersByTime(3500);
      const result = await promise;
      expect(result.serverReachable).toBe(false);
      jest.useRealTimers();
    });
  });

  // NOTE: the Chrome suite has a `ping()` test here. `ping()`/`isClosed()` are
  // MV3 service-worker keepalive plumbing (Chrome's client.ts only — the SW can
  // be suspended and an alarm pings to keep the socket warm). Firefox MV2 runs a
  // persistent background page with no such suspension, so it has no keepalive
  // alarm and no `ping()`/`isClosed()`. This is an intentional MV2 divergence,
  // so there is deliberately no ping test in the Firefox mirror.
});
