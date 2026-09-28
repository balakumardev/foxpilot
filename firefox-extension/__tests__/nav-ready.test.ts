import { mockBrowser } from "./setup";
import { waitForTabReady, execWithReadyRetry, navigateAndSettle } from "../nav-ready";

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

describe("firefox navigateAndSettle", () => {
  type Listener = (id: number, info: Record<string, string>, tab: object) => void;
  let listeners: Listener[];

  beforeEach(() => {
    jest.clearAllMocks();
    listeners = [];
    (mockBrowser as any).tabs.onUpdated = {
      addListener: (l: Listener) => listeners.push(l),
      removeListener: (l: Listener) => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
  });

  it("gives up at the deadline without rejecting, and releases its listener", async () => {
    // A load that never finishes (long-poll page, hung server).
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ status: "loading", url: "https://old.example/" });
    const start = jest.fn().mockResolvedValue(undefined);
    const t0 = Date.now();
    await expect(navigateAndSettle(5, start, { timeoutMs: 60 })).resolves.toEqual({ committed: false });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(0);
  });

  it("propagates a failure to start the navigation and still releases its listener", async () => {
    const start = jest.fn().mockRejectedValue(new Error("Invalid tab ID: 5"));
    await expect(navigateAndSettle(5, start, { timeoutMs: 1000 })).rejects.toThrow("Invalid tab ID: 5");
    expect(listeners).toHaveLength(0);
  });

  it("is listening before the navigation starts, so a commit that lands immediately is not missed", async () => {
    let state = { status: "complete", url: "https://old.example/" };
    (mockBrowser.tabs.get as jest.Mock).mockImplementation(async () => state);
    // A same-document jump commits and completes before tabs.update resolves.
    const start = jest.fn(async () => {
      state = { status: "complete", url: "https://old.example/#next" };
      listeners.slice().forEach((l) => l(5, { status: "complete", url: state.url }, state));
    });
    const t0 = Date.now();
    await expect(navigateAndSettle(5, start, { timeoutMs: 2000 })).resolves.toEqual({ committed: true });
    // ...and there is nothing left to wait for.
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("does not sleep through a load that finished while it was reading the tab", async () => {
    jest.useFakeTimers();
    try {
      let reads = 0;
      (mockBrowser.tabs.get as jest.Mock).mockImplementation(async () => {
        reads++;
        if (reads === 1) {
          // The start, commit and end of the load are delivered while this
          // read is in flight, so the state it returns is already stale.
          listeners.slice().forEach((l) => l(5, { status: "loading" }, {}));
          listeners.slice().forEach((l) => l(5, { status: "loading", url: "https://new.example/" }, {}));
          listeners.slice().forEach((l) => l(5, { status: "complete" }, {}));
          return { status: "loading", url: "https://new.example/" };
        }
        return { status: "complete", url: "https://new.example/" };
      });
      let settled: unknown;
      navigateAndSettle(5, async () => undefined, { timeoutMs: 5000 }).then((r) => {
        settled = r;
      });
      // Run promise callbacks WITHOUT advancing the clock: nothing is left to
      // wait for, so the settle must not be parked on a poll timer.
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(settled).toEqual({ committed: true });
    } finally {
      jest.useRealTimers();
    }
  });
});
