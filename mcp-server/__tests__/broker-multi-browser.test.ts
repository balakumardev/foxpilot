import WebSocket from "ws";
import { BrokerServer } from "../broker";
import { createSignature } from "../signing";

const SECRET = "integration-secret";

function envelope(payload: unknown): string {
  return JSON.stringify({
    payload,
    signature: createSignature(SECRET, JSON.stringify(payload)),
  });
}

function hello(
  browserId: string,
  browserType: "chrome" | "firefox",
  label: string
): string {
  return envelope({ type: "hello", browserId, browserType, label });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

function connectExtension(
  port: number,
  id: string,
  type: "chrome" | "firefox",
  label: string
): Promise<WebSocket> {
  return new Promise(async (resolve, reject) => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    try {
      await waitOpen(ext);
    } catch (e) {
      reject(e);
      return;
    }
    ext.send(hello(id, type, label));
    resolve(ext);
  });
}

describe("BrokerServer multi-browser handshake", () => {
  let server: BrokerServer;
  let port: number;

  beforeEach(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    port = server.getPort();
  });

  afterEach(() => {
    server.close();
  });

  it("registers a browser that sends a valid hello", async () => {
    const ext = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    // Drive a tool through it to prove it is registered and routable.
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);

    const extHandled = new Promise<void>((resolve) => {
      ext.on("message", (data) => {
        const env = JSON.parse(data.toString());
        if (env.payload?.cmd !== "open-tab") return;
        ext.send(
          envelope({
            resource: "opened-tab-id",
            correlationId: env.payload.correlationId,
            tabId: 7,
          })
        );
        resolve();
      });
    });

    const resultP = nextMessage(client);
    client.send(
      envelope({
        kind: "tool",
        requestId: "r1",
        message: { cmd: "open-tab", url: "https://x.com" },
      })
    );
    await extHandled;
    const result = await resultP;
    expect(result.payload).toMatchObject({
      kind: "tool-result",
      requestId: "r1",
      message: { resource: "opened-tab-id", tabId: 7 },
    });

    ext.close();
    client.close();
  }, 10000);

  it("does NOT admit a browser whose hello signature is invalid", async () => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ext);
    const badHelloPayload = {
      type: "hello",
      browserId: "evil",
      browserType: "chrome",
      label: "Evil",
    };
    ext.send(
      JSON.stringify({
        payload: badHelloPayload,
        signature: createSignature("wrong-secret", JSON.stringify(badHelloPayload)),
      })
    );

    // A tool from a real client must fail "no browser connected" because the
    // bad-hello socket was never registered.
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const resultP = nextMessage(client);
    client.send(
      envelope({
        kind: "tool",
        requestId: "r1",
        message: { cmd: "get-tab-list" },
      })
    );
    const result = await resultP;
    expect(result.payload.kind).toBe("tool-error");
    expect(result.payload.errorMessage).toMatch(/no browser|not connected/i);

    ext.close();
    client.close();
  }, 10000);

  it("lets two valid browsers coexist; the second does not terminate the first", async () => {
    const chrome = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    const firefox = await connectExtension(
      port,
      "firefox-1",
      "firefox",
      "Firefox"
    );

    // Both sockets stay open after the second hello.
    expect(chrome.readyState).toBe(WebSocket.OPEN);
    expect(firefox.readyState).toBe(WebSocket.OPEN);

    // Health reports two connected browsers.
    const health = await new Promise<any>((resolve, reject) => {
      require("http")
        .get(`http://127.0.0.1:${port}/health`, (res: any) => {
          let d = "";
          res.on("data", (c: any) => (d += c));
          res.on("end", () => resolve(JSON.parse(d)));
        })
        .on("error", reject);
    });
    expect(health.browsers).toBe(2);

    chrome.close();
    firefox.close();
  }, 10000);
});

describe("BrokerServer target resolution", () => {
  let server: BrokerServer;
  let port: number;

  beforeEach(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    port = server.getPort();
  });

  afterEach(() => {
    server.close();
    delete process.env.DEFAULT_BROWSER;
  });

  async function toolResult(
    client: WebSocket,
    requestId: string,
    message: unknown
  ): Promise<any> {
    const p = nextMessage(client);
    client.send(envelope({ kind: "tool", requestId, message }));
    return (await p).payload;
  }

  it("0 browsers -> tool-error (no browser connected)", async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const res = await toolResult(client, "r1", { cmd: "get-tab-list" });
    expect(res.kind).toBe("tool-error");
    expect(res.errorMessage).toMatch(/no browser|not connected/i);
    client.close();
  }, 10000);

  it("1 browser -> routes to it implicitly", async () => {
    const ext = await connectExtension(port, "only-1", "chrome", "Chrome");
    ext.on("message", (data) => {
      const env = JSON.parse(data.toString());
      if (env.payload?.cmd !== "get-tab-list") return;
      ext.send(
        envelope({
          resource: "tabs",
          correlationId: env.payload.correlationId,
          tabs: [],
        })
      );
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const res = await toolResult(client, "r1", { cmd: "get-tab-list" });
    expect(res).toMatchObject({ kind: "tool-result", requestId: "r1" });
    ext.close();
    client.close();
  }, 10000);

  it("2 browsers, none active -> fail-loud tool-error naming the labels", async () => {
    const a = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    const b = await connectExtension(port, "firefox-1", "firefox", "Firefox");
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const res = await toolResult(client, "r1", { cmd: "get-tab-list" });
    expect(res.kind).toBe("tool-error");
    expect(res.errorMessage).toMatch(/Multiple browsers connected/);
    expect(res.errorMessage).toMatch(/Chrome/);
    expect(res.errorMessage).toMatch(/Firefox/);
    expect(res.errorMessage).toMatch(/select-browser/);
    a.close();
    b.close();
    client.close();
  }, 10000);

  it("DEFAULT_BROWSER by label routes when no active is set", async () => {
    process.env.DEFAULT_BROWSER = "Firefox";
    const a = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    const b = await connectExtension(port, "firefox-1", "firefox", "Firefox");
    b.on("message", (data) => {
      const env = JSON.parse(data.toString());
      if (env.payload?.cmd !== "get-tab-list") return;
      ext_b_received = true;
      b.send(
        envelope({
          resource: "tabs",
          correlationId: env.payload.correlationId,
          tabs: [],
        })
      );
    });
    let ext_b_received = false;
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const res = await toolResult(client, "r1", { cmd: "get-tab-list" });
    expect(res).toMatchObject({ kind: "tool-result" });
    expect(ext_b_received).toBe(true);
    a.close();
    b.close();
    client.close();
  }, 10000);

  // NOTE: This case depends on the `select-browser` control handler, which
  // lands in Task 4. It is `.skip`ped here and un-skipped in Task 4 Step 7.
  it("disconnecting the active falls back to the lone remaining browser", async () => {
    const a = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    const b = await connectExtension(port, "firefox-1", "firefox", "Firefox");

    // Make Chrome active via a select-browser control, then close it.
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const selP = nextMessage(client);
    client.send(
      envelope({
        kind: "control",
        requestId: "sel",
        control: { control: "select-browser", browserId: "chrome-1" },
      })
    );
    await selP;

    // Close the active (Chrome); Firefox is now the lone remaining one.
    a.close();
    await new Promise((r) => setTimeout(r, 100));

    b.on("message", (data) => {
      const env = JSON.parse(data.toString());
      if (env.payload?.cmd !== "get-tab-list") return;
      b.send(
        envelope({
          resource: "tabs",
          correlationId: env.payload.correlationId,
          tabs: [],
        })
      );
    });
    const res = await toolResult(client, "r1", { cmd: "get-tab-list" });
    expect(res).toMatchObject({ kind: "tool-result", requestId: "r1" });
    b.close();
    client.close();
  }, 10000);
});

describe("BrokerServer list/select control", () => {
  let server: BrokerServer;
  let port: number;

  beforeEach(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    port = server.getPort();
  });

  afterEach(() => {
    server.close();
  });

  async function control(
    client: WebSocket,
    requestId: string,
    ctl: unknown
  ): Promise<any> {
    const p = nextMessage(client);
    client.send(envelope({ kind: "control", requestId, control: ctl }));
    return (await p).payload;
  }

  it("list-browsers returns both browsers with connected/active flags", async () => {
    const a = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    const b = await connectExtension(port, "firefox-1", "firefox", "Firefox");
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);

    const res = await control(client, "c1", { control: "list-browsers" });
    expect(res).toMatchObject({ kind: "control-result", requestId: "c1" });
    expect(res.result.ok).toBe(true);
    const ids = res.result.browsers.map((x: any) => x.browserId).sort();
    expect(ids).toEqual(["chrome-1", "firefox-1"]);
    expect(res.result.browsers.every((x: any) => x.connected)).toBe(true);
    // No active set yet -> none flagged active.
    expect(res.result.browsers.some((x: any) => x.active)).toBe(false);

    a.close();
    b.close();
    client.close();
  }, 10000);

  it("select-browser sets active and subsequent tools route there", async () => {
    const a = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    const b = await connectExtension(port, "firefox-1", "firefox", "Firefox");
    let firefoxGot = false;
    b.on("message", (data) => {
      const env = JSON.parse(data.toString());
      if (env.payload?.cmd !== "get-tab-list") return;
      firefoxGot = true;
      b.send(
        envelope({
          resource: "tabs",
          correlationId: env.payload.correlationId,
          tabs: [],
        })
      );
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);

    const sel = await control(client, "c1", {
      control: "select-browser",
      browserId: "firefox-1",
    });
    expect(sel.result.ok).toBe(true);
    expect(sel.result.activeBrowserId).toBe("firefox-1");

    const toolP = nextMessage(client);
    client.send(
      envelope({
        kind: "tool",
        requestId: "r1",
        message: { cmd: "get-tab-list" },
      })
    );
    const tool = await toolP;
    expect(tool.payload).toMatchObject({ kind: "tool-result", requestId: "r1" });
    expect(firefoxGot).toBe(true);

    a.close();
    b.close();
    client.close();
  }, 10000);

  it("select-browser with an unknown id returns ok:false", async () => {
    const a = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const sel = await control(client, "c1", {
      control: "select-browser",
      browserId: "ghost",
    });
    expect(sel.result.ok).toBe(false);
    expect(sel.result.error).toMatch(/not connected|unknown/i);
    a.close();
    client.close();
  }, 10000);
});

describe("BrokerServer per-browser in-flight failure", () => {
  let server: BrokerServer;
  let port: number;

  beforeEach(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    port = server.getPort();
  });

  afterEach(() => {
    server.close();
  });

  /** Accumulate every frame the client receives (not just the next one). */
  function collectClient(ws: WebSocket): any[] {
    const seen: any[] = [];
    ws.on("message", (data) => seen.push(JSON.parse(data.toString()).payload));
    return seen;
  }

  /** Resolves once the extension socket has been handed a tool request. */
  function awaitDispatch(ws: WebSocket, cmd: string): Promise<void> {
    return new Promise((resolve) => {
      ws.on("message", (data) => {
        const env = JSON.parse(data.toString());
        if (env.payload?.cmd === cmd) resolve();
      });
    });
  }

  async function selectBrowser(
    client: WebSocket,
    browserId: string
  ): Promise<void> {
    client.send(
      envelope({
        kind: "control",
        requestId: `sel-${browserId}`,
        control: { control: "select-browser", browserId },
      })
    );
    await new Promise((r) => setTimeout(r, 50));
  }

  /**
   * Park one never-answered request on each browser. Neither extension socket
   * replies, so both stay in-flight for the duration of the test.
   */
  async function parkOnBoth(
    client: WebSocket,
    chrome: WebSocket,
    firefox: WebSocket
  ): Promise<void> {
    const chromeGot = awaitDispatch(chrome, "get-tab-list");
    await selectBrowser(client, "chrome-1");
    client.send(
      envelope({ kind: "tool", requestId: "r1", message: { cmd: "get-tab-list" } })
    );
    await chromeGot;

    const firefoxGot = awaitDispatch(firefox, "get-tab-list");
    await selectBrowser(client, "firefox-1");
    client.send(
      envelope({ kind: "tool", requestId: "r2", message: { cmd: "get-tab-list" } })
    );
    await firefoxGot;
  }

  it("disconnecting one browser fails only its in-flight request", async () => {
    const chrome = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    const firefox = await connectExtension(port, "firefox-1", "firefox", "Firefox");
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const seen = collectClient(client);

    await parkOnBoth(client, chrome, firefox);

    chrome.close();
    await new Promise((r) => setTimeout(r, 150));

    const errors = seen.filter((f) => f.kind === "tool-error");
    expect(errors).toHaveLength(1);
    expect(errors[0].requestId).toBe("r1");
    expect(errors[0].errorMessage).toMatch(/disconnected before responding/);

    firefox.close();
    client.close();
  }, 10000);

  it("reconnecting under the same browserId fails that browser's in-flight request with the replaced wording", async () => {
    const chrome = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    const firefox = await connectExtension(port, "firefox-1", "firefox", "Firefox");
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const seen = collectClient(client);

    await parkOnBoth(client, chrome, firefox);

    // The MV3 case: a fresh socket re-registers under the SAME persisted
    // browserId, so registerExtension swaps the socket rather than the old
    // one's close handler tearing the entry down.
    const chromeAgain = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    await new Promise((r) => setTimeout(r, 150));

    const errors = seen.filter((f) => f.kind === "tool-error");
    expect(errors).toHaveLength(1);
    expect(errors[0].requestId).toBe("r1");
    expect(errors[0].errorMessage).toMatch(/connection was replaced/);
    expect(errors[0].errorMessage).toMatch(/may have already run/);

    // Firefox's in-flight request is untouched by the Chrome swap.
    expect(seen.some((f) => f.requestId === "r2")).toBe(false);

    chromeAgain.close();
    firefox.close();
    client.close();
  }, 10000);
});

describe("BrokerServer queued work when a browser goes away", () => {
  let server: BrokerServer;
  let port: number;

  beforeEach(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    port = server.getPort();
  });

  afterEach(() => {
    server.close();
  });

  function collectClient(ws: WebSocket): any[] {
    const seen: any[] = [];
    ws.on("message", (data) => seen.push(JSON.parse(data.toString()).payload));
    return seen;
  }

  /** Every frame an extension socket receives, envelope and all. */
  function collectExtension(ws: WebSocket): any[] {
    const seen: any[] = [];
    ws.on("message", (data) => seen.push(JSON.parse(data.toString())));
    return seen;
  }

  function awaitDispatch(ws: WebSocket, cmd: string): Promise<void> {
    return new Promise((resolve) => {
      ws.on("message", (data) => {
        const env = JSON.parse(data.toString());
        if (env.payload?.cmd === cmd) resolve();
      });
    });
  }

  async function selectBrowser(
    client: WebSocket,
    browserId: string
  ): Promise<void> {
    client.send(
      envelope({
        kind: "control",
        requestId: `sel-${browserId}`,
        control: { control: "select-browser", browserId },
      })
    );
    await new Promise((r) => setTimeout(r, 50));
  }

  const tool = (requestId: string, message: unknown) =>
    envelope({ kind: "tool", requestId, message });

  it("never re-dispatches a queued tab request to the surviving browser", async () => {
    // The proven sequence: a click on Chrome's tab 5 is in flight, a fill for
    // the same tab is queued behind it (tabInFlight is a GLOBAL Set<number>),
    // and Chrome's socket closes. Draining that queue would re-resolve the
    // target — with Chrome deregistered, Firefox is the lone browser and so the
    // implicit active driver — and the fill would mutate FIREFOX's tab 5, a
    // different page, reported to the client as success.
    const chrome = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    const firefox = await connectExtension(
      port,
      "firefox-1",
      "firefox",
      "Firefox"
    );
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const seen = collectClient(client);
    const firefoxFrames = collectExtension(firefox);

    await selectBrowser(client, "chrome-1");

    // r1 goes to Chrome and is deliberately never answered.
    const chromeGot = awaitDispatch(chrome, "click-element");
    client.send(tool("r1", { cmd: "click-element", tabId: 5, uid: "e1" }));
    await chromeGot;

    // r2 targets the same tab, so it queues instead of dispatching.
    client.send(
      tool("r2", {
        cmd: "fill-element",
        tabId: 5,
        uid: "e2",
        value: "SECRET",
      })
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(firefoxFrames.some((f) => f.payload?.cmd === "fill-element")).toBe(
      false
    );

    chrome.close();
    await new Promise((r) => setTimeout(r, 250));

    // Firefox saw neither request — only its own active-status frames.
    expect(firefoxFrames.some((f) => f.payload?.cmd === "fill-element")).toBe(
      false
    );
    expect(firefoxFrames.some((f) => f.payload?.cmd === "click-element")).toBe(
      false
    );

    // Both requests are reported to the client, each with the honest wording
    // for its own state.
    const errors = seen.filter((f) => f.kind === "tool-error");
    expect(errors.map((e) => e.requestId).sort()).toEqual(["r1", "r2"]);
    const inFlight = errors.find((e) => e.requestId === "r1");
    expect(inFlight.errorMessage).toMatch(/disconnected before responding/);
    expect(inFlight.errorMessage).toMatch(/MISSING REPLY/);
    const queued = errors.find((e) => e.requestId === "r2");
    expect(queued.errorMessage).toMatch(/before the request could be sent/);
    expect(queued.errorMessage).toMatch(/SAFE to retry/);

    firefox.close();
    client.close();
  }, 10000);

  it("frees the abandoned tab so the surviving browser can still be driven", async () => {
    // The other half of abandoning a tab: releasing tabInFlight. Without it,
    // tab 5 stays marked in-flight forever and every later request for it
    // queues and never dispatches.
    const chrome = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    const firefox = await connectExtension(
      port,
      "firefox-1",
      "firefox",
      "Firefox"
    );
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);

    await selectBrowser(client, "chrome-1");
    const chromeGot = awaitDispatch(chrome, "click-element");
    client.send(tool("r1", { cmd: "click-element", tabId: 5, uid: "e1" }));
    await chromeGot;
    client.send(tool("r2", { cmd: "click-element", tabId: 5, uid: "e2" }));
    await new Promise((r) => setTimeout(r, 100));

    chrome.close();
    await new Promise((r) => setTimeout(r, 250));

    // Firefox is now the lone browser. A NEW request for tab 5 — one the
    // caller chose to send after being told the old ones failed — must go out.
    const firefoxGot = awaitDispatch(firefox, "click-element");
    client.send(tool("r3", { cmd: "click-element", tabId: 5, uid: "e3" }));
    await firefoxGot;

    firefox.close();
    client.close();
  }, 10000);

  it("sends welcome as the FIRST frame on a reconnecting socket", async () => {
    // registerExtension installs the new connection before failing the old
    // one's in-flight work, so anything that resolved a target during that
    // failure would resolve to this socket. Nothing may reach it before the
    // welcome ack — the zero-config pairing contract, and what the status pill
    // flips on.
    const chrome = await connectExtension(port, "chrome-1", "chrome", "Chrome");
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);

    const chromeGot = awaitDispatch(chrome, "click-element");
    client.send(tool("r1", { cmd: "click-element", tabId: 5, uid: "e1" }));
    await chromeGot;
    client.send(
      tool("r2", { cmd: "fill-element", tabId: 5, uid: "e2", value: "SECRET" })
    );
    await new Promise((r) => setTimeout(r, 100));

    // Reconnect under the SAME browserId, recording from before the hello.
    const again = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(again);
    const frames = collectExtension(again);
    again.send(hello("chrome-1", "chrome", "Chrome"));
    await new Promise((r) => setTimeout(r, 250));

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].type).toBe("welcome");
    // And the queued fill was failed, not handed to the fresh socket.
    expect(frames.some((f) => f.payload?.cmd === "fill-element")).toBe(false);

    again.close();
    chrome.close();
    client.close();
  }, 10000);
});

describe("BrokerServer active-status push", () => {
  let server: BrokerServer;
  let port: number;

  beforeEach(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    port = server.getPort();
  });

  afterEach(() => {
    server.close();
  });

  /** Collect active-status frames seen on an extension socket. */
  function collectStatus(ws: WebSocket): boolean[] {
    const seen: boolean[] = [];
    ws.on("message", (data) => {
      const env = JSON.parse(data.toString());
      if (env.payload?.cmd === "active-status") {
        seen.push(!!env.payload.active);
      }
    });
    return seen;
  }

  it("pushes active=true to the sole browser when it connects", async () => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ext);
    const seen = collectStatus(ext);
    ext.send(hello("only-1", "chrome", "Chrome"));
    await new Promise((r) => setTimeout(r, 150));
    // Sole connected browser is implicitly active.
    expect(seen[seen.length - 1]).toBe(true);
    ext.close();
  }, 10000);

  it("flips ACTIVE/STANDBY on select-browser across two browsers", async () => {
    const a = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(a);
    const aSeen = collectStatus(a);
    a.send(hello("chrome-1", "chrome", "Chrome"));

    const b = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(b);
    const bSeen = collectStatus(b);
    b.send(hello("firefox-1", "firefox", "Firefox"));
    await new Promise((r) => setTimeout(r, 150));

    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const selP = nextMessage(client);
    client.send(
      envelope({
        kind: "control",
        requestId: "sel",
        control: { control: "select-browser", browserId: "firefox-1" },
      })
    );
    await selP;
    await new Promise((r) => setTimeout(r, 150));

    // After selecting Firefox: Firefox sees active=true, Chrome sees false.
    expect(bSeen[bSeen.length - 1]).toBe(true);
    expect(aSeen[aSeen.length - 1]).toBe(false);

    a.close();
    b.close();
    client.close();
  }, 10000);

  it("still delivers to healthy browsers when one connection's send throws (TOCTOU guard)", async () => {
    // Two browsers connected and registered.
    const a = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(a);
    a.send(hello("chrome-1", "chrome", "Chrome"));
    const b = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(b);
    const bSeen = collectStatus(b);
    b.send(hello("firefox-1", "firefox", "Firefox"));
    await new Promise((r) => setTimeout(r, 150));

    // Simulate the TOCTOU: chrome-1's socket still reports OPEN but its send
    // throws (as a socket caught mid-transition to CLOSING would). Reaching the
    // private map is fine — TS `private` is compile-time only.
    // chrome-1 is still OPEN here (both browsers handshaked), so the OPEN branch
    // is taken; we only need its send to throw, as a socket caught mid-
    // transition to CLOSING would. (`readyState` is a getter-only prop on the
    // real ws, so we override `send` rather than the state.)
    const conns: Map<string, any> = (server as any).extensions;
    const bad = conns.get("chrome-1");
    expect(bad).toBeTruthy();
    expect(bad.ws.readyState).toBe(WebSocket.OPEN);
    bad.ws.send = () => {
      throw new Error("socket closing mid-send");
    };

    // Trigger a broadcast by selecting firefox-1. Pre-guard, chrome-1's throw
    // would abort the loop; whether firefox-1 got its frame depended on map
    // order. The guard makes delivery to the healthy socket unconditional and
    // keeps broadcastActiveStatus from throwing.
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const selP = nextMessage(client);
    client.send(
      envelope({
        kind: "control",
        requestId: "sel",
        control: { control: "select-browser", browserId: "firefox-1" },
      })
    );
    const sel = await selP;
    // The select itself succeeds (the broadcast it triggers does not throw).
    expect(sel.payload.result.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 150));

    // The healthy browser received its ACTIVE frame despite the bad socket.
    expect(bSeen[bSeen.length - 1]).toBe(true);

    a.close();
    b.close();
    client.close();
  }, 10000);

  it("select-active frame from a browser makes that browser active", async () => {
    const server2 = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server2.listen();
    const p = server2.getPort();
    const a = new WebSocket(`ws://127.0.0.1:${p}/extension`);
    await waitOpen(a);
    a.send(hello("chrome-1", "chrome", "Chrome"));
    const b = new WebSocket(`ws://127.0.0.1:${p}/extension`);
    await waitOpen(b);
    b.send(hello("firefox-1", "firefox", "Firefox"));
    await new Promise((r) => setTimeout(r, 100));

    // Firefox asks to be made active via the signed select-active frame.
    const payload = { type: "select-active", browserId: "firefox-1" };
    b.send(
      JSON.stringify({
        payload,
        signature: createSignature(SECRET, JSON.stringify(payload)),
      })
    );
    await new Promise((r) => setTimeout(r, 100));

    // A list-browsers now flags firefox-1 active.
    const client = new WebSocket(`ws://127.0.0.1:${p}/mcp`);
    await waitOpen(client);
    const lp = nextMessage(client);
    client.send(envelope({ kind: "control", requestId: "c1", control: { control: "list-browsers" } }));
    const list = await lp;
    const ff = list.payload.result.browsers.find((x: any) => x.browserId === "firefox-1");
    expect(ff.active).toBe(true);

    a.close(); b.close(); client.close();
    server2.close();
  }, 10000);
});
