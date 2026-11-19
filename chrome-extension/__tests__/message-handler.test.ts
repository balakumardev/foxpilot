import { MessageHandler } from "../message-handler";
import type { ExtensionTransport } from "../transport";
import type { ServerMessageRequest } from "@foxpilot/common";
import { cdpEval } from "../cdp-eval";
import { mainWorldEval } from "../main-world-eval";
import {
  SNAPSHOT_SETTLE_POLL_MS,
  SNAPSHOT_SETTLE_LOADING_MS,
  SNAPSHOT_SETTLE_SHELL_MS,
} from "@foxpilot/common";
import { addConsoleEntry, clearConsoleEntries } from "../console-capture";

// The native-input client is mocked so importing/constructing the handler never
// touches a real socket or OS input. None of the paths exercised below use it.
jest.mock("../native-input-client", () => ({
  NativeInputClient: jest.fn().mockImplementation(() => ({
    sendGesture: jest.fn(),
  })),
}));

// evaluate-script engine:"cdp" routes through cdpEval (chrome.debugger CDP).
// Mock the module so the routing can be asserted without a real debugger attach.
jest.mock("../cdp-eval", () => ({
  cdpEval: jest.fn(),
}));

// The capture pacing (Chrome allows 2 captureVisibleTab calls per second) is real
// time in production; these handler tests use real timers, so run them with no
// gap. The pacing itself is covered by viewport-capture.test.ts.
jest.mock("../viewport-capture", () => ({
  ...jest.requireActual("../viewport-capture"),
  CAPTURE_MIN_GAP_MS: 0,
}));

// Poll the macrotask queue until `pred` holds — used to await the point at which
// an async handler has progressed far enough to register its nav-race listener
// before the test simulates a tab navigation.
async function flushUntil(
  pred: () => boolean,
  maxTicks = 100
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function makeTransport(): jest.Mocked<ExtensionTransport> {
  return {
    sendResourceToServer: jest.fn().mockResolvedValue(undefined),
    sendErrorToServer: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ExtensionTransport>;
}

describe("MessageHandler (chrome) — foreground-tab preservation", () => {
  let messageHandler: MessageHandler;
  let transport: jest.Mocked<ExtensionTransport>;

  const baseConfig = {
    secret: "test-secret",
    ports: [8089],
    domainDenyList: [] as string[],
    auditLog: [],
    toolSettings: {
      "open-browser-tab": true,
      "find-highlight-in-browser-tab": true,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    transport = makeTransport();
    messageHandler = new MessageHandler(transport);
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: baseConfig,
    });
    // The synthetic input / point-action paths now race their content-script
    // dispatch against tab navigation (nav-race), which registers a
    // tabs.onUpdated listener. The shared setup mock has no onUpdated, so give
    // every test a fresh no-op pair (individual nav tests override it to capture
    // and fire the listener).
    (browser as any).tabs.onUpdated = {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    };
  });

  describe("open-tab command", () => {
    it("opens the new tab in the background (active: false)", async () => {
      (browser.tabs.create as jest.Mock).mockResolvedValue({ id: 123 });

      const request: ServerMessageRequest = {
        cmd: "open-tab",
        url: "https://example.com",
        correlationId: "c1",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.create).toHaveBeenCalledWith({
        url: "https://example.com",
        active: false,
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "opened-tab-id",
        correlationId: "c1",
        tabId: 123,
      });
    });
  });

  describe("select-tab command", () => {
    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...baseConfig, automationMode: true },
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 7, url: "https://example.com", windowId: 3 });
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.windows.update as jest.Mock).mockResolvedValue(undefined);
    });

    it("activates the tab, focuses its window and says so", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "select-tab",
        tabId: 7,
        correlationId: "st1",
      } as ServerMessageRequest);

      expect(browser.tabs.update).toHaveBeenCalledWith(7, { active: true });
      expect(browser.windows.update).toHaveBeenCalledWith(3, { focused: true });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "tab-selected",
        correlationId: "st1",
        tabId: 7,
        windowFocused: true,
      });
    });

    it("with focusWindow:false only activates the tab, leaving the keyboard with the user", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "select-tab",
        tabId: 7,
        focusWindow: false,
        correlationId: "st2",
      } as ServerMessageRequest);

      expect(browser.tabs.update).toHaveBeenCalledWith(7, { active: true });
      expect(browser.windows.update).not.toHaveBeenCalled();
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "tab-selected",
        correlationId: "st2",
        tabId: 7,
        windowFocused: false,
      });
    });
  });

  describe("find-highlight command", () => {
    it("does NOT activate the tab — the highlight is applied via a content-script message", async () => {
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({ count: 3 });

      const request: ServerMessageRequest = {
        cmd: "find-highlight",
        tabId: 123,
        queryPhrase: "test",
        correlationId: "c1",
      };

      await messageHandler.handleDecodedMessage(request);

      // The tab must never be brought to the foreground for a find-highlight.
      expect(browser.tabs.update).not.toHaveBeenCalledWith(123, {
        active: true,
      });
      expect(browser.tabs.update).not.toHaveBeenCalled();
      // The highlight is delivered to the content script instead.
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(123, {
        type: "findHighlight",
        queryPhrase: "test",
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "find-highlight-result",
        correlationId: "c1",
        noOfResults: 3,
      });
    });
  });

  describe("host access when the browser has not granted the page's origin", () => {
    beforeEach(() => {
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com/page",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(false);
      (browser.tabs.create as jest.Mock).mockResolvedValue({ id: 500 });
    });

    it("Automation Mode ON: opens the ALL-SITES grant dialog, not a per-host one", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...baseConfig, automationMode: true },
      });

      await expect(
        messageHandler.handleDecodedMessage({
          cmd: "take-snapshot",
          tabId: 123,
          correlationId: "all1",
        } as ServerMessageRequest)
      ).rejects.toThrow(/^SITE ACCESS NOT GRANTED:.*Automation Mode is on.*all sites/s);

      expect(browser.tabs.create).toHaveBeenCalledTimes(1);
      expect(browser.tabs.create).toHaveBeenCalledWith({
        url: "chrome-extension://test/options.html?requestAllSites=1",
      });
      // The per-origin request must NOT be what the user is asked to approve.
      const url = (browser.tabs.create as jest.Mock).mock.calls[0][0].url;
      expect(url).not.toContain("requestUrl");
      expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it("Automation Mode OFF: keeps the per-host dialog for that origin", async () => {
      await expect(
        messageHandler.handleDecodedMessage({
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "all2",
        } as ServerMessageRequest)
      ).rejects.toThrow(/^SITE ACCESS NOT GRANTED:.*https:\/\/example\.com.*Site access/s);

      expect(browser.tabs.create).toHaveBeenCalledWith({
        url:
          "chrome-extension://test/options.html?requestUrl=" +
          encodeURIComponent("https://example.com/page"),
      });
    });

    it("Automation Mode ON but the origin IS granted: no dialog at all", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...baseConfig, automationMode: true },
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        tree: "",
        isTruncated: false,
      });

      await messageHandler.handleDecodedMessage({
        cmd: "take-snapshot",
        tabId: 123,
        correlationId: "all3",
      } as ServerMessageRequest);

      expect(browser.tabs.create).not.toHaveBeenCalled();
    });
  });

  describe("take-screenshot command", () => {
    const automationConfig = {
      ...baseConfig,
      automationMode: true,
    };

    it("activates the target then restores the previously-active tab when it differs", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
        windowId: 7,
      });
      // A different tab (id 99) is the user's foreground tab.
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 99 }]);
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue(
        "data:image/png;base64,AAAA"
      );

      const request: ServerMessageRequest = {
        cmd: "take-screenshot",
        tabId: 123,
        correlationId: "c1",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.update).toHaveBeenNthCalledWith(1, 123, {
        active: true,
      });
      expect(browser.tabs.update).toHaveBeenNthCalledWith(2, 99, {
        active: true,
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "screenshot",
        correlationId: "c1",
        mimeType: "image/png",
        base64: "AAAA",
      });
    });

    it("does NOT restore when the target tab was already active", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
        windowId: 7,
      });
      // The target tab is already the active tab.
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 123 }]);
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue(
        "data:image/png;base64,AAAA"
      );

      const request: ServerMessageRequest = {
        cmd: "take-screenshot",
        tabId: 123,
        correlationId: "c1",
      };

      await messageHandler.handleDecodedMessage(request);

      // Only the activation, no restore.
      expect(browser.tabs.update).toHaveBeenCalledTimes(1);
      expect(browser.tabs.update).toHaveBeenCalledWith(123, { active: true });
    });

    it("restores the previously-active tab even when both capture paths fail", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
        windowId: 7,
      });
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 99 }]);
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      // captureVisibleTab keeps failing, AND the CDP fallback returns no data —
      // so the whole capture ultimately rejects. The finally must still restore.
      (browser.tabs.captureVisibleTab as jest.Mock).mockRejectedValue(
        new Error("capture failed")
      );
      const dbg = (chrome as any).debugger;
      dbg.attach.mockReset().mockResolvedValue(undefined);
      dbg.detach.mockReset().mockResolvedValue(undefined);
      dbg.sendCommand.mockReset().mockResolvedValue({}); // no .data

      const request: ServerMessageRequest = {
        cmd: "take-screenshot",
        tabId: 123,
        correlationId: "c1",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow(/no data/);

      expect(browser.tabs.update).toHaveBeenNthCalledWith(1, 123, {
        active: true,
      });
      expect(browser.tabs.update).toHaveBeenNthCalledWith(2, 99, {
        active: true,
      });
    });

    it("falls back to CDP Page.captureScreenshot when captureVisibleTab returns empty", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
        windowId: 7,
      });
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 123 }]);
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      // Empty readback on every captureVisibleTab attempt.
      (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue(
        "data:image/png;base64,"
      );
      const dbg = (chrome as any).debugger;
      dbg.attach.mockReset().mockResolvedValue(undefined);
      dbg.detach.mockReset().mockResolvedValue(undefined);
      dbg.sendCommand.mockReset().mockResolvedValue({ data: "Q0RQ" });

      await messageHandler.handleDecodedMessage({
        cmd: "take-screenshot",
        tabId: 123,
        correlationId: "c1",
      } as ServerMessageRequest);

      expect(dbg.attach).toHaveBeenCalledWith({ tabId: 123 }, "1.3");
      expect(dbg.sendCommand).toHaveBeenCalledWith(
        { tabId: 123 },
        "Page.captureScreenshot",
        expect.objectContaining({ format: "png" })
      );
      expect(dbg.detach).toHaveBeenCalledWith({ tabId: 123 });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "screenshot",
          base64: "Q0RQ",
          warning: expect.stringContaining("CDP screenshot fallback"),
        })
      );
    });
    it("hidden (minimized) window whose tab has a frame: probes once, then the debugger renders a fresh image, naming the cause", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
        windowId: 7,
      });
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 123 }]);
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      // A minimized window: the page reports hidden, the window reports minimized.
      (browser as any).scripting.executeScript = jest
        .fn()
        .mockResolvedValue([{ result: "hidden" }]);
      (browser as any).windows.get = jest.fn().mockResolvedValue({ id: 7, state: "minimized" });
      // The tab kept its last frame, so captureVisibleTab returns it (STALE).
      (browser.tabs.captureVisibleTab as jest.Mock)
        .mockReset()
        .mockResolvedValue("data:image/png;base64,STALE");
      const dbg = (chrome as any).debugger;
      dbg.attach.mockReset().mockResolvedValue(undefined);
      dbg.detach.mockReset().mockResolvedValue(undefined);
      dbg.sendCommand.mockReset().mockResolvedValue({ data: "Q0RQ" });

      await messageHandler.handleDecodedMessage({
        cmd: "take-screenshot",
        tabId: 123,
        correlationId: "hid",
      } as ServerMessageRequest);

      // One probe only, no retries against a window that paints nothing, and the
      // fresh debugger render is what the agent gets, not the stale probe.
      expect(browser.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
      expect(dbg.sendCommand).toHaveBeenCalledWith(
        { tabId: 123 },
        "Page.captureScreenshot",
        expect.objectContaining({ format: "png" })
      );
      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "screenshot",
          base64: "Q0RQ",
          warning: expect.stringMatching(/minimized[\s\S]*CDP screenshot fallback/),
        })
      );
      delete (browser as any).scripting.executeScript;
      delete (browser as any).windows.get;
    });

    it("hidden window whose tab has NO frame: fails at once with the cause and never attaches the debugger", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
        windowId: 7,
      });
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 123 }]);
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser as any).scripting.executeScript = jest
        .fn()
        .mockResolvedValue([{ result: "hidden" }]);
      (browser as any).windows.get = jest.fn().mockResolvedValue({ id: 7, state: "minimized" });
      (browser.tabs.captureVisibleTab as jest.Mock)
        .mockReset()
        .mockRejectedValue(new Error("Failed to capture tab: image readback failed"));
      const dbg = (chrome as any).debugger;
      dbg.attach.mockReset().mockResolvedValue(undefined);

      await expect(
        messageHandler.handleDecodedMessage({
          cmd: "take-screenshot",
          tabId: 123,
          correlationId: "noframe",
        } as ServerMessageRequest)
      ).rejects.toThrow(/minimized[\s\S]*no frame[\s\S]*take-snapshot/);

      // The debugger would wait forever for a frame that never comes: do not attach it.
      expect(dbg.attach).not.toHaveBeenCalled();
      expect(browser.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
      delete (browser as any).scripting.executeScript;
      delete (browser as any).windows.get;
    });

    it("hidden window: a full-page screenshot fails at once with the cause, not a bare readback error", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
        windowId: 7,
      });
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 123 }]);
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser as any).scripting.executeScript = jest
        .fn()
        .mockResolvedValue([{ result: "hidden" }]);
      (browser as any).windows.get = jest.fn().mockResolvedValue({ id: 7, state: "minimized" });
      (browser.tabs.captureVisibleTab as jest.Mock).mockReset();

      await expect(
        messageHandler.handleDecodedMessage({
          cmd: "take-screenshot",
          tabId: 123,
          fullPage: true,
          correlationId: "hidfp",
        } as ServerMessageRequest)
      ).rejects.toThrow(/full-page screenshot[\s\S]*minimized[\s\S]*take-snapshot/);
      expect(browser.tabs.captureVisibleTab).not.toHaveBeenCalled();
      delete (browser as any).scripting.executeScript;
      delete (browser as any).windows.get;
    });
    describe("timeouts that keep a screenshot from hanging (measured 2026-11-15)", () => {
      beforeEach(() => {
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: automationConfig,
        });
        (browser.tabs.get as jest.Mock).mockResolvedValue({
          id: 123,
          url: "https://example.com",
          windowId: 7,
        });
        (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 123 }]);
        (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
        jest.useFakeTimers();
      });
      afterEach(() => {
        jest.useRealTimers();
        delete (browser as any).scripting.executeScript;
        delete (browser as any).windows.get;
      });

      it("a debugger capture that never returns is cut off at 6s and the stale frame is returned, labelled", async () => {
        (browser as any).scripting.executeScript = jest
          .fn()
          .mockResolvedValue([{ result: "hidden" }]);
        (browser as any).windows.get = jest.fn().mockResolvedValue({ id: 7, state: "minimized" });
        (browser.tabs.captureVisibleTab as jest.Mock)
          .mockReset()
          .mockResolvedValue("data:image/png;base64,STALE");
        const dbg = (chrome as any).debugger;
        dbg.attach.mockReset().mockResolvedValue(undefined);
        dbg.detach.mockReset().mockResolvedValue(undefined);
        dbg.sendCommand.mockReset().mockReturnValue(new Promise(() => {})); // never settles

        const done = messageHandler.handleDecodedMessage({
          cmd: "take-screenshot",
          tabId: 123,
          correlationId: "hang",
        } as ServerMessageRequest);
        await jest.advanceTimersByTimeAsync(10_000);
        await done;

        expect(transport.sendResourceToServer).toHaveBeenCalledWith(
          expect.objectContaining({
            resource: "screenshot",
            base64: "STALE",
            warning: expect.stringMatching(/produced no frame within 6s[\s\S]*out of date/),
          })
        );
        // The debugger is released even though the capture never answered.
        expect(dbg.detach).toHaveBeenCalledWith({ tabId: 123 });
      });

      it("a visible window whose debugger capture never returns fails with the reason, not a hang", async () => {
        (browser.tabs.captureVisibleTab as jest.Mock)
          .mockReset()
          .mockRejectedValue(new Error("Failed to capture tab: image readback failed"));
        const dbg = (chrome as any).debugger;
        dbg.attach.mockReset().mockResolvedValue(undefined);
        dbg.detach.mockReset().mockResolvedValue(undefined);
        dbg.sendCommand.mockReset().mockReturnValue(new Promise(() => {}));

        const done = messageHandler
          .handleDecodedMessage({
            cmd: "take-screenshot",
            tabId: 123,
            correlationId: "hang2",
          } as ServerMessageRequest)
          .then(
            () => "resolved",
            (e: Error) => e.message
          );
        await jest.advanceTimersByTimeAsync(20_000);
        expect(await done).toMatch(/produced no frame within 6s[\s\S]*readback failed/);
        expect(dbg.detach).toHaveBeenCalledWith({ tabId: 123 });
      });

      it("a busy page cannot stall the screenshot through the visibility read", async () => {
        (browser as any).scripting.executeScript = jest.fn().mockReturnValue(new Promise(() => {}));
        (browser.tabs.captureVisibleTab as jest.Mock)
          .mockReset()
          .mockResolvedValue("data:image/png;base64,GOOD");

        const done = messageHandler.handleDecodedMessage({
          cmd: "take-screenshot",
          tabId: 123,
          correlationId: "busy",
        } as ServerMessageRequest);
        await jest.advanceTimersByTimeAsync(5_000);
        await done;

        expect(transport.sendResourceToServer).toHaveBeenCalledWith({
          resource: "screenshot",
          correlationId: "busy",
          mimeType: "image/png",
          base64: "GOOD",
        });
      });
    });
  });

  describe("opt-in activateTab flag (non-screenshot tools)", () => {
    const automationConfig = { ...baseConfig, automationMode: true };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
        windowId: 7,
      });
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        tree: 'button "Go" [uid=e1]',
        isTruncated: false,
      });
    });

    it("take-snapshot with activateTab:true activates then restores the previous tab", async () => {
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 99 }]);

      await messageHandler.handleDecodedMessage({
        cmd: "take-snapshot",
        tabId: 123,
        activateTab: true,
        correlationId: "s1",
      } as ServerMessageRequest);

      expect(browser.tabs.update).toHaveBeenNthCalledWith(1, 123, {
        active: true,
      });
      expect(browser.tabs.update).toHaveBeenNthCalledWith(2, 99, {
        active: true,
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({ resource: "snapshot", tabId: 123 })
      );
    });

    it("wait-for-text with activateTab:true foregrounds the tab, then restores it", async () => {
      // Regression: wait-for-text had no activateTab field at all, so a frozen
      // BACKGROUND tab could never be un-frozen — and because this command
      // polls for a CHANGE (not a current-state read), a frozen tab can never
      // produce the awaited text, so the call burned its whole deadline and
      // reported "did not appear" on a page that was actually fine.
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 99 }]);
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        found: true,
      });

      await messageHandler.handleDecodedMessage({
        cmd: "wait-for-text",
        tabId: 123,
        text: "Hello",
        activateTab: true,
        correlationId: "w1",
      } as ServerMessageRequest);

      expect(browser.tabs.update).toHaveBeenNthCalledWith(1, 123, {
        active: true,
      });
      expect(browser.tabs.update).toHaveBeenNthCalledWith(2, 99, {
        active: true,
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "wait-for-text-result",
          found: true,
        })
      );
    });

    it("take-snapshot WITHOUT activateTab does not touch tab activation", async () => {
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 99 }]);

      await messageHandler.handleDecodedMessage({
        cmd: "take-snapshot",
        tabId: 123,
        correlationId: "s2",
      } as ServerMessageRequest);

      expect(browser.tabs.update).not.toHaveBeenCalled();
    });

    it("restores the previous tab even when the wrapped tool throws", async () => {
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 99 }]);
      (browser.tabs.sendMessage as jest.Mock).mockRejectedValue(
        new Error("snapshot boom")
      );

      await expect(
        messageHandler.handleDecodedMessage({
          cmd: "take-snapshot",
          tabId: 123,
          activateTab: true,
          correlationId: "s3",
        } as ServerMessageRequest)
      ).rejects.toThrow("snapshot boom");

      expect(browser.tabs.update).toHaveBeenNthCalledWith(2, 99, {
        active: true,
      });
    });
  });

  describe("capture-response-bodies command (chrome.debugger deep capture)", () => {
    const automationConfig = { ...baseConfig, automationMode: true };
    const dbg = (): any => (chrome as any).debugger;

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 42,
        url: "https://example.com",
        windowId: 1,
      });
      dbg().attach.mockReset().mockResolvedValue(undefined);
      dbg().detach.mockReset().mockResolvedValue(undefined);
      dbg().sendCommand.mockReset().mockResolvedValue({});
    });

    afterEach(async () => {
      // The real network-capture module is used here; never leave tab 42 attached.
      const { detachDebugger } = require("../network-capture");
      await detachDebugger(42);
    });

    it("attaches the debugger and replies supported/enabled on enable", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "capture-response-bodies",
        tabId: 42,
        enabled: true,
        correlationId: "cb1",
      } as ServerMessageRequest);

      expect(dbg().attach).toHaveBeenCalledWith({ tabId: 42 }, "1.3");
      expect(dbg().sendCommand).toHaveBeenCalledWith(
        { tabId: 42 },
        "Network.enable"
      );
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "response-body-capture",
        correlationId: "cb1",
        ok: true,
        enabled: true,
        supported: true,
      });
    });

    it("detaches the debugger and replies enabled:false on disable", async () => {
      // Attach first so the disable actually detaches.
      await messageHandler.handleDecodedMessage({
        cmd: "capture-response-bodies",
        tabId: 42,
        enabled: true,
        correlationId: "on",
      } as ServerMessageRequest);
      dbg().detach.mockClear();

      await messageHandler.handleDecodedMessage({
        cmd: "capture-response-bodies",
        tabId: 42,
        enabled: false,
        correlationId: "cb2",
      } as ServerMessageRequest);

      expect(dbg().detach).toHaveBeenCalledWith({ tabId: 42 });
      expect(transport.sendResourceToServer).toHaveBeenLastCalledWith({
        resource: "response-body-capture",
        correlationId: "cb2",
        ok: true,
        enabled: false,
        supported: true,
      });
    });

    it("replies ok:false with the error when attach rejects (DevTools already open)", async () => {
      dbg().attach.mockRejectedValue(
        new Error("Another debugger is already attached")
      );

      await messageHandler.handleDecodedMessage({
        cmd: "capture-response-bodies",
        tabId: 42,
        enabled: true,
        correlationId: "cb3",
      } as ServerMessageRequest);

      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "response-body-capture",
        correlationId: "cb3",
        ok: false,
        enabled: false,
        supported: true,
        error: "Another debugger is already attached",
      });
    });

    // BUG B — the attach succeeds but reporting it fails. The catch reports
    // ok:false/enabled:false while the tab stays attached (banner up, debugger
    // held), so the reported state contradicts the real state and nothing will
    // ever release it. A blanket `finally { detach }` would be wrong here — a
    // SUCCESSFUL enable:true is a deliberate long-lived attach — so only the
    // failure path may roll back.
    it("rolls the attach back when the enable reply cannot be sent", async () => {
      transport.sendResourceToServer
        .mockRejectedValueOnce(new Error("transport down"))
        .mockResolvedValue(undefined);

      await messageHandler.handleDecodedMessage({
        cmd: "capture-response-bodies",
        tabId: 42,
        enabled: true,
        correlationId: "cb-report-fail",
      } as ServerMessageRequest);

      // It told the caller the capture is OFF ...
      expect(transport.sendResourceToServer).toHaveBeenLastCalledWith(
        expect.objectContaining({ ok: false, enabled: false })
      );
      // ... so the tab must actually be detached.
      expect(dbg().detach).toHaveBeenCalledWith({ tabId: 42 });
      const { isDebuggerAttached } = require("../network-capture");
      expect(isDebuggerAttached(42)).toBe(false);
    });

    // F5 — the rollback must only undo a hold THIS call established. When the
    // tab already held the "network" purpose the second attachDebugger is a
    // no-op, and because purposes are a Set (not a counter) a rollback would
    // destroy the pre-existing capture that the earlier caller still owns.
    it("does not tear down a pre-existing capture when a redundant enable fails to report", async () => {
      // First call establishes the long-lived hold.
      await messageHandler.handleDecodedMessage({
        cmd: "capture-response-bodies",
        tabId: 42,
        enabled: true,
        correlationId: "cb-first",
      } as ServerMessageRequest);
      dbg().detach.mockClear();

      // Second, redundant enable — its reply fails to send.
      transport.sendResourceToServer
        .mockRejectedValueOnce(new Error("transport down"))
        .mockResolvedValue(undefined);

      await messageHandler.handleDecodedMessage({
        cmd: "capture-response-bodies",
        tabId: 42,
        enabled: true,
        correlationId: "cb-redundant",
      } as ServerMessageRequest);

      expect(dbg().detach).not.toHaveBeenCalled();
      const { isDebuggerAttached } = require("../network-capture");
      expect(isDebuggerAttached(42)).toBe(true);
    });

    // BUG B guard — a SUCCESSFUL enable must keep its long-lived attach.
    it("keeps the attach when the enable reply is sent successfully", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "capture-response-bodies",
        tabId: 42,
        enabled: true,
        correlationId: "cb-keep",
      } as ServerMessageRequest);

      expect(dbg().detach).not.toHaveBeenCalled();
      const { isDebuggerAttached } = require("../network-capture");
      expect(isDebuggerAttached(42)).toBe(true);
    });
  });

  describe("get-network-requests includeBody scoping (per-tab, not global)", () => {
    const automationConfig = { ...baseConfig, automationMode: true };
    const nc = (): any => require("../network-capture");

    // Seed a POST with a form body through the pure updaters — the same path the
    // covert webRequest listeners drive.
    function seedPost(tabId: number, requestId: string) {
      nc().onBeforeRequestRecord({
        requestId,
        url: "https://example.com/api",
        method: "POST",
        type: "xmlhttprequest",
        tabId,
        timeStamp: 1000,
        requestBody: { formData: { field: ["value"] } },
      });
      nc().onCompletedRecord({
        requestId,
        url: "https://example.com/api",
        method: "POST",
        type: "xmlhttprequest",
        tabId,
        statusCode: 200,
        timeStamp: 1100,
      });
    }

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 60,
        url: "https://example.com",
        windowId: 1,
      });
      nc().clearAllNetworkState();
    });

    afterEach(() => {
      nc().clearAllNetworkState();
    });

    // BUG E — the tool is tab-scoped but the flag it flips is a module global, so
    // one includeBody:true call silently starts capturing request bodies for
    // EVERY tab in the browser.
    it("does not turn on request-body capture for other tabs", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "get-network-requests",
        tabId: 60,
        includeBody: true,
        correlationId: "nb1",
      } as ServerMessageRequest);

      seedPost(61, "other-tab");

      expect(nc().getNetworkRequests(61)[0].requestBody).toBeUndefined();
    });

    it("does turn on request-body capture for the tab that asked", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "get-network-requests",
        tabId: 60,
        includeBody: true,
        correlationId: "nb2",
      } as ServerMessageRequest);

      seedPost(60, "asked-tab");

      expect(nc().getNetworkRequests(60)[0].requestBody).toBe(
        JSON.stringify({ field: ["value"] })
      );
    });

    it("includeBody:false turns capture off again for that tab only", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "get-network-requests",
        tabId: 60,
        includeBody: true,
        correlationId: "nb3",
      } as ServerMessageRequest);
      await messageHandler.handleDecodedMessage({
        cmd: "get-network-requests",
        tabId: 62,
        includeBody: true,
        correlationId: "nb4",
      } as ServerMessageRequest);
      await messageHandler.handleDecodedMessage({
        cmd: "get-network-requests",
        tabId: 60,
        includeBody: false,
        correlationId: "nb5",
      } as ServerMessageRequest);

      seedPost(60, "off-tab");
      seedPost(62, "still-on-tab");

      expect(nc().getNetworkRequests(60)[0].requestBody).toBeUndefined();
      expect(nc().getNetworkRequests(62)[0].requestBody).toBe(
        JSON.stringify({ field: ["value"] })
      );
    });
  });

  describe("wait-for-text command", () => {
    const automationConfig = { ...baseConfig, automationMode: true };

    it("OR-matches an array and returns which needle matched", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 5,
        url: "https://example.com",
      });
      // sendMessageToTab -> content-script probe returns {found, matched}.
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        found: true,
        matched: "Ready",
      });

      await messageHandler.handleDecodedMessage({
        cmd: "wait-for-text",
        tabId: 5,
        text: ["Loading", "Ready"],
        correlationId: "cw",
      } as ServerMessageRequest);

      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(5, {
        type: "waitForText",
        text: ["Loading", "Ready"],
        timeoutMs: 0,
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "wait-for-text-result",
        correlationId: "cw",
        found: true,
        matched: "Ready",
      });
    });

    // The background loop owns the deadline and the spacing between polls. The
    // page is asked for ONE immediate check per round (timeoutMs 0), never to
    // wait or poll on its own: an in-page timer is clamped to one tick per
    // second in a hidden tab, and to one per minute once the tab has been hidden
    // for 5+ minutes, which would stretch each round far past the call budget.
    it("asks the page for a single immediate check per round and keeps polling from the background", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 5,
        url: "https://example.com",
      });
      (browser.tabs.sendMessage as jest.Mock)
        .mockResolvedValueOnce({ found: false })
        .mockResolvedValueOnce({ found: false })
        .mockResolvedValueOnce({ found: true });

      await messageHandler.handleDecodedMessage({
        cmd: "wait-for-text",
        tabId: 5,
        text: "Ready",
        timeoutMs: 5000,
        correlationId: "cw2",
      } as ServerMessageRequest);

      const rounds = (browser.tabs.sendMessage as jest.Mock).mock.calls;
      expect(rounds).toHaveLength(3);
      for (const c of rounds) {
        expect(c[1]).toEqual({ type: "waitForText", text: "Ready", timeoutMs: 0 });
      }
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "wait-for-text-result",
        correlationId: "cw2",
        found: true,
      });
    });
  });

  describe("evaluate-script world (Task 1)", () => {
    const automationConfig = { ...baseConfig, automationMode: true };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 5,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
    });

    it("world:isolated routes to the isolated content-script message and forwards the result", async () => {
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        ok: true,
        value: 42,
      });

      await messageHandler.handleDecodedMessage({
        cmd: "evaluate-script",
        tabId: 5,
        function: "() => 42",
        world: "isolated",
        correlationId: "ci",
      } as ServerMessageRequest);

      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(5, {
        type: "evaluateScriptIsolated",
        functionSource: "() => 42",
        args: [],
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "eval-result",
        correlationId: "ci",
        ok: true,
        value: 42,
        error: undefined,
      });
    });

    it("engine:cdp routes to cdpEval (CSP-immune) and forwards its value as eval-result ok:true", async () => {
      (cdpEval as jest.Mock).mockResolvedValue({ ok: true, value: 5 });

      await messageHandler.handleDecodedMessage({
        cmd: "evaluate-script",
        tabId: 5,
        function: "() => 5",
        args: [],
        engine: "cdp",
        correlationId: "ce",
      } as ServerMessageRequest);

      expect(cdpEval).toHaveBeenCalledWith(5, "() => 5", []);
      // engine:"cdp" bypasses the covert content-script injection entirely.
      expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "eval-result",
        correlationId: "ce",
        ok: true,
        value: 5,
        error: undefined,
      });
    });

    describe("main world via scripting.executeScript (world main / auto / omitted)", () => {
      // The page script's own outcome, as mainWorldEval returns it to the worker.
      // Fake data only; the exact CSP refusal text is the Chromium 140 wording
      // recorded in test-fixtures/browser-probe/OBSERVED.json (case 3, "self").
      const CSP_REFUSAL =
        "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\".\n";

      beforeEach(() => {
        (browser as any).scripting.executeScript = jest.fn();
      });
      afterEach(() => {
        jest.useRealTimers();
        (browser as any).scripting.executeScript = jest.fn().mockResolvedValue([]);
      });

      const evalCall = (extra: Record<string, unknown>, id: string) =>
        messageHandler.handleDecodedMessage({
          cmd: "evaluate-script",
          tabId: 5,
          function: "(a) => a + 1",
          args: [1],
          correlationId: id,
          ...extra,
        } as ServerMessageRequest);

      const lastEvalResult = (id: string) =>
        (transport.sendResourceToServer as jest.Mock).mock.calls.find(
          (c: any[]) => c[0].correlationId === id
        )![0];

      it.each([
        ["main", { world: "main" }],
        ["auto", { world: "auto" }],
        ["undefined", {}],
        // Any non-isolated world string takes the main-world route, as before.
        ["an unknown world string", { world: "bogus" }],
      ])("world %s injects mainWorldEval into the MAIN world and forwards the value", async (_label, extra) => {
        (browser as any).scripting.executeScript.mockResolvedValue([
          { frameId: 0, result: { ok: true, value: { n: 2 } } },
        ]);

        await evalCall(extra as Record<string, unknown>, "m1");

        const exec = (browser as any).scripting.executeScript as jest.Mock;
        expect(exec).toHaveBeenCalledTimes(1);
        const injection = exec.mock.calls[0][0];
        expect(injection.world).toBe("MAIN");
        expect(injection.target).toEqual({ tabId: 5 });
        expect(injection.func).toBe(mainWorldEval);
        expect(injection.args).toEqual(["(a) => a + 1", [1]]);
        // No content-script <script> route, no debugger.
        expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
        expect(cdpEval).not.toHaveBeenCalled();
        expect(transport.sendResourceToServer).toHaveBeenCalledWith({
          resource: "eval-result",
          correlationId: "m1",
          ok: true,
          value: { n: 2 },
          error: undefined,
        });
      });

      it("defaults args to [] when none are given", async () => {
        (browser as any).scripting.executeScript.mockResolvedValue([
          { frameId: 0, result: { ok: true, value: null } },
        ]);
        await messageHandler.handleDecodedMessage({
          cmd: "evaluate-script",
          tabId: 5,
          function: "() => undefined",
          correlationId: "m2",
        } as ServerMessageRequest);
        expect(
          ((browser as any).scripting.executeScript as jest.Mock).mock.calls[0][0].args
        ).toEqual(["() => undefined", []]);
        expect(lastEvalResult("m2")).toMatchObject({ ok: true, value: null });
      });

      it("a function that throws is a plain ok:false carrying its own message (not the CSP text)", async () => {
        (browser as any).scripting.executeScript.mockResolvedValue([
          { frameId: 0, result: { ok: false, error: "fake page error" } },
        ]);
        await evalCall({ world: "auto" }, "m3");
        const r = lastEvalResult("m3");
        expect(r.ok).toBe(false);
        expect(r.error).toBe("fake page error");
      });

      it("cspBlocked becomes the page-CSP message: real cause, what still works, debugger only as the last resort", async () => {
        (browser as any).scripting.executeScript.mockResolvedValue([
          {
            frameId: 0,
            result: { ok: false, error: CSP_REFUSAL, cspBlocked: true },
          },
        ]);

        await evalCall({ world: "auto" }, "m4");

        expect(cdpEval).not.toHaveBeenCalled();
        const r = lastEvalResult("m4");
        expect(r.ok).toBe(false);
        // Pins: the cause is the PAGE's CSP (script-src without 'unsafe-eval').
        expect(r.error).toContain("The page's Content-Security-Policy forbids eval");
        expect(r.error).toContain("script-src has no 'unsafe-eval'");
        // The browser's own refusal is quoted so the agent can see the directive.
        expect(r.error).toContain("Refused to evaluate a string as JavaScript");
        // Reads still work.
        for (const tool of [
          "take-snapshot",
          "get-tab-web-content",
          "get-network-requests",
          "get-cookies",
          "coordinate tools",
        ]) {
          expect(r.error).toContain(tool);
        }
        // The debugger is the last resort and its cost is stated.
        expect(r.error).toContain('engine:"cdp"');
        expect(r.error).toContain("last resort");
        expect(r.error).toContain("FoxPilot started debugging this browser");
        expect(r.error).toContain("the page can detect it");
        // The old misattribution is gone.
        expect(r.error).not.toMatch(/inline script/i);
      });

      it("a hung page function is reported as the same timeout text the old path used, after EVAL_TIMEOUT_MS", async () => {
        jest.useFakeTimers();
        (browser as any).scripting.executeScript.mockReturnValue(new Promise(() => {}));

        const done = evalCall({ world: "main" }, "m5");
        await jest.advanceTimersByTimeAsync(9999);
        expect(
          (transport.sendResourceToServer as jest.Mock).mock.calls.some(
            (c: any[]) => c[0].correlationId === "m5"
          )
        ).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        await done;

        const r = lastEvalResult("m5");
        expect(r.ok).toBe(false);
        expect(r.error).toBe(
          "Timed out waiting for the script result (the function may be hanging or awaiting a promise that never resolves)."
        );
        // The timeout timer was cleaned up, nothing is left pending.
        expect(jest.getTimerCount()).toBe(0);
      });

      it("an executeScript rejection (host access, discarded tab) propagates untouched", async () => {
        (browser as any).scripting.executeScript.mockRejectedValue(
          new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host.")
        );
        await expect(evalCall({ world: "main" }, "m6")).rejects.toThrow(
          /Cannot access contents of the page/
        );
        expect(
          (transport.sendResourceToServer as jest.Mock).mock.calls.some(
            (c: any[]) => c[0].correlationId === "m6"
          )
        ).toBe(false);
      });

      it("an empty injection reply is reported, never thrown as a TypeError", async () => {
        (browser as any).scripting.executeScript.mockResolvedValue([]);
        await evalCall({ world: "main" }, "m7");
        expect(lastEvalResult("m7")).toMatchObject({
          ok: false,
          error: "evaluation produced no result.",
        });
      });

      it("the deny list still runs before anything is injected", async () => {
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: { ...automationConfig, domainDenyList: ["example.com"] },
        });
        await expect(evalCall({ world: "main" }, "m8")).rejects.toThrow(
          /deny list/
        );
        expect((browser as any).scripting.executeScript).not.toHaveBeenCalled();
      });

      it("engine:cdp stays the debugger route and injects nothing", async () => {
        (cdpEval as jest.Mock).mockResolvedValue({ ok: true, value: 7 });
        await evalCall({ engine: "cdp", world: "main" }, "m9");
        expect(cdpEval).toHaveBeenCalledWith(5, "(a) => a + 1", [1]);
        expect((browser as any).scripting.executeScript).not.toHaveBeenCalled();
      });

      it("world:isolated stays on the content-script route and injects nothing", async () => {
        (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({ ok: true, value: 3 });
        await evalCall({ world: "isolated" }, "m10");
        expect((browser as any).scripting.executeScript).not.toHaveBeenCalled();
        expect(browser.tabs.sendMessage).toHaveBeenCalledWith(5, {
          type: "evaluateScriptIsolated",
          functionSource: "(a) => a + 1",
          args: [1],
        });
      });
    });
  });

  describe("take-snapshot waits for a tab that is still loading", () => {
    const automationConfig = { ...baseConfig, automationMode: true };
    const TAB_URL = "https://app.example.test/";

    // One reply of the content script's buildSnapshot, fake data only.
    const reply = (total: number, readyState: string, bodyChildren: number) => ({
      tree: total ? 'button "Go" [uid=e1]' : "",
      isTruncated: false,
      total,
      hasMore: false,
      docState: { readyState, url: TAB_URL, bodyChildren },
    });
    const sendMessage = () => browser.tabs.sendMessage as jest.Mock;
    const sent = () =>
      (transport.sendResourceToServer as jest.Mock).mock.calls
        .map((c: any[]) => c[0])
        .filter((m: any) => m.resource === "snapshot");

    // tabs.get as the tab looks at each point: `pre` for every lookup before the
    // first read (the handler's own gates), then `post` in order, one per lookup
    // the settle loop makes (the last repeats; an Error rejects, as a closed tab).
    const mockTabs = (pre: any, ...post: any[]) => {
      let i = 0;
      (browser.tabs.get as jest.Mock).mockImplementation(async () => {
        if (sendMessage().mock.calls.length === 0) return pre;
        const t = post[Math.min(i++, post.length - 1)];
        if (t instanceof Error) throw t;
        return t;
      });
    };
    const loadingTab = { id: 7, url: TAB_URL, status: "loading" };
    const completeTab = { id: 7, url: TAB_URL, status: "complete" };

    // Starts the command and lets its first read land, without moving the clock.
    const start = (id = "w1") => {
      const done = messageHandler.handleDecodedMessage({
        cmd: "take-snapshot",
        tabId: 7,
        correlationId: id,
      } as ServerMessageRequest);
      // Swallow a rejection that lands before the test awaits `done`.
      done.catch(() => {});
      return done;
    };

    beforeEach(() => {
      jest.useFakeTimers();
      (browser.storage.local.get as jest.Mock).mockResolvedValue({ config: automationConfig });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser.tabs.get as jest.Mock).mockReset();
      (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 7, url: TAB_URL, status: "loading" });
      sendMessage().mockReset();
    });
    afterEach(() => {
      jest.useRealTimers();
      // Leave nothing behind for the describes that follow.
      (browser.tabs.get as jest.Mock).mockReset();
      sendMessage().mockReset();
    });

    it("loading tab that fills in after two re-reads: waits 2 x 300 ms and reports it", async () => {
      sendMessage()
        .mockResolvedValueOnce(reply(0, "loading", 1))
        .mockResolvedValueOnce(reply(0, "loading", 1))
        .mockResolvedValueOnce(reply(4, "complete", 9));
      // after the first read, then before re-read 1, then before re-read 2
      mockTabs(loadingTab, loadingTab, loadingTab, completeTab);

      const done = start();
      await jest.advanceTimersByTimeAsync(SNAPSHOT_SETTLE_POLL_MS - 1);
      expect(sent()).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(sent()).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(SNAPSHOT_SETTLE_POLL_MS);
      await done;

      expect(sendMessage()).toHaveBeenCalledTimes(3);
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatchObject({
        resource: "snapshot",
        correlationId: "w1",
        tabId: 7,
        total: 4,
        waitedMs: 600,
        tabStatus: "complete",
      });
      expect(jest.getTimerCount()).toBe(0);
    });

    it("loading tab that stays empty: stops at SNAPSHOT_SETTLE_LOADING_MS and says how long it waited", async () => {
      sendMessage().mockResolvedValue(reply(0, "loading", 1));
      const done = start("w2");
      await jest.advanceTimersByTimeAsync(SNAPSHOT_SETTLE_LOADING_MS - 1);
      expect(sent()).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(1);
      await done;

      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatchObject({
        total: 0,
        waitedMs: SNAPSHOT_SETTLE_LOADING_MS,
        tabStatus: "loading",
        docState: { readyState: "loading", url: TAB_URL, bodyChildren: 1 },
      });
      // The first read plus 17 re-reads (16 x 300 ms and one trimmed to 200 ms).
      expect(sendMessage()).toHaveBeenCalledTimes(18);
      expect(jest.getTimerCount()).toBe(0);
    });

    it("complete but unrendered shell that fills in: waits, then answers with the rendered tree", async () => {
      (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 7, url: TAB_URL, status: "complete" });
      sendMessage()
        .mockResolvedValueOnce(reply(0, "complete", 1))
        .mockResolvedValueOnce(reply(0, "complete", 2))
        .mockResolvedValueOnce(reply(6, "complete", 8));
      const done = start("w3");
      await jest.advanceTimersByTimeAsync(2 * SNAPSHOT_SETTLE_POLL_MS);
      await done;
      expect(sent()[0]).toMatchObject({ total: 6, waitedMs: 600, tabStatus: "complete" });
    });

    it("complete shell that never renders: gives up after SNAPSHOT_SETTLE_SHELL_MS, not the loading budget", async () => {
      (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 7, url: TAB_URL, status: "complete" });
      sendMessage().mockResolvedValue(reply(0, "complete", 1));
      const done = start("w4");
      await jest.advanceTimersByTimeAsync(SNAPSHOT_SETTLE_SHELL_MS);
      await done;
      expect(sent()[0]).toMatchObject({ total: 0, waitedMs: SNAPSHOT_SETTLE_SHELL_MS, tabStatus: "complete" });
      expect(sendMessage()).toHaveBeenCalledTimes(6); // the first read plus 5 re-reads
    });

    it("a genuinely empty, settled page is NOT waited on: exactly one read, no waitedMs", async () => {
      (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 7, url: TAB_URL, status: "complete" });
      sendMessage().mockResolvedValue(reply(0, "complete", 12));
      await start("w5"); // no timer advance: it must not be sleeping
      expect(sendMessage()).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
      const msg = sent()[0];
      expect(msg).toMatchObject({ total: 0, docState: { readyState: "complete", bodyChildren: 12 } });
      expect("waitedMs" in msg).toBe(false);
      expect("tabStatus" in msg).toBe(false);
    });

    it("a snapshot with elements never waits (and never asks for the tab again)", async () => {
      sendMessage().mockResolvedValue(reply(3, "loading", 5));
      await start("w6");
      expect(sendMessage()).toHaveBeenCalledTimes(1);
      // Every tabs.get came BEFORE the read: the tab is not asked again.
      const gets = (browser.tabs.get as jest.Mock).mock.invocationCallOrder;
      expect(Math.max(...gets)).toBeLessThan(sendMessage().mock.invocationCallOrder[0]);
      expect("waitedMs" in sent()[0]).toBe(false);
    });

    it("a reply with no total or docState (older content script) never waits", async () => {
      sendMessage().mockResolvedValue({ tree: "", isTruncated: false });
      await start("w7");
      expect(sendMessage()).toHaveBeenCalledTimes(1);
      expect(sent()[0]).toEqual({
        resource: "snapshot",
        correlationId: "w7",
        tabId: 7,
        snapshot: "",
        isTruncated: false,
      });
    });

    it("a re-read that fails mid-navigation is retried within the budget", async () => {
      sendMessage()
        .mockResolvedValueOnce(reply(0, "loading", 0))
        .mockRejectedValueOnce(new Error("Frame with ID 0 was removed."))
        .mockResolvedValueOnce(reply(2, "complete", 6));
      const done = start("w8");
      await jest.advanceTimersByTimeAsync(2 * SNAPSHOT_SETTLE_POLL_MS);
      await done;
      expect(sent()[0]).toMatchObject({ total: 2, waitedMs: 600 });
    });

    it("keeps failing until the budget is spent, then rethrows the last error", async () => {
      sendMessage()
        .mockResolvedValueOnce(reply(0, "loading", 0))
        .mockRejectedValue(new Error("Frame with ID 0 was removed."));
      const done = start("w9");
      const outcome = expect(done).rejects.toThrow("Frame with ID 0 was removed.");
      await jest.advanceTimersByTimeAsync(SNAPSHOT_SETTLE_LOADING_MS);
      await outcome;
      expect(sent()).toHaveLength(0);
    });

    it("a FIRST read that fails still fails at once, as before", async () => {
      sendMessage().mockRejectedValue(new Error("Frame with ID 0 was removed."));
      await expect(start("w10")).rejects.toThrow("Frame with ID 0 was removed.");
      expect(sendMessage()).toHaveBeenCalledTimes(1);
    });

    it("a tab closed during the wait ends it with the browser's error", async () => {
      sendMessage().mockResolvedValue(reply(0, "loading", 0));
      mockTabs(loadingTab, loadingTab, new Error("No tab with id: 7."));
      const done = start("w11");
      const outcome = expect(done).rejects.toThrow("No tab with id: 7.");
      await jest.advanceTimersByTimeAsync(SNAPSHOT_SETTLE_POLL_MS);
      await outcome;
      expect(sendMessage()).toHaveBeenCalledTimes(1);
    });

    it("a discarded tab is not retried: the real read error comes out at once", async () => {
      sendMessage()
        .mockResolvedValueOnce(reply(0, "loading", 0))
        .mockRejectedValue(
          new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host.")
        );
      mockTabs(loadingTab, loadingTab, { id: 7, url: TAB_URL, status: "unloaded", discarded: true });
      const done = start("w12");
      const outcome = expect(done).rejects.toThrow(/Cannot access contents of the page/);
      await jest.advanceTimersByTimeAsync(SNAPSHOT_SETTLE_POLL_MS);
      await outcome;
      expect(sendMessage()).toHaveBeenCalledTimes(2);
    });

    it("re-checks the deny list on the tab's CURRENT url (a new tab has none when the gate first runs)", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...automationConfig, domainDenyList: ["denied.example.test"] },
      });
      sendMessage().mockResolvedValue(reply(0, "loading", 0));
      // No url yet when the gates run, still none after the first read, then the
      // tab commits to a denied host.
      mockTabs(
        { id: 7, url: "", status: "loading" },
        { id: 7, url: "", status: "loading" },
        { id: 7, url: "https://denied.example.test/page", status: "loading" }
      );
      const done = start("w13");
      const outcome = expect(done).rejects.toThrow("Domain in tab URL is in the deny list");
      await jest.advanceTimersByTimeAsync(SNAPSHOT_SETTLE_POLL_MS);
      await outcome;
      // Nothing was read off the denied page.
      expect(sendMessage()).toHaveBeenCalledTimes(1);
      expect(sent()).toHaveLength(0);
    });

    it("paces the wait from the service worker (setTimeout here), 300 ms at a time", async () => {
      const spy = jest.spyOn(global, "setTimeout");
      sendMessage().mockResolvedValue(reply(0, "loading", 0));
      const done = start("w14");
      await jest.advanceTimersByTimeAsync(SNAPSHOT_SETTLE_LOADING_MS);
      await done;
      const delays = spy.mock.calls.map((c) => c[1]).filter((d) => d === SNAPSHOT_SETTLE_POLL_MS);
      expect(delays.length).toBeGreaterThanOrEqual(16);
      spy.mockRestore();
    });
  });

  describe("coordinate tools — CDP engine (Phase 3)", () => {
    const automationConfig = { ...baseConfig, automationMode: true };
    let dbg: any;

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 8,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      dbg = (chrome as any).debugger;
      dbg.attach.mockReset().mockResolvedValue(undefined);
      dbg.detach.mockReset().mockResolvedValue(undefined);
      dbg.sendCommand.mockReset().mockResolvedValue({});
      // The isolated-world descriptor read that follows the CDP dispatch.
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        ok: true,
        element: {
          tag: "div",
          id: "card",
          classes: [],
          rect: { x: 0, y: 0, w: 0, h: 0 },
          editable: false,
        },
      });
    });

    afterEach(async () => {
      const { forceDetachDebugger } = require("../network-capture");
      await forceDetachDebugger(8);
    });

    it("click-at engine:cdp describes (validates) the point FIRST, then dispatches trusted Input.*, returning the pre-captured descriptor", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "click-at",
        tabId: 8,
        x: 100,
        y: 200,
        engine: "cdp",
        correlationId: "cdpc",
      } as ServerMessageRequest);

      expect(dbg.attach).toHaveBeenCalledWith({ tabId: 8 }, "1.3");
      const mouse = (dbg.sendCommand as jest.Mock).mock.calls.filter(
        (c: any[]) => c[1] === "Input.dispatchMouseEvent"
      );
      // C17 prepends a mouseMoved, so match press/release by type (not index).
      const pressed = mouse.find((c: any[]) => c[2].type === "mousePressed");
      const released = mouse.find((c: any[]) => c[2].type === "mouseReleased");
      expect(pressed[2]).toMatchObject({ type: "mousePressed", x: 100, y: 200 });
      expect(released[2]).toMatchObject({ type: "mouseReleased", x: 100, y: 200 });
      // Descriptor read is a read-only describe-at in the isolated world.
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
        type: "performPointAction",
        args: { action: "describe-at", x: 100, y: 200 },
      });
      // New ordering (resolve→act→describe): the read-only describe-at that both
      // validates the point and captures the descriptor runs BEFORE any trusted
      // Input.* dispatch — so a click that mutates/navigates can't turn a
      // post-dispatch describe-at miss into a false ok:false for the action.
      const describeOrder = (browser.tabs.sendMessage as jest.Mock).mock
        .invocationCallOrder[0];
      const firstDispatchOrder = (dbg.sendCommand as jest.Mock).mock
        .invocationCallOrder[0];
      expect(describeOrder).toBeLessThan(firstDispatchOrder);
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "point-action-result",
        correlationId: "cdpc",
        ok: true,
        element: {
          tag: "div",
          id: "card",
          classes: [],
          rect: { x: 0, y: 0, w: 0, h: 0 },
          editable: false,
        },
      });
      expect(dbg.detach).toHaveBeenCalledWith({ tabId: 8 });
    });

    it("off-point engine:cdp reports ok:false and does NOT dispatch a trusted event (synthetic offPoint parity)", async () => {
      // describe-at (point validation) finds nothing at the point → the trusted
      // Input.* dispatch must be skipped entirely (no attach, no sendCommand).
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        ok: false,
        error:
          "No element at point (5, 6) — the coordinates may be outside the visible viewport or over a cross-origin frame.",
      });

      await messageHandler.handleDecodedMessage({
        cmd: "click-at",
        tabId: 8,
        x: 5,
        y: 6,
        engine: "cdp",
        correlationId: "cdpoff",
      } as ServerMessageRequest);

      // Point was validated first...
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
        type: "performPointAction",
        args: { action: "describe-at", x: 5, y: 6 },
      });
      // ...and because it missed, NO trusted event was fired and the debugger
      // was never attached.
      const dispatched = (dbg.sendCommand as jest.Mock).mock.calls.filter(
        (c: any[]) => c[1] === "Input.dispatchMouseEvent"
      );
      expect(dispatched).toHaveLength(0);
      expect(dbg.attach).not.toHaveBeenCalled();
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "point-action-result",
        correlationId: "cdpoff",
        ok: false,
        error:
          "No element at point (5, 6) — the coordinates may be outside the visible viewport or over a cross-origin frame.",
      });
    });

    it("reports ok:false (not a throw) when the debugger attach fails", async () => {
      dbg.attach.mockRejectedValue(
        new Error("Another debugger is already attached")
      );
      await messageHandler.handleDecodedMessage({
        cmd: "click-at",
        tabId: 8,
        x: 10,
        y: 20,
        engine: "cdp",
        correlationId: "cdpe",
      } as ServerMessageRequest);

      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "cdpe"
      );
      expect(call[0].ok).toBe(false);
      expect(call[0].error).toMatch(/CDP input dispatch failed/);
    });

    it("synthetic (default engine) still routes to the isolated performPointAction, never CDP", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "click-at",
        tabId: 8,
        x: 3,
        y: 4,
        correlationId: "syn",
      } as ServerMessageRequest);
      expect(dbg.attach).not.toHaveBeenCalled();
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
        type: "performPointAction",
        args: { action: "click-at", x: 3, y: 4, doubleClick: undefined, button: undefined },
      });
    });

    it("type-at engine:cdp validates the point first, then focus-clicks + inserts text, returning the pre-captured descriptor", async () => {
      // C16: the point must be editable for the CDP type to proceed — describe-at
      // reports an editable field here.
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        ok: true,
        element: {
          tag: "textarea",
          classes: [],
          rect: { x: 0, y: 0, w: 0, h: 0 },
          editable: true,
        },
      });
      await messageHandler.handleDecodedMessage({
        cmd: "type-at",
        tabId: 8,
        x: 40,
        y: 50,
        text: "hi there",
        submit: true,
        engine: "cdp",
        correlationId: "cdpt",
      } as ServerMessageRequest);

      expect((dbg.sendCommand as jest.Mock).mock.calls).toEqual(
        expect.arrayContaining([
          [{ tabId: 8 }, "Input.insertText", { text: "hi there" }],
        ])
      );
      const keys = (dbg.sendCommand as jest.Mock).mock.calls.filter(
        (c: any[]) => c[1] === "Input.dispatchKeyEvent"
      );
      expect(keys).toHaveLength(2); // Enter down + up
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
        type: "performPointAction",
        args: { action: "describe-at", x: 40, y: 50 },
      });
      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "cdpt"
      );
      expect(call[0].ok).toBe(true);
    });

    it("type-at engine:cdp on a NON-editable point reports ok:false and never inserts text (C16)", async () => {
      // The default beforeEach describe-at mock reports editable:false, so the
      // CDP type must refuse rather than insertText into a non-field.
      await messageHandler.handleDecodedMessage({
        cmd: "type-at",
        tabId: 8,
        x: 40,
        y: 50,
        text: "nope",
        engine: "cdp",
        correlationId: "cdpne",
      } as ServerMessageRequest);

      expect(
        (dbg.sendCommand as jest.Mock).mock.calls.some(
          (c: any[]) => c[1] === "Input.insertText"
        )
      ).toBe(false);
      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "cdpne"
      );
      expect(call[0].ok).toBe(false);
      expect(call[0].error).toMatch(/not an editable field/i);
    });

    it("hover-at engine:cdp validates the point first, then dispatches a trusted mouseMoved, returning the pre-captured descriptor", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "hover-at",
        tabId: 8,
        x: 12,
        y: 34,
        engine: "cdp",
        correlationId: "cdph",
      } as ServerMessageRequest);
      const move = (dbg.sendCommand as jest.Mock).mock.calls.find(
        (c: any[]) => c[1] === "Input.dispatchMouseEvent"
      );
      expect(move[2]).toMatchObject({ type: "mouseMoved", x: 12, y: 34 });
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
        type: "performPointAction",
        args: { action: "describe-at", x: 12, y: 34 },
      });
    });

    it("scroll-at engine:cdp dispatches a trusted mouseWheel with the deltas", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "scroll-at",
        tabId: 8,
        x: 10,
        y: 20,
        dx: 0,
        dy: 250,
        engine: "cdp",
        correlationId: "cdps",
      } as ServerMessageRequest);
      const wheel = (dbg.sendCommand as jest.Mock).mock.calls.find(
        (c: any[]) => c[1] === "Input.dispatchMouseEvent"
      );
      expect(wheel[2]).toMatchObject({ type: "mouseWheel", x: 10, y: 20, deltaX: 0, deltaY: 250 });
    });
  });

  describe("uid tools — CDP engine (Wave 2 C15)", () => {
    // inputRealismMode:"off" so the SYNTHETIC (non-CDP) path uses the simple
    // performInputAction raw sender — makes "routes to CDP not synthetic"
    // assertions unambiguous.
    const automationConfig = {
      ...baseConfig,
      automationMode: true,
      inputRealismMode: "off",
    };
    let dbg: any;

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 8,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      dbg = (chrome as any).debugger;
      dbg.attach.mockReset().mockResolvedValue(undefined);
      dbg.detach.mockReset().mockResolvedValue(undefined);
      dbg.sendCommand.mockReset().mockResolvedValue({});
      // readElementRect returns getBoundingClientRect-style viewport coords;
      // any synthetic dispatch (performInputAction) resolves ok:true.
      (browser.tabs.sendMessage as jest.Mock).mockImplementation(
        (_id: number, msg: any) => {
          if (msg && msg.type === "readElementRect") {
            // center = (10 + 100/2, 20 + 40/2) = (60, 40)
            return Promise.resolve({ x: 10, y: 20, width: 100, height: 40, dpr: 2 });
          }
          return Promise.resolve({ ok: true });
        }
      );
    });

    afterEach(async () => {
      const { forceDetachDebugger } = require("../network-capture");
      await forceDetachDebugger(8);
    });

    it("click-element engine:cdp resolves the uid center and dispatches a TRUSTED click, NOT the synthetic path", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 8,
        uid: "e5",
        engine: "cdp",
        correlationId: "uidc",
      } as ServerMessageRequest);

      // Resolved the uid via the isolated-world readElementRect...
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
        type: "readElementRect",
        uid: "e5",
      });
      // ...dispatched a trusted click at the computed center (60, 40)...
      expect(dbg.attach).toHaveBeenCalledWith({ tabId: 8 }, "1.3");
      const pressed = (dbg.sendCommand as jest.Mock).mock.calls.find(
        (c: any[]) => c[1] === "Input.dispatchMouseEvent" && c[2].type === "mousePressed"
      );
      expect(pressed[2]).toMatchObject({ type: "mousePressed", x: 60, y: 40, button: "left" });
      // ...and NEVER dispatched a SYNTHETIC input action. The read-only
      // classify-intercept probe rides the performInputAction channel but does
      // not dispatch anything, so it is excluded from this "no synthetic
      // dispatch" guard; a real synthetic click/fill would still be caught.
      const synthetic = (browser.tabs.sendMessage as jest.Mock).mock.calls.filter(
        (c: any[]) =>
          c[1] &&
          ((c[1].type === "performInputAction" &&
            !(c[1].args && c[1].args.action === "classify-intercept")) ||
            c[1].type === "runHumanInput")
      );
      expect(synthetic).toHaveLength(0);
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "uidc",
        ok: true,
      });
    });

    it("click-element engine:cdp surfaces `intercepted` from the isolated classify probe (parity with synthetic)", async () => {
      // A foreign overlay covers the target: the isolated classify probe reports
      // it, and the CDP path forwards it on the action-result so the server
      // renders the "⚠ intercepted" warning — the fix for the silent CDP no-op.
      (browser.tabs.sendMessage as jest.Mock).mockImplementation(
        (_id: number, msg: any) => {
          if (msg && msg.type === "readElementRect") {
            return Promise.resolve({ x: 10, y: 20, width: 100, height: 40, dpr: 2 });
          }
          if (
            msg &&
            msg.type === "performInputAction" &&
            msg.args &&
            msg.args.action === "classify-intercept"
          ) {
            return Promise.resolve({
              ok: true,
              intercepted: { tag: "dialog", classes: "Overlay" },
            });
          }
          return Promise.resolve({ ok: true });
        }
      );

      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 8,
        uid: "e5",
        engine: "cdp",
        correlationId: "uidint",
      } as ServerMessageRequest);

      // The probe ran against the SAME uid...
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
        type: "performInputAction",
        args: { action: "classify-intercept", uid: "e5" },
      });
      // ...the trusted click still fired...
      const pressed = (dbg.sendCommand as jest.Mock).mock.calls.find(
        (c: any[]) =>
          c[1] === "Input.dispatchMouseEvent" && c[2].type === "mousePressed"
      );
      expect(pressed).toBeDefined();
      // ...and the interception was surfaced on the action-result.
      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "uidint"
      );
      expect(call[0].ok).toBe(true);
      expect(call[0].intercepted).toMatchObject({
        tag: "dialog",
        classes: "Overlay",
      });
    });

    it("click-element engine:cdp + failIfIntercepted hard-stops (no trusted click) when covered", async () => {
      (browser.tabs.sendMessage as jest.Mock).mockImplementation(
        (_id: number, msg: any) => {
          if (msg && msg.type === "readElementRect") {
            return Promise.resolve({ x: 10, y: 20, width: 100, height: 40, dpr: 2 });
          }
          if (
            msg &&
            msg.type === "performInputAction" &&
            msg.args &&
            msg.args.action === "classify-intercept"
          ) {
            return Promise.resolve({
              ok: true,
              intercepted: { tag: "dialog", id: "ovl", classes: "Overlay" },
            });
          }
          return Promise.resolve({ ok: true });
        }
      );

      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 8,
        uid: "e5",
        engine: "cdp",
        failIfIntercepted: true,
        correlationId: "uidfail",
      } as ServerMessageRequest);

      // Hard stop: no debugger attach, no trusted dispatch...
      expect(dbg.attach).not.toHaveBeenCalled();
      const dispatched = (dbg.sendCommand as jest.Mock).mock.calls.filter(
        (c: any[]) => c[1] === "Input.dispatchMouseEvent"
      );
      expect(dispatched).toHaveLength(0);
      // ...and it short-circuits BEFORE resolving the center (no readElementRect).
      const rectCalls = (browser.tabs.sendMessage as jest.Mock).mock.calls.filter(
        (c: any[]) => c[1] && c[1].type === "readElementRect"
      );
      expect(rectCalls).toHaveLength(0);
      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "uidfail"
      );
      expect(call[0].ok).toBe(false);
      expect(call[0].error).toContain("click intercepted by #ovl");
      expect(call[0].intercepted).toMatchObject({ id: "ovl" });
    });

    it("a resolve MISS (stale uid) reports ok:false and never attaches the debugger", async () => {
      (browser.tabs.sendMessage as jest.Mock).mockImplementation(
        (_id: number, msg: any) => {
          if (msg && msg.type === "readElementRect") return Promise.resolve(null);
          return Promise.resolve({ ok: true });
        }
      );
      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 8,
        uid: "gone",
        engine: "cdp",
        correlationId: "uidmiss",
      } as ServerMessageRequest);

      expect(dbg.attach).not.toHaveBeenCalled();
      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "uidmiss"
      );
      expect(call[0].ok).toBe(false);
      expect(call[0].error).toMatch(/take a fresh snapshot/i);
    });

    it("a debugger-attach failure is reported as ok:false (not a thrown tool-error)", async () => {
      dbg.attach.mockRejectedValue(new Error("Another debugger is already attached"));
      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 8,
        uid: "e5",
        engine: "cdp",
        correlationId: "uidatt",
      } as ServerMessageRequest);

      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "uidatt"
      );
      expect(call[0].ok).toBe(false);
      expect(call[0].error).toMatch(/CDP input dispatch failed/);
    });

    it("fill-element engine:cdp select-alls then inserts the value at the uid center", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "fill-element",
        tabId: 8,
        uid: "e7",
        value: "hello world",
        engine: "cdp",
        correlationId: "uidf",
      } as ServerMessageRequest);

      const calls = (dbg.sendCommand as jest.Mock).mock.calls;
      // select-all (KeyA) precedes the insertText.
      const selectAll = calls.find(
        (c: any[]) => c[1] === "Input.dispatchKeyEvent" && c[2].code === "KeyA" && c[2].type === "keyDown"
      );
      expect(selectAll[2]).toMatchObject({ code: "KeyA", windowsVirtualKeyCode: 65 });
      expect(calls).toEqual(
        expect.arrayContaining([[{ tabId: 8 }, "Input.insertText", { text: "hello world" }]])
      );
      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "uidf"
      );
      expect(call[0].ok).toBe(true);
    });

    it("press-key engine:cdp dispatches a TRUSTED key event to the focused element (no uid resolve)", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "press-key",
        tabId: 8,
        key: "Enter",
        engine: "cdp",
        correlationId: "uidk",
      } as ServerMessageRequest);

      // press-key has no uid, so readElementRect is never queried.
      expect(browser.tabs.sendMessage).not.toHaveBeenCalledWith(8, {
        type: "readElementRect",
        uid: expect.anything(),
      });
      const keys = (dbg.sendCommand as jest.Mock).mock.calls.filter(
        (c: any[]) => c[1] === "Input.dispatchKeyEvent"
      );
      expect(keys).toHaveLength(2); // keyDown + keyUp
      expect(keys[0][2]).toMatchObject({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "uidk"
      );
      expect(call[0].ok).toBe(true);
    });

    it("fill-form engine:cdp resolves + fills each field in order", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "fill-form",
        tabId: 8,
        fields: [
          { uid: "e1", value: "alice" },
          { uid: "e2", value: "secret" },
        ],
        engine: "cdp",
        correlationId: "uidff",
      } as ServerMessageRequest);

      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, { type: "readElementRect", uid: "e1" });
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, { type: "readElementRect", uid: "e2" });
      const inserts = (dbg.sendCommand as jest.Mock).mock.calls.filter(
        (c: any[]) => c[1] === "Input.insertText"
      );
      expect(inserts.map((c: any[]) => c[2].text)).toEqual(["alice", "secret"]);
      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "uidff"
      );
      expect(call[0].ok).toBe(true);
    });

    it("fill-element engine:cdp with commit leaves the field from the isolated world after the trusted insert", async () => {
      const order: string[] = [];
      (dbg.sendCommand as jest.Mock).mockImplementation(async (_t: any, method: string) => {
        if (method === "Input.insertText") order.push("insertText");
        return {};
      });
      (browser.tabs.sendMessage as jest.Mock).mockImplementation((_id: number, msg: any) => {
        if (msg && msg.type === "readElementRect") {
          return Promise.resolve({ x: 10, y: 20, width: 100, height: 40, dpr: 2 });
        }
        if (msg && msg.type === "performInputAction" && msg.args.action === "commit") {
          order.push("commit:" + JSON.stringify(msg.args));
        }
        return Promise.resolve({ ok: true });
      });

      await messageHandler.handleDecodedMessage({
        cmd: "fill-element",
        tabId: 8,
        uid: "e7",
        value: "a@b.co",
        engine: "cdp",
        commit: true,
        correlationId: "uidfc",
      } as ServerMessageRequest);

      // Trusted typing gets the browser's own change on that blur, so none is asked for.
      expect(order).toEqual(["insertText", 'commit:{"action":"commit","change":false}']);
      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "uidfc"
      );
      expect(call[0].ok).toBe(true);
    });

    it("fill-element engine:cdp without commit sends no commit step", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "fill-element",
        tabId: 8,
        uid: "e7",
        value: "a@b.co",
        engine: "cdp",
        correlationId: "uidfn",
      } as ServerMessageRequest);
      const commits = (browser.tabs.sendMessage as jest.Mock).mock.calls.filter(
        (c: any[]) => c[1] && c[1].type === "performInputAction" && c[1].args.action === "commit"
      );
      expect(commits).toEqual([]);
    });

    it("click-element engine:cdp reports disabled:true when the probe found a disabled control", async () => {
      (browser.tabs.sendMessage as jest.Mock).mockImplementation((_id: number, msg: any) => {
        if (msg && msg.type === "readElementRect") {
          return Promise.resolve({ x: 10, y: 20, width: 100, height: 40, dpr: 2 });
        }
        if (msg && msg.type === "performInputAction" && msg.args.action === "classify-intercept") {
          return Promise.resolve({ ok: true, disabled: true });
        }
        return Promise.resolve({ ok: true });
      });

      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 8,
        uid: "e5",
        engine: "cdp",
        correlationId: "uidcd",
      } as ServerMessageRequest);

      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "uidcd"
      );
      expect(call[0]).toMatchObject({ ok: true, disabled: true });
    });

    it("hover-element engine:cdp dispatches a TRUSTED mouseMoved at the uid center", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "hover-element",
        tabId: 8,
        uid: "e9",
        engine: "cdp",
        correlationId: "uidh",
      } as ServerMessageRequest);
      const move = (dbg.sendCommand as jest.Mock).mock.calls.find(
        (c: any[]) => c[1] === "Input.dispatchMouseEvent" && c[2].type === "mouseMoved"
      );
      expect(move[2]).toMatchObject({ type: "mouseMoved", x: 60, y: 40 });
    });

    it("synthetic (default engine) still routes to the content-script input path, never CDP", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 8,
        uid: "e5",
        correlationId: "uidsyn",
      } as ServerMessageRequest);
      expect(dbg.attach).not.toHaveBeenCalled();
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
        type: "performInputAction",
        args: { action: "click", uid: "e5", doubleClick: undefined, failIfIntercepted: undefined },
      });
    });

    it("synthetic click forwards the injected dispatchedTo on the action-result", async () => {
      (browser.tabs.sendMessage as jest.Mock).mockImplementation(
        (_id: number, msg: any) =>
          Promise.resolve(
            msg && msg.type === "performInputAction"
              ? { ok: true, dispatchedTo: { tag: "button", name: "Draft macOS Submission (1)" } }
              : { ok: true }
          )
      );
      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 8,
        uid: "e2",
        correlationId: "uiddt",
      } as ServerMessageRequest);

      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "uiddt"
      );
      expect(call[0].dispatchedTo).toEqual({ tag: "button", name: "Draft macOS Submission (1)" });
    });

    it("leaves dispatchedTo off the frame entirely when the click went to the uid element", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 8,
        uid: "e5",
        correlationId: "uidnodt",
      } as ServerMessageRequest);
      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 8,
        uid: "e5",
        engine: "cdp",
        correlationId: "uidnodtcdp",
      } as ServerMessageRequest);

      for (const id of ["uidnodt", "uidnodtcdp"]) {
        const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
          (c: any[]) => c[0].correlationId === id
        );
        expect(call[0].ok).toBe(true);
        expect("dispatchedTo" in call[0]).toBe(false);
      }
    });
  });

  describe("coordinate tools (Task 2+)", () => {
    const automationConfig = { ...baseConfig, automationMode: true };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 8,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
    });

    it("click-at forwards coords to the isolated point action and returns point-action-result with the descriptor", async () => {
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        ok: true,
        element: { tag: "div", id: "card", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: false },
      });

      await messageHandler.handleDecodedMessage({
        cmd: "click-at",
        tabId: 8,
        x: 12,
        y: 34,
        correlationId: "cx",
      } as ServerMessageRequest);

      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
        type: "performPointAction",
        args: { action: "click-at", x: 12, y: 34, doubleClick: undefined, button: undefined },
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "point-action-result",
        correlationId: "cx",
        ok: true,
        element: { tag: "div", id: "card", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: false },
      });
    });

    it("click-at reports ok:false (not a thrown error) when the point missed", async () => {
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        ok: false,
        error: "No element at point (1, 2) — the coordinates may be outside the visible viewport or over a cross-origin frame.",
      });

      await messageHandler.handleDecodedMessage({
        cmd: "click-at",
        tabId: 8,
        x: 1,
        y: 2,
        correlationId: "cm",
      } as ServerMessageRequest);

      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "point-action-result",
        correlationId: "cm",
        ok: false,
        error: "No element at point (1, 2) — the coordinates may be outside the visible viewport or over a cross-origin frame.",
      });
    });

    it("type-at forwards coords/text/submit to the isolated point action and returns point-action-result", async () => {
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        ok: true,
        element: { tag: "textarea", id: "msg", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: true },
      });

      await messageHandler.handleDecodedMessage({
        cmd: "type-at",
        tabId: 8,
        x: 5,
        y: 6,
        text: "hello",
        submit: true,
        correlationId: "tx",
      } as ServerMessageRequest);

      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
        type: "performPointAction",
        args: { action: "type-at", x: 5, y: 6, text: "hello", submit: true },
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "point-action-result",
        correlationId: "tx",
        ok: true,
        element: { tag: "textarea", id: "msg", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: true },
      });
    });

    it("hover-at forwards coords to the isolated point action and returns point-action-result with the descriptor", async () => {
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        ok: true,
        element: { tag: "div", id: "menu", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: false },
      });

      await messageHandler.handleDecodedMessage({
        cmd: "hover-at",
        tabId: 8,
        x: 7,
        y: 8,
        correlationId: "hx",
      } as ServerMessageRequest);

      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
        type: "performPointAction",
        args: { action: "hover-at", x: 7, y: 8 },
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "point-action-result",
        correlationId: "hx",
        ok: true,
        element: { tag: "div", id: "menu", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: false },
      });
    });

    it("scroll-at forwards coords/deltas to the isolated point action and returns point-action-result with the container descriptor", async () => {
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        ok: true,
        element: { tag: "div", id: "panel", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: false },
      });

      await messageHandler.handleDecodedMessage({
        cmd: "scroll-at",
        tabId: 8,
        x: 5,
        y: 6,
        dx: 0,
        dy: 250,
        correlationId: "sx",
      } as ServerMessageRequest);

      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
        type: "performPointAction",
        args: { action: "scroll-at", x: 5, y: 6, dx: 0, dy: 250 },
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "point-action-result",
        correlationId: "sx",
        ok: true,
        element: { tag: "div", id: "panel", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: false },
      });
    });

    it("scroll-to replies action-result ok:true", async () => {
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({ ok: true });
      await messageHandler.handleDecodedMessage({
        cmd: "scroll-to", tabId: 8, x: 0, y: 500, correlationId: "st",
      } as ServerMessageRequest);
      expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, { type: "scrollWindowTo", x: 0, y: 500 });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result", correlationId: "st", ok: true,
      });
    });

    it("scroll-into-view replies action-result ok:false for a stale uid", async () => {
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({ ok: false, error: "Element uid 'e9' not found — take a fresh snapshot (uids are reassigned each snapshot)." });
      await messageHandler.handleDecodedMessage({
        cmd: "scroll-into-view", tabId: 8, uid: "e9", correlationId: "sv",
      } as ServerMessageRequest);
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result", correlationId: "sv", ok: false,
        error: "Element uid 'e9' not found — take a fresh snapshot (uids are reassigned each snapshot).",
      });
    });
  });

  describe("input navigation-race (Task B3)", () => {
    const automationConfig = { ...baseConfig, automationMode: true };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 9,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
    });

    it("click-element whose content-script ack never returns resolves {ok:true,navigated:true} once the tab starts loading", async () => {
      const navListeners: Array<
        (id: number, info: { status?: string }) => void
      > = [];
      (browser as any).tabs.onUpdated = {
        addListener: jest.fn((cb: any) => navListeners.push(cb)),
        removeListener: jest.fn((cb: any) => {
          const i = navListeners.indexOf(cb);
          if (i >= 0) navListeners.splice(i, 1);
        }),
      };
      // The navigating click tears down the page before the ack returns, so the
      // content-script reply promise never settles.
      (browser.tabs.sendMessage as jest.Mock).mockReturnValue(
        new Promise(() => {})
      );

      const p = messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 9,
        uid: "e1",
        correlationId: "nav1",
      } as ServerMessageRequest);

      // Once the handler has registered its nav-race listener, simulate the tab
      // beginning to navigate — the nav must win the race.
      await flushUntil(() => navListeners.length > 0);
      navListeners.forEach((cb) => cb(9, { status: "loading" }));

      await p;

      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "nav1",
        ok: true,
        error: undefined,
        navigated: true,
      });
      // The nav-race listener is always cleaned up.
      expect(
        (browser as any).tabs.onUpdated.removeListener
      ).toHaveBeenCalled();
    });
  });

  // Chrome clamps every timer in a HIDDEN tab to one tick per second. The
  // humanized (default "synthetic") input used to run its whole paced loop
  // inside the page's content script, so a click (8-40 cursor steps) took 8-40 s
  // in a background tab and blew the 15 s broker budget, while the action still
  // landed later. The pacing must live in the background (service worker), whose
  // timers do not depend on tab visibility; the page only runs one step per
  // message. Firefox always worked this way.
  describe("synthetic input is paced from the background, not inside the page", () => {
    const automationConfig = { ...baseConfig, automationMode: true };

    // Every content-script message the handler sent, in order.
    const sentTypes = (): string[] =>
      (browser.tabs.sendMessage as jest.Mock).mock.calls.map(
        (c: any[]) => c[1] && c[1].type
      );
    const stepCalls = (type: string): any[][] =>
      (browser.tabs.sendMessage as jest.Mock).mock.calls.filter(
        (c: any[]) => c[1] && c[1].type === type
      );

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 11,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser.tabs.sendMessage as jest.Mock).mockImplementation(
        (_id: number, msg: any) => {
          switch (msg && msg.type) {
            case "readElementRect":
              return Promise.resolve({ x: 500, y: 300, width: 100, height: 40, dpr: 1 });
            case "dispatchMouseMoveStep":
              return Promise.resolve({ ok: true });
            case "typeCharStep":
              return Promise.resolve({ ok: true });
            case "performInputAction":
              return Promise.resolve({ ok: true });
            default:
              // "runHumanInput" is the in-page paced loop: a hidden tab would
              // stall it, so reaching it is the bug.
              return Promise.resolve({
                ok: false,
                error: "unexpected in-page message: " + (msg && msg.type),
              });
          }
        }
      );
    });

    it("click-element sends the cursor path one step per message, then ONE real click, and never the in-page loop", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 11,
        uid: "e1",
        correlationId: "pace1",
      } as ServerMessageRequest);

      expect(sentTypes()).not.toContain("runHumanInput");
      const types = sentTypes();
      expect(types[0]).toBe("readElementRect");
      expect(stepCalls("dispatchMouseMoveStep").length).toBeGreaterThanOrEqual(8);
      // Exactly one authoritative click, after the whole path.
      const clicks = stepCalls("performInputAction");
      expect(clicks).toHaveLength(1);
      expect(clicks[0][1].args).toMatchObject({ action: "click", uid: "e1" });
      expect(types[types.length - 1]).toBe("performInputAction");
      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "action-result",
          correlationId: "pace1",
          ok: true,
        })
      );
    });

    it("remembers where the cursor ended, so the next click on the same target moves the minimum path", async () => {
      const click = (id: string) =>
        messageHandler.handleDecodedMessage({
          cmd: "click-element",
          tabId: 11,
          uid: "e1",
          correlationId: id,
        } as ServerMessageRequest);

      await click("cur1");
      const firstPath = stepCalls("dispatchMouseMoveStep").length;
      (browser.tabs.sendMessage as jest.Mock).mockClear();
      (browser.tabs.sendMessage as jest.Mock).mockImplementation(
        (_id: number, msg: any) =>
          Promise.resolve(
            msg.type === "readElementRect"
              ? { x: 500, y: 300, width: 100, height: 40, dpr: 1 }
              : { ok: true }
          )
      );
      await click("cur2");
      const secondPath = stepCalls("dispatchMouseMoveStep").length;

      // The cursor starts at (100,100), far from the target: a long path. After
      // the click it sits ON the target, so the second path is the 8-step floor.
      expect(firstPath).toBeGreaterThan(8);
      expect(secondPath).toBe(8);
    });

    it("type-text types one character per message and never sends the in-page loop", async () => {
      await messageHandler.handleDecodedMessage({
        cmd: "type-text",
        tabId: 11,
        text: "abc",
        correlationId: "pace2",
      } as ServerMessageRequest);

      expect(sentTypes()).not.toContain("runHumanInput");
      expect(stepCalls("typeCharStep").map((c) => c[1].char)).toEqual(["a", "b", "c"]);
      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "action-result",
          correlationId: "pace2",
          ok: true,
        })
      );
    });
  });

  describe("viewport screenshot readback retry (Task C1)", () => {
    const automationConfig = { ...baseConfig, automationMode: true };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 3,
        url: "https://example.com",
        windowId: 1,
      });
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 3 }]);
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
    });

    it("retries a transient captureVisibleTab readback failure and still produces the screenshot", async () => {
      let calls = 0;
      (browser.tabs.captureVisibleTab as jest.Mock).mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.reject(new Error("image readback failed"));
        }
        return Promise.resolve("data:image/png;base64,GOOD");
      });

      await messageHandler.handleDecodedMessage({
        cmd: "take-screenshot",
        tabId: 3,
        correlationId: "vpr",
      } as ServerMessageRequest);

      // The first (transient) failure was retried rather than propagated.
      expect(browser.tabs.captureVisibleTab).toHaveBeenCalledTimes(2);
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "screenshot",
        correlationId: "vpr",
        mimeType: "image/png",
        base64: "GOOD",
      });
    });
  });

  describe("tab-activation drag retry (Fix C)", () => {
    const automationConfig = { ...baseConfig, automationMode: true };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 3,
        url: "https://example.com",
        windowId: 1,
      });
      // Target is already the active tab → no restore, so update() calls are
      // purely the activation attempts we want to count.
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 3 }]);
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue(
        "data:image/png;base64,GOOD"
      );
    });

    it("retries the transient 'dragging a tab' activation failure and still captures", async () => {
      let n = 0;
      (browser.tabs.update as jest.Mock).mockImplementation(() => {
        n++;
        if (n === 1) {
          return Promise.reject(
            new Error(
              "Tabs cannot be edited right now (user may be dragging a tab)."
            )
          );
        }
        return Promise.resolve(undefined);
      });

      await messageHandler.handleDecodedMessage({
        cmd: "take-screenshot",
        tabId: 3,
        correlationId: "drag1",
      } as ServerMessageRequest);

      // First activation threw the transient; the retry succeeded.
      expect(browser.tabs.update).toHaveBeenCalledTimes(2);
      expect(browser.tabs.update).toHaveBeenNthCalledWith(2, 3, {
        active: true,
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "screenshot",
        correlationId: "drag1",
        mimeType: "image/png",
        base64: "GOOD",
      });
    });

    it("does NOT retry a non-transient activation error — it fails fast", async () => {
      (browser.tabs.update as jest.Mock).mockRejectedValue(
        new Error("No tab with id: 3.")
      );

      await expect(
        messageHandler.handleDecodedMessage({
          cmd: "take-screenshot",
          tabId: 3,
          correlationId: "drag2",
        } as ServerMessageRequest)
      ).rejects.toThrow(/No tab with id/);

      // Fatal error → single attempt, no retry, and the capture never ran.
      expect(browser.tabs.update).toHaveBeenCalledTimes(1);
      expect(browser.tabs.captureVisibleTab).not.toHaveBeenCalled();
    });
  });

  describe("screenshot fullPage hardening (Task 7)", () => {
    const automationConfig = { ...baseConfig, automationMode: true };
    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 3,
        url: "https://example.com",
        windowId: 1,
      });
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 3 }]);
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      // `offscreen` is an MV3-only API not on the webextension-polyfill Browser
      // type, so reach it via an any-cast (same pattern as the chrome.debugger
      // tests above).
      ((browser as any).offscreen.hasDocument as jest.Mock).mockResolvedValue(
        true
      );
      // Content-script measurement reads (readPageDimensions / scrollTo).
      (browser.tabs.sendMessage as jest.Mock).mockImplementation((_id, msg) => {
        if (msg.type === "readPageDimensions") {
          return Promise.resolve({
            scrollWidth: 100,
            scrollHeight: 100,
            clientWidth: 100,
            clientHeight: 100,
            dpr: 1,
            originalScrollY: 0,
          });
        }
        return Promise.resolve({ ok: true });
      });
    });

    it("falls back to a single viewport capture with a warning when the offscreen stitch returns empty", async () => {
      (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue(
        "data:image/png;base64,GOOD"
      );
      // Offscreen stitch (runtime.sendMessage) returns an empty readback.
      (browser.runtime.sendMessage as jest.Mock).mockResolvedValue({
        mimeType: "image/png",
        base64: "",
      });
      await messageHandler.handleDecodedMessage({
        cmd: "take-screenshot",
        tabId: 3,
        fullPage: true,
        correlationId: "fp",
      } as ServerMessageRequest);
      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "screenshot",
          correlationId: "fp",
          base64: "GOOD",
          warning:
            "Full-page stitch failed; returning a single viewport capture instead.",
        })
      );
    });

    it("a page too tall to tile inside the time budget returns one viewport capture with a warning, not a timeout", async () => {
      // 60 screens tall. Chrome allows 2 captureVisibleTab calls per second, so a
      // tile costs at least ~0.55 s and the broker gives take-screenshot 45 s.
      (browser.tabs.sendMessage as jest.Mock).mockImplementation((_id, msg) => {
        if (msg.type === "readPageDimensions") {
          return Promise.resolve({
            scrollWidth: 100,
            scrollHeight: 60 * 800,
            clientWidth: 100,
            clientHeight: 800,
            dpr: 1,
            originalScrollY: 0,
          });
        }
        return Promise.resolve({ ok: true });
      });
      (browser.tabs.captureVisibleTab as jest.Mock)
        .mockReset()
        .mockResolvedValue("data:image/png;base64,GOOD");
      (browser.runtime.sendMessage as jest.Mock).mockReset();

      await messageHandler.handleDecodedMessage({
        cmd: "take-screenshot",
        tabId: 3,
        fullPage: true,
        correlationId: "tall",
      } as ServerMessageRequest);

      // One viewport capture, no 60 tiles, nothing sent to the stitcher.
      expect(browser.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
      expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "screenshot",
          base64: "GOOD",
          warning: expect.stringMatching(/60 screens[\s\S]*limit[\s\S]*take-snapshot/),
        })
      );
    });

    it("throws 'image readback failed' when tiles and the fallback are all empty", async () => {
      (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue("");
      (browser.runtime.sendMessage as jest.Mock).mockResolvedValue({
        mimeType: "image/png",
        base64: "",
      });
      await expect(
        messageHandler.handleDecodedMessage({
          cmd: "take-screenshot",
          tabId: 3,
          fullPage: true,
          correlationId: "err",
        } as ServerMessageRequest)
      ).rejects.toThrow("image readback failed");
    });
  });
});

/**
 * `get-console-messages` must FAIL LOUDLY when console capture is off.
 *
 * Capture is off by default (patching page `console` is detectable and breaks
 * bot-detection challenges). If the tool silently returned an empty list in that
 * state, an agent would read it as "the page logged nothing" and move on — so the
 * handler throws, and the message names the exact options toggle plus the reload
 * requirement (registration is document_start, so an already-loaded page is not
 * captured until it reloads).
 */
describe("MessageHandler (chrome) — get-console-messages capture gate", () => {
  let messageHandler: MessageHandler;
  let transport: jest.Mocked<ExtensionTransport>;

  const baseConfig = {
    secret: "test-secret",
    ports: [8089],
    domainDenyList: [] as string[],
    auditLog: [],
    automationMode: true,
  };

  function setConfig(extra: Record<string, unknown>) {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { ...baseConfig, ...extra },
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    transport = makeTransport();
    messageHandler = new MessageHandler(transport);
    clearConsoleEntries(700);
    setConfig({});
  });

  it("replies with the buffered entries when capture is enabled", async () => {
    setConfig({ consoleCapture: true });
    addConsoleEntry(700, { level: "log", text: "hello", timestamp: 10 });

    await messageHandler.handleDecodedMessage({
      cmd: "get-console-messages",
      tabId: 700,
      correlationId: "c-on",
    } as ServerMessageRequest);

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "console-messages",
      correlationId: "c-on",
      entries: [{ level: "log", text: "hello", timestamp: 10 }],
    });
  });

  it("throws instead of silently returning an empty list when capture is off", async () => {
    await expect(
      messageHandler.handleDecodedMessage({
        cmd: "get-console-messages",
        tabId: 700,
        correlationId: "c-off",
      } as ServerMessageRequest)
    ).rejects.toThrow(/console capture is disabled/i);

    expect(transport.sendResourceToServer).not.toHaveBeenCalledWith(
      expect.objectContaining({ resource: "console-messages" })
    );
  });

  it("throws even when the buffer happens to hold stale entries", async () => {
    addConsoleEntry(700, { level: "log", text: "stale", timestamp: 1 });

    await expect(
      messageHandler.handleDecodedMessage({
        cmd: "get-console-messages",
        tabId: 700,
        correlationId: "c-stale",
      } as ServerMessageRequest)
    ).rejects.toThrow(/console capture is disabled/i);
  });

  it("names the exact options toggle and the required page reload", async () => {
    const err = await messageHandler
      .handleDecodedMessage({
        cmd: "get-console-messages",
        tabId: 700,
        correlationId: "c-msg",
      } as ServerMessageRequest)
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("Capture page console output");
    expect(msg).toMatch(/reload/i);
    expect(msg).toMatch(/default/i);
  });
});

describe("MessageHandler (chrome) — get-tab-list", () => {
  let messageHandler: MessageHandler;
  let transport: jest.Mocked<ExtensionTransport>;

  beforeEach(() => {
    jest.clearAllMocks();
    transport = makeTransport();
    messageHandler = new MessageHandler(transport);
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: {
        secret: "test-secret",
        ports: [8089],
        domainDenyList: [] as string[],
        auditLog: [],
        toolSettings: {},
      },
    });
    (browser as any).tabGroups.query = jest.fn().mockResolvedValue([]);
  });

  it("sends only the fields the server reads, not the whole Tab object", async () => {
    (browser.tabs.query as jest.Mock).mockResolvedValue([
      {
        id: 1,
        windowId: 7,
        url: "https://a.com",
        title: "A",
        lastAccessed: 1000,
        favIconUrl: "data:image/png;base64," + "A".repeat(4000),
        mutedInfo: { muted: false },
        groupId: -1,
        width: 1200,
        height: 800,
        active: true,
      },
    ]);

    await messageHandler.handleDecodedMessage({
      cmd: "get-tab-list",
      correlationId: "c-slim",
    });

    expect(browser.tabs.query).toHaveBeenCalledWith({});
    const sent = transport.sendResourceToServer.mock.calls[0][0] as any;
    expect(sent.resource).toBe("tabs");
    expect(sent.tabs).toEqual([
      {
        id: 1,
        windowId: 7,
        url: "https://a.com",
        title: "A",
        lastAccessed: 1000,
      },
    ]);
    expect(Object.keys(sent.tabs[0]).sort()).toEqual([
      "id",
      "lastAccessed",
      "title",
      "url",
      "windowId",
    ]);
  });

  it("passes windowId and activeOnly to tabs.query, and never asks for hidden", async () => {
    (browser.tabs.query as jest.Mock).mockResolvedValue([]);

    await messageHandler.handleDecodedMessage({
      cmd: "get-tab-list",
      correlationId: "c-filter",
      windowId: 7,
      activeOnly: true,
    });

    // Chrome has no `hidden` tab state, so the query must not carry one.
    expect(browser.tabs.query).toHaveBeenCalledWith({
      windowId: 7,
      active: true,
    });
  });

  it("visibleOnly drops tabs that sit in a collapsed tab group", async () => {
    (browser.tabs.query as jest.Mock).mockResolvedValue([
      { id: 1, windowId: 7, url: "https://a.com", groupId: -1 },
      { id: 2, windowId: 7, url: "https://b.com", groupId: 5 },
      { id: 3, windowId: 7, url: "https://c.com", groupId: 6 },
    ]);
    (browser as any).tabGroups.query.mockResolvedValue([
      { id: 5, collapsed: true },
    ]);

    await messageHandler.handleDecodedMessage({
      cmd: "get-tab-list",
      correlationId: "c-visible",
      visibleOnly: true,
    });

    expect((browser as any).tabGroups.query).toHaveBeenCalledWith({
      collapsed: true,
    });
    const sent = transport.sendResourceToServer.mock.calls[0][0] as any;
    expect(sent.tabs.map((t: { id: number }) => t.id)).toEqual([1, 3]);
  });

  it("visibleOnly does not touch tab groups when the caller did not ask", async () => {
    (browser.tabs.query as jest.Mock).mockResolvedValue([
      { id: 2, windowId: 7, url: "https://b.com", groupId: 5 },
    ]);

    await messageHandler.handleDecodedMessage({
      cmd: "get-tab-list",
      correlationId: "c-all",
    });

    expect((browser as any).tabGroups.query).not.toHaveBeenCalled();
    const sent = transport.sendResourceToServer.mock.calls[0][0] as any;
    expect(sent.tabs).toHaveLength(1);
  });

  it("visibleOnly still lists every tab when the browser has no tabGroups API", async () => {
    (browser.tabs.query as jest.Mock).mockResolvedValue([
      { id: 1, windowId: 7, url: "https://a.com", groupId: 5 },
    ]);
    const saved = (browser as any).tabGroups;
    (browser as any).tabGroups = undefined;
    try {
      await messageHandler.handleDecodedMessage({
        cmd: "get-tab-list",
        correlationId: "c-nogroups",
        visibleOnly: true,
      });
    } finally {
      (browser as any).tabGroups = saved;
    }

    const sent = transport.sendResourceToServer.mock.calls[0][0] as any;
    expect(sent.tabs.map((t: { id: number }) => t.id)).toEqual([1]);
  });

  describe("text filters, URL redaction and the filtersApplied marker", () => {
    const rawTabs = () => [
      {
        id: 1,
        windowId: 7,
        url: "https://app.example.test/inbox?token=fake-token-123#access_token=fake-token-456",
        title: "Inbox",
        lastAccessed: 10,
        favIconUrl: "data:image/png;base64,AAAA",
        groupId: -1,
      },
      { id: 2, windowId: 7, url: "https://docs.example.test/guide", title: "Guide" },
      { id: 3, windowId: 8, url: "https://app.example.test/settings", title: "Settings" },
    ];

    const send = async (extra: Record<string, unknown>) => {
      (browser.tabs.query as jest.Mock).mockResolvedValue(rawTabs());
      await messageHandler.handleDecodedMessage({
        cmd: "get-tab-list",
        correlationId: "c-text",
        ...extra,
      } as any);
      return transport.sendResourceToServer.mock.calls[0][0] as any;
    };

    it("marks the reply filtersApplied, with or without filters", async () => {
      const sent = await send({});
      expect(sent.filtersApplied).toBe(true);
      expect(sent.tabs).toHaveLength(3);
    });

    it("sends raw URLs unless redactUrls is set (an older server asks for nothing)", async () => {
      const sent = await send({});
      expect(sent.tabs[0].url).toBe(rawTabs()[0].url);
    });

    it("redacts every URL in the reply when redactUrls is set, and keeps the slim fields", async () => {
      const sent = await send({ redactUrls: true });
      expect(sent.tabs.map((t: { url: string }) => t.url)).toEqual([
        "https://app.example.test/inbox?[redacted]#[redacted]",
        "https://docs.example.test/guide",
        "https://app.example.test/settings",
      ]);
      expect(JSON.stringify(sent)).not.toMatch(/fake-token/);
      expect(Object.keys(sent.tabs[0]).sort()).toEqual([
        "id",
        "lastAccessed",
        "title",
        "url",
        "windowId",
      ]);
    });

    it("applies urlContains and titleContains (AND, case-insensitive)", async () => {
      const byUrl = await send({ urlContains: "APP.EXAMPLE", redactUrls: true });
      expect(byUrl.tabs.map((t: { id: number }) => t.id)).toEqual([1, 3]);

      transport.sendResourceToServer.mockClear();
      const both = await send({
        urlContains: "app.example",
        titleContains: "settings",
        redactUrls: true,
      });
      expect(both.tabs.map((t: { id: number }) => t.id)).toEqual([3]);
    });

    it("matches urlContains on the redacted URL, so token text finds nothing", async () => {
      const sent = await send({ urlContains: "fake-token-123", redactUrls: true });
      expect(sent.tabs).toEqual([]);
    });

    it("matches urlContains on the raw URL when redaction is off", async () => {
      const sent = await send({ urlContains: "fake-token-123" });
      expect(sent.tabs.map((t: { id: number }) => t.id)).toEqual([1]);
    });

    it("combines the text filters with windowId / activeOnly (those still reach tabs.query)", async () => {
      const sent = await send({
        windowId: 7,
        activeOnly: true,
        urlContains: "example.test",
      });
      expect(browser.tabs.query).toHaveBeenCalledWith({ windowId: 7, active: true });
      expect(sent.filtersApplied).toBe(true);
    });

    it("applies the text filters after visibleOnly removed collapsed-group tabs", async () => {
      (browser as any).tabGroups.query.mockResolvedValue([{ id: 5, collapsed: true }]);
      (browser.tabs.query as jest.Mock).mockResolvedValue([
        { id: 1, windowId: 7, url: "https://a.example.test/", title: "A", groupId: 5 },
        { id: 2, windowId: 7, url: "https://b.example.test/", title: "B", groupId: -1 },
      ]);
      await messageHandler.handleDecodedMessage({
        cmd: "get-tab-list",
        correlationId: "c-vis-text",
        visibleOnly: true,
        urlContains: "example.test",
      });
      const sent = transport.sendResourceToServer.mock.calls[0][0] as any;
      expect(sent.tabs.map((t: { id: number }) => t.id)).toEqual([2]);
    });
  });
});
