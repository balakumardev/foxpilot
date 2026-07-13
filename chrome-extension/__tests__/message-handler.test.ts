import { MessageHandler } from "../message-handler";
import type { ExtensionTransport } from "../transport";
import type { ServerMessageRequest } from "@foxpilot/common";
import { cdpEval } from "../cdp-eval";

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
        timeoutMs: 500,
      });
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "wait-for-text-result",
        correlationId: "cw",
        found: true,
        matched: "Ready",
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

    it('world:auto forwards the content-script CSP error (naming engine:"cdp") as eval-result ok:false when the main world is blocked', async () => {
      // On Chrome, world:"auto" does not retry isolated; the started-marker probe
      // in the content script reports the CSP block as a non-throwing
      // {ok:false,cspBlocked} result via the RAW sender, and the handler forwards
      // that actionable error as the eval-result.
      (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
        ok: false,
        cspBlocked: true,
        error:
          'CSP blocked the injected script (the page forbids inline script execution). On Chrome/Edge retry with engine:"cdp" (runs via the debugger, bypasses page CSP).',
      });

      await messageHandler.handleDecodedMessage({
        cmd: "evaluate-script",
        tabId: 5,
        function: "() => 1",
        world: "auto",
        correlationId: "ca",
      } as ServerMessageRequest);

      // Reached the main-world inject (not cdpEval).
      expect(cdpEval).not.toHaveBeenCalled();
      const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].correlationId === "ca"
      );
      expect(call).toBeDefined();
      expect(call[0].resource).toBe("eval-result");
      expect(call[0].ok).toBe(false);
      expect(call[0].error).toContain('engine:"cdp"');
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
      // ...and NEVER touched the synthetic content-script input path.
      const synthetic = (browser.tabs.sendMessage as jest.Mock).mock.calls.filter(
        (c: any[]) =>
          c[1] &&
          (c[1].type === "performInputAction" || c[1].type === "runHumanInput")
      );
      expect(synthetic).toHaveLength(0);
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "uidc",
        ok: true,
      });
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
