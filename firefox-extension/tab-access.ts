/**
 * Firefox side of "why will this tab not let FoxPilot in".
 *
 * The decisions (classify the URL, order the causes, word the message) live in
 * common/tab-access.ts and are shared with Chrome; this file only binds them to
 * the Firefox APIs. Every function here NEVER throws and never waits longer than
 * the shared diagnosis budget: a failing or hanging browser call means "cause
 * unknown", which the shared code reports honestly instead of guessing.
 *
 * Mirrors chrome-extension/tab-access.ts (the `browser` global is the same name
 * in both builds; only the browser id and the own-origin rule differ).
 *
 * The Firefox error strings this relies on are NOT verified against a live
 * Firefox (the probe in test-fixtures/browser-probe drives Chromium): the
 * matching in common/tab-access.ts is deliberately defensive, and a refusal it
 * does not recognise passes through unchanged.
 */
import {
  diagnoseTabAccess,
  gateTabUrl,
  type TabAccessProbe,
  type TabInfoForAccess,
} from "@foxpilot/common";

const BROWSER = "firefox" as const;

/** `moz-extension://<uuid>` of this extension, or undefined when it cannot be read. */
export function ownExtensionOrigin(): string | undefined {
  try {
    const url = browser.runtime.getURL("");
    if (typeof url !== "string") {
      return undefined;
    }
    const m = /^(moz-extension:\/\/[^/?#]+)/i.exec(url);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** The Firefox calls diagnosis reads. Each may reject; the shared code absorbs that. */
export const firefoxTabAccessProbe: TabAccessProbe = {
  getTab: (tabId: number) =>
    browser.tabs.get(tabId) as unknown as Promise<TabInfoForAccess | undefined>,
  containsOrigin: (origin: string) =>
    browser.permissions.contains({ origins: [`${origin}/*`] }),
  containsFileAccess: () => browser.permissions.contains({ origins: ["file:///*"] }),
};

/**
 * The tagged message for a tab URL no grant can fix (restricted page, blank
 * page, a file: tab without file access), else null. Makes no permission call for
 * an opaque origin.
 */
export function gateFirefoxTabUrl(
  url: string | undefined,
  tabId?: number
): Promise<string | null> {
  return gateTabUrl(url, BROWSER, firefoxTabAccessProbe, {
    tabId,
    selfOrigin: ownExtensionOrigin(),
  }).catch(() => null);
}

/**
 * Turns a browser page-access refusal into the message that names the real
 * cause, from the live tab state. Never throws: when the state cannot be read the
 * result is the browser's own message, redacted, plus a note.
 */
export function diagnoseFirefoxTabAccess(
  tabId: number,
  rawMessage: string,
  activateTabRequested?: boolean
): Promise<string> {
  return diagnoseTabAccess(
    {
      browser: BROWSER,
      tabId,
      rawMessage,
      activateTabRequested,
      selfOrigin: ownExtensionOrigin(),
    },
    firefoxTabAccessProbe
  );
}
