jest.mock("../nav-ready", () => ({
  waitForTabReady: jest.fn().mockResolvedValue(undefined),
  execWithReadyRetry: jest.fn(),
}));

import { mockBrowser } from "./setup";
import { MessageHandler } from "../message-handler";
import { execWithReadyRetry, waitForTabReady } from "../nav-ready";
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

  it("clamps the combined settle+condition budget under the broker cap for a large timeoutMs", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://dash.cloudflare.com/home", status: "complete" });
    // Capture the budget handed to the (private) condition-wait without running its loop.
    const condSpy = jest.spyOn(handler as any, "awaitNavConditions").mockResolvedValue(undefined);
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/x",
      waitForText: "Never appears", timeoutMs: 40000, correlationId: "c3",
    } as any;
    await handler.handleDecodedMessage(req);
    // Settle stays capped at 8s.
    expect(waitForTabReady).toHaveBeenCalledWith(7, { timeoutMs: 8000 });
    // Condition budget is clamped so settle(8s) + conditions ≤ 28s (< 30s broker cap).
    const conditionBudget = condSpy.mock.calls[0][2] as number;
    expect(conditionBudget).toBe(20000);
    expect(8000 + conditionBudget).toBeLessThan(30000);
  });

  it("leaves the default budget unchanged (condition-wait still gets the full 15s)", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://dash.cloudflare.com/home", status: "complete" });
    const condSpy = jest.spyOn(handler as any, "awaitNavConditions").mockResolvedValue(undefined);
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/x",
      waitForText: "Never appears", correlationId: "c4",
    } as any;
    await handler.handleDecodedMessage(req);
    expect(condSpy.mock.calls[0][2]).toBe(15000);
  });
});
