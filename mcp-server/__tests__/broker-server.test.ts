import WebSocket from "ws";
import * as http from "http";
import { BrokerServer } from "../broker";
import { createSignature } from "../signing";

const SECRET = "integration-secret";

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

describe("BrokerServer integration", () => {
  let server: BrokerServer;
  let port: number;

  beforeAll(async () => {
    server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
    await server.listen();
    port = server.getPort();
  });

  afterAll(() => {
    server.close();
  });

  it("round-trips a tool request from client through extension and back", async () => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ext);
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);

    // The mock extension echoes a response for whatever request it receives.
    const extHandled = new Promise<void>((resolve) => {
      ext.once("message", (data) => {
        const env = JSON.parse(data.toString());
        const req = env.payload;
        ext.send(
          envelope({
            resource: "opened-tab-id",
            correlationId: req.correlationId,
            tabId: 99,
          })
        );
        resolve();
      });
    });

    const resultPromise = nextMessage(client);
    client.send(
      envelope({
        kind: "tool",
        requestId: "r1",
        message: { cmd: "open-tab", url: "https://x.com" },
      })
    );

    await extHandled;
    const result = await resultPromise;
    expect(result.payload).toMatchObject({
      kind: "tool-result",
      requestId: "r1",
      message: { resource: "opened-tab-id", tabId: 99 },
    });

    ext.close();
    client.close();
  }, 10000);

  it("handles a lease control request without an extension", async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);

    const resultPromise = nextMessage(client);
    client.send(
      envelope({
        kind: "control",
        requestId: "ctl1",
        control: { control: "acquire-lease", tabId: 5 },
      })
    );

    const result = await resultPromise;
    expect(result.payload).toMatchObject({
      kind: "control-result",
      requestId: "ctl1",
      result: { ok: true },
    });

    client.close();
  }, 10000);

  it("rejects a client signed with the wrong secret", async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(client);

    const badPayload = {
      kind: "control",
      requestId: "ctlbad",
      control: { control: "acquire-lease", tabId: 7 },
    };
    client.send(
      JSON.stringify({
        payload: badPayload,
        signature: createSignature("wrong-secret", JSON.stringify(badPayload)),
      })
    );

    // The broker must NOT respond to an improperly-signed frame.
    const got = await Promise.race([
      nextMessage(client).then(() => "responded"),
      new Promise((resolve) => setTimeout(() => resolve("silent"), 300)),
    ]);
    expect(got).toBe("silent");

    client.close();
  }, 10000);

  it("serves a health endpoint over HTTP", async () => {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/health`, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        })
        .on("error", reject);
    });
    expect(JSON.parse(body)).toMatchObject({ status: "ok" });
  }, 10000);
});
