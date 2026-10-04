import WebSocket from "ws";
import { BrokerClientFrame, BrokerServerFrame } from "../broker-protocol";
import { LinkConfig, createLinkConfig, linkSecret } from "../link-config";
import {
  ClientHandshake,
  ClientHandshakeResult,
  SecureChannel,
  deriveRoomId,
  generateLinkSecret,
} from "../link-crypto";
import { LinkHost, LinkHostBroker, RemoteClientSink } from "../link-host";
import {
  CLOSE_KICKED,
  clientPath,
} from "../relay-protocol";
import { RelayServer } from "../relay-server";

class FakeBroker implements LinkHostBroker {
  attached: Array<{
    clientId: string;
    sink: RemoteClientSink;
    info: { label: string; version: string };
  }> = [];
  delivered: Array<{ clientId: string; frame: BrokerClientFrame }> = [];
  detached: string[] = [];
  sinks = new Map<string, RemoteClientSink>();
  private nextId = 1;

  attachRemoteClient(
    sink: RemoteClientSink,
    info: { label: string; version: string }
  ): string {
    const id = `r${this.nextId++}`;
    this.attached.push({ clientId: id, sink, info });
    this.sinks.set(id, sink);
    return id;
  }

  deliverRemoteFrame(clientId: string, frame: BrokerClientFrame): void {
    this.delivered.push({ clientId, frame });
  }

  detachRemoteClient(clientId: string): void {
    this.detached.push(clientId);
    this.sinks.delete(clientId);
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  msg = "timed out waiting for condition"
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(msg);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface TestClient {
  ws: WebSocket;
  channel: SecureChannel | null;
  handshakeResult: ClientHandshakeResult | null;
  receivedFrames: BrokerServerFrame[];
  sendFrame: (frame: BrokerClientFrame) => void;
  sendRawCiphertext: (plaintext: string) => void;
  close: () => void;
  closePromise: Promise<{ code: number; reason: string }>;
}

function connectTestClient(
  relayUrl: string,
  roomId: string,
  secret: Buffer,
  info: { label: string; version: string } = {
    label: "test-client",
    version: "1.0.0",
  }
): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const wsUrl = `${relayUrl}${clientPath(roomId)}`;
    const ws = new WebSocket(wsUrl);
    const handshake = new ClientHandshake(secret, info);

    let channel: SecureChannel | null = null;
    let handshakeResult: ClientHandshakeResult | null = null;
    const receivedFrames: BrokerServerFrame[] = [];

    let resolveClose: (res: { code: number; reason: string }) => void;
    const closePromise = new Promise<{ code: number; reason: string }>((r) => {
      resolveClose = r;
    });

    ws.on("close", (code, reason) => {
      resolveClose({ code, reason: reason.toString() });
    });

    ws.on("error", (err) => {
      /* close or open handler deals with it */
    });

    const client: TestClient = {
      ws,
      get channel() {
        return channel;
      },
      get handshakeResult() {
        return handshakeResult;
      },
      receivedFrames,
      sendFrame: (frame: BrokerClientFrame) => {
        if (!channel) throw new Error("channel not established");
        const parts = channel.seal(JSON.stringify(frame));
        for (const part of parts) {
          ws.send(JSON.stringify({ t: "msg", d: part }));
        }
      },
      sendRawCiphertext: (plaintext: string) => {
        if (!channel) throw new Error("channel not established");
        const parts = channel.seal(plaintext);
        for (const part of parts) {
          ws.send(JSON.stringify({ t: "msg", d: part }));
        }
      },
      close: () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
      closePromise,
    };

    ws.on("message", (data) => {
      const raw = data.toString();
      if (raw === "pong") return;
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.t === "host") {
        if (msg.online) {
          ws.send(JSON.stringify({ t: "msg", d: handshake.hello() }));
        }
        return;
      }

      if (msg.t === "msg" && typeof msg.d === "string") {
        if (!channel && !handshakeResult) {
          try {
            const res = handshake.finish(msg.d);
            handshakeResult = res;
            if (res.kind === "established") {
              channel = res.channel;
            }
            resolve(client);
          } catch (err) {
            reject(err);
          }
          return;
        }

        if (channel) {
          const pt = channel.open(msg.d);
          if (pt !== null) {
            try {
              receivedFrames.push(JSON.parse(pt));
            } catch {
              /* ignore */
            }
          }
        }
      }
    });

    ws.on("open", () => {
      // If host is already online, relay will send { t: "host", online: true }
    });

    ws.once("error", (err) => {
      reject(err);
    });
  });
}

describe("LinkHost", () => {
  let relay: RelayServer;
  let relayUrl: string;
  let broker: FakeBroker;
  let host: LinkHost;
  let clientsToClose: TestClient[] = [];

  beforeEach(async () => {
    relay = new RelayServer({ port: 0 });
    await relay.listen();
    relayUrl = `ws://127.0.0.1:${relay.getPort()}`;

    broker = new FakeBroker();
    host = new LinkHost({
      broker,
      version: "1.0.28",
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
      handshakeTimeoutMs: 1000,
      pingIntervalMs: 1000,
      deadAfterMs: 3000,
    });
    clientsToClose = [];
  });

  afterEach(async () => {
    for (const c of clientsToClose) {
      c.close();
    }
    clientsToClose = [];
    host.close();
    await relay.close();
  });

  it("handshake connects and attaches remote client with label and version", async () => {
    const config = createLinkConfig(relayUrl);
    const secret = linkSecret(config);
    const roomId = deriveRoomId(secret);

    host.apply(config);
    await waitFor(() => host.status().relayConnected, 3000);

    const client = await connectTestClient(relayUrl, roomId, secret, {
      label: "agent-1",
      version: "1.0.0",
    });
    clientsToClose.push(client);

    expect(client.handshakeResult?.kind).toBe("established");
    await waitFor(() => broker.attached.length === 1, 2000);
    expect(broker.attached[0].info).toEqual({
      label: "agent-1",
      version: "1.0.0",
    });

    const status = host.status();
    expect(status.sessions.length).toBe(1);
    expect(status.sessions[0].label).toBe("agent-1");
    expect(status.sessions[0].version).toBe("1.0.0");
  });

  it("delivers client->broker frames and broker->client frames", async () => {
    const config = createLinkConfig(relayUrl);
    const secret = linkSecret(config);
    const roomId = deriveRoomId(secret);

    host.apply(config);
    await waitFor(() => host.status().relayConnected, 3000);

    const client = await connectTestClient(relayUrl, roomId, secret);
    clientsToClose.push(client);
    await waitFor(() => broker.attached.length === 1, 2000);

    // Client -> broker frame
    const toolFrame: BrokerClientFrame = {
      kind: "tool",
      requestId: "req-1",
      message: { cmd: "tabs", correlationId: "c-1" } as any,
    };
    client.sendFrame(toolFrame);
    await waitFor(() => broker.delivered.length === 1, 2000);
    expect(broker.delivered[0]).toEqual({
      clientId: "r1",
      frame: toolFrame,
    });

    // Broker -> client frame
    const resultFrame: BrokerServerFrame = {
      kind: "tool-result",
      requestId: "req-1",
      message: { response: "tabs-list", correlationId: "c-1" } as any,
    };
    broker.sinks.get("r1")!.send(resultFrame);
    await waitFor(() => client.receivedFrames.length === 1, 2000);
    expect(client.receivedFrames[0]).toEqual(resultFrame);
  });

  it("supports large (2 MB) frames both ways with multi-part chunking", async () => {
    const config = createLinkConfig(relayUrl);
    const secret = linkSecret(config);
    const roomId = deriveRoomId(secret);

    host.apply(config);
    await waitFor(() => host.status().relayConnected, 3000);

    const client = await connectTestClient(relayUrl, roomId, secret);
    clientsToClose.push(client);

    await waitFor(() => broker.attached.length === 1, 2000);

    // 2 MB text
    const largeText = "A".repeat(2 * 1024 * 1024);

    // Client -> host
    client.sendFrame({
      kind: "tool",
      requestId: "req-large-1",
      message: { cmd: "eval", code: largeText, correlationId: "c-large" } as any,
    });
    await waitFor(() => broker.delivered.length === 1, 5000);
    expect((broker.delivered[0].frame as any).message.code.length).toBe(
      2 * 1024 * 1024
    );

    // Host -> client
    broker.sinks.get("r1")!.send({
      kind: "tool-result",
      requestId: "req-large-1",
      message: { response: largeText, correlationId: "c-large" } as any,
    });
    await waitFor(() => client.receivedFrames.length === 1, 5000);
    expect((client.receivedFrames[0] as any).message.response.length).toBe(
      2 * 1024 * 1024
    );
  });

  it("kicks client with invalid handshake hello without attaching", async () => {
    const config = createLinkConfig(relayUrl);
    const secret = linkSecret(config);
    const roomId = deriveRoomId(secret);

    host.apply(config);
    await waitFor(() => host.status().relayConnected, 3000);

    const wrongSecret = generateLinkSecret();
    const ws = new WebSocket(`${relayUrl}${clientPath(roomId)}`);
    const handshake = new ClientHandshake(wrongSecret, {
      label: "bad-client",
      version: "1.0",
    });

    const closePromise = new Promise<{ code: number; reason: string }>((r) => {
      ws.on("close", (code, reason) => r({ code, reason: reason.toString() }));
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.t === "host" && msg.online) {
        ws.send(JSON.stringify({ t: "msg", d: handshake.hello() }));
      }
    });

    const closed = await closePromise;
    expect(closed.code).toBe(CLOSE_KICKED);
    expect(broker.attached.length).toBe(0);
  });

  it("enforces maxSessions limit and rejects excess sessions with authenticated reject", async () => {
    const hostWithLimit = new LinkHost({
      broker,
      version: "1.0.28",
      maxSessions: 1,
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
    });

    const config = createLinkConfig(relayUrl);
    const secret = linkSecret(config);
    const roomId = deriveRoomId(secret);

    hostWithLimit.apply(config);
    await waitFor(() => hostWithLimit.status().relayConnected, 3000);

    // Client 1 connects successfully
    const c1 = await connectTestClient(relayUrl, roomId, secret, {
      label: "c1",
      version: "1.0",
    });
    clientsToClose.push(c1);
    expect(c1.handshakeResult?.kind).toBe("established");
    await waitFor(() => broker.attached.length === 1, 2000);

    // Client 2 connects and should get rejected
    const c2 = await connectTestClient(relayUrl, roomId, secret, {
      label: "c2",
      version: "1.0",
    });
    clientsToClose.push(c2);

    expect(c2.handshakeResult?.kind).toBe("rejected");
    expect((c2.handshakeResult as any).reason).toMatch(
      /too many remote sessions/
    );

    const closed = await c2.closePromise;
    expect(closed.code).toBe(CLOSE_KICKED);
    expect(broker.attached.length).toBe(1);

    hostWithLimit.close();
  });

  it("detaches remote client when client disconnects", async () => {
    const config = createLinkConfig(relayUrl);
    const secret = linkSecret(config);
    const roomId = deriveRoomId(secret);

    host.apply(config);
    await waitFor(() => host.status().relayConnected, 3000);

    const client = await connectTestClient(relayUrl, roomId, secret);
    await waitFor(() => broker.attached.length === 1, 2000);

    client.close();
    await waitFor(() => broker.detached.includes("r1"), 2000);
    expect(host.status().sessions.length).toBe(0);
  });

  it("kicks and detaches sessions when apply(null) is called", async () => {
    const config = createLinkConfig(relayUrl);
    const secret = linkSecret(config);
    const roomId = deriveRoomId(secret);

    host.apply(config);
    await waitFor(() => host.status().relayConnected, 3000);

    const client = await connectTestClient(relayUrl, roomId, secret);
    clientsToClose.push(client);
    await waitFor(() => broker.attached.length === 1, 2000);

    host.apply(null);
    expect(host.status().enabled).toBe(false);

    const closed = await client.closePromise;
    expect(closed.code).toBe(CLOSE_KICKED);
    expect(closed.reason).toMatch(/turned off/);
    expect(broker.detached.includes("r1")).toBe(true);
  });

  it("kicks old sessions when link token is rotated", async () => {
    const config1 = createLinkConfig(relayUrl);
    const secret1 = linkSecret(config1);
    const roomId1 = deriveRoomId(secret1);

    host.apply(config1);
    await waitFor(() => host.status().relayConnected, 3000);

    const client1 = await connectTestClient(relayUrl, roomId1, secret1);
    clientsToClose.push(client1);
    await waitFor(() => broker.attached.length === 1, 2000);

    // Apply new config with new secret
    const config2 = createLinkConfig(relayUrl);
    const secret2 = linkSecret(config2);
    const roomId2 = deriveRoomId(secret2);

    host.apply(config2);

    const closed = await client1.closePromise;
    expect(closed.code).toBe(CLOSE_KICKED);
    expect(closed.reason).toMatch(/token was rotated/);
    expect(broker.detached.includes("r1")).toBe(true);

    // Host connects to new room
    await waitFor(() => host.status().roomHint === roomId2.slice(0, 6), 3000);
    await waitFor(() => host.status().relayConnected, 3000);

    const client2 = await connectTestClient(relayUrl, roomId2, secret2);
    clientsToClose.push(client2);
    await waitFor(() => broker.attached.length === 2, 2000);
    expect(broker.attached[1].clientId).toBe("r2");
  });

  it("reconnects to relay on relay restart", async () => {
    const config = createLinkConfig(relayUrl);
    const port = relay.getPort();

    host.apply(config);
    await waitFor(() => host.status().relayConnected, 3000);

    // Close relay
    await relay.close();
    await waitFor(() => !host.status().relayConnected, 2000);

    // Start a new relay on the same port
    relay = new RelayServer({ port });
    await relay.listen();

    // Host should automatically reconnect
    await waitFor(() => host.status().relayConnected, 5000);
    expect(host.status().relayConnected).toBe(true);
  });

  it("kicks and detaches client when a malformed plaintext frame is received", async () => {
    const config = createLinkConfig(relayUrl);
    const secret = linkSecret(config);
    const roomId = deriveRoomId(secret);

    host.apply(config);
    await waitFor(() => host.status().relayConnected, 3000);

    const client = await connectTestClient(relayUrl, roomId, secret);
    clientsToClose.push(client);
    await waitFor(() => broker.attached.length === 1, 2000);

    // Send malformed plaintext (valid encryption, but invalid frame JSON)
    client.sendRawCiphertext("not-a-valid-json");

    const closed = await client.closePromise;
    expect(closed.code).toBe(CLOSE_KICKED);
    expect(closed.reason).toMatch(/protocol error/);
    await waitFor(() => broker.detached.includes("r1"), 2000);
  });
});
