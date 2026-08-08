import {
  getOrCreateBrowserId,
  getBrowserType,
  getBrowserLabel,
  setSecret,
  getSecret,
  migrateStaleSecret,
  getBrokerConnected,
  getBrokerStatus,
  setBrokerStatus,
  BROKER_STATUS_STORAGE_KEY,
  isConsoleCaptureEnabled,
  setConsoleCaptureEnabled,
  shouldCaptureConsole,
} from "../extension-config";

describe("browser identity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("generates a stable browserId, persisting it once", async () => {
    const store: any = { config: { secret: "s", ports: [8089] } };
    (browser.storage.local.get as jest.Mock).mockImplementation(async () => store);
    (browser.storage.local.set as jest.Mock).mockImplementation(async (v: any) => {
      Object.assign(store, v);
    });
    const fixed = "11111111-2222-3333-4444-555555555555";
    const spy = jest
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(fixed as `${string}-${string}-${string}-${string}-${string}`);

    const first = await getOrCreateBrowserId();
    expect(first).toBe(fixed);
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      config: expect.objectContaining({ browserId: fixed }),
    });

    // Second call reads the persisted id and does NOT generate again.
    spy.mockReturnValue(
      "99999999-9999-9999-9999-999999999999" as `${string}-${string}-${string}-${string}-${string}`
    );
    const second = await getOrCreateBrowserId();
    expect(second).toBe(fixed);
  });

  it("detects chrome when getBrowserInfo is absent", async () => {
    (browser as any).runtime.getBrowserInfo = undefined;
    expect(await getBrowserType()).toBe("chrome");
  });

  it("detects firefox when getBrowserInfo is a function (Zen too)", async () => {
    (browser as any).runtime.getBrowserInfo = jest.fn();
    expect(await getBrowserType()).toBe("firefox");
    (browser as any).runtime.getBrowserInfo = undefined;
  });

  it("defaults the label to the browser type when unset", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
    (browser as any).runtime.getBrowserInfo = undefined;
    expect(await getBrowserLabel()).toBe("chrome");
  });

  it("setSecret persists a user-supplied secret", async () => {
    const store: any = { config: { secret: "old", ports: [8089] } };
    (browser.storage.local.get as jest.Mock).mockImplementation(async () => store);
    (browser.storage.local.set as jest.Mock).mockImplementation(async (v: any) => {
      Object.assign(store, v);
    });
    await setSecret("shared-secret-123");
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      config: expect.objectContaining({ secret: "shared-secret-123" }),
    });
    expect(await getSecret()).toBe("shared-secret-123");
  });
});

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

/**
 * Console capture is an INDEPENDENT opt-in, separate from Automation Mode.
 *
 * Injecting the console-capture scripts patches `console.log/info/warn/error/debug`
 * in the MAIN world of every frame of every page at document_start. That patch is
 * observable from the page, and bot-detection challenges probe exactly those five
 * methods — so an always-on capture (keyed off Automation Mode alone) broke those
 * challenges on every site the user merely browsed. Capture therefore gets its own
 * flag, defaulting OFF.
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
