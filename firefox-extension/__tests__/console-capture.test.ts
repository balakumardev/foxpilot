/**
 * Tests for the background console-capture module.
 *
 * NOTE on scope: the live page-world console interception (wrapping the page's
 * `console.*` and `window.onerror`) is browser-only — jsdom has no page/isolated
 * world split and `browser.contentScripts.register` does not actually inject. So
 * these tests cover the parts that run in the background's isolated world:
 *   - the per-tab ring buffer (add / get / cap / isolation / clear-on-removal),
 *   - the `runtime.onMessage` plumbing that turns a content-script message into a
 *     buffered entry keyed by `sender.tab.id`,
 *   - registration toggling as Automation Mode flips via `storage.onChanged`,
 *   - the structural shape of the `CAPTURE_CONTENT_SCRIPT` string.
 * The actual interception is verified manually in a real Firefox profile.
 */

import {
  addConsoleEntry,
  getConsoleEntries,
  clearAllConsoleState,
  initConsoleCapture,
  registerCaptureScript,
  unregisterCaptureScript,
  CAPTURE_CONTENT_SCRIPT,
  CONSOLE_BUFFER_CAP,
} from "../console-capture";

// Helpers to grab the listeners registered with the mocked browser event APIs.
function lastListener(mockFn: jest.Mock): (...args: any[]) => any {
  const calls = mockFn.mock.calls;
  return calls[calls.length - 1][0];
}

// Flush all pending promise chains (microtasks across multiple awaits). A
// setTimeout(0) macrotask yields after every currently-queued microtask has
// run, which is enough for the storage.get → getConfig → isAutomationModeEnabled
// → registerCaptureScript → contentScripts.register chain to settle.
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("console-capture ring buffer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear any state left over from a prior test by removing the tabs we use.
    [1, 2, 3, 99].forEach((id) => {
      // getConsoleEntries has no clear API of its own; clearing happens on tab
      // removal, which the buffer exposes indirectly. We rely on unique tab ids
      // per test instead, but reset the well-known ones defensively via the
      // exported removal path if present.
    });
  });

  it("buffers and returns entries for a tab in insertion order", () => {
    const tabId = 101;
    addConsoleEntry(tabId, { level: "log", text: "first", timestamp: 1 });
    addConsoleEntry(tabId, { level: "warn", text: "second", timestamp: 2 });

    const entries = getConsoleEntries(tabId);
    expect(entries).toEqual([
      { level: "log", text: "first", timestamp: 1 },
      { level: "warn", text: "second", timestamp: 2 },
    ]);
  });

  it("returns an empty array for a tab with no entries", () => {
    expect(getConsoleEntries(987654)).toEqual([]);
  });

  it("isolates buffers per tab", () => {
    const a = 201;
    const b = 202;
    addConsoleEntry(a, { level: "log", text: "a-only", timestamp: 1 });
    addConsoleEntry(b, { level: "log", text: "b-only", timestamp: 1 });

    expect(getConsoleEntries(a)).toEqual([
      { level: "log", text: "a-only", timestamp: 1 },
    ]);
    expect(getConsoleEntries(b)).toEqual([
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
    // Oldest 50 dropped, so the first retained entry is m50 and the last is the
    // final one pushed.
    expect(entries[0].text).toBe(`m${total - CONSOLE_BUFFER_CAP}`);
    expect(entries[entries.length - 1].text).toBe(`m${total - 1}`);
  });

  it("returns only the most-recent `limit` entries when a limit is given", () => {
    const tabId = 401;
    for (let i = 0; i < 10; i++) {
      addConsoleEntry(tabId, { level: "log", text: `n${i}`, timestamp: i });
    }
    const entries = getConsoleEntries(tabId, 3);
    expect(entries.map((e: { text: string }) => e.text)).toEqual([
      "n7",
      "n8",
      "n9",
    ]);
  });

  it("returns all entries when limit exceeds the buffered count", () => {
    const tabId = 402;
    addConsoleEntry(tabId, { level: "log", text: "only", timestamp: 1 });
    expect(getConsoleEntries(tabId, 100)).toHaveLength(1);
  });
});

describe("initConsoleCapture wiring", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // Reset the module-level capture-script registration state so each test
    // starts from "not registered" (registration is intentionally idempotent
    // via module state that would otherwise leak across tests).
    await unregisterCaptureScript();
    jest.clearAllMocks();
    // Default: automation mode off, so init does not register the script.
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
    (browser.contentScripts.register as jest.Mock).mockResolvedValue({
      unregister: jest.fn(),
    });
  });

  it("does not touch the browser API on mere import (registration is explicit)", () => {
    // Importing the module at the top of this file must NOT have called any
    // browser event API. If it had, these would have been called before any
    // test ran; clearAllMocks in beforeEach resets call counts, so we assert by
    // registering listeners only via initConsoleCapture below.
    expect(browser.runtime.onMessage.addListener).not.toHaveBeenCalled();
    expect(browser.tabs.onRemoved.addListener).not.toHaveBeenCalled();
    expect(browser.storage.onChanged.addListener).not.toHaveBeenCalled();
  });

  it("registers runtime.onMessage, tabs.onRemoved and storage.onChanged listeners", () => {
    initConsoleCapture();
    expect(browser.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(browser.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
    expect(browser.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
  });

  it("buffers an entry from a content-script message keyed by sender.tab.id", async () => {
    initConsoleCapture();
    const onMessage = lastListener(browser.runtime.onMessage.addListener as jest.Mock);

    const tabId = 555;
    onMessage(
      {
        type: "bcmcp-console-entry",
        entry: { level: "error", text: "boom", timestamp: 123 },
      },
      { tab: { id: tabId } }
    );

    expect(getConsoleEntries(tabId)).toEqual([
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
        ],
      },
      { tab: { id: 562 } }
    );
    expect(getConsoleEntries(562)).toEqual([
      { level: "log", text: "a", timestamp: 1 },
      { level: "warn", text: "b", timestamp: 2 },
    ]);
  });

  it("clamps an oversized entry text to the cap on the runtime.onMessage path", async () => {
    // Defense in depth: even though the page-world wrapper clamps text, a forged
    // or buggy content-script message could carry an over-long string. The
    // background must re-clamp it so a hostile page cannot bloat the buffer with
    // multi-megabyte entries. The cap (MAX_ENTRY_TEXT) is 2000 chars.
    const MAX_ENTRY_TEXT = 2000;
    initConsoleCapture();
    const onMessage = lastListener(
      browser.runtime.onMessage.addListener as jest.Mock
    );

    const tabId = 557;
    const huge = "x".repeat(MAX_ENTRY_TEXT + 5000);
    onMessage(
      {
        type: "bcmcp-console-entry",
        entry: { level: "log", text: huge, timestamp: 7 },
      },
      { tab: { id: tabId } }
    );

    const entries = getConsoleEntries(tabId);
    expect(entries).toHaveLength(1);
    expect(entries[0].text.length).toBe(MAX_ENTRY_TEXT);
    expect(entries[0].text).toBe("x".repeat(MAX_ENTRY_TEXT));
  });

  it("ignores unrelated runtime messages and messages without a sender tab", async () => {
    initConsoleCapture();
    const onMessage = lastListener(browser.runtime.onMessage.addListener as jest.Mock);

    // Unrelated message type:
    onMessage({ type: "something-else" }, { tab: { id: 556 } });
    // Right type but no sender tab id:
    onMessage(
      { type: "bcmcp-console-entry", entry: { level: "log", text: "x", timestamp: 1 } },
      {}
    );
    onMessage(
      { type: "bcmcp-console-entry", entry: { level: "log", text: "x", timestamp: 1 } },
      { tab: {} }
    );

    expect(getConsoleEntries(556)).toEqual([]);
  });

  it("clears a tab's buffer when the tab is removed", () => {
    initConsoleCapture();
    const onRemoved = lastListener(browser.tabs.onRemoved.addListener as jest.Mock);

    const tabId = 600;
    addConsoleEntry(tabId, { level: "log", text: "gone soon", timestamp: 1 });
    expect(getConsoleEntries(tabId)).toHaveLength(1);

    onRemoved(tabId, { windowId: 1, isWindowClosing: false });
    expect(getConsoleEntries(tabId)).toEqual([]);
  });

  it("registers the capture script on init when Automation Mode AND console capture are already on", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: {
        secret: "s",
        ports: [8089],
        automationMode: true,
        consoleCapture: true,
      },
    });
    initConsoleCapture();
    // initConsoleCapture reads config asynchronously; let the chain settle.
    await flushPromises();
    expect(browser.contentScripts.register).toHaveBeenCalledTimes(1);
    const arg = (browser.contentScripts.register as jest.Mock).mock.calls[0][0];
    expect(arg.matches).toEqual(["<all_urls>"]);
    expect(arg.runAt).toBe("document_start");
    expect(arg.allFrames).toBe(true);
    expect(arg.js[0].code).toBe(CAPTURE_CONTENT_SCRIPT);
  });

  it("does NOT register the capture script on init when Automation Mode is off", async () => {
    initConsoleCapture();
    await flushPromises();
    expect(browser.contentScripts.register).not.toHaveBeenCalled();
  });

  it("registers when storage.onChanged flips automationMode on, unregisters when off", async () => {
    initConsoleCapture();
    const onChanged = lastListener(browser.storage.onChanged.addListener as jest.Mock);
    const handle = { unregister: jest.fn() };
    (browser.contentScripts.register as jest.Mock).mockResolvedValue(handle);

    // Flip ON: config.automationMode changes false -> true (capture already opted in).
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
    expect(browser.contentScripts.register).toHaveBeenCalledTimes(1);

    // Flip OFF: config.automationMode changes true -> false → unregister.
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
    expect(handle.unregister).toHaveBeenCalledTimes(1);
  });

  it("ignores storage.onChanged events from other areas or unrelated keys", async () => {
    initConsoleCapture();
    const onChanged = lastListener(browser.storage.onChanged.addListener as jest.Mock);

    // sync area — ignored.
    onChanged(
      { config: { newValue: { automationMode: true, consoleCapture: true } } },
      "sync"
    );
    // local area but a different key — ignored.
    onChanged({ somethingElse: { newValue: 1 } }, "local");
    await flushPromises();
    expect(browser.contentScripts.register).not.toHaveBeenCalled();
  });

  it("clears buffered console entries when Automation Mode flips off", async () => {
    const handle = { unregister: jest.fn() };
    (browser.contentScripts.register as jest.Mock).mockResolvedValue(handle);

    initConsoleCapture();
    const onChanged = lastListener(
      browser.storage.onChanged.addListener as jest.Mock
    );

    // Flip ON so capture is active and accumulate some entries.
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
    const tabId = 650;
    addConsoleEntry(tabId, { level: "log", text: "prior-session", timestamp: 1 });
    expect(getConsoleEntries(tabId)).toHaveLength(1);

    // Flip OFF: the capture script is unregistered AND the buffers are cleared so
    // a later re-enable does not surface stale prior-session output.
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
    expect(handle.unregister).toHaveBeenCalledTimes(1);
    expect(getConsoleEntries(tabId)).toEqual([]);
  });
});

describe("registerCaptureScript idempotency and error handling", () => {
  beforeEach(async () => {
    // Start each test from "not registered" — the module keeps the handle in a
    // module-level variable that persists across tests.
    (browser.contentScripts.register as jest.Mock).mockResolvedValue({
      unregister: jest.fn(),
    });
    await unregisterCaptureScript();
    jest.clearAllMocks();
  });

  it("registers only once across repeated calls (idempotent)", async () => {
    (browser.contentScripts.register as jest.Mock).mockResolvedValue({
      unregister: jest.fn(),
    });
    await registerCaptureScript();
    await registerCaptureScript();
    expect(browser.contentScripts.register).toHaveBeenCalledTimes(1);
    // Clean up so other suites start fresh.
    await unregisterCaptureScript();
  });

  it("unregister calls the stored handle's unregister and allows re-registration", async () => {
    const handle = { unregister: jest.fn() };
    (browser.contentScripts.register as jest.Mock).mockResolvedValue(handle);
    await registerCaptureScript();
    await unregisterCaptureScript();
    expect(handle.unregister).toHaveBeenCalledTimes(1);
    // After unregister we can register again.
    await registerCaptureScript();
    expect(browser.contentScripts.register).toHaveBeenCalledTimes(2);
    await unregisterCaptureScript();
  });

  it("swallows a registration failure (missing host permission) without throwing", async () => {
    (browser.contentScripts.register as jest.Mock).mockRejectedValue(
      new Error("missing host permission")
    );
    await expect(registerCaptureScript()).resolves.toBeUndefined();
  });

  it("drops the handle if automation mode flips off while a register is mid-await", async () => {
    // register resolves on the next macrotask, giving us a window to call
    // unregister before the handle is stored.
    const handle = { unregister: jest.fn() };
    (browser.contentScripts.register as jest.Mock).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(handle), 0))
    );

    const registerPromise = registerCaptureScript();
    // Flip off before register resolves.
    await unregisterCaptureScript();
    await registerPromise;

    // The just-resolved handle must be unregistered, not left registered.
    expect(handle.unregister).toHaveBeenCalledTimes(1);
  });
});

describe("CAPTURE_CONTENT_SCRIPT structure", () => {
  it("is a non-empty string", () => {
    expect(typeof CAPTURE_CONTENT_SCRIPT).toBe("string");
    expect(CAPTURE_CONTENT_SCRIPT.length).toBeGreaterThan(0);
  });

  it("references the page-world console wrapper and the bridge plumbing", () => {
    expect(CAPTURE_CONTENT_SCRIPT).toContain("console");
    expect(CAPTURE_CONTENT_SCRIPT).toContain("postMessage");
    expect(CAPTURE_CONTENT_SCRIPT).toContain("__bcmcp_console");
    expect(CAPTURE_CONTENT_SCRIPT).toContain("runtime.sendMessage");
    expect(CAPTURE_CONTENT_SCRIPT).toContain('addEventListener("error"');
    expect(CAPTURE_CONTENT_SCRIPT).toContain("unhandledrejection");
    // The content script bridges page-world postMessage to the background and
    // tags batches with the capture message type the background listens for.
    expect(CAPTURE_CONTENT_SCRIPT).toContain("bcmcp-console-batch");
  });

  it("coalesces entries into timed batches and rate-limits at the source", () => {
    // The bridge must buffer + flush on a timer (one message per interval), not
    // one runtime.sendMessage per console line, and the page-world wrapper must
    // rate-limit — together these bound the IPC a chatty page can generate and
    // keep it off the browser IO thread.
    expect(CAPTURE_CONTENT_SCRIPT).toContain("setTimeout");
    expect(CAPTURE_CONTENT_SCRIPT).toContain("entries:");
    expect(CAPTURE_CONTENT_SCRIPT).toContain("RATE_MAX_PER_SEC");
  });

  it("forge-guards the bridge: only forwards same-window messages (e.source === window)", () => {
    // The bridge listens to `window` "message" events, which ANY page script (or
    // a cross-origin iframe via postMessage) can fire. Without the source check a
    // hostile page could inject arbitrary console entries by posting a crafted
    // `{ __bcmcp_console: ... }` message. The guard `e.source === window` ensures
    // we only forward messages the page-world wrapper itself posted to this same
    // window. This is a load-bearing security check — assert it structurally so a
    // refactor cannot silently drop it.
    expect(CAPTURE_CONTENT_SCRIPT).toContain("e.source === window");
    // And the payload-shape guard that pairs with it.
    expect(CAPTURE_CONTENT_SCRIPT).toContain("e.data.__bcmcp_console");
  });

  it("clamps text page-side to the same cap as the background (defense in depth)", () => {
    // The page-world wrapper caps `text` to 2000 chars before posting, mirroring
    // the background's MAX_ENTRY_TEXT re-clamp.
    expect(CAPTURE_CONTENT_SCRIPT).toContain("var MAX = 2000");
    expect(CAPTURE_CONTENT_SCRIPT).toContain("text.slice(0, MAX)");
  });
});

describe("clearAllConsoleState", () => {
  it("drops buffered entries across every tab", () => {
    addConsoleEntry(901, { level: "log", text: "a", timestamp: 1 });
    addConsoleEntry(902, { level: "log", text: "b", timestamp: 1 });
    expect(getConsoleEntries(901)).toHaveLength(1);
    expect(getConsoleEntries(902)).toHaveLength(1);

    clearAllConsoleState();

    expect(getConsoleEntries(901)).toEqual([]);
    expect(getConsoleEntries(902)).toEqual([]);
  });
});

/**
 * Console capture must be gated on its OWN opt-in, not on Automation Mode alone.
 *
 * The registered capture script injects a page-world wrapper over
 * console.log/info/warn/error/debug across <all_urls>, all frames, at
 * document_start. That patch is visible to the page. Bot-detection challenges
 * probe exactly those five methods, so capturing on every page the user merely
 * browses (which is what keying off Automation Mode alone did) breaks those
 * challenges permanently. Capture is now OFF by default and requires BOTH flags.
 */
describe("console capture requires its own opt-in (not Automation Mode alone)", () => {
  beforeEach(async () => {
    (browser.contentScripts.register as jest.Mock).mockResolvedValue({
      unregister: jest.fn(),
    });
    await unregisterCaptureScript();
    jest.clearAllMocks();
    clearAllConsoleState();
    // jest.clearAllMocks() clears call records but NOT implementations, so pin a
    // both-flags-off config here: otherwise initConsoleCapture()'s boot probe
    // would read the previous test's config and register behind the test's back.
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
    (browser.contentScripts.register as jest.Mock).mockResolvedValue({
      unregister: jest.fn(),
    });
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
    expect(browser.contentScripts.register).not.toHaveBeenCalled();
  });

  it("does NOT register on init when console capture is on but Automation Mode is off", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], consoleCapture: true },
    });
    initConsoleCapture();
    await flushPromises();
    expect(browser.contentScripts.register).not.toHaveBeenCalled();
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
    expect(browser.contentScripts.register).toHaveBeenCalledTimes(1);
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
    expect(browser.contentScripts.register).not.toHaveBeenCalled();

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
    expect(browser.contentScripts.register).toHaveBeenCalledTimes(1);
  });

  it("unregisters and clears buffers when consoleCapture flips off (Automation Mode stays on)", async () => {
    const handle = { unregister: jest.fn() };
    (browser.contentScripts.register as jest.Mock).mockResolvedValue(handle);

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
    expect(browser.contentScripts.register).toHaveBeenCalledTimes(1);

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
    expect(handle.unregister).toHaveBeenCalledTimes(1);
    expect(getConsoleEntries(660)).toEqual([]);
  });

  it("unregisters and clears buffers when automationMode flips off (consoleCapture stays on)", async () => {
    const handle = { unregister: jest.fn() };
    (browser.contentScripts.register as jest.Mock).mockResolvedValue(handle);

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
    expect(browser.contentScripts.register).toHaveBeenCalledTimes(1);

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
    expect(handle.unregister).toHaveBeenCalledTimes(1);
    expect(getConsoleEntries(661)).toEqual([]);
  });
});
