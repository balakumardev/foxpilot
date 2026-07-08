import { mockBrowser } from "./setup";
import { waitForTabReady, execWithReadyRetry } from "../nav-ready";

describe("firefox nav-ready", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockBrowser as any).tabs.onUpdated = {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    };
  });

  it("waitForTabReady resolves once the tab is complete and the frame probes injectable", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ status: "complete" });
    (mockBrowser.tabs.executeScript as jest.Mock).mockResolvedValue([1]);
    await expect(waitForTabReady(5)).resolves.toBeUndefined();
    expect(mockBrowser.tabs.executeScript).toHaveBeenCalledWith(5, { code: "1" });
  });

  it("waitForTabReady NEVER rejects on timeout (best-effort)", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ status: "loading" });
    (mockBrowser.tabs.executeScript as jest.Mock).mockRejectedValue(new Error("not injectable"));
    // onUpdated never fires; short budget → resolves (does not throw) after timeout.
    await expect(waitForTabReady(5, { timeoutMs: 40 })).resolves.toBeUndefined();
  });

  it("execWithReadyRetry re-checks permission + retries once after an injection failure", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://new.example/", status: "complete" });
    (mockBrowser.permissions.contains as jest.Mock).mockResolvedValue(true);
    let firstToolCall = true;
    (mockBrowser.tabs.executeScript as jest.Mock).mockImplementation(async (_id: number, d: any) => {
      if (d.code === "1") return [1]; // waitForTabReady probe
      if (firstToolCall) { firstToolCall = false; throw new Error("can't access dead object"); }
      return [42];
    });
    const r = await execWithReadyRetry(9, { code: "document.title" });
    expect(r).toEqual([42]);
    expect(mockBrowser.permissions.contains).toHaveBeenCalledWith({ origins: ["https://new.example/*"] });
  });

  it("execWithReadyRetry throws a clear error when the new origin is unpermitted", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://blocked.example/", status: "complete" });
    (mockBrowser.permissions.contains as jest.Mock).mockResolvedValue(false);
    (mockBrowser.tabs.executeScript as jest.Mock).mockRejectedValue(new Error("mid-nav"));
    await expect(execWithReadyRetry(9, { code: "1+1" })).rejects.toThrow(/Missing host permission for "https:\/\/blocked.example"/);
  });
});
