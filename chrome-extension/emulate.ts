/**
 * Background-side device/UA emulation support for Chrome MV3.
 *
 * In Chrome MV3 service workers, blocking webRequest is not available,
 * so we cannot rewrite the User-Agent request header on the wire.
 * The page-world navigator.userAgent shim (injected by the message handler)
 * still works and changes what the PAGE reads, but the server-visible
 * User-Agent header remains unchanged.
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

// Legacy stub for backward compatibility with tests. In Chrome MV3, blocking
// webRequest is not available, so header rewriting is not possible.
export function rewriteUserAgentHeader(
  _details: any,
  _map: Map<number, string>
): any {
  return undefined;
}

export function initEmulate(): void {
  try {
    browser.tabs.onRemoved.addListener((tabId: number) => {
      clearTabUserAgent(tabId);
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
