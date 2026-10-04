import * as childProcess from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import WebSocket from "ws";

import type { ServerMessageRequest } from "@foxpilot/common";
import { BrokerServer, LinkController } from "../broker";
import { BrowserAPI } from "../browser-api";
import {
  createLinkConfig,
  linkToken,
  readLinkConfig,
  writeLinkConfig,
} from "../link-config";
import { generateLinkSecret, formatLinkToken } from "../link-crypto";
import { LinkHost } from "../link-host";
import { RelayServer } from "../relay-server";
import { createSignature } from "../signing";
import { FOXPILOT_VERSION } from "../version";

// Mock child_process so spawn is a jest mock we can assert on.
jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    spawn: jest.fn(() => ({ unref: jest.fn() })),
  };
});
const spawnMock = childProcess.spawn as jest.Mock;

jest.setTimeout(60000);

const CONTROL_SECRET = "link-e2e-control-secret-test";
const LARGE_SCREENSHOT_DATA = "A".repeat(3 * 1024 * 1024);

type Reply = { payload: object } | { error: string };

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

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
  diagnosticFn?: () => unknown
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() > deadline) {
        const diag = diagnosticFn ? ` (diagnostics: ${JSON.stringify(diagnosticFn())})` : "";
        reject(new Error(`Timed out waiting for predicate after ${timeoutMs}ms${diag}`));
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}

function startMockExtension(
  port: number,
  secret: string,
  replyFn: (req: ServerMessageRequest) => Promise<Reply> | Reply,
  onReq?: (req: ServerMessageRequest) => void
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    let opened = false;

    ws.on("open", () => {
      opened = true;
      const helloPayload = {
        type: "hello",
        browserId: "mock-e2e-ext",
        browserType: "firefox",
        label: "Firefox E2E",
      };
      ws.send(
        JSON.stringify({
          payload: helloPayload,
          signature: createSignature(secret, JSON.stringify(helloPayload)),
        })
      );
      resolve(ws);
    });

    ws.on("error", (err) => {
      if (!opened) {
        reject(err);
      }
    });

    ws.on("message", async (data) => {
      try {
        const env = JSON.parse(data.toString());
        if (env?.type === "welcome" || env?.type === "rejected") {
          return;
        }
        const rawCmd = env?.payload?.cmd;
        if (typeof rawCmd !== "string" || rawCmd === "active-status") {
          return;
        }
        const req = env.payload as ServerMessageRequest;
        onReq?.(req);
        const reply = await replyFn(req);
        if (ws.readyState !== WebSocket.OPEN) return;
        if ("error" in reply) {
          ws.send(
            JSON.stringify({
              correlationId: req.correlationId,
              errorMessage: reply.error,
            })
          );
        } else {
          ws.send(
            JSON.stringify({
              payload: reply.payload,
              signature: createSignature(secret, JSON.stringify(reply.payload)),
            })
          );
        }
      } catch {
        /* ignore parse or network teardown */
      }
    });
  });
}

describe("FoxPilot remote link end-to-end test suite", () => {
  let tempDir: string;
  let relay: RelayServer;
  let relayPort: number;
  let relayUrl: string;
  let broker: BrokerServer;
  let brokerPort: number;
  let linkHost: LinkHost;
  let linkController: LinkController;
  let ext: WebSocket;
  let localApi: BrowserAPI;
  let remoteApi: BrowserAPI;
  let apiRotated: BrowserAPI;

  const createdApis: BrowserAPI[] = [];
  const receivedExtensionRequests: ServerMessageRequest[] = [];
  const extensionEvents: Array<{ event: "start" | "end"; req: ServerMessageRequest; time: number }> = [];

  const originalEnv = { ...process.env };

  beforeAll(async () => {
    // 1. Temp dir for link.json
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "foxpilot-link-e2e-"));

    // 2. Start in-process RelayServer
    relay = new RelayServer({ port: 0 });
    await relay.listen();
    relayPort = relay.getPort();
    relayUrl = `ws://127.0.0.1:${relayPort}`;

    // 3. Write initial enabled LinkConfig to temp dir
    const initialConfig = createLinkConfig(relayUrl);
    writeLinkConfig(initialConfig, tempDir);

    // 4. Start local BrokerServer
    broker = new BrokerServer({
      port: 0,
      host: "127.0.0.1",
      secret: CONTROL_SECRET,
    });
    await broker.listen();
    brokerPort = broker.getPort();

    // 5. Wire LinkHost exactly like broker-main.ts
    linkHost = new LinkHost({
      broker,
      version: FOXPILOT_VERSION,
      reconnectMinMs: 100,
      reconnectMaxMs: 500,
    });

    linkController = {
      status: () => linkHost.status(),
      reload: () => {
        linkHost.apply(readLinkConfig(tempDir));
        broker.refreshIdle();
        return linkHost.status();
      },
      turnOff: () => {
        const config = readLinkConfig(tempDir);
        if (config) {
          try {
            writeLinkConfig({ ...config, enabled: false }, tempDir);
          } catch (err) {
            console.error("Broker: failed to write link config on turn-off:", err);
          }
        }
        linkHost.apply(null);
        broker.refreshIdle();
        return linkHost.status();
      },
      isActive: () => linkHost.isActive(),
    };

    broker.setLinkController(linkController);
    linkHost.apply(readLinkConfig(tempDir));

    await waitFor(() => linkHost.status().relayConnected, 5000);

    // 6. Connect mock browser extension to broker /extension
    ext = await startMockExtension(
      brokerPort,
      CONTROL_SECRET,
      async (req) => {
        switch (req.cmd) {
          case "get-tab-list":
            return {
              payload: {
                resource: "tabs",
                correlationId: req.correlationId,
                tabs: [
                  { id: 1, url: "https://example.com/tab1", title: "Tab 1" },
                  { id: 2, url: "https://example.com/tab2", title: "Tab 2" },
                ],
              },
            };
          case "take-screenshot":
            return {
              payload: {
                resource: "screenshot",
                correlationId: req.correlationId,
                mimeType: "image/png",
                base64: LARGE_SCREENSHOT_DATA,
              },
            };
          case "open-tab":
            return {
              payload: {
                resource: "opened-tab-id",
                correlationId: req.correlationId,
                tabId: 42,
              },
            };
          case "click-element":
            extensionEvents.push({ event: "start", req, time: Date.now() });
            await new Promise((r) => setTimeout(r, 300));
            extensionEvents.push({ event: "end", req, time: Date.now() });
            return {
              payload: {
                resource: "action-result",
                correlationId: req.correlationId,
                ok: true,
              },
            };
          default:
            return { error: `unhandled cmd: ${req.cmd}` };
        }
      },
      (req) => {
        receivedExtensionRequests.push(req);
      }
    );

    // 7. Initialize LOCAL BrowserAPI (plain mode)
    delete process.env.FOXPILOT_LINK;
    delete process.env.FOXPILOT_LINK_LABEL;
    delete process.env.FOXPILOT_RELAY_URL;
    process.env.EXTENSION_SECRET = CONTROL_SECRET;
    process.env.EXTENSION_PORT = String(brokerPort);

    localApi = new BrowserAPI();
    await localApi.init();

    // 8. Initialize REMOTE BrowserAPI (link mode)
    delete process.env.EXTENSION_SECRET;
    delete process.env.EXTENSION_PORT;
    process.env.FOXPILOT_LINK = linkToken(initialConfig);
    process.env.FOXPILOT_LINK_LABEL = "cloud-ws-1";

    remoteApi = new BrowserAPI();
    await remoteApi.init();

    // Clear any previous spawn calls
    spawnMock.mockClear();
  });

  afterAll(async () => {
    for (const api of createdApis) {
      try {
        api.close();
      } catch {
        /* ignore */
      }
    }
    try {
      remoteApi?.close();
    } catch {
      /* ignore */
    }
    try {
      localApi?.close();
    } catch {
      /* ignore */
    }
    try {
      ext?.close();
    } catch {
      /* ignore */
    }
    try {
      linkHost?.close();
    } catch {
      /* ignore */
    }
    try {
      broker?.close();
    } catch {
      /* ignore */
    }
    try {
      await relay?.close();
    } catch {
      /* ignore */
    }
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    process.env = { ...originalEnv };
  });

  it("1. remote session establishes: remote getTabList returns tabs, /health shows link info, label matches", async () => {
    const tabs = await remoteApi.getTabList();
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toEqual({ id: 1, url: "https://example.com/tab1", title: "Tab 1" });
    expect(tabs[1]).toEqual({ id: 2, url: "https://example.com/tab2", title: "Tab 2" });

    const health = await getHealth(brokerPort);
    expect(health.remoteClients).toBe(1);
    expect(health.link).toEqual({
      enabled: true,
      relayConnected: true,
      sessions: 1,
    });

    const hostStatus = linkHost.status();
    expect(hostStatus.sessions).toHaveLength(1);
    expect(hostStatus.sessions[0].label).toBe("cloud-ws-1");

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("2. local and remote at the same time: concurrent requests all succeed", async () => {
    const [localTabs, remoteTabs, browsers] = await Promise.all([
      localApi.getTabList(),
      remoteApi.getTabList(),
      remoteApi.listBrowsers(),
    ]);

    expect(localTabs).toHaveLength(2);
    expect(remoteTabs).toHaveLength(2);
    expect(browsers.length).toBeGreaterThanOrEqual(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("3. large payload: remote takeScreenshot returns the exact 3 MB data", async () => {
    const screenshot = await remoteApi.takeScreenshot(42, {});
    expect(screenshot.resource).toBe("screenshot");
    expect(screenshot.base64).toBe(LARGE_SCREENSHOT_DATA);
    expect(screenshot.base64.length).toBe(3 * 1024 * 1024);
  });

  it("4. leases and tab serialization are shared across local and remote", async () => {
    const order: Array<{ who: "local" | "remote"; time: number }> = [];

    const pRemote = remoteApi.clickElement(42, "btn-remote").then(() => {
      order.push({ who: "remote", time: Date.now() });
    });

    // Ensure remote click has arrived at the extension and is in flight
    await waitFor(
      () => extensionEvents.some((e) => e.event === "start" && (e.req as any).uid === "btn-remote"),
      3000
    );

    const pLocal = localApi.clickElement(42, "btn-local").then(() => {
      order.push({ who: "local", time: Date.now() });
    });

    await Promise.all([pRemote, pLocal]);

    expect(order).toHaveLength(2);
    expect(order[0].who).toBe("remote");
    expect(order[1].who).toBe("local");
    expect(order[1].time - order[0].time).toBeGreaterThanOrEqual(250);

    // Verify in extension events that second click-element started only after first ended
    const clickReqs = extensionEvents.filter((e) => (e.req as any).uid?.startsWith("btn-"));
    expect(clickReqs).toHaveLength(4);
    expect(clickReqs[0].event).toBe("start");
    expect(clickReqs[1].event).toBe("end");
    expect(clickReqs[2].event).toBe("start");
    expect(clickReqs[3].event).toBe("end");
    expect(clickReqs[2].time).toBeGreaterThanOrEqual(clickReqs[1].time);
  });

  it("5. turning the link off from the browser disables link and fails next remote call", async () => {
    const linkOffPayload = { type: "link-off" };
    ext.send(
      JSON.stringify({
        payload: linkOffPayload,
        signature: createSignature(CONTROL_SECRET, JSON.stringify(linkOffPayload)),
      })
    );

    await waitFor(() => {
      const conf = readLinkConfig(tempDir);
      return conf !== null && conf.enabled === false;
    }, 3000);

    const config = readLinkConfig(tempDir);
    expect(config?.enabled).toBe(false);

    const health = await getHealth(brokerPort);
    expect(health.link.enabled).toBe(false);

    await expect(remoteApi.getTabList()).rejects.toThrow(
      /(turned off|rotated|not connected)/i
    );
  }, 30000);

  it("6. re-enable and rotate: reload re-enables old token, then rotation switches room", async () => {
    // 1. Re-enable with existing secret
    const conf = readLinkConfig(tempDir)!;
    writeLinkConfig({ ...conf, enabled: true }, tempDir);
    linkController.reload();

    await waitFor(
      () => linkHost.status().relayConnected,
      5000,
      50,
      () => ({ hostStatus: linkHost.status(), relayStats: relay.stats(), config: readLinkConfig(tempDir) })
    );

    // NEW remote BrowserAPI with old token works again
    process.env.FOXPILOT_LINK = linkToken(conf);
    process.env.FOXPILOT_LINK_LABEL = "cloud-ws-reenabled";
    const apiReenabled = new BrowserAPI();
    await apiReenabled.init();
    createdApis.push(apiReenabled);

    const reenabledTabs = await apiReenabled.getTabList();
    expect(reenabledTabs).toHaveLength(2);

    // 2. Rotate with new secret
    const rotatedConfig = {
      ...conf,
      enabled: true,
      secret: generateLinkSecret().toString("base64url"),
      createdAt: new Date().toISOString(),
    };
    writeLinkConfig(rotatedConfig, tempDir);
    linkController.reload();

    await waitFor(
      () => linkHost.status().relayConnected,
      5000,
      50,
      () => ({ hostStatus: linkHost.status(), relayStats: relay.stats(), config: readLinkConfig(tempDir) })
    );

    // Remote BrowserAPI with OLD token fails
    await expect(apiReenabled.getTabList()).rejects.toThrow(
      /(not connected|did not accept)/i
    );

    // BrowserAPI with NEW token works
    process.env.FOXPILOT_LINK = linkToken(rotatedConfig);
    process.env.FOXPILOT_LINK_LABEL = "cloud-ws-rotated";
    apiRotated = new BrowserAPI();
    await apiRotated.init();
    createdApis.push(apiRotated);

    const rotatedTabs = await apiRotated.getTabList();
    expect(rotatedTabs).toHaveLength(2);
  }, 30000);

  it("7. in-flight request when the relay dies rejects with MISSING REPLY and reconnects", async () => {
    // Remote click-element in flight
    const clickPromise = apiRotated.clickElement(42, "btn-relay-died");

    // Close RelayServer abruptly
    await relay.close();

    // Rejects with MISSING REPLY text
    await expect(clickPromise).rejects.toThrow(/MISSING REPLY/);

    // Restart RelayServer on the SAME port
    relay = new RelayServer({ port: relayPort });
    await relay.listen();

    // Within a few seconds LinkHost reconnects
    await waitFor(() => linkHost.status().relayConnected, 6000);

    // Fresh remote call succeeds again
    const tabs = await apiRotated.getTabList();
    expect(tabs).toHaveLength(2);
  }, 15000);

  it("8. wrong token fails with host-offline text and nothing reaches mock extension", async () => {
    const reqsBefore = receivedExtensionRequests.length;
    const wrongSecret = generateLinkSecret();
    const wrongToken = formatLinkToken(wrongSecret, relayUrl);

    process.env.FOXPILOT_LINK = wrongToken;
    process.env.FOXPILOT_LINK_LABEL = "cloud-ws-wrong";
    const wrongApi = new BrowserAPI();
    await wrongApi.init();
    createdApis.push(wrongApi);

    await expect(wrongApi.getTabList()).rejects.toThrow(/not connected/i);
    expect(receivedExtensionRequests.length).toBe(reqsBefore);
  }, 30000);

  it("9. shutdown cleanup leaves no open handles", async () => {
    for (const api of createdApis) {
      try {
        api.close();
      } catch {
        /* ignore */
      }
    }
    createdApis.length = 0;

    try {
      localApi.close();
    } catch {
      /* ignore */
    }

    try {
      remoteApi.close();
    } catch {
      /* ignore */
    }

    try {
      ext.close();
    } catch {
      /* ignore */
    }

    try {
      linkHost.close();
    } catch {
      /* ignore */
    }

    try {
      broker.close();
    } catch {
      /* ignore */
    }

    try {
      await relay.close();
    } catch {
      /* ignore */
    }

    expect(linkHost.isActive()).toBe(false);
    expect(relay.stats().hosts).toBe(0);
    expect(relay.stats().clients).toBe(0);
  });
});
