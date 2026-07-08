jest.mock("../nav-ready", () => ({
  waitForTabReady: jest.fn().mockResolvedValue(undefined),
  execWithReadyRetry: jest.fn(),
}));

import { mockBrowser } from "./setup";
import { MessageHandler } from "../message-handler";
import { execWithReadyRetry } from "../nav-ready";
import type { ExtensionTransport } from "../transport";
import type { ServerMessageRequest } from "@foxpilot/common";

function makeTransport(): jest.Mocked<ExtensionTransport> {
  return {
    sendResourceToServer: jest.fn().mockResolvedValue(undefined),
    sendErrorToServer: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ExtensionTransport>;
}

describe("firefox navigate-tab settle", () => {
  let handler: MessageHandler;
  let transport: jest.Mocked<ExtensionTransport>;

  beforeEach(() => {
    jest.clearAllMocks();
    transport = makeTransport();
    handler = new MessageHandler(transport);
    // navigate-tab requires automation mode (see the Chrome navigate-tab test note).
    (mockBrowser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], domainDenyList: [], auditLog: [], toolSettings: {}, automationMode: true },
    });
    (mockBrowser as any).tabs.onUpdated = { addListener: jest.fn(), removeListener: jest.fn() };
    (mockBrowser.tabs.update as jest.Mock).mockResolvedValue(undefined);
  });

  it("returns the ACTUAL settled url", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://dash.cloudflare.com/home", status: "complete" });
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/templates", correlationId: "c1",
    } as any;
    await handler.handleDecodedMessage(req);
    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated", correlationId: "c1", tabId: 7, url: "https://dash.cloudflare.com/home",
    });
  });

  it("reports a mismatch when waitForText is unmet, via execWithReadyRetry", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://dash.cloudflare.com/home", status: "complete" });
    (execWithReadyRetry as jest.Mock).mockResolvedValue([false]);
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/x",
      waitForText: "Create Token", timeoutMs: 0, correlationId: "c2",
    } as any;
    await handler.handleDecodedMessage(req);
    const sent = (transport.sendResourceToServer as jest.Mock).mock.calls[0][0];
    expect(sent.url).toContain('expected text "Create Token" not found');
  });
});
