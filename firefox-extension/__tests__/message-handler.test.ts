import { MessageHandler } from "../message-handler";
import { WebsocketClient } from "../client";
import type { ServerMessageRequest } from "@foxpilot/common";
import { ExtensionConfig } from "../extension-config";
import { addConsoleEntry, clearConsoleEntries } from "../console-capture";
import {
  onBeforeRequestRecord,
  onCompletedRecord,
  clearNetworkRequests,
} from "../network-capture";
import { getTabUserAgent, clearTabUserAgent } from "../emulate";

// Mock the WebsocketClient
jest.mock("../client", () => {
  return {
    WebsocketClient: jest.fn().mockImplementation(() => {
      return {
        sendResourceToServer: jest.fn().mockResolvedValue(undefined),
        sendErrorToServer: jest.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

// Mock the native-input client so no real socket or OS input is ever used. Each
// test drives what `sendGesture` resolves via the `__mockSendGesture` global,
// letting us exercise the native success path and the native-miss fallback.
jest.mock("../native-input-client", () => ({
  NativeInputClient: jest.fn().mockImplementation(() => ({
    sendGesture: (global as any).__mockSendGesture,
  })),
}));

describe("MessageHandler", () => {
  let messageHandler: MessageHandler;
  let mockClient: jest.Mocked<WebsocketClient>;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Create a new instance of WebsocketClient and MessageHandler
    mockClient = new WebsocketClient(
      8080,
      "test-secret"
    ) as jest.Mocked<WebsocketClient>;
    messageHandler = new MessageHandler(mockClient);

    // Mock browser.storage.local.get to return default config
    const defaultConfig: ExtensionConfig = {
      secret: "test-secret",
      toolSettings: {
        "open-browser-tab": true,
        "close-browser-tabs": true,
        "get-list-of-open-tabs": true,
        "get-recent-browser-history": true,
        "get-tab-web-content": true,
        "reorder-browser-tabs": true,
        "find-highlight-in-browser-tab": true,
      },
      domainDenyList: [],
      ports: [8089],
      auditLog: [],
    };

    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: defaultConfig,
    });
  });

  describe("handleDecodedMessage", () => {
    it("should throw an error if command is not allowed", async () => {
      // Arrange
      const configWithDisabledOpenTab: ExtensionConfig = {
        secret: "test-secret",
        toolSettings: {
          "open-browser-tab": false, // Disable open-tab command
          "close-browser-tabs": true,
          "get-list-of-open-tabs": true,
          "get-recent-browser-history": true,
          "get-tab-web-content": true,
          "reorder-browser-tabs": true,
          "find-highlight-in-browser-tab": true,
        },
        domainDenyList: [],
        ports: [8089],
        auditLog: [],
      };
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: configWithDisabledOpenTab,
      });

      const request: ServerMessageRequest = {
        cmd: "open-tab",
        url: "https://example.com",
        correlationId: "test-correlation-id",
      };

      // Act & Assert
      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Command 'open-tab' is disabled in extension settings");
    });

    describe("open-tab command", () => {
      it("should open a new tab and send the tab ID to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "open-tab",
          url: "https://example.com",
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123 };
        (browser.tabs.create as jest.Mock).mockResolvedValue(mockTab);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert — new tabs open in the background so automation never steals
        // the user's foreground tab.
        expect(browser.tabs.create).toHaveBeenCalledWith({
          url: "https://example.com",
          active: false,
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "opened-tab-id",
          correlationId: "test-correlation-id",
          tabId: 123,
        });
      });

      it("should throw an error if URL does not start with https://", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "open-tab",
          url: "http://example.com",
          correlationId: "test-correlation-id",
        };

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Invalid URL");
        expect(browser.tabs.create).not.toHaveBeenCalled();
      });

      it("should throw an error if domain is in deny list", async () => {
        // Arrange
        const configWithDenyList: ExtensionConfig = {
          secret: "test-secret",
          toolSettings: {
            "open-browser-tab": true,
            "close-browser-tabs": true,
            "get-list-of-open-tabs": true,
            "get-recent-browser-history": true,
            "get-tab-web-content": true,
            "reorder-browser-tabs": true,
            "find-highlight-in-browser-tab": true,
          },
          domainDenyList: ["example.com", "another.com"],
          ports: [8089],
          auditLog: [],
        };
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: configWithDenyList,
        });

        const request: ServerMessageRequest = {
          cmd: "open-tab",
          url: "https://example.com",
          correlationId: "test-correlation-id",
        };

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Domain in user defined deny list");
        expect(browser.tabs.create).not.toHaveBeenCalled();
      });

      it("should open a new tab in the domain is not in the deny list", async () => {
        // Arrange
        const configWithDenyList: ExtensionConfig = {
          secret: "test-secret",
          toolSettings: {
            "open-browser-tab": true,
            "close-browser-tabs": true,
            "get-list-of-open-tabs": true,
            "get-recent-browser-history": true,
            "get-tab-web-content": true,
            "reorder-browser-tabs": true,
            "find-highlight-in-browser-tab": true,
          },
          domainDenyList: ["example.com", "another.com"],
          ports: [8089],
          auditLog: [],
        };
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: configWithDenyList,
        });

        const request: ServerMessageRequest = {
          cmd: "open-tab",
          url: "https://allowed.com",
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123 };
        (browser.tabs.create as jest.Mock).mockResolvedValue(mockTab);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.create).toHaveBeenCalledWith({
          url: "https://allowed.com",
          active: false,
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "opened-tab-id",
          correlationId: "test-correlation-id",
          tabId: 123,
        });
      });
    });

    describe("close-tabs command", () => {
      it("should close tabs and send confirmation to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "close-tabs",
          tabIds: [123, 456],
          correlationId: "test-correlation-id",
        };

        (browser.tabs.remove as jest.Mock).mockResolvedValue(undefined);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.remove).toHaveBeenCalledWith([123, 456]);
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tabs-closed",
          correlationId: "test-correlation-id",
        });
      });
    });

    describe("get-tab-list command", () => {
      it("should get tabs and send them to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-list",
          correlationId: "test-correlation-id",
        };

        const mockTabs = [{ id: 123, url: "https://example.com" }];
        (browser.tabs.query as jest.Mock).mockResolvedValue(mockTabs);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.query).toHaveBeenCalledWith({});
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tabs",
          correlationId: "test-correlation-id",
          tabs: mockTabs,
        });
      });
    });

    describe("get-browser-recent-history command", () => {
      it("should get history items and send them to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-browser-recent-history",
          searchQuery: "test",
          correlationId: "test-correlation-id",
        };

        const mockHistoryItems = [
          { url: "https://example.com", title: "Example" },
          { url: "https://test.com", title: "Test" },
        ];
        (browser.history.search as jest.Mock).mockResolvedValue(
          mockHistoryItems
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.history.search).toHaveBeenCalledWith({
          text: "test",
          maxResults: 200,
          startTime: 0,
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "history",
          correlationId: "test-correlation-id",
          historyItems: mockHistoryItems,
        });
      });

      it("should use empty string for search query if not provided", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-browser-recent-history",
          correlationId: "test-correlation-id",
        };

        const mockHistoryItems = [
          { url: "https://example.com", title: "Example" },
        ];
        (browser.history.search as jest.Mock).mockResolvedValue(
          mockHistoryItems
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.history.search).toHaveBeenCalledWith({
          text: "",
          maxResults: 200,
          startTime: 0,
        });
      });

      it("should filter out history items without URLs", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-browser-recent-history",
          correlationId: "test-correlation-id",
        };

        const mockHistoryItems = [
          { url: "https://example.com", title: "Example" },
          { title: "No URL" }, // This should be filtered out
        ];
        (browser.history.search as jest.Mock).mockResolvedValue(
          mockHistoryItems
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "history",
          correlationId: "test-correlation-id",
          historyItems: [{ url: "https://example.com", title: "Example" }],
        });
      });
    });

    describe("get-tab-content command", () => {
      it("should get tab content and send it to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);

        const mockScriptResult = [
          {
            links: [{ url: "https://example.com/page", text: "Page" }],
            fullText: "Page content",
            isTruncated: false,
            totalLength: 12,
          },
        ];
        (browser.tabs.executeScript as jest.Mock).mockResolvedValue(
          mockScriptResult
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.get).toHaveBeenCalledWith(123);
        expect(browser.permissions.contains).toHaveBeenCalledWith({
          origins: ["https://example.com/*"],
        });
        expect(browser.tabs.executeScript).toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
          isTruncated: false,
          fullText: "Page content",
          links: [{ url: "https://example.com/page", text: "Page" }],
          totalLength: 12,
        });
      });

      it("should throw an error if tab URL domain is in deny list", async () => {
        // Arrange
        const configWithDenyList: ExtensionConfig = {
          secret: "test-secret",
          toolSettings: {
            "open-browser-tab": true,
            "close-browser-tabs": true,
            "get-list-of-open-tabs": true,
            "get-recent-browser-history": true,
            "get-tab-web-content": true,
            "reorder-browser-tabs": true,
            "find-highlight-in-browser-tab": true,
          },
          domainDenyList: ["example.com"], // Add example.com to deny list
          ports: [8089],
          auditLog: [],
        };
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: configWithDenyList,
        });

        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Domain in tab URL is in the deny list");
        expect(browser.tabs.executeScript).not.toHaveBeenCalled();
      });

      it("should throw an error if permissions are denied", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(false);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow();
        expect(browser.tabs.executeScript).not.toHaveBeenCalled();
      });
    });

    describe("reorder-tabs command", () => {
      it("should reorder tabs and send confirmation to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "reorder-tabs",
          tabOrder: [123, 456, 789],
          correlationId: "test-correlation-id",
        };

        (browser.tabs.move as jest.Mock).mockResolvedValue(undefined);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.move).toHaveBeenCalledTimes(3);
        expect(browser.tabs.move).toHaveBeenNthCalledWith(1, 123, { index: 0 });
        expect(browser.tabs.move).toHaveBeenNthCalledWith(2, 456, { index: 1 });
        expect(browser.tabs.move).toHaveBeenNthCalledWith(3, 789, { index: 2 });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tabs-reordered",
          correlationId: "test-correlation-id",
          tabOrder: [123, 456, 789],
        });
      });
    });

    describe("find-highlight command", () => {
      it("should find and highlight text in a tab", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "find-highlight",
          tabId: 123,
          queryPhrase: "test",
          correlationId: "test-correlation-id",
        };

        const mockFindResults = { count: 5 };
        (browser.find.find as jest.Mock).mockResolvedValue(mockFindResults);
        (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.find.find).toHaveBeenCalledWith("test", {
          tabId: 123,
          caseSensitive: true,
        });
        expect(browser.tabs.update).toHaveBeenCalledWith(123, { active: true });
        expect(browser.find.highlightResults).toHaveBeenCalledWith({
          tabId: 123,
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "find-highlight-result",
          correlationId: "test-correlation-id",
          noOfResults: 5,
        });
      });

      it("should not highlight or activate tab if no results found", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "find-highlight",
          tabId: 123,
          queryPhrase: "test",
          correlationId: "test-correlation-id",
        };

        const mockFindResults = { count: 0 };
        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.find.find as jest.Mock).mockResolvedValue(mockFindResults);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.update).not.toHaveBeenCalled();
        expect(browser.find.highlightResults).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "find-highlight-result",
          correlationId: "test-correlation-id",
          noOfResults: 0,
        });
      });

      it("should throw an error if permissions are denied", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "find-highlight",
          tabId: 123,
          queryPhrase: "test",
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(false);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow();
        expect(browser.find.find).not.toHaveBeenCalled();
      });
    });
  });

  describe("take-snapshot command", () => {
    it("takes a snapshot and sends it to the server when automation mode is enabled", async () => {
      // Arrange — automation mode must be enabled for this gated command.
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: {
          secret: "test-secret",
          ports: [8089],
          domainDenyList: [],
          auditLog: [],
          automationMode: true,
        },
      });

      const request: ServerMessageRequest = {
        cmd: "take-snapshot",
        tabId: 123,
        correlationId: "test-correlation-id",
      };

      const mockTab = { id: 123, url: "https://example.com" };
      (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
        { tree: 'button "X" [uid=e1]', isTruncated: false },
      ]);

      // Act
      await messageHandler.handleDecodedMessage(request);

      // Assert
      expect(browser.tabs.get).toHaveBeenCalledWith(123);
      expect(browser.tabs.executeScript).toHaveBeenCalled();
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "snapshot",
        correlationId: "test-correlation-id",
        tabId: 123,
        snapshot: 'button "X" [uid=e1]',
        isTruncated: false,
      });
    });

    it("throws if the tab URL domain is in the deny list", async () => {
      // Arrange
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: {
          secret: "test-secret",
          ports: [8089],
          domainDenyList: ["example.com"],
          auditLog: [],
          automationMode: true,
        },
      });

      const request: ServerMessageRequest = {
        cmd: "take-snapshot",
        tabId: 123,
        correlationId: "test-correlation-id",
      };

      const mockTab = { id: 123, url: "https://example.com" };
      (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

      // Act & Assert
      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Domain in tab URL is in the deny list");
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });
  });

  describe("input action commands", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
      inputRealismMode: "off",
    };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
    });

    it("click-element replies action-result ok:true when the injected action succeeds", async () => {
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
        { ok: true },
      ]);

      const request: ServerMessageRequest = {
        cmd: "click-element",
        tabId: 123,
        uid: "e1",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.executeScript).toHaveBeenCalled();
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "test-correlation-id",
        ok: true,
        error: undefined,
      });
    });

    it("click-element replies action-result ok:false with the error when the uid is not found", async () => {
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
        {
          ok: false,
          error:
            "Element uid 'e9' not found — take a fresh snapshot (uids are reassigned each snapshot).",
        },
      ]);

      const request: ServerMessageRequest = {
        cmd: "click-element",
        tabId: 123,
        uid: "e9",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "test-correlation-id",
        ok: false,
        error:
          "Element uid 'e9' not found — take a fresh snapshot (uids are reassigned each snapshot).",
      });
    });

    it("fill-element passes the value through to the injected action and replies ok:true", async () => {
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
        { ok: true },
      ]);

      const request: ServerMessageRequest = {
        cmd: "fill-element",
        tabId: 123,
        uid: "e2",
        value: "hello",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      // The injected code must carry the fill action + value.
      const call = (browser.tabs.executeScript as jest.Mock).mock.calls[0][1];
      expect(call.code).toContain('"action":"fill"');
      expect(call.code).toContain('"value":"hello"');
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "test-correlation-id",
        ok: true,
        error: undefined,
      });
    });

    it("throws if the tab URL domain is in the deny list (no script injected)", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...automationConfig, domainDenyList: ["example.com"] },
      });

      const request: ServerMessageRequest = {
        cmd: "click-element",
        tabId: 123,
        uid: "e1",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Domain in tab URL is in the deny list");
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });

    it("blocks input actions when automation mode is disabled", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { secret: "test-secret", ports: [8089], automationMode: false },
      });

      const request: ServerMessageRequest = {
        cmd: "click-element",
        tabId: 123,
        uid: "e1",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("requires Automation Mode");
    });
  });

  describe("input realism — synthetic mode", () => {
    it("routes a click through the humanized path (multiple executeScript calls) and replies ok", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: {
          secret: "test-secret",
          domainDenyList: [],
          ports: [8089],
          automationMode: true,
          inputRealismMode: "synthetic",
        },
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      // readTargetInfo (a rect) + mouse moves + instant click all read [0].
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
        { ok: true, x: 0, y: 0, width: 20, height: 10, dpr: 1 },
      ]);

      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 123,
        uid: "e1",
        correlationId: "c1",
      } as ServerMessageRequest);

      expect((browser.tabs.executeScript as jest.Mock).mock.calls.length).toBeGreaterThan(1);
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "c1",
        ok: true,
        error: undefined,
      });
    });
  });

  describe("input realism — native mode", () => {
    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: {
          secret: "test-secret",
          domainDenyList: [],
          ports: [8089],
          automationMode: true,
          inputRealismMode: "native",
        },
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      // Every injected read goes through executeScript and reads results[0]. The
      // native rect reader needs screenX/screenY; the synthetic rect reader (used
      // on fallback) needs x/y; the instant/type steps return {ok}. Provide all
      // keys so whichever path runs gets a well-formed result.
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
        { ok: true, x: 0, y: 0, screenX: 0, screenY: 0, width: 20, height: 10, dpr: 1 },
      ]);
    });

    afterEach(() => {
      delete (global as any).__mockSendGesture;
    });

    it("native success sends a move-click gesture and replies ok:true", async () => {
      const sendGesture = jest.fn().mockResolvedValue({ id: "x", ok: true });
      (global as any).__mockSendGesture = sendGesture;

      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 123,
        uid: "e1",
        correlationId: "c-native-ok",
      } as ServerMessageRequest);

      // The native client was asked to perform a move-click gesture.
      expect(sendGesture).toHaveBeenCalledTimes(1);
      const gesture = sendGesture.mock.calls[0][0];
      expect(gesture.kind).toBe("move-click");
      expect(Array.isArray(gesture.waypoints)).toBe(true);
      expect(gesture.waypoints.length).toBeGreaterThan(0);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "c-native-ok",
        ok: true,
        error: undefined,
      });
    });

    it("native failure falls back to the synthetic path and still replies ok:true", async () => {
      const sendGesture = jest.fn().mockResolvedValue({ id: "x", ok: false });
      (global as any).__mockSendGesture = sendGesture;

      await messageHandler.handleDecodedMessage({
        cmd: "click-element",
        tabId: 123,
        uid: "e1",
        correlationId: "c-native-miss",
      } as ServerMessageRequest);

      // Native was attempted, missed...
      expect(sendGesture).toHaveBeenCalledTimes(1);
      // ...and the synthetic executor ran (it injects rect + performInputAction
      // via executeScript, which the native rect read also uses — so a fallback
      // produces strictly MORE executeScript calls than the single rect read).
      expect(
        (browser.tabs.executeScript as jest.Mock).mock.calls.length
      ).toBeGreaterThan(1);
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "c-native-miss",
        ok: true,
        error: undefined,
      });
    });
  });

  describe("navigate-tab command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
    };

    it("loads an https URL in the tab and replies navigated", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://old.com",
      });
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);

      const request: ServerMessageRequest = {
        cmd: "navigate-tab",
        tabId: 123,
        url: "https://example.com",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.update).toHaveBeenCalledWith(123, {
        url: "https://example.com",
      });
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "test-correlation-id",
        tabId: 123,
        url: "https://example.com",
      });
    });

    it("allows http for localhost", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);

      const request: ServerMessageRequest = {
        cmd: "navigate-tab",
        tabId: 123,
        url: "http://localhost:3000/",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.update).toHaveBeenCalledWith(123, {
        url: "http://localhost:3000/",
      });
    });

    it("allows http for the IPv6 loopback [::1]", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);

      const request: ServerMessageRequest = {
        cmd: "navigate-tab",
        tabId: 123,
        url: "http://[::1]:3000/",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.update).toHaveBeenCalledWith(123, {
        url: "http://[::1]:3000/",
      });
    });

    it("rejects a non-localhost http URL", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });

      const request: ServerMessageRequest = {
        cmd: "navigate-tab",
        tabId: 123,
        url: "http://example.com",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Invalid URL (must be https, or http for localhost)");
      expect(browser.tabs.update).not.toHaveBeenCalled();
    });

    it("throws when the URL domain is in the deny list", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...automationConfig, domainDenyList: ["example.com"] },
      });

      const request: ServerMessageRequest = {
        cmd: "navigate-tab",
        tabId: 123,
        url: "https://example.com",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Domain in user defined deny list");
      expect(browser.tabs.update).not.toHaveBeenCalled();
    });
  });

  describe("navigate-page-history command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
    };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
    });

    it("goes back and replies navigated", async () => {
      (browser.tabs.goBack as jest.Mock).mockResolvedValue(undefined);

      const request: ServerMessageRequest = {
        cmd: "navigate-page-history",
        tabId: 123,
        direction: "back",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.goBack).toHaveBeenCalledWith(123);
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "test-correlation-id",
        tabId: 123,
      });
    });

    it("goes forward and replies navigated", async () => {
      (browser.tabs.goForward as jest.Mock).mockResolvedValue(undefined);

      const request: ServerMessageRequest = {
        cmd: "navigate-page-history",
        tabId: 123,
        direction: "forward",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.goForward).toHaveBeenCalledWith(123);
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "test-correlation-id",
        tabId: 123,
      });
    });

    it("reloads with bypassCache and replies navigated", async () => {
      (browser.tabs.reload as jest.Mock).mockResolvedValue(undefined);

      const request: ServerMessageRequest = {
        cmd: "navigate-page-history",
        tabId: 123,
        direction: "reload",
        bypassCache: true,
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.reload).toHaveBeenCalledWith(123, {
        bypassCache: true,
      });
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "test-correlation-id",
        tabId: 123,
      });
    });

    it("reloads without bypassCache defaulting to false", async () => {
      (browser.tabs.reload as jest.Mock).mockResolvedValue(undefined);

      const request: ServerMessageRequest = {
        cmd: "navigate-page-history",
        tabId: 123,
        direction: "reload",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.reload).toHaveBeenCalledWith(123, {
        bypassCache: false,
      });
    });
  });

  describe("select-tab command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
    };

    it("activates the tab and focuses its window, then replies tab-selected", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
        windowId: 5,
      });
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.windows.update as jest.Mock).mockResolvedValue(undefined);

      const request: ServerMessageRequest = {
        cmd: "select-tab",
        tabId: 123,
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.update).toHaveBeenCalledWith(123, { active: true });
      expect(browser.windows.update).toHaveBeenCalledWith(5, {
        focused: true,
      });
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "tab-selected",
        correlationId: "test-correlation-id",
        tabId: 123,
      });
    });
  });

  describe("get-active-tab command", () => {
    it("returns the active tab without requiring automation mode", async () => {
      // Note: no automationMode in config — get-active-tab is intentionally not gated.
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: {
          secret: "test-secret",
          ports: [8089],
          domainDenyList: [],
          auditLog: [],
        },
      });

      const activeTab = {
        id: 42,
        url: "https://example.com",
        title: "Example",
      };
      (browser.tabs.query as jest.Mock).mockResolvedValue([activeTab]);

      const request: ServerMessageRequest = {
        cmd: "get-active-tab",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.query).toHaveBeenCalledWith({
        active: true,
        currentWindow: true,
      });
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "active-tab",
        correlationId: "test-correlation-id",
        tab: activeTab,
      });
    });

    it("replies with null when there is no active tab", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: {
          secret: "test-secret",
          ports: [8089],
          domainDenyList: [],
          auditLog: [],
        },
      });
      (browser.tabs.query as jest.Mock).mockResolvedValue([]);

      const request: ServerMessageRequest = {
        cmd: "get-active-tab",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "active-tab",
        correlationId: "test-correlation-id",
        tab: null,
      });
    });
  });

  describe("wait-for-text command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
    };

    it("replies found:true when the text appears on the page", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue([true]);

      const request: ServerMessageRequest = {
        cmd: "wait-for-text",
        tabId: 123,
        text: "Hello",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.executeScript).toHaveBeenCalled();
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "wait-for-text-result",
        correlationId: "test-correlation-id",
        found: true,
      });
    });

    it("replies found:false when the text never appears before the timeout", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue([false]);

      const request: ServerMessageRequest = {
        cmd: "wait-for-text",
        tabId: 123,
        text: "Never",
        timeoutMs: 50,
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "wait-for-text-result",
        correlationId: "test-correlation-id",
        found: false,
      });
    });

    it("accepts an array of strings, OR-matches, and returns which matched", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
      // The injected isolated-world probe returns the matched needle (or null).
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue(["World"]);

      const request: ServerMessageRequest = {
        cmd: "wait-for-text",
        tabId: 123,
        text: ["Hello", "World"],
        correlationId: "c-arr",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "wait-for-text-result",
        correlationId: "c-arr",
        found: true,
        matched: "World",
      });
    });

    it("throws when the tab URL domain is in the deny list", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...automationConfig, domainDenyList: ["example.com"] },
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });

      const request: ServerMessageRequest = {
        cmd: "wait-for-text",
        tabId: 123,
        text: "Hello",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Domain in tab URL is in the deny list");
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });
  });

  describe("evaluate-script command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
    };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
    });

    it("injects the page-world script, polls the result, and replies eval-result ok:true with the value", async () => {
      // First executeScript call is the injector (returns [true]); the next is
      // the poller, which returns the serialized in-page envelope.
      (browser.tabs.executeScript as jest.Mock)
        .mockResolvedValueOnce([true])
        .mockResolvedValueOnce([JSON.stringify({ ok: true, value: "Hello" })]);

      const request: ServerMessageRequest = {
        cmd: "evaluate-script",
        tabId: 123,
        function: "() => document.title",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      // The injector executeScript carries the page-world script (which embeds
      // the evaluated function source). The function source is nested two JSON
      // layers deep (page script inside injector), so assert on the recognizable
      // source rather than a single-encoded literal.
      const injectorCode = (browser.tabs.executeScript as jest.Mock).mock
        .calls[0][1].code;
      expect(injectorCode).toContain("createElement('script')");
      expect(injectorCode).toContain("() => document.title");

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "eval-result",
        correlationId: "test-correlation-id",
        ok: true,
        value: "Hello",
        error: undefined,
      });
    });

    it("replies eval-result ok:false with the error when the page script throws", async () => {
      (browser.tabs.executeScript as jest.Mock)
        .mockResolvedValueOnce([true])
        .mockResolvedValueOnce([
          JSON.stringify({ ok: false, error: "ReferenceError: x is not defined" }),
        ]);

      const request: ServerMessageRequest = {
        cmd: "evaluate-script",
        tabId: 123,
        function: "() => x",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "eval-result",
        correlationId: "test-correlation-id",
        ok: false,
        value: undefined,
        error: "ReferenceError: x is not defined",
      });
    });

    it("forwards args by embedding them in the injected page script", async () => {
      (browser.tabs.executeScript as jest.Mock)
        .mockResolvedValueOnce([true])
        .mockResolvedValueOnce([JSON.stringify({ ok: true, value: 7 })]);

      const request: ServerMessageRequest = {
        cmd: "evaluate-script",
        tabId: 123,
        function: "(a, b) => a + b",
        args: [3, 4],
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      const injectorCode = (browser.tabs.executeScript as jest.Mock).mock
        .calls[0][1].code;
      expect(injectorCode).toContain(JSON.stringify([3, 4]));
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "eval-result",
        correlationId: "test-correlation-id",
        ok: true,
        value: 7,
        error: undefined,
      });
    });

    it("throws if the tab URL domain is in the deny list (no script injected)", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...automationConfig, domainDenyList: ["example.com"] },
      });

      const request: ServerMessageRequest = {
        cmd: "evaluate-script",
        tabId: 123,
        function: "() => 1",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Domain in tab URL is in the deny list");
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });

    it("is blocked when automation mode is disabled", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { secret: "test-secret", ports: [8089], automationMode: false },
      });

      const request: ServerMessageRequest = {
        cmd: "evaluate-script",
        tabId: 123,
        function: "() => 1",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("requires Automation Mode");
    });
  });

  describe("take-screenshot command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
    };

    // Viewport mode is the only fully-testable path in jsdom: it never touches a
    // canvas. captureVisibleTab returns a data URL, which the handler activates
    // the tab for, strips the prefix from, and forwards as a screenshot message.
    // (full-page stitch and element crop draw onto a <canvas>, which jsdom has no
    // renderer for, so they are exercised only in a real browser.)
    it("captures the viewport (png), activating the tab first, and replies screenshot", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
        windowId: 7,
      });
      // The target tab is already the active tab, so no restore should occur.
      (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 123 }]);
      (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue(
        "data:image/png;base64,AAAA"
      );

      const request: ServerMessageRequest = {
        cmd: "take-screenshot",
        tabId: 123,
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      // The active tab is the only one captureVisibleTab can grab, so the tab
      // must be activated before the capture.
      expect(browser.tabs.update).toHaveBeenCalledWith(123, { active: true });
      // Target was already active, so it is the only tabs.update call (no restore).
      expect(browser.tabs.update).toHaveBeenCalledTimes(1);
      expect(browser.tabs.captureVisibleTab).toHaveBeenCalledWith(7, {
        format: "png",
        quality: 90,
      });
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "screenshot",
        correlationId: "test-correlation-id",
        mimeType: "image/png",
        base64: "AAAA",
      });
    });

    it("captures the viewport as jpeg when format is jpeg", async () => {
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
      (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue(
        "data:image/jpeg;base64,/9j/4AAQ"
      );

      const request: ServerMessageRequest = {
        cmd: "take-screenshot",
        tabId: 123,
        format: "jpeg",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.captureVisibleTab).toHaveBeenCalledWith(7, {
        format: "jpeg",
        quality: 90,
      });
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "screenshot",
        correlationId: "test-correlation-id",
        mimeType: "image/jpeg",
        base64: "/9j/4AAQ",
      });
    });

    it("re-activates the previously-active tab when it differs from the target", async () => {
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
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      // Target activated for the capture, then the prior tab restored afterwards.
      expect(browser.tabs.update).toHaveBeenNthCalledWith(1, 123, {
        active: true,
      });
      expect(browser.tabs.update).toHaveBeenNthCalledWith(2, 99, {
        active: true,
      });
      // The reply still goes out unchanged.
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "screenshot",
        correlationId: "test-correlation-id",
        mimeType: "image/png",
        base64: "AAAA",
      });
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
      // The capture itself fails.
      (browser.tabs.captureVisibleTab as jest.Mock).mockRejectedValue(
        new Error("capture failed")
      );

      const request: ServerMessageRequest = {
        cmd: "take-screenshot",
        tabId: 123,
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("capture failed");

      // Even on failure, the user's foreground tab is restored.
      expect(browser.tabs.update).toHaveBeenNthCalledWith(1, 123, {
        active: true,
      });
      expect(browser.tabs.update).toHaveBeenNthCalledWith(2, 99, {
        active: true,
      });
    });

    it("throws when the tab URL domain is in the deny list (no capture)", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...automationConfig, domainDenyList: ["example.com"] },
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
        windowId: 7,
      });

      const request: ServerMessageRequest = {
        cmd: "take-screenshot",
        tabId: 123,
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Domain in tab URL is in the deny list");
      expect(browser.tabs.captureVisibleTab).not.toHaveBeenCalled();
    });

    it("is blocked when automation mode is disabled", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { secret: "test-secret", ports: [8089], automationMode: false },
      });

      const request: ServerMessageRequest = {
        cmd: "take-screenshot",
        tabId: 123,
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("requires Automation Mode");
      expect(browser.tabs.captureVisibleTab).not.toHaveBeenCalled();
    });
  });

  describe("upload-file command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
    };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
    });

    it("runs the isolated-world upload function (no page <script>) and replies action-result ok:true", async () => {
      // upload-file runs `performFileUpload` directly in the isolated
      // content-script world via a single executeScript call (no page-world
      // <script> injection, so a strict page CSP can't block it) and reads the
      // {ok,error} envelope from results[0]. The real File/DataTransfer assignment
      // is browser-only (jsdom is incomplete), so it is mocked here and exercised
      // directly in upload-script.test.ts.
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue([{ ok: true }]);

      const request: ServerMessageRequest = {
        cmd: "upload-file",
        tabId: 123,
        uid: "e5",
        filename: "report.pdf",
        mimeType: "application/pdf",
        base64: "QUJD",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      // Exactly one executeScript call, carrying the isolated-world upload
      // function and the embedded args — and NOT an injected page <script>.
      expect(
        (browser.tabs.executeScript as jest.Mock).mock.calls.length
      ).toBe(1);
      const code = (browser.tabs.executeScript as jest.Mock).mock.calls[0][1]
        .code;
      expect(code).toContain("performFileUpload");
      expect(code).toContain("report.pdf");
      expect(code).toContain("QUJD");
      expect(code).not.toContain("createElement('script')");

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "test-correlation-id",
        ok: true,
        error: undefined,
      });
    });

    it("replies action-result ok:false with the error when the uid is not found", async () => {
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
        {
          ok: false,
          error: "Element uid 'e9' not found — take a fresh snapshot.",
        },
      ]);

      const request: ServerMessageRequest = {
        cmd: "upload-file",
        tabId: 123,
        uid: "e9",
        filename: "a.txt",
        mimeType: "text/plain",
        base64: "QQ==",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "test-correlation-id",
        ok: false,
        error: "Element uid 'e9' not found — take a fresh snapshot.",
      });
    });

    it("throws when the tab URL domain is in the deny list (no script injected)", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...automationConfig, domainDenyList: ["example.com"] },
      });

      const request: ServerMessageRequest = {
        cmd: "upload-file",
        tabId: 123,
        uid: "e5",
        filename: "a.txt",
        mimeType: "text/plain",
        base64: "QQ==",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Domain in tab URL is in the deny list");
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });

    it("is blocked when automation mode is disabled", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { secret: "test-secret", ports: [8089], automationMode: false },
      });

      const request: ServerMessageRequest = {
        cmd: "upload-file",
        tabId: 123,
        uid: "e5",
        filename: "a.txt",
        mimeType: "text/plain",
        base64: "QQ==",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("requires Automation Mode");
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });
  });

  describe("automation mode gate", () => {
    it("blocks an automation command when automation mode is disabled", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { secret: "test-secret", ports: [8089], automationMode: false },
      });

      const request = {
        cmd: "take-snapshot",
        tabId: 1,
        correlationId: "c1",
      } as unknown as ServerMessageRequest;

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("requires Automation Mode");
    });

    it("allows a non-automation command when automation mode is disabled", async () => {
      (browser.tabs.create as jest.Mock).mockResolvedValue({ id: 7 });

      const request: ServerMessageRequest = {
        cmd: "open-tab",
        url: "https://example.com",
        correlationId: "c2",
      };

      await messageHandler.handleDecodedMessage(request);
      expect(browser.tabs.create).toHaveBeenCalledWith({
        url: "https://example.com",
        active: false,
      });
    });
  });

  describe("get-console-messages command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
    };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      // Start each test from an empty buffer for the tabs we use.
      clearConsoleEntries(700);
      clearConsoleEntries(701);
    });

    it("replies with the tab's buffered console entries when automation mode is enabled", async () => {
      addConsoleEntry(700, { level: "log", text: "hello", timestamp: 10 });
      addConsoleEntry(700, { level: "error", text: "boom", timestamp: 20 });

      const request: ServerMessageRequest = {
        cmd: "get-console-messages",
        tabId: 700,
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "console-messages",
        correlationId: "test-correlation-id",
        entries: [
          { level: "log", text: "hello", timestamp: 10 },
          { level: "error", text: "boom", timestamp: 20 },
        ],
      });
      // It is a pure buffer read — no page scripting.
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });

    it("respects the limit, returning only the most-recent entries", async () => {
      for (let i = 0; i < 5; i++) {
        addConsoleEntry(701, { level: "log", text: `m${i}`, timestamp: i });
      }

      const request: ServerMessageRequest = {
        cmd: "get-console-messages",
        tabId: 701,
        limit: 2,
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "console-messages",
        correlationId: "test-correlation-id",
        entries: [
          { level: "log", text: "m3", timestamp: 3 },
          { level: "log", text: "m4", timestamp: 4 },
        ],
      });
    });

    it("replies with an empty list when nothing was captured for the tab", async () => {
      const request: ServerMessageRequest = {
        cmd: "get-console-messages",
        tabId: 700,
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "console-messages",
        correlationId: "test-correlation-id",
        entries: [],
      });
    });

    it("is blocked when automation mode is disabled", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { secret: "test-secret", ports: [8089], automationMode: false },
      });

      const request: ServerMessageRequest = {
        cmd: "get-console-messages",
        tabId: 700,
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("requires Automation Mode");
    });
  });

  describe("get-network-requests command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
    };

    // Seed a finalized record into a tab's buffer via the pure updaters (the
    // live webRequest flow is browser-only; this is the same path the listeners
    // drive).
    function seed(
      tabId: number,
      requestId: string,
      url: string,
      type: string,
      status: number
    ) {
      onBeforeRequestRecord({ requestId, url, method: "GET", type, tabId, timeStamp: 1000 });
      onCompletedRecord({
        requestId,
        url,
        method: "GET",
        type,
        tabId,
        statusCode: status,
        timeStamp: 1100,
      });
    }

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      clearNetworkRequests(800);
      clearNetworkRequests(801);
    });

    it("replies with the tab's captured network records when automation mode is enabled", async () => {
      seed(800, "n1", "https://example.com/api/users", "xmlhttprequest", 200);

      const request: ServerMessageRequest = {
        cmd: "get-network-requests",
        tabId: 800,
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      const call = (mockClient.sendResourceToServer as jest.Mock).mock.calls[0][0];
      expect(call.resource).toBe("network-requests");
      expect(call.correlationId).toBe("test-correlation-id");
      expect(call.requests).toHaveLength(1);
      expect(call.requests[0]).toMatchObject({
        requestId: "n1",
        url: "https://example.com/api/users",
        method: "GET",
        type: "xmlhttprequest",
        statusCode: 200,
        durationMs: 100,
      });
      // It is a pure buffer read — no page scripting.
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });

    it("honors filter (resource type) and limit", async () => {
      seed(801, "a1", "https://example.com/api/users", "xmlhttprequest", 200);
      seed(801, "a2", "https://cdn.example.com/app.js", "script", 200);
      seed(801, "a3", "https://example.com/api/orders", "xmlhttprequest", 500);

      const request: ServerMessageRequest = {
        cmd: "get-network-requests",
        tabId: 801,
        filter: "xmlhttprequest",
        limit: 1,
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      const call = (mockClient.sendResourceToServer as jest.Mock).mock.calls[0][0];
      // Two match the type; the single most-recent is a3.
      expect(call.requests.map((r: { requestId: string }) => r.requestId)).toEqual([
        "a3",
      ]);
    });

    it("replies with an empty list when nothing was captured for the tab", async () => {
      const request: ServerMessageRequest = {
        cmd: "get-network-requests",
        tabId: 800,
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "network-requests",
        correlationId: "test-correlation-id",
        requests: [],
      });
    });

    it("is blocked when automation mode is disabled", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { secret: "test-secret", ports: [8089], automationMode: false },
      });

      const request: ServerMessageRequest = {
        cmd: "get-network-requests",
        tabId: 800,
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("requires Automation Mode");
    });
  });

  describe("drag-element command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
      inputRealismMode: "off",
    };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
    });

    it("injects the drag action carrying both uids and replies action-result ok:true", async () => {
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
        { ok: true },
      ]);

      const request: ServerMessageRequest = {
        cmd: "drag-element",
        tabId: 123,
        fromUid: "e1",
        toUid: "e2",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      const call = (browser.tabs.executeScript as jest.Mock).mock.calls[0][1];
      expect(call.code).toContain('"action":"drag"');
      expect(call.code).toContain('"fromUid":"e1"');
      expect(call.code).toContain('"toUid":"e2"');
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "test-correlation-id",
        ok: true,
        error: undefined,
      });
    });

    it("replies action-result ok:false with the error when a uid is not found", async () => {
      (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
        {
          ok: false,
          error:
            "Element uid 'e9' not found — take a fresh snapshot (uids are reassigned each snapshot).",
        },
      ]);

      const request: ServerMessageRequest = {
        cmd: "drag-element",
        tabId: 123,
        fromUid: "e9",
        toUid: "e2",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "test-correlation-id",
        ok: false,
        error:
          "Element uid 'e9' not found — take a fresh snapshot (uids are reassigned each snapshot).",
      });
    });

    it("throws if the tab URL domain is in the deny list (no script injected)", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...automationConfig, domainDenyList: ["example.com"] },
      });

      const request: ServerMessageRequest = {
        cmd: "drag-element",
        tabId: 123,
        fromUid: "e1",
        toUid: "e2",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Domain in tab URL is in the deny list");
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });

    it("is blocked when automation mode is disabled", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { secret: "test-secret", ports: [8089], automationMode: false },
      });

      const request: ServerMessageRequest = {
        cmd: "drag-element",
        tabId: 123,
        fromUid: "e1",
        toUid: "e2",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("requires Automation Mode");
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });
  });

  describe("resize-window command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
    };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
    });

    it("resizes the tab's window and replies action-result ok:true", async () => {
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
        windowId: 5,
      });
      (browser.windows.update as jest.Mock).mockResolvedValue(undefined);

      const request: ServerMessageRequest = {
        cmd: "resize-window",
        tabId: 123,
        width: 1024,
        height: 768,
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(browser.tabs.get).toHaveBeenCalledWith(123);
      expect(browser.windows.update).toHaveBeenCalledWith(5, {
        width: 1024,
        height: 768,
      });
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "test-correlation-id",
        ok: true,
      });
    });

    it("is blocked when automation mode is disabled", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { secret: "test-secret", ports: [8089], automationMode: false },
      });

      const request: ServerMessageRequest = {
        cmd: "resize-window",
        tabId: 123,
        width: 800,
        height: 600,
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("requires Automation Mode");
      expect(browser.windows.update).not.toHaveBeenCalled();
    });
  });

  describe("handle-dialog command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
    };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
    });

    it("injects the page-world dialog script, polls the result, and replies action-result ok:true", async () => {
      // First executeScript call is the injector (returns [true]); the next is
      // the poller, which returns the serialized in-page envelope. The actual
      // dialog suppression (alert/confirm/prompt override) is browser-only, so
      // the injected script is exercised through the mock here plus the builder's
      // structural tests in page-world.test.ts.
      (browser.tabs.executeScript as jest.Mock)
        .mockResolvedValueOnce([true])
        .mockResolvedValueOnce([JSON.stringify({ ok: true })]);

      const request: ServerMessageRequest = {
        cmd: "handle-dialog",
        tabId: 123,
        action: "accept",
        promptText: "answer",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      // The injector executeScript carries the page-world dialog script, which
      // overrides window.confirm/prompt/alert. They are nested two JSON layers
      // deep (page script inside injector), so assert on recognizable content.
      const injectorCode = (browser.tabs.executeScript as jest.Mock).mock
        .calls[0][1].code;
      expect(injectorCode).toContain("createElement('script')");
      expect(injectorCode).toContain("window.confirm");
      expect(injectorCode).toContain("answer");

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "test-correlation-id",
        ok: true,
        error: undefined,
      });
    });

    it("replies action-result ok:false when the page script reports an error", async () => {
      (browser.tabs.executeScript as jest.Mock)
        .mockResolvedValueOnce([true])
        .mockResolvedValueOnce([
          JSON.stringify({ ok: false, error: "boom" }),
        ]);

      const request: ServerMessageRequest = {
        cmd: "handle-dialog",
        tabId: 123,
        action: "dismiss",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "test-correlation-id",
        ok: false,
        error: "boom",
      });
    });

    it("throws when the tab URL domain is in the deny list (no script injected)", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...automationConfig, domainDenyList: ["example.com"] },
      });

      const request: ServerMessageRequest = {
        cmd: "handle-dialog",
        tabId: 123,
        action: "accept",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Domain in tab URL is in the deny list");
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });

    it("is blocked when automation mode is disabled", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { secret: "test-secret", ports: [8089], automationMode: false },
      });

      const request: ServerMessageRequest = {
        cmd: "handle-dialog",
        tabId: 123,
        action: "accept",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("requires Automation Mode");
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });
  });

  describe("emulate command", () => {
    const automationConfig = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
    };

    beforeEach(() => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: automationConfig,
      });
      (browser.tabs.get as jest.Mock).mockResolvedValue({
        id: 123,
        url: "https://example.com",
      });
      (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      clearTabUserAgent(123);
    });

    afterEach(() => {
      clearTabUserAgent(123);
    });

    it("injects the page-world emulate script, polls the result, and replies action-result ok:true", async () => {
      // The navigator overrides and webRequest UA rewrite are browser-only; the
      // injected script is exercised through the mock here plus the builder's
      // structural tests in page-world.test.ts.
      (browser.tabs.executeScript as jest.Mock)
        .mockResolvedValueOnce([true])
        .mockResolvedValueOnce([JSON.stringify({ ok: true })]);

      const request: ServerMessageRequest = {
        cmd: "emulate",
        tabId: 123,
        geolocation: { latitude: 12.5, longitude: -77.25, accuracy: 30 },
        userAgent: "Custom/9.9",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      const injectorCode = (browser.tabs.executeScript as jest.Mock).mock
        .calls[0][1].code;
      expect(injectorCode).toContain("createElement('script')");
      expect(injectorCode).toContain("navigator.geolocation");
      expect(injectorCode).toContain("Custom/9.9");

      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "test-correlation-id",
        ok: true,
        error: undefined,
      });
    });

    it("registers the userAgent in the per-tab map so server-visible requests are rewritten", async () => {
      (browser.tabs.executeScript as jest.Mock)
        .mockResolvedValueOnce([true])
        .mockResolvedValueOnce([JSON.stringify({ ok: true })]);

      const request: ServerMessageRequest = {
        cmd: "emulate",
        tabId: 123,
        userAgent: "Custom/9.9",
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      // The handler stored the UA override for the tab, which the
      // onBeforeSendHeaders rewriter consults at request time.
      expect(getTabUserAgent(123)).toBe("Custom/9.9");
    });

    it("does not touch the UA map when no userAgent is given (geolocation only)", async () => {
      (browser.tabs.executeScript as jest.Mock)
        .mockResolvedValueOnce([true])
        .mockResolvedValueOnce([JSON.stringify({ ok: true })]);

      const request: ServerMessageRequest = {
        cmd: "emulate",
        tabId: 123,
        geolocation: { latitude: 1, longitude: 2 },
        correlationId: "test-correlation-id",
      };

      await messageHandler.handleDecodedMessage(request);

      expect(getTabUserAgent(123)).toBeUndefined();
      expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
        resource: "action-result",
        correlationId: "test-correlation-id",
        ok: true,
        error: undefined,
      });
    });

    it("throws when the tab URL domain is in the deny list (no script injected, no UA set)", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { ...automationConfig, domainDenyList: ["example.com"] },
      });

      const request: ServerMessageRequest = {
        cmd: "emulate",
        tabId: 123,
        userAgent: "Custom/9.9",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Domain in tab URL is in the deny list");
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
      expect(getTabUserAgent(123)).toBeUndefined();
    });

    it("is blocked when automation mode is disabled", async () => {
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: { secret: "test-secret", ports: [8089], automationMode: false },
      });

      const request: ServerMessageRequest = {
        cmd: "emulate",
        tabId: 123,
        userAgent: "Custom/9.9",
        correlationId: "test-correlation-id",
      };

      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("requires Automation Mode");
      expect(browser.tabs.executeScript).not.toHaveBeenCalled();
    });
  });
});
