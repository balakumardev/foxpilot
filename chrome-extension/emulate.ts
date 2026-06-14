/**
 * Background-side device/UA emulation support for Chrome MV3.
 *
 * Blocking webRequest is unavailable in MV3 service workers, so we rewrite the
 * wire User-Agent request header via declarativeNetRequest session rules
 * instead (one modifyHeaders rule per tab; see buildUserAgentRule /
 * applyUserAgentRule below). This makes the server-visible User-Agent header
 * match the emulated value. The page-world navigator.userAgent shim (injected
 * by the message handler) covers what the PAGE reads in JS, so the two stay
 * consistent.
 *
 * We keep the per-tab UA map for reference and the tab removal cleanup.
 */

import { isAutomationModeEnabled } from "./extension-config";

const userAgents = new Map<number, string>();

export function setTabUserAgent(tabId: number, userAgent: string): void {
  userAgents.set(tabId, userAgent);
}

export function clearTabUserAgent(tabId: number): void {
  userAgents.delete(tabId);
}

export function getTabUserAgent(tabId: number): string | undefined {
  return userAgents.get(tabId);
}

export function clearAllUserAgents(): void {
  userAgents.clear();
}

export function __getUserAgentMap(): Map<number, string> {
  return userAgents;
}

// Base id for per-tab User-Agent DNR session rules. The rule id for a tab is
// UA_RULE_ID_BASE + tabId, giving a stable, distinct, replaceable id per tab.
const UA_RULE_ID_BASE = 100000;

// Resource types whose request User-Agent header we rewrite. Covers the page
// load and its subresources/XHR so the wire UA is consistent.
const UA_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "script",
  "image",
  "stylesheet",
  "font",
  "media",
  "websocket",
  "other",
];

function uaRuleId(tabId: number): number {
  return UA_RULE_ID_BASE + tabId;
}

/**
 * Pure builder for a declarativeNetRequest session rule that sets the
 * User-Agent request header for one tab. No chrome.* access — unit-testable.
 */
export function buildUserAgentRule(
  tabId: number,
  userAgent: string,
  ruleId: number
): {
  id: number;
  priority: number;
  action: {
    type: "modifyHeaders";
    requestHeaders: { header: string; operation: "set"; value: string }[];
  };
  condition: { tabIds: number[]; resourceTypes: string[] };
} {
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "user-agent", operation: "set", value: userAgent },
      ],
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: UA_RESOURCE_TYPES,
    },
  };
}

/**
 * Installs (or replaces) the per-tab User-Agent session rule on the wire. The
 * tab's existing rule id is removed first so re-applying replaces cleanly.
 */
export async function applyUserAgentRule(
  tabId: number,
  userAgent: string
): Promise<void> {
  const id = uaRuleId(tabId);
  setTabUserAgent(tabId, userAgent);
  await (browser as any).declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [buildUserAgentRule(tabId, userAgent, id)],
  });
}

/**
 * Removes the per-tab User-Agent session rule (on emulate-clear / tab close).
 */
export async function clearUserAgentRule(tabId: number): Promise<void> {
  const id = uaRuleId(tabId);
  clearTabUserAgent(tabId);
  await (browser as any).declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
  });
}

export function initEmulate(): void {
  try {
    browser.tabs.onRemoved.addListener((tabId: number) => {
      void clearUserAgentRule(tabId);
    });

    browser.storage.onChanged.addListener(
      (
        changes: { [key: string]: { oldValue?: unknown; newValue?: unknown } },
        areaName: string
      ) => {
        if (areaName !== "local" || !changes.config) {
          return;
        }
        const newConfig = changes.config.newValue as
          | { automationMode?: boolean }
          | undefined;
        const enabled = newConfig?.automationMode === true;
        if (!enabled) {
          clearAllUserAgents();
        }
      }
    );
  } catch (error) {
    console.error("emulate: initEmulate failed:", error);
  }
}
