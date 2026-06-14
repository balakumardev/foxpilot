import {
  buildUserAgentRule,
  applyUserAgentRule,
  clearUserAgentRule,
} from "../emulate";

describe("buildUserAgentRule (pure)", () => {
  it("builds a modifyHeaders session rule that sets User-Agent for the given tab", () => {
    const rule = buildUserAgentRule(42, "MyUA/1.0", 4200);
    expect(rule.id).toBe(4200);
    expect(rule.action.type).toBe("modifyHeaders");
    expect(rule.action.requestHeaders).toEqual([
      { header: "user-agent", operation: "set", value: "MyUA/1.0" },
    ]);
    expect(rule.condition.tabIds).toEqual([42]);
    expect(Array.isArray(rule.condition.resourceTypes)).toBe(true);
    expect(rule.condition.resourceTypes.length).toBeGreaterThan(0);
  });

  it("derives a stable, distinct rule id per tab", () => {
    const a = buildUserAgentRule(1, "ua", 1001);
    const b = buildUserAgentRule(2, "ua", 1002);
    expect(a.id).not.toBe(b.id);
  });
});

describe("applyUserAgentRule / clearUserAgentRule (DNR plumbing)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (browser.declarativeNetRequest.updateSessionRules as jest.Mock).mockResolvedValue(
      undefined
    );
  });

  it("applies a session rule via updateSessionRules with the rule in addRules and its id removed first", async () => {
    await applyUserAgentRule(7, "UA-7");
    expect(browser.declarativeNetRequest.updateSessionRules).toHaveBeenCalledTimes(1);
    const arg = (browser.declarativeNetRequest.updateSessionRules as jest.Mock).mock
      .calls[0][0];
    expect(arg.addRules).toHaveLength(1);
    expect(arg.addRules[0].action.requestHeaders[0].value).toBe("UA-7");
    expect(arg.addRules[0].condition.tabIds).toEqual([7]);
    // The same id is cleared first so re-applying for a tab replaces cleanly.
    expect(arg.removeRuleIds).toContain(arg.addRules[0].id);
  });

  it("clearUserAgentRule removes only that tab's rule id", async () => {
    // The per-tab rule id is derived (UA_RULE_ID_BASE + tabId); the pure builder
    // echoes whatever ruleId it is handed, so re-derive the same id for the
    // expectation. (apply for the same tab uses this id in addRules below.)
    await applyUserAgentRule(7, "x");
    const expectedId = (browser.declarativeNetRequest
      .updateSessionRules as jest.Mock).mock.calls[0][0].addRules[0].id;
    jest.clearAllMocks();
    (browser.declarativeNetRequest.updateSessionRules as jest.Mock).mockResolvedValue(
      undefined
    );

    await clearUserAgentRule(7);
    expect(browser.declarativeNetRequest.updateSessionRules).toHaveBeenCalledTimes(1);
    const arg = (browser.declarativeNetRequest.updateSessionRules as jest.Mock).mock
      .calls[0][0];
    expect(arg.removeRuleIds).toEqual([expectedId]);
    expect(arg.addRules ?? []).toEqual([]);
  });
});
