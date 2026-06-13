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
