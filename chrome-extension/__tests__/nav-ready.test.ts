import { mockBrowser } from "./setup";
import { waitForTabReady } from "../nav-ready";

describe("chrome nav-ready", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockBrowser as any).tabs.onUpdated = {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    };
  });

  it("waitForTabReady injects the content script then pings the responder", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ status: "complete" });
    (mockBrowser.scripting.executeScript as jest.Mock).mockResolvedValue([]);
    (mockBrowser.tabs.sendMessage as jest.Mock).mockResolvedValue({ ok: true });
    await expect(waitForTabReady(5)).resolves.toBeUndefined();
    expect(mockBrowser.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 5 },
      files: ["dist/content-script.js"],
    });
    expect(mockBrowser.tabs.sendMessage).toHaveBeenCalledWith(5, { type: "ping" });
  });

  it("waitForTabReady NEVER rejects on timeout", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ status: "loading" });
    (mockBrowser.scripting.executeScript as jest.Mock).mockResolvedValue([]);
    (mockBrowser.tabs.sendMessage as jest.Mock).mockRejectedValue(new Error("no receiver"));
    await expect(waitForTabReady(5, { timeoutMs: 40 })).resolves.toBeUndefined();
  });
});
