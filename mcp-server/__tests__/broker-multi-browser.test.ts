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
