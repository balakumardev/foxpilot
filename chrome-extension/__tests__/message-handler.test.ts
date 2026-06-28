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
});
