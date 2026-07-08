// Mock nav-ready so waitForTabReady is a deterministic no-op (its own path is
// covered by nav-ready.test.ts). This test isolates the harden's control flow.
jest.mock("../nav-ready", () => ({
  waitForTabReady: jest.fn().mockResolvedValue(undefined),
}));
// Defensive module-load mocks, mirroring the message-handler.test.ts header, so
// importing message-handler never touches a real socket / debugger.
jest.mock("../native-input-client", () => ({
  NativeInputClient: jest.fn().mockImplementation(() => ({ sendGesture: jest.fn() })),
}));
jest.mock("../cdp-eval", () => ({ cdpEval: jest.fn() }));

import { mockBrowser } from "./setup";
import { sendMessageToTab } from "../message-handler";
import { waitForTabReady } from "../nav-ready";

describe("chrome sendMessageToTab harden", () => {
  beforeEach(() => jest.clearAllMocks());

  it("re-reads the live url, re-checks permission, and retries once on a permission failure", async () => {
    let call = 0;
    (mockBrowser.tabs.sendMessage as jest.Mock).mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error("Missing host permission for the tab");
      return { ok: true, tree: "x" };
    });
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://new.example/page" });
    (mockBrowser.permissions.contains as jest.Mock).mockResolvedValue(true);
    (mockBrowser.scripting.executeScript as jest.Mock).mockResolvedValue([]);

    const r = await sendMessageToTab(7, { type: "buildSnapshot" });
    expect(r).toEqual({ ok: true, tree: "x" });
    expect(mockBrowser.permissions.contains).toHaveBeenCalledWith({ origins: ["https://new.example/*"] });
    expect(waitForTabReady).toHaveBeenCalledWith(7, { timeoutMs: 8000 });
    expect(mockBrowser.scripting.executeScript).toHaveBeenCalled();
  });

  it("throws a clear error when the CURRENT origin is unpermitted after nav", async () => {
    (mockBrowser.tabs.sendMessage as jest.Mock).mockRejectedValue(new Error("Missing host permission for the tab"));
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://blocked.example/" });
    (mockBrowser.permissions.contains as jest.Mock).mockResolvedValue(false);
    await expect(sendMessageToTab(7, { type: "buildSnapshot" })).rejects.toThrow(
      /Missing host permission for "https:\/\/blocked.example"/
    );
  });

  it("still passes through a first-try success unchanged", async () => {
    (mockBrowser.tabs.sendMessage as jest.Mock).mockResolvedValue({ ok: true });
    const r = await sendMessageToTab(7, { type: "ping" });
    expect(r).toEqual({ ok: true });
    expect(mockBrowser.scripting.executeScript).not.toHaveBeenCalled();
  });
});
