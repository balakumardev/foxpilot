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
