import { mockBrowser } from "./setup";
import {
  waitForTabReady,
  navigateAndSettle,
  plantDocumentToken,
  readDocumentToken,
  isAtTarget,
  type NavigationWatch,
} from "../nav-ready";

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
  type ReplacedListener = (addedTabId: number, removedTabId: number) => void;
  let listeners: Listener[];
  let replacedListeners: ReplacedListener[];

  beforeEach(() => {
    jest.clearAllMocks();
    listeners = [];
    replacedListeners = [];
    (mockBrowser as any).tabs.onUpdated = {
      addListener: (l: Listener) => listeners.push(l),
      removeListener: (l: Listener) => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    (mockBrowser as any).tabs.onReplaced = {
      addListener: (l: ReplacedListener) => replacedListeners.push(l),
      removeListener: (l: ReplacedListener) => {
        const i = replacedListeners.indexOf(l);
        if (i >= 0) replacedListeners.splice(i, 1);
      },
    };
  });

  it("gives up at the deadline without rejecting, and keeps listening until disposed", async () => {
    // A navigation that never commits within the wait (hung server).
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({
      status: "loading",
      url: "https://old.example/",
      pendingUrl: "https://new.example/",
    });
    const start = jest.fn().mockResolvedValue(undefined);
    const t0 = Date.now();
    const watch = await navigateAndSettle(5, start, { timeoutMs: 60 });
    expect(watch.committed()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(1);
    watch.dispose();
    expect(listeners).toHaveLength(0);
    expect(replacedListeners).toHaveLength(0);
    watch.dispose(); // idempotent
  });

  it("counts a commit that lands after the settle window, until it is disposed", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({
      status: "loading",
      url: "https://old.example/",
      pendingUrl: "https://new.example/",
    });
    const watch = await navigateAndSettle(5, jest.fn().mockResolvedValue(undefined), { timeoutMs: 60 });
    expect(watch.committed()).toBe(false);
    // The commit arrives while the caller is still polling a waitFor* condition.
    const tab = { status: "loading", url: "https://new.example/" };
    listeners.slice().forEach((l) => l(5, { status: "loading", url: tab.url }, tab));
    expect(watch.committed()).toBe(true);
    watch.dispose();
  });

  it("after a timed-out settle, stops counting once the navigation ends without a page, and stops reading the tab when disposed", async () => {
    let state: Record<string, string> = {
      status: "loading",
      url: "https://old.example/",
      pendingUrl: "https://new.example/",
    };
    (mockBrowser.tabs.get as jest.Mock).mockImplementation(async () => state);
    const watch = await navigateAndSettle(5, jest.fn().mockResolvedValue(undefined), { timeoutMs: 60 });
    // Ours ends without a page: Chromium fires no event, the tab just reads
    // complete again.
    state = { status: "complete", url: "https://old.example/" };
    await new Promise((r) => setTimeout(r, 250));
    // Then the old page changes its own url.
    const moved = { status: "loading", url: "https://old.example/#later" };
    listeners.slice().forEach((l) => l(5, { status: "loading", url: moved.url }, moved));
    expect(watch.committed()).toBe(false);
    watch.dispose();
    const reads = (mockBrowser.tabs.get as jest.Mock).mock.calls.length;
    await new Promise((r) => setTimeout(r, 250));
    expect((mockBrowser.tabs.get as jest.Mock).mock.calls.length).toBe(reads);
  });

  it("propagates a failure to start the navigation and still releases its listeners", async () => {
    const start = jest.fn().mockRejectedValue(new Error("No tab with id: 5."));
    await expect(navigateAndSettle(5, start, { timeoutMs: 1000 })).rejects.toThrow("No tab with id: 5.");
    expect(listeners).toHaveLength(0);
    expect(replacedListeners).toHaveLength(0);
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
    const watch = await navigateAndSettle(5, start, { timeoutMs: 2000 });
    expect(watch.committed()).toBe(true);
    // ...and there is nothing left to wait for.
    expect(Date.now() - t0).toBeLessThan(1000);
    watch.dispose();
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
    const watch = await navigateAndSettle(5, start, { timeoutMs: 2000 });
    expect(watch.committed()).toBe(false);
    watch.dispose();
  });

  it("reports a tab closed mid-navigation as gone, without waiting out the deadline", async () => {
    let closed = false;
    (mockBrowser.tabs.get as jest.Mock).mockImplementation(async () => {
      if (closed) throw new Error("No tab with id: 5.");
      return { status: "loading", url: "https://old.example/", pendingUrl: "https://new.example/" };
    });
    const start = jest.fn(async () => {
      setTimeout(() => {
        closed = true;
      }, 20);
    });
    const t0 = Date.now();
    const watch = await navigateAndSettle(5, start, { timeoutMs: 3000 });
    expect(watch.gone()).toBe(true);
    expect(watch.replacedBy()).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
    watch.dispose();
  });

  it("names the tab Chrome swapped in for ours (tabs.onReplaced)", async () => {
    let replaced = false;
    (mockBrowser.tabs.get as jest.Mock).mockImplementation(async () => {
      if (replaced) throw new Error("No tab with id: 5.");
      return { status: "loading", url: "https://old.example/", pendingUrl: "https://new.example/" };
    });
    const start = jest.fn(async () => {
      setTimeout(() => {
        replaced = true;
        replacedListeners.slice().forEach((l) => l(12, 5));
      }, 20);
    });
    const watch = await navigateAndSettle(5, start, { timeoutMs: 3000 });
    expect(watch.gone()).toBe(true);
    expect(watch.replacedBy()).toBe(12);
    watch.dispose();
    expect(replacedListeners).toHaveLength(0);
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
      let settled: NavigationWatch | undefined;
      navigateAndSettle(5, async () => undefined, { timeoutMs: 5000 }).then((w) => {
        settled = w;
      });
      // Run promise callbacks WITHOUT advancing the clock: nothing is left to
      // wait for, so the settle must not be parked on a poll timer.
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(settled && settled.committed()).toBe(true);
      settled?.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("chrome document token", () => {
  type Injection = { func: (...args: any[]) => unknown; args?: unknown[] };
  // Runs an injected func the way chrome.scripting.executeScript does (from
  // its source, with `args`), with `win` standing in for the page's window as
  // the extension's isolated world sees it.
  function runInWindow(d: Injection, win: Record<string, unknown>): unknown {
    return new Function("window", "args", `return (${d.func.toString()}).apply(null, args);`)(win, d.args || []);
  }
  const scriptWindow = (win: Record<string, unknown>) =>
    (mockBrowser.scripting.executeScript as jest.Mock).mockImplementation(async (d: Injection) => [
      { frameId: 0, result: runInWindow(d, win) },
    ]);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("plants a token at once and hands back the same one while the document lasts", async () => {
    const win: Record<string, unknown> = {};
    scriptWindow(win);
    const token = await plantDocumentToken(5);
    expect(typeof token).toBe("string");
    expect(token).not.toBe("");
    expect(await plantDocumentToken(5)).toBe(token);
    expect(await readDocumentToken(5)).toBe(token);
    // At once, even on a page that is still loading.
    expect(mockBrowser.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 5 },
      injectImmediately: true,
      func: expect.any(Function),
      args: [expect.any(String)],
    });
    expect(
      (mockBrowser.scripting.executeScript as jest.Mock).mock.calls.every(([d]) => d.injectImmediately === true)
    ).toBe(true);
  });

  it("reads '' from a document without a token, and does not plant one", async () => {
    const win: Record<string, unknown> = {};
    scriptWindow(win);
    expect(await readDocumentToken(5)).toBe("");
    expect(Object.keys(win)).toHaveLength(0);
  });

  it("cannot tell (undefined) when the page refuses the script or answers with something else", async () => {
    (mockBrowser.scripting.executeScript as jest.Mock).mockRejectedValue(new Error("Cannot access a chrome:// URL"));
    expect(await plantDocumentToken(5)).toBeUndefined();
    expect(await readDocumentToken(5)).toBeUndefined();
    for (const answer of [[{ frameId: 0, result: 1 }], [{ frameId: 0 }], [], undefined]) {
      (mockBrowser.scripting.executeScript as jest.Mock).mockResolvedValue(answer);
      expect(await plantDocumentToken(5)).toBeUndefined();
      expect(await readDocumentToken(5)).toBeUndefined();
    }
  });

  it("gives up after 500ms on a frame that does not answer", async () => {
    jest.useFakeTimers();
    try {
      (mockBrowser.scripting.executeScript as jest.Mock).mockImplementation(() => new Promise(() => {}));
      for (const probe of [plantDocumentToken, readDocumentToken]) {
        let result: string | undefined | null = null;
        probe(5).then((r) => {
          result = r;
        });
        await jest.advanceTimersByTimeAsync(499);
        expect(result).toBeNull();
        await jest.advanceTimersByTimeAsync(1);
        expect(result).toBeUndefined();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it("isAtTarget: the target url once normalized, or the target's own document when the target has a fragment", () => {
    expect(isAtTarget("https://app.example/", "https://app.example")).toBe(true);
    expect(isAtTarget("https://app.example/a", "https://app.example/b")).toBe(false);
    // A hash router moving a same-document jump on.
    expect(isAtTarget("https://app.example/#/settings/general", "https://app.example/#/settings")).toBe(true);
    expect(isAtTarget("https://app.example/b#/settings", "https://app.example/a#/settings")).toBe(false);
    // A target without a fragment loads a new document; a fragment on the
    // tab's url does not make it the target.
    expect(isAtTarget("https://app.example/a#top", "https://app.example/a")).toBe(false);
    // Chrome reports url "" for a tab that has not committed any page yet.
    expect(isAtTarget("", "https://app.example/")).toBe(false);
    expect(isAtTarget(undefined, "https://app.example/")).toBe(false);
  });
});
