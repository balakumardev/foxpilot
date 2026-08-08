import {
  isAutomationModeEnabled,
  setAutomationModeEnabled,
} from "../extension-config";

describe("automation mode config", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("defaults to disabled when not set", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
    expect(await isAutomationModeEnabled()).toBe(false);
  });

  it("reports enabled when the flag is true", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], automationMode: true },
    });
    expect(await isAutomationModeEnabled()).toBe(true);
  });

  it("persists the flag when set", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
    await setAutomationModeEnabled(true);
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      config: expect.objectContaining({ automationMode: true }),
    });
  });
});

import { getTransport, setTransport } from "../extension-config";

describe("transport config", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("defaults to websocket when not set", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
    expect(await getTransport()).toBe("websocket");
  });

  it("reports longpoll when configured", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], transport: "longpoll" },
    });
    expect(await getTransport()).toBe("longpoll");
  });

  it("falls back to websocket for an unrecognized value", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], transport: "bogus" },
    });
    expect(await getTransport()).toBe("websocket");
  });

  it("persists the transport when set", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
    await setTransport("longpoll");
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      config: expect.objectContaining({ transport: "longpoll" }),
    });
  });
});

import {
  requiresAutomationMode,
  shouldBlockForAutomationMode,
} from "../extension-config";

describe("automation command predicates", () => {
  it("flags page-automation commands as requiring automation mode", () => {
    expect(requiresAutomationMode("take-snapshot")).toBe(true);
    expect(requiresAutomationMode("click-element")).toBe(true);
    expect(requiresAutomationMode("evaluate-script")).toBe(true);
    expect(requiresAutomationMode("get-console-messages")).toBe(true);
  });

  it("does not flag existing or benign read commands", () => {
    expect(requiresAutomationMode("open-tab")).toBe(false);
    expect(requiresAutomationMode("get-tab-list")).toBe(false);
    expect(requiresAutomationMode("get-active-tab")).toBe(false);
  });

  it("blocks only when the command requires automation mode and it is disabled", () => {
    expect(shouldBlockForAutomationMode("click-element", false)).toBe(true);
    expect(shouldBlockForAutomationMode("click-element", true)).toBe(false);
    expect(shouldBlockForAutomationMode("open-tab", false)).toBe(false);
  });
});

describe("inputRealismMode", () => {
  beforeEach(() => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
    (browser.storage.local.set as jest.Mock).mockResolvedValue(undefined);
  });

  it("defaults to 'synthetic' when unset", async () => {
    const { getInputRealismMode } = await import("../extension-config");
    expect(await getInputRealismMode()).toBe("synthetic");
  });

  it("returns 'off' when explicitly set", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], inputRealismMode: "off" },
    });
    const { getInputRealismMode } = await import("../extension-config");
    expect(await getInputRealismMode()).toBe("off");
  });

  it("persists a new mode via setInputRealismMode", async () => {
    const { setInputRealismMode } = await import("../extension-config");
    await setInputRealismMode("off");
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      config: expect.objectContaining({ inputRealismMode: "off" }),
    });
  });
});

describe("sidecarPort", () => {
  beforeEach(() => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
    (browser.storage.local.set as jest.Mock).mockResolvedValue(undefined);
  });

  it("defaults to 8090 when unset", async () => {
    const { getSidecarPort } = await import("../extension-config");
    expect(await getSidecarPort()).toBe(8090);
  });

  it("returns the configured port when set", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], sidecarPort: 9123 },
    });
    const { getSidecarPort } = await import("../extension-config");
    expect(await getSidecarPort()).toBe(9123);
  });

  it("persists a new port via setSidecarPort", async () => {
    const { setSidecarPort } = await import("../extension-config");
    await setSidecarPort(9123);
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      config: expect.objectContaining({ sidecarPort: 9123 }),
    });
  });
});

import {
  getBrokerConnected,
  getBrokerStatus,
  setBrokerStatus,
  BROKER_STATUS_STORAGE_KEY,
} from "../extension-config";

describe("broker status mirror", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("setBrokerStatus writes state + reason under the status key", async () => {
    await setBrokerStatus("blocked", "origin_not_allowed");
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      [BROKER_STATUS_STORAGE_KEY]: {
        connected: false,
        state: "blocked",
        reason: "origin_not_allowed",
      },
    });
  });

  it("setBrokerStatus marks connected:true only for the connected state", async () => {
    await setBrokerStatus("connected");
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      [BROKER_STATUS_STORAGE_KEY]: {
        connected: true,
        state: "connected",
        reason: undefined,
      },
    });
  });

  it("getBrokerStatus reads back the full state + reason", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      [BROKER_STATUS_STORAGE_KEY]: {
        connected: false,
        state: "blocked",
        reason: "origin_not_allowed",
      },
    });
    const status = await getBrokerStatus();
    expect(status.state).toBe("blocked");
    expect(status.reason).toBe("origin_not_allowed");
    expect(status.connected).toBe(false);
  });

  it("getBrokerStatus defaults to disconnected when nothing is stored", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({});
    const status = await getBrokerStatus();
    expect(status.state).toBe("disconnected");
    expect(status.connected).toBe(false);
  });

  it("getBrokerConnected still reflects the connected flag", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      [BROKER_STATUS_STORAGE_KEY]: { connected: true, state: "connected" },
    });
    expect(await getBrokerConnected()).toBe(true);
  });
});

import { migrateStaleSecret, setSecret, getSecret } from "../extension-config";

describe("zero-config secret migration", () => {
  function statefulStore(initial: any) {
    const store: any = { config: initial };
    (browser.storage.local.get as jest.Mock).mockImplementation(async () => store);
    (browser.storage.local.set as jest.Mock).mockImplementation(async (v: any) => {
      Object.assign(store, v);
    });
    return store;
  }

  beforeEach(() => jest.clearAllMocks());

  it("clears a stale auto-generated secret (no userSetSecret flag)", async () => {
    const store = statefulStore({ secret: "auto-generated-uuid", ports: [8089] });
    await migrateStaleSecret();
    expect(store.config.secret).toBe("");
    expect(await getSecret()).toBe("");
  });

  it("preserves a deliberately user-set secret", async () => {
    const store = statefulStore({
      secret: "remote-secret",
      userSetSecret: true,
      ports: [8089],
    });
    await migrateStaleSecret();
    expect(store.config.secret).toBe("remote-secret");
  });

  it("is a no-op on a fresh install (no secret to clear)", async () => {
    statefulStore({ secret: "", ports: [8089] });
    await migrateStaleSecret();
    expect(browser.storage.local.set).not.toHaveBeenCalled();
  });

  it("setSecret marks the secret user-set so migration won't clear it", async () => {
    const store = statefulStore({ secret: "", ports: [8089] });
    await setSecret("my-remote-secret");
    expect(store.config.userSetSecret).toBe(true);
    await migrateStaleSecret();
    expect(store.config.secret).toBe("my-remote-secret");
  });
});

import {
  isConsoleCaptureEnabled,
  setConsoleCaptureEnabled,
  shouldCaptureConsole,
} from "../extension-config";

/**
 * Console capture is an INDEPENDENT opt-in, separate from Automation Mode.
 *
 * Registering the capture content script injects a page-world wrapper over
 * `console.log/info/warn/error/debug` in every frame of every page at
 * document_start. That patch is observable from the page, and bot-detection
 * challenges probe exactly those five methods — so an always-on capture (keyed
 * off Automation Mode alone) broke those challenges on every site the user merely
 * browsed. Capture therefore gets its own flag, defaulting OFF.
 */
describe("console capture config flag", () => {
  function statefulStore(initial: any) {
    const store: any = { config: initial };
    (browser.storage.local.get as jest.Mock).mockImplementation(async () => store);
    (browser.storage.local.set as jest.Mock).mockImplementation(async (v: any) => {
      Object.assign(store, v);
    });
    return store;
  }

  beforeEach(() => jest.clearAllMocks());

  it("defaults to DISABLED when the flag is absent", async () => {
    statefulStore({ secret: "s", ports: [8089] });
    expect(await isConsoleCaptureEnabled()).toBe(false);
  });

  it("stays disabled when only Automation Mode is on", async () => {
    statefulStore({ secret: "s", ports: [8089], automationMode: true });
    expect(await isConsoleCaptureEnabled()).toBe(false);
  });

  it("reports enabled only when the flag is explicitly true", async () => {
    statefulStore({ secret: "s", ports: [8089], consoleCapture: true });
    expect(await isConsoleCaptureEnabled()).toBe(true);
  });

  it("treats a non-true value as disabled", async () => {
    statefulStore({ secret: "s", ports: [8089], consoleCapture: "yes" as any });
    expect(await isConsoleCaptureEnabled()).toBe(false);
  });

  it("persists the flag through setConsoleCaptureEnabled", async () => {
    const store = statefulStore({ secret: "s", ports: [8089] });
    await setConsoleCaptureEnabled(true);
    expect(store.config.consoleCapture).toBe(true);
    expect(await isConsoleCaptureEnabled()).toBe(true);

    await setConsoleCaptureEnabled(false);
    expect(store.config.consoleCapture).toBe(false);
    expect(await isConsoleCaptureEnabled()).toBe(false);
  });

  it("does not disturb Automation Mode when toggled", async () => {
    const store = statefulStore({
      secret: "s",
      ports: [8089],
      automationMode: true,
    });
    await setConsoleCaptureEnabled(true);
    expect(store.config.automationMode).toBe(true);
  });
});

describe("shouldCaptureConsole (pure gate)", () => {
  it("requires BOTH Automation Mode and the console-capture opt-in", () => {
    expect(shouldCaptureConsole(true, true)).toBe(true);
  });

  it("is false when console capture is off, however Automation Mode is set", () => {
    expect(shouldCaptureConsole(true, false)).toBe(false);
    expect(shouldCaptureConsole(false, false)).toBe(false);
  });

  it("is false when Automation Mode is off even if console capture is on", () => {
    expect(shouldCaptureConsole(false, true)).toBe(false);
  });
});
