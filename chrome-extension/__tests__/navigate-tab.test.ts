jest.mock("../nav-ready", () => ({
  waitForTabReady: jest.fn().mockResolvedValue(undefined),
}));
// Defensive module-load mocks (mirror message-handler.test.ts header).
jest.mock("../native-input-client", () => ({
  NativeInputClient: jest.fn().mockImplementation(() => ({ sendGesture: jest.fn() })),
}));
jest.mock("../cdp-eval", () => ({ cdpEval: jest.fn() }));

import { mockBrowser } from "./setup";
import { MessageHandler } from "../message-handler";
import { waitForTabReady } from "../nav-ready";
import type { ExtensionTransport } from "../transport";
import type { ServerMessageRequest } from "@foxpilot/common";

function makeTransport(): jest.Mocked<ExtensionTransport> {
  return {
    sendResourceToServer: jest.fn().mockResolvedValue(undefined),
    sendErrorToServer: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ExtensionTransport>;
}

describe("chrome navigate-tab settle", () => {
  let handler: MessageHandler;
  let transport: jest.Mocked<ExtensionTransport>;

  beforeEach(() => {
    jest.clearAllMocks();
    transport = makeTransport();
    handler = new MessageHandler(transport);
    // navigate-tab is in AUTOMATION_COMMANDS → automationMode MUST be true, else
    // handleDecodedMessage throws "requires Automation Mode". Unset tool ids
    // default to allowed, so toolSettings can stay empty.
    (mockBrowser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], domainDenyList: [], auditLog: [], toolSettings: {}, automationMode: true },
    });
    (mockBrowser as any).tabs.onUpdated = { addListener: jest.fn(), removeListener: jest.fn() };
    (mockBrowser.tabs.update as jest.Mock).mockResolvedValue(undefined);
  });

  it("returns the ACTUAL settled url (not the requested one)", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://dash.cloudflare.com/home", status: "complete" });
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/templates", correlationId: "c1",
    } as any;
    await handler.handleDecodedMessage(req);
    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated", correlationId: "c1", tabId: 7, url: "https://dash.cloudflare.com/home",
    });
  });

  it("reports a mismatch when a waitFor* condition is unmet within timeout", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://dash.cloudflare.com/home", status: "complete" });
    (mockBrowser.scripting.executeScript as jest.Mock).mockResolvedValue([{ result: false }]);
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/x",
      waitForText: "Create Token", timeoutMs: 0, correlationId: "c2",
    } as any;
    await handler.handleDecodedMessage(req);
    const sent = (transport.sendResourceToServer as jest.Mock).mock.calls[0][0];
    expect(sent.url).toContain("https://dash.cloudflare.com/home");
    expect(sent.url).toContain('expected text "Create Token" not found');
  });

  it("waitUntil:none restores fire-and-forget (echoes the requested url, no settle)", async () => {
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/y", waitUntil: "none", correlationId: "c3",
    } as any;
    await handler.handleDecodedMessage(req);
    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated", correlationId: "c3", tabId: 7, url: "https://dash.cloudflare.com/y",
    });
    // No settle on the fire-and-forget path. (The settle path is gated by
    // waitForTabReady; asserting it never ran proves no settle re-read occurred.
    // NB: a tabs.get IS incidentally issued by the unrelated audit-log path
    // (addAuditLogForReq) for every tabId-bearing command, so asserting on
    // waitForTabReady — not tabs.get — is the accurate proxy for "no settle".)
    expect(waitForTabReady).not.toHaveBeenCalled();
  });

  it("clamps the combined settle+condition budget under the broker cap for a large timeoutMs", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://dash.cloudflare.com/home", status: "complete" });
    // Capture the budget handed to the (private) condition-wait without running its loop.
    const condSpy = jest.spyOn(handler as any, "awaitNavConditions").mockResolvedValue(undefined);
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/x",
      waitForText: "Never appears", timeoutMs: 40000, correlationId: "c4",
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
      waitForText: "Never appears", correlationId: "c5",
    } as any;
    await handler.handleDecodedMessage(req);
    expect(condSpy.mock.calls[0][2]).toBe(15000);
  });
});
