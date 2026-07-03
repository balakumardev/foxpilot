import { MessageHandler } from "../message-handler";
import type { ExtensionTransport } from "../transport";
import type { ServerMessageRequest } from "@foxpilot/common";

// The native-input client is mocked so importing/constructing the handler never
// touches a real socket or OS input. None of the paths exercised below use it.
jest.mock("../native-input-client", () => ({
  NativeInputClient: jest.fn().mockImplementation(() => ({
    sendGesture: jest.fn(),
  })),
}));

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

    it("restores the previously-active tab even when the capture throws", async () => {
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
      (browser.tabs.captureVisibleTab as jest.Mock).mockRejectedValue(
        new Error("capture failed")
      );

      const request: ServerMessageRequest = {
        cmd: "take-screenshot",
        tabId: 123,
        correlationId: "c1",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("capture failed");

      expect(browser.tabs.update).toHaveBeenNthCalledWith(1, 123, {
        active: true,
      });
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
      expect(mouse[0][2]).toMatchObject({ type: "mousePressed", x: 100, y: 200 });
      expect(mouse[1][2]).toMatchObject({ type: "mouseReleased", x: 100, y: 200 });
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
