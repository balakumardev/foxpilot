import { mockBrowser } from "./setup";
import { waitForTabReady, navigateAndSettle } from "../nav-ready";

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

describe("chrome navigateAndSettle", () => {
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
    // A navigation that never commits within the wait (hung server).
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({
      status: "loading",
      url: "https://old.example/",
      pendingUrl: "https://new.example/",
    });
    const start = jest.fn().mockResolvedValue(undefined);
    const t0 = Date.now();
    await expect(navigateAndSettle(5, start, { timeoutMs: 60 })).resolves.toEqual({ committed: false });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(0);
  });

  it("propagates a failure to start the navigation and still releases its listener", async () => {
    const start = jest.fn().mockRejectedValue(new Error("No tab with id: 5."));
    await expect(navigateAndSettle(5, start, { timeoutMs: 1000 })).rejects.toThrow("No tab with id: 5.");
    expect(listeners).toHaveLength(0);
  });

  it("is listening before the navigation starts, so a commit that lands immediately is not missed", async () => {
    let state: Record<string, string> = { status: "complete", url: "https://old.example/" };
    (mockBrowser.tabs.get as jest.Mock).mockImplementation(async () => state);
    // A same-document jump commits and completes before tabs.update resolves.
    const start = jest.fn(async () => {
      state = { status: "complete", url: "https://old.example/#next" };
      listeners.slice().forEach((l) => l(5, { status: "loading", url: state.url }, state));
    });
    const t0 = Date.now();
    await expect(navigateAndSettle(5, start, { timeoutMs: 2000 })).resolves.toEqual({ committed: true });
    // ...and there is nothing left to wait for.
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("does not take the old page changing its own url, while ours is pending, as the commit", async () => {
    let state: Record<string, string> = {
      status: "loading",
      url: "https://old.example/",
      pendingUrl: "https://new.example/",
    };
    (mockBrowser.tabs.get as jest.Mock).mockImplementation(async () => state);
    const start = jest.fn(async () => {
      setTimeout(() => {
        // The old page's router rewrites its url; our navigation is still pending.
        state = { ...state, url: "https://old.example/#tab2" };
        listeners.slice().forEach((l) => l(5, { status: "loading", url: state.url }, state));
      }, 10);
      setTimeout(() => {
        // Our navigation then ends without a page (download / 204).
        state = { status: "complete", url: "https://old.example/#tab2" };
      }, 30);
    });
    await expect(navigateAndSettle(5, start, { timeoutMs: 2000 })).resolves.toEqual({ committed: false });
  });

  it("does not sleep through a load that finished while it was reading the tab", async () => {
    jest.useFakeTimers();
    try {
      let reads = 0;
      (mockBrowser.tabs.get as jest.Mock).mockImplementation(async () => {
        reads++;
        if (reads === 1) {
          // The commit and the end of the load are delivered while this read
          // is in flight, so the state it returns is already stale.
          const tab = { status: "loading", url: "https://new.example/" };
          listeners.slice().forEach((l) => l(5, { status: "loading", url: tab.url }, tab));
          listeners.slice().forEach((l) => l(5, { status: "complete" }, { ...tab, status: "complete" }));
          return tab;
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
