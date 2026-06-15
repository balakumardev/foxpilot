import {
  getOrCreateBrowserId,
  getBrowserType,
  getBrowserLabel,
  setSecret,
  getSecret,
  getBrokerConnected,
  getBrokerStatus,
  setBrokerStatus,
  BROKER_STATUS_STORAGE_KEY,
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
