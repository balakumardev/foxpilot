import WebSocket from "ws";
import * as http from "http";
import { BrokerServer } from "../broker";
import { BrokerLongPoll } from "../broker-longpoll";
import { createSignature, verifySignature } from "../signing";

const SECRET = "longpoll-secret";

function envelope(payload: unknown): string {
  return JSON.stringify({
    payload,
    signature: createSignature(SECRET, JSON.stringify(payload)),
  });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      })
      .on("error", reject);
  });
}

function httpPost(url: string, body: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("BrokerLongPoll", () => {
  let server: BrokerServer;
  let port: number;

  beforeAll(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    new BrokerLongPoll(server, SECRET, { pollTimeoutMs: 1000 });
    await server.listen();
    port = server.getPort();
  });

  afterAll(() => {
    server.close();
  });

  it("delivers a tool request and routes the response over HTTP long-poll", async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const auth = createSignature(SECRET, "extension-poll");

    // Start the long-poll; it is held open until a request is enqueued.
    const pollPromise = httpGet(
      `http://127.0.0.1:${port}/extension/poll?auth=${auth}`
    );
    // Let the server receive the poll and register the long-poll sink.
    await delay(150);

    const clientResult = nextMessage(client);
    client.send(
      envelope({
        kind: "tool",
        requestId: "r1",
        message: { cmd: "open-tab", url: "https://x.com" },
      })
    );

    const poll = await pollPromise;
    const body = JSON.parse(poll.body);
    expect(body.requests).toHaveLength(1);
    const signedReq = body.requests[0];
    // The poll response now wraps each request in a signed envelope.
    expect(
      verifySignature(
        SECRET,
        JSON.stringify(signedReq.payload),
        signedReq.signature
      )
    ).toBe(true);
    const correlationId = signedReq.payload.correlationId;
    expect(signedReq.payload).toMatchObject({
      cmd: "open-tab",
      url: "https://x.com",
    });

    // The extension posts its response back over HTTP.
    const responsePayload = {
      resource: "opened-tab-id",
      correlationId,
      tabId: 55,
    };
    await httpPost(
      `http://127.0.0.1:${port}/extension/respond?auth=${auth}`,
      envelope(responsePayload)
    );

    const result = await clientResult;
    expect(result.payload).toMatchObject({
      kind: "tool-result",
      requestId: "r1",
      message: { resource: "opened-tab-id", tabId: 55 },
    });

    client.close();
  }, 10000);

  it("rejects a poll with an invalid auth signature", async () => {
    const res = await httpGet(
      `http://127.0.0.1:${port}/extension/poll?auth=deadbeef`
    );
    expect(res.status).toBe(401);
  });

  it("registers a long-poll browser from a signed hello posted to /respond", async () => {
    const auth = createSignature(SECRET, "extension-poll");
    const hello = {
      type: "hello",
      browserId: "lp-browser-1",
      browserType: "chrome",
      label: "Chrome (long-poll)",
    };

    // The long-poll client's identity step: POST the signed hello to /respond.
    // The broker ingests it like a WS first frame and registers the browser.
    await httpPost(
      `http://127.0.0.1:${port}/extension/respond?auth=${auth}`,
      envelope(hello)
    );

    // /health should now report the registered browser.
    const health = JSON.parse(
      (await httpGet(`http://127.0.0.1:${port}/health`)).body
    );
    expect(health.browsers).toBe(1);

    // A client list-browsers control round-trip should surface the browser.
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);
    const listResult = nextMessage(client);
    client.send(
      envelope({
        kind: "control",
        requestId: "ctl-1",
        control: { control: "list-browsers" },
      })
    );
    const listed = await listResult;
    expect(listed.payload).toMatchObject({
      kind: "control-result",
      requestId: "ctl-1",
    });
    expect(listed.payload.result.ok).toBe(true);
    expect(listed.payload.result.browsers).toHaveLength(1);
    expect(listed.payload.result.browsers[0]).toMatchObject({
      browserId: "lp-browser-1",
      label: "Chrome (long-poll)",
      type: "chrome",
    });

    client.close();
  }, 10000);

  it("re-registers a long-poll browser after a stale-drop clears it", async () => {
    // A dedicated broker so the stale timer can fire without racing the shared
    // poll above. pollTimeoutMs * 2 is the stale window — keep it short.
    const localServer = new BrokerServer({
      port: 0,
      host: "127.0.0.1",
      secret: SECRET,
    });
    new BrokerLongPoll(localServer, SECRET, { pollTimeoutMs: 50 });
    await localServer.listen();
    const localPort = localServer.getPort();
    const auth = createSignature(SECRET, "extension-poll");
    const hello = {
      type: "hello",
      browserId: "lp-browser-2",
      browserType: "firefox",
      label: "Firefox (long-poll)",
    };

    // First hello registers the browser.
    await httpPost(
      `http://127.0.0.1:${localPort}/extension/respond?auth=${auth}`,
      envelope(hello)
    );
    let health = JSON.parse(
      (await httpGet(`http://127.0.0.1:${localPort}/health`)).body
    );
    expect(health.browsers).toBe(1);

    // Open a poll so the long-poll sink activates and arms the stale timer,
    // then let the stale timer (pollTimeoutMs * 2) fire with no further
    // activity. onLongPollExtensionGone() drops the registry entry.
    await httpGet(`http://127.0.0.1:${localPort}/extension/poll?auth=${auth}`);
    await delay(200);
    health = JSON.parse(
      (await httpGet(`http://127.0.0.1:${localPort}/health`)).body
    );
    expect(health.browsers).toBe(0);

    // A subsequent hello (what the re-armed client re-POSTs) re-registers it.
    await httpPost(
      `http://127.0.0.1:${localPort}/extension/respond?auth=${auth}`,
      envelope(hello)
    );
    health = JSON.parse(
      (await httpGet(`http://127.0.0.1:${localPort}/health`)).body
    );
    expect(health.browsers).toBe(1);

    localServer.close();
  }, 10000);
});
