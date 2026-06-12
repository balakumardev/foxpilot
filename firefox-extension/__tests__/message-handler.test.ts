import { MessageHandler } from "../message-handler";
import { WebsocketClient } from "../client";
import type { ServerMessageRequest } from "@browser-control-mcp/common";
import { ExtensionConfig } from "../extension-config";

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

        // Assert
        expect(browser.tabs.create).toHaveBeenCalledWith({
          url: "https://example.com",
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
      });
    });
  });
});
