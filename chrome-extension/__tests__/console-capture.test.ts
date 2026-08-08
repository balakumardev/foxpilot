import {
  addConsoleEntry,
  getConsoleEntries,
  clearAllConsoleState,
  initConsoleCapture,
  registerCaptureScript,
  unregisterCaptureScript,
  CONSOLE_BUFFER_CAP,
} from "../console-capture";

function lastListener(mockFn: jest.Mock): (...args: any[]) => any {
  const calls = mockFn.mock.calls;
  return calls[calls.length - 1][0];
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("console-capture ring buffer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAllConsoleState();
  });

  it("buffers and returns entries for a tab in insertion order", () => {
    const tabId = 101;
    addConsoleEntry(tabId, { level: "log", text: "first", timestamp: 1 });
    addConsoleEntry(tabId, { level: "warn", text: "second", timestamp: 2 });
    expect(getConsoleEntries(tabId)).toEqual([
      { level: "log", text: "first", timestamp: 1 },
      { level: "warn", text: "second", timestamp: 2 },
    ]);
  });

  it("returns an empty array for a tab with no entries", () => {
    expect(getConsoleEntries(987654)).toEqual([]);
  });

  it("isolates buffers per tab", () => {
    addConsoleEntry(201, { level: "log", text: "a-only", timestamp: 1 });
    addConsoleEntry(202, { level: "log", text: "b-only", timestamp: 1 });
    expect(getConsoleEntries(201)).toEqual([
      { level: "log", text: "a-only", timestamp: 1 },
    ]);
    expect(getConsoleEntries(202)).toEqual([
      { level: "log", text: "b-only", timestamp: 1 },
    ]);
  });

  it("caps a tab's buffer at CONSOLE_BUFFER_CAP, dropping the oldest", () => {
    const tabId = 301;
    expect(CONSOLE_BUFFER_CAP).toBe(200);
    const total = CONSOLE_BUFFER_CAP + 50;
    for (let i = 0; i < total; i++) {
      addConsoleEntry(tabId, { level: "log", text: `m${i}`, timestamp: i });
    }
    const entries = getConsoleEntries(tabId);
    expect(entries).toHaveLength(CONSOLE_BUFFER_CAP);
    expect(entries[0].text).toBe(`m${total - CONSOLE_BUFFER_CAP}`);
    expect(entries[entries.length - 1].text).toBe(`m${total - 1}`);
  });

  it("returns only the most-recent `limit` entries when a limit is given", () => {
    const tabId = 401;
    for (let i = 0; i < 10; i++) {
      addConsoleEntry(tabId, { level: "log", text: `n${i}`, timestamp: i });
    }
    expect(getConsoleEntries(tabId, 3).map((e) => e.text)).toEqual([
      "n7",
      "n8",
      "n9",
    ]);
  });
});

describe("initConsoleCapture wiring", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await unregisterCaptureScript();
    jest.clearAllMocks();
    clearAllConsoleState();
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
    (browser.scripting.registerContentScripts as jest.Mock).mockResolvedValue(
      undefined
    );
  });

  it("registers runtime.onMessage, tabs.onRemoved and storage.onChanged listeners", () => {
    initConsoleCapture();
    expect(browser.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(browser.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
    expect(browser.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
  });

  it("buffers an entry from a content-script message keyed by sender.tab.id", () => {
    initConsoleCapture();
    const onMessage = lastListener(
      browser.runtime.onMessage.addListener as jest.Mock
    );
    onMessage(
      {
        type: "bcmcp-console-entry",
        entry: { level: "error", text: "boom", timestamp: 123 },
      },
      { tab: { id: 555 } }
    );
    expect(getConsoleEntries(555)).toEqual([
      { level: "error", text: "boom", timestamp: 123 },
    ]);
  });

  it("buffers every entry from a batched (bcmcp-console-batch) message", () => {
    initConsoleCapture();
    const onMessage = lastListener(
      browser.runtime.onMessage.addListener as jest.Mock
    );
    onMessage(
      {
        type: "bcmcp-console-batch",
        entries: [
          { level: "log", text: "a", timestamp: 1 },
          { level: "warn", text: "b", timestamp: 2 },
          { level: "error", text: "c", timestamp: 3 },
        ],
      },
      { tab: { id: 561 } }
    );
    expect(getConsoleEntries(561)).toEqual([
      { level: "log", text: "a", timestamp: 1 },
      { level: "warn", text: "b", timestamp: 2 },
      { level: "error", text: "c", timestamp: 3 },
    ]);
  });

  it("clamps an oversized entry text to the 2000-char cap on the message path", () => {
    const MAX_ENTRY_TEXT = 2000;
    initConsoleCapture();
    const onMessage = lastListener(
      browser.runtime.onMessage.addListener as jest.Mock
    );
    onMessage(
      {
        type: "bcmcp-console-entry",
        entry: { level: "log", text: "x".repeat(MAX_ENTRY_TEXT + 5000), timestamp: 7 },
      },
      { tab: { id: 557 } }
    );
    const entries = getConsoleEntries(557);
    expect(entries).toHaveLength(1);
    expect(entries[0].text.length).toBe(MAX_ENTRY_TEXT);
  });

  it("ignores unrelated messages and messages without a sender tab", () => {
    initConsoleCapture();
    const onMessage = lastListener(
      browser.runtime.onMessage.addListener as jest.Mock
    );
    onMessage({ type: "something-else" }, { tab: { id: 556 } });
    onMessage(
      { type: "bcmcp-console-entry", entry: { level: "log", text: "x", timestamp: 1 } },
      {}
    );
    expect(getConsoleEntries(556)).toEqual([]);
  });

  it("clears a tab's buffer when the tab is removed", () => {
    initConsoleCapture();
    const onRemoved = lastListener(
      browser.tabs.onRemoved.addListener as jest.Mock
    );
    addConsoleEntry(600, { level: "log", text: "gone soon", timestamp: 1 });
    expect(getConsoleEntries(600)).toHaveLength(1);
    onRemoved(600, { windowId: 1, isWindowClosing: false });
    expect(getConsoleEntries(600)).toEqual([]);
  });

  it("registers the capture scripts on init when Automation Mode AND console capture are already on", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: {
        secret: "s",
        ports: [8089],
        automationMode: true,
        consoleCapture: true,
      },
    });
    initConsoleCapture();
    await flushPromises();
    expect(browser.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
  });

  it("does NOT register the capture scripts on init when Automation Mode is off", async () => {
    initConsoleCapture();
    await flushPromises();
    expect(browser.scripting.registerContentScripts).not.toHaveBeenCalled();
  });
});

describe("registerCaptureScript world split", () => {
  beforeEach(async () => {
    (browser.scripting.registerContentScripts as jest.Mock).mockResolvedValue(
      undefined
    );
    await unregisterCaptureScript();
    jest.clearAllMocks();
    (browser.scripting.registerContentScripts as jest.Mock).mockResolvedValue(
      undefined
    );
  });

  it("registers exactly two scripts, exactly one in the MAIN world, both at document_start/allFrames", async () => {
    await registerCaptureScript();
    expect(browser.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
    const regs = (browser.scripting.registerContentScripts as jest.Mock).mock
      .calls[0][0];
    expect(Array.isArray(regs)).toBe(true);
    expect(regs).toHaveLength(2);

    const mainRegs = regs.filter((r: any) => r.world === "MAIN");
    expect(mainRegs).toHaveLength(1);
    expect(mainRegs[0].js).toEqual(["dist/console-capture-main.js"]);

    const isolated = regs.filter((r: any) => r.world !== "MAIN");
    expect(isolated).toHaveLength(1);
    expect(isolated[0].js).toEqual(["dist/console-capture-bridge.js"]);

    for (const r of regs) {
      expect(r.runAt).toBe("document_start");
      // All frames captured; batching (not frame-count limiting) is what
      // bounds IPC, so iframe console is not dropped.
      expect(r.allFrames).toBe(true);
      expect(r.matches).toEqual(["<all_urls>"]);
    }
    await unregisterCaptureScript();
  });

  it("is idempotent across repeated calls", async () => {
    await registerCaptureScript();
    await registerCaptureScript();
    expect(browser.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
    await unregisterCaptureScript();
  });

  it("clears a stale registration before re-registering (no Duplicate script ID)", async () => {
    (
      browser.scripting.getRegisteredContentScripts as jest.Mock
    ).mockResolvedValueOnce([
      { id: "bcmcp-console-capture-main" },
      { id: "bcmcp-console-capture-bridge" },
    ]);
    await registerCaptureScript();
    expect(browser.scripting.unregisterContentScripts).toHaveBeenCalled();
    const unregArg = (
      browser.scripting.unregisterContentScripts as jest.Mock
    ).mock.calls.pop()![0];
    expect(unregArg.ids).toEqual(
      expect.arrayContaining([
        "bcmcp-console-capture-main",
        "bcmcp-console-capture-bridge",
      ])
    );
    expect(browser.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
    await unregisterCaptureScript();
  });

  it("unregisters BOTH script ids", async () => {
    await registerCaptureScript();
    await unregisterCaptureScript();
    const arg = (browser.scripting.unregisterContentScripts as jest.Mock).mock
      .calls.pop()![0];
    expect(arg.ids).toContain("bcmcp-console-capture-main");
    expect(arg.ids).toContain("bcmcp-console-capture-bridge");
  });

  it("drops the registration if automation mode flips off mid-await", async () => {
    (browser.scripting.registerContentScripts as jest.Mock).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(undefined), 0))
    );
    const registerPromise = registerCaptureScript();
    // Flip off before the register resolves.
    await unregisterCaptureScript();
    await registerPromise;
    await flushPromises();
    // The post-await desiredRegistered re-check must have triggered an unregister.
    expect(browser.scripting.unregisterContentScripts).toHaveBeenCalled();
  });
});

/**
 * Console capture must be gated on its OWN opt-in, not on Automation Mode alone.
 *
 * The capture registration is the most invasive injection the scripting API
 * allows — MAIN world, <all_urls>, allFrames, document_start — and the MAIN-world
 * script monkey-patches console.log/info/warn/error/debug. That patch is visible
 * to the page. Bot-detection challenges probe exactly those five methods, so
 * capturing on every page the user merely browses (which is what keying off
 * Automation Mode alone did) breaks those challenges permanently. Capture is now
 * OFF by default and requires BOTH flags.
 */
describe("console capture requires its own opt-in (not Automation Mode alone)", () => {
  beforeEach(async () => {
    await unregisterCaptureScript();
    jest.clearAllMocks();
    clearAllConsoleState();
    // jest.clearAllMocks() clears call records but NOT implementations, so pin a
    // both-flags-off config here: otherwise initConsoleCapture()'s boot probe
    // would read the previous test's config and register behind the test's back.
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
    (browser.scripting.registerContentScripts as jest.Mock).mockResolvedValue(
      undefined
    );
  });

  afterEach(async () => {
    await unregisterCaptureScript();
  });

  it("does NOT register on init when Automation Mode is on but console capture is off (the default)", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], automationMode: true },
    });
    initConsoleCapture();
    await flushPromises();
    expect(browser.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it("does NOT register on init when console capture is on but Automation Mode is off", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], consoleCapture: true },
    });
    initConsoleCapture();
    await flushPromises();
    expect(browser.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it("registers on init only when BOTH flags are on", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: {
        secret: "s",
        ports: [8089],
        automationMode: true,
        consoleCapture: true,
      },
    });
    initConsoleCapture();
    await flushPromises();
    expect(browser.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
  });

  it("registers when storage.onChanged flips consoleCapture on with Automation Mode already on", async () => {
    initConsoleCapture();
    const onChanged = lastListener(
      browser.storage.onChanged.addListener as jest.Mock
    );

    // Automation Mode alone: still no injection.
    onChanged(
      {
        config: {
          oldValue: { automationMode: false, consoleCapture: false },
          newValue: { automationMode: true, consoleCapture: false },
        },
      },
      "local"
    );
    await flushPromises();
    expect(browser.scripting.registerContentScripts).not.toHaveBeenCalled();

    // Console capture opted in: now it injects.
    onChanged(
      {
        config: {
          oldValue: { automationMode: true, consoleCapture: false },
          newValue: { automationMode: true, consoleCapture: true },
        },
      },
      "local"
    );
    await flushPromises();
    expect(browser.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
  });

  it("unregisters and clears buffers when consoleCapture flips off (Automation Mode stays on)", async () => {
    initConsoleCapture();
    const onChanged = lastListener(
      browser.storage.onChanged.addListener as jest.Mock
    );

    onChanged(
      {
        config: {
          oldValue: { automationMode: true, consoleCapture: false },
          newValue: { automationMode: true, consoleCapture: true },
        },
      },
      "local"
    );
    await flushPromises();
    expect(browser.scripting.registerContentScripts).toHaveBeenCalledTimes(1);

    addConsoleEntry(660, { level: "log", text: "prior", timestamp: 1 });
    expect(getConsoleEntries(660)).toHaveLength(1);

    onChanged(
      {
        config: {
          oldValue: { automationMode: true, consoleCapture: true },
          newValue: { automationMode: true, consoleCapture: false },
        },
      },
      "local"
    );
    await flushPromises();
    expect(browser.scripting.unregisterContentScripts).toHaveBeenCalled();
    expect(getConsoleEntries(660)).toEqual([]);
  });

  it("unregisters and clears buffers when automationMode flips off (consoleCapture stays on)", async () => {
    initConsoleCapture();
    const onChanged = lastListener(
      browser.storage.onChanged.addListener as jest.Mock
    );

    onChanged(
      {
        config: {
          oldValue: { automationMode: false, consoleCapture: true },
          newValue: { automationMode: true, consoleCapture: true },
        },
      },
      "local"
    );
    await flushPromises();
    expect(browser.scripting.registerContentScripts).toHaveBeenCalledTimes(1);

    addConsoleEntry(661, { level: "log", text: "prior", timestamp: 1 });
    expect(getConsoleEntries(661)).toHaveLength(1);

    onChanged(
      {
        config: {
          oldValue: { automationMode: true, consoleCapture: true },
          newValue: { automationMode: false, consoleCapture: true },
        },
      },
      "local"
    );
    await flushPromises();
    expect(browser.scripting.unregisterContentScripts).toHaveBeenCalled();
    expect(getConsoleEntries(661)).toEqual([]);
  });
});

/**
 * Chrome MV3 registrations made with `chrome.scripting.registerContentScripts`
 * default to `persistAcrossSessions: true` — they survive a browser restart AND
 * an extension update. So an install that already had capture registered under
 * the old Automation-Mode-only gate keeps injecting the console patch after
 * updating to a build where capture is off by default: the boot probe simply
 * declines to register, and `unregisterCaptureScript()` early-returns because the
 * in-memory handle is null on a fresh service-worker boot.
 *
 * The boot probe must therefore actively SWEEP a persisted registration when the
 * gate is off, not merely decline to add one. Without this, the fix only reaches
 * new installs, not the users who currently have the bug.
 */
describe("boot sweep of a persisted registration", () => {
  beforeEach(async () => {
    await unregisterCaptureScript();
    jest.clearAllMocks();
    clearAllConsoleState();
    (browser.scripting.registerContentScripts as jest.Mock).mockResolvedValue(
      undefined
    );
    (
      browser.scripting.getRegisteredContentScripts as jest.Mock
    ).mockResolvedValue([]);
  });

  afterEach(async () => {
    await unregisterCaptureScript();
  });

  it("unregisters a registration left over from a previous session when capture is off", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], automationMode: true },
    });
    // A previous version's persisted registration is still installed.
    (
      browser.scripting.getRegisteredContentScripts as jest.Mock
    ).mockResolvedValue([
      { id: "bcmcp-console-capture-main" },
      { id: "bcmcp-console-capture-bridge" },
    ]);

    initConsoleCapture();
    await flushPromises();

    expect(browser.scripting.registerContentScripts).not.toHaveBeenCalled();
    expect(browser.scripting.unregisterContentScripts).toHaveBeenCalled();
    const arg = (browser.scripting.unregisterContentScripts as jest.Mock).mock
      .calls.pop()![0];
    expect(arg.ids).toEqual(
      expect.arrayContaining([
        "bcmcp-console-capture-main",
        "bcmcp-console-capture-bridge",
      ])
    );
  });

  it("does not call unregister when nothing is registered (clean install)", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });

    initConsoleCapture();
    await flushPromises();

    expect(browser.scripting.registerContentScripts).not.toHaveBeenCalled();
    expect(browser.scripting.unregisterContentScripts).not.toHaveBeenCalled();
  });

  it("does not sweep when the gate is on (the registration is wanted)", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: {
        secret: "s",
        ports: [8089],
        automationMode: true,
        consoleCapture: true,
      },
    });

    initConsoleCapture();
    await flushPromises();

    expect(browser.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
  });

  it("survives a getRegisteredContentScripts failure without throwing", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], automationMode: true },
    });
    (
      browser.scripting.getRegisteredContentScripts as jest.Mock
    ).mockRejectedValue(new Error("unsupported"));

    initConsoleCapture();
    await expect(flushPromises()).resolves.toBeUndefined();
    expect(browser.scripting.registerContentScripts).not.toHaveBeenCalled();
  });
});
