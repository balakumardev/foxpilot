/**
 * Chrome side of "why will this tab not let FoxPilot in".
 *
 * The decisions (classify the URL, order the causes, word the message) live in
 * common/tab-access.ts and are shared with Firefox; this file only binds them to
 * the Chrome APIs. Every function here NEVER throws and never waits longer than
 * the shared diagnosis budget: a failing or hanging browser call means "cause
 * unknown", which the shared code reports honestly instead of guessing.
 *
 * Mirrors firefox-extension/tab-access.ts (the `browser` global is the same
 * name in both builds; only the browser id and the own-origin rule differ).
 */
import {
  diagnoseTabAccess,
  gateTabUrl,
  type TabAccessProbe,
  type TabInfoForAccess,
} from "@foxpilot/common";

const BROWSER = "chrome" as const;

/** The Chrome calls diagnosis reads. Each may reject; the shared code absorbs that. */
export const chromeTabAccessProbe: TabAccessProbe = {
  getTab: (tabId: number) =>
    browser.tabs.get(tabId) as unknown as Promise<TabInfoForAccess | undefined>,
  containsOrigin: (origin: string) =>
    browser.permissions.contains({ origins: [`${origin}/*`] }),
  containsFileAccess: () => browser.permissions.contains({ origins: ["file:///*"] }),
};

/**
 * The tagged message for a tab URL no grant can fix (restricted page, blank
 * page, a file: tab while "Allow access to file URLs" is off), else null. Makes
 * no permission call for an opaque origin, which Chrome rejects with
 * "Invalid value for origin pattern null/*".
 */
export function gateChromeTabUrl(
  url: string | undefined,
  tabId?: number
): Promise<string | null> {
  return gateTabUrl(url, BROWSER, chromeTabAccessProbe, { tabId }).catch(() => null);
}

/**
 * Turns a browser page-access refusal into the message that names the real
 * cause, from the live tab state. Never throws: when the state cannot be read the
 * result is the browser's own message, redacted, plus a note.
 */
export function diagnoseChromeTabAccess(
  tabId: number,
  rawMessage: string,
  activateTabRequested?: boolean
): Promise<string> {
  return diagnoseTabAccess(
    { browser: BROWSER, tabId, rawMessage, activateTabRequested },
    chromeTabAccessProbe
  );
}
