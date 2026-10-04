import WebSocket from "ws";
import * as http from "http";
import { BrokerServer, LinkController } from "../broker";
import {
  BrokerClientFrame,
  BrokerServerFrame,
  LinkStatus,
} from "../broker-protocol";
import { RemoteClientSink } from "../link-host";
import { createSignature } from "../signing";
import { FOXPILOT_VERSION } from "../version";

const SECRET = "broker-link-test-secret";

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

function getHealth(port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/health`, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d)));
      })
      .on("error", reject);
  });
}

class FakeLinkController implements LinkController {
  active = true;
  turnOffCalls = 0;
  reloadCalls = 0;
  statusCalls = 0;

  linkStatus: LinkStatus = {
    enabled: true,
    relayConnected: true,
    relayUrl: "wss://relay.example.com",
    roomHint: "room12",
    sessions: [
      {
        id: "r1",
        label: "agent-remote",
        connectedAt: 1234567890,
        version: "1.0.0",
      },
    ],
  };

  status(): LinkStatus {
    this.statusCalls++;
    return this.linkStatus;
  }

  reload(): LinkStatus {
    this.reloadCalls++;
    return this.linkStatus;
  }

  turnOff(): LinkStatus {
    this.turnOffCalls++;
    this.active = false;
    this.linkStatus.enabled = false;
    return this.linkStatus;
  }

  isActive(): boolean {
    return this.active;
  }
}

describe("Broker remote link support", () => {
  let server: BrokerServer;
  let port: number;
  let fakeCtrl: FakeLinkController;
  let shutdownCalled = false;

  beforeEach(async () => {
    shutdownCalled = false;
    fakeCtrl = new FakeLinkController();
    server = new BrokerServer({
      port: 0,
      host: "127.0.0.1",
      secret: SECRET,
      onShutdown: () => {
        shutdownCalled = true;
      },
    });
    server.setLinkController(fakeCtrl);
    await server.listen();
    port = server.getPort();
  });

  afterEach(() => {
    server.close();
  });

  it("round-trips a remote tool frame to extension and back to sink", async () => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ext);
    ext.send(
      envelope({
        type: "hello",
        browserId: "ext-1",
        browserType: "chrome",
        label: "Chrome",
      })
    );
    await nextMessage(ext); // welcome message

    const sentFrames: BrokerServerFrame[] = [];
    const sink: RemoteClientSink = {
      send: (frame) => sentFrames.push(frame),
      close: () => {},
    };

    const remoteClientId = server.attachRemoteClient(sink, {
      label: "agent-1",
      version: "1.0",
    });

    const extReplied = new Promise<void>((resolve) => {
      const onMsg = (data: any) => {
        const env = JSON.parse(data.toString());
        const req = env.payload;
        if (req && req.cmd === "open-tab") {
          ext.off("message", onMsg);
          ext.send(
            envelope({
              resource: "tabs",
              correlationId: req.correlationId,
              tabId: 101,
            })
          );
          resolve();
        }
      };
      ext.on("message", onMsg);
    });

    server.deliverRemoteFrame(remoteClientId, {
      kind: "tool",
      requestId: "remote-req-1",
      message: { cmd: "open-tab", url: "https://foxpilot.dev" } as any,
    });

    await extReplied;
    const start = Date.now();
    while (sentFrames.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(sentFrames.length).toBe(1);
    expect(sentFrames[0]).toMatchObject({
      kind: "tool-result",
      requestId: "remote-req-1",
      message: { resource: "tabs", tabId: 101 },
    });

    ext.close();
  });

  it("handles remote control list-browsers", async () => {
    const sentFrames: BrokerServerFrame[] = [];
    const sink: RemoteClientSink = {
      send: (frame) => sentFrames.push(frame),
      close: () => {},
    };

    const remoteClientId = server.attachRemoteClient(sink, {
      label: "agent-1",
      version: "1.0",
    });

    server.deliverRemoteFrame(remoteClientId, {
      kind: "control",
      requestId: "ctl-1",
      control: { control: "list-browsers" },
    });

    expect(sentFrames.length).toBe(1);
    expect(sentFrames[0]).toMatchObject({
      kind: "control-result",
      requestId: "ctl-1",
      result: { ok: true, browsers: [] },
    });
  });

  it("refuses remote link-status, link-reload, and shutdown controls", async () => {
    const sentFrames: BrokerServerFrame[] = [];
    const sink: RemoteClientSink = {
      send: (frame) => sentFrames.push(frame),
      close: () => {},
    };

    const remoteClientId = server.attachRemoteClient(sink, {
      label: "agent-1",
      version: "1.0",
    });

    // link-status
    server.deliverRemoteFrame(remoteClientId, {
      kind: "control",
      requestId: "ctl-status",
      control: { control: "link-status" },
    });
    expect(sentFrames[0]).toEqual({
      kind: "control-result",
      requestId: "ctl-status",
      result: {
        ok: false,
        error: "'link-status' is not allowed over a remote link",
      },
    });

    // link-reload
    server.deliverRemoteFrame(remoteClientId, {
      kind: "control",
      requestId: "ctl-reload",
      control: { control: "link-reload" },
    });
    expect(sentFrames[1]).toEqual({
      kind: "control-result",
      requestId: "ctl-reload",
      result: {
        ok: false,
        error: "'link-reload' is not allowed over a remote link",
      },
    });

    // shutdown
    server.deliverRemoteFrame(remoteClientId, {
      kind: "control",
      requestId: "ctl-shutdown",
      control: { control: "shutdown" },
    });
    expect(sentFrames[2]).toEqual({
      kind: "control-result",
      requestId: "ctl-shutdown",
      result: {
        ok: false,
        error: "'shutdown' is not allowed over a remote link",
      },
    });
  });

  it("allows local signed client to call link-status and shutdown", async () => {
    const localClient = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(localClient);

    // Call link-status
    const statusPromise = nextMessage(localClient);
    localClient.send(
      envelope({
        kind: "control",
        requestId: "local-ctl-status",
        control: { control: "link-status" },
      })
    );

    const statusRes = await statusPromise;
    expect(statusRes.payload).toEqual({
      kind: "control-result",
      requestId: "local-ctl-status",
      result: {
        ok: true,
        link: fakeCtrl.linkStatus,
        version: FOXPILOT_VERSION,
      },
    });

    // Call shutdown
    const shutdownPromise = nextMessage(localClient);
    localClient.send(
      envelope({
        kind: "control",
        requestId: "local-ctl-shutdown",
        control: { control: "shutdown" },
      })
    );

    const shutdownRes = await shutdownPromise;
    expect(shutdownRes.payload).toEqual({
      kind: "control-result",
      requestId: "local-ctl-shutdown",
      result: {
        ok: true,
        version: FOXPILOT_VERSION,
      },
    });

    // Wait for onShutdown callback to be invoked (~50ms)
    await new Promise((r) => setTimeout(r, 80));
    expect(shutdownCalled).toBe(true);

    localClient.close();
  });

  it("releases leases when detachRemoteClient is called", async () => {
    const sink: RemoteClientSink = {
      send: () => {},
      close: () => {},
    };

    const remoteClientId = server.attachRemoteClient(sink, {
      label: "agent-1",
      version: "1.0",
    });

    // Remote client acquires lease on tab 42
    server.deliverRemoteFrame(remoteClientId, {
      kind: "control",
      requestId: "c-acquire",
      control: { control: "acquire-lease", tabId: 42 },
    });

    // Local client tries to acquire lease on tab 42 -> conflict
    const localClient = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    await waitOpen(localClient);

    const failPromise = nextMessage(localClient);
    localClient.send(
      envelope({
        kind: "control",
        requestId: "c-local-1",
        control: { control: "acquire-lease", tabId: 42 },
      })
    );
    const failRes = await failPromise;
    expect(failRes.payload.result.ok).toBe(false);

    // Detach remote client
    server.detachRemoteClient(remoteClientId);

    // Local client now tries to acquire lease on tab 42 -> success
    const successPromise = nextMessage(localClient);
    localClient.send(
      envelope({
        kind: "control",
        requestId: "c-local-2",
        control: { control: "acquire-lease", tabId: 42 },
      })
    );
    const successRes = await successPromise;
    expect(successRes.payload.result.ok).toBe(true);

    localClient.close();
  });

  it("includes version, remoteClients, and link status in GET /health", async () => {
    const sink: RemoteClientSink = {
      send: () => {},
      close: () => {},
    };
    server.attachRemoteClient(sink, { label: "agent", version: "1.0" });

    const health = await getHealth(port);
    expect(health).toMatchObject({
      status: "ok",
      version: FOXPILOT_VERSION,
      remoteClients: 1,
      link: {
        enabled: true,
        relayConnected: true,
        sessions: 1,
      },
    });
  });

  it("includes link status in extension healthcheck reply", async () => {
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ext);
    ext.send(
      envelope({
        type: "hello",
        browserId: "ext-1",
        browserType: "chrome",
        label: "Chrome",
      })
    );
    await nextMessage(ext); // welcome

    const replyPromise = nextMessage(ext);
    ext.send(JSON.stringify({ type: "healthcheck" }));
    const reply = await replyPromise;

    expect(reply.type).toBe("healthcheck-result");
    expect(reply.link).toEqual({
      enabled: true,
      relayConnected: true,
      relayUrl: "wss://relay.example.com",
      sessions: [
        {
          label: "agent-remote",
          connectedAt: 1234567890,
        },
      ],
    });

    ext.close();
  });

  it("handles link-off envelope from origin-mode and signed-mode extensions", async () => {
    // 1. Origin-mode extension sends unsigned link-off -> calls turnOff
    const originExt = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      origin: "chrome-extension://abcdefghijklmnop",
    });
    await waitOpen(originExt);
    originExt.send(
      JSON.stringify({
        payload: {
          type: "hello",
          browserId: "origin-ext",
          browserType: "chrome",
          label: "Chrome",
        },
      })
    );
    await nextMessage(originExt);

    originExt.send(JSON.stringify({ payload: { type: "link-off" } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeCtrl.turnOffCalls).toBe(1);
    originExt.close();

    // 2. Signed-mode extension sends unsigned link-off -> ignored
    const signedExt = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(signedExt);
    signedExt.send(
      envelope({
        type: "hello",
        browserId: "signed-ext",
        browserType: "chrome",
        label: "Chrome",
      })
    );
    await nextMessage(signedExt);

    signedExt.send(JSON.stringify({ payload: { type: "link-off" } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeCtrl.turnOffCalls).toBe(1); // not incremented!

    // 3. Signed-mode extension sends signed link-off -> calls turnOff
    signedExt.send(envelope({ type: "link-off" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeCtrl.turnOffCalls).toBe(2);
    signedExt.close();
  });

  it("suppresses idle shutdown while linkController is active and shuts down when inactive", async () => {
    let idleFired = false;
    const idleServer = new BrokerServer({
      port: 0,
      host: "127.0.0.1",
      secret: SECRET,
      idleTimeoutMs: 100,
      onIdle: () => {
        idleFired = true;
      },
    });

    const activeCtrl = new FakeLinkController();
    activeCtrl.active = true;
    idleServer.setLinkController(activeCtrl);
    await idleServer.listen();

    idleServer.refreshIdle();
    await new Promise((r) => setTimeout(r, 150));
    expect(idleFired).toBe(false);

    // Make inactive and refreshIdle
    activeCtrl.active = false;
    idleServer.refreshIdle();

    await new Promise((r) => setTimeout(r, 150));
    expect(idleFired).toBe(true);

    idleServer.close();
  });
});
