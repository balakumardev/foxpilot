/**
 * Background-side device/UA emulation support for the `emulate` tool.
 *
 * The page-world part of `emulate` (navigator.geolocation + navigator.userAgent
 * shims) is injected by the message handler via the page-world helper. But
 * overriding `navigator.userAgent` in the page only changes what the PAGE reads
 * — the `User-Agent` request header the SERVER receives is set by the browser
 * engine and is unaffected. To make the server-visible UA change too, we rewrite
 * the `User-Agent` request header on outgoing requests for tabs that have a UA
 * override, using a blocking `webRequest.onBeforeSendHeaders` listener.
 *
 * Only the userAgent override touches the network. Geolocation is purely a
 * page-world JS shim and needs nothing here.
 *
 * Known caveats (documented for callers):
 *   - Only requests made AFTER an override is set are rewritten, and the
 *     blocking listener requires the `webRequestBlocking` permission.
 *   - The override is per-tab and lives in memory; it is cleared when the tab is
 *     removed (and replaced if `emulate` is called again for the tab).
 *   - The live header rewrite is browser-only. The pure `rewriteUserAgentHeader`
 *     function below is what the unit tests drive with synthetic details.
 */

import type { NetworkHeader } from "@foxpilot/common";
import { isAutomationModeEnabled } from "./extension-config";

// Per-tab User-Agent override. Keyed by tabId. A tab present here has its
// outgoing requests' User-Agent header replaced by the mapped value.
const userAgents = new Map<number, string>();

/**
 * Set (or replace) the User-Agent override for a tab. Registering an override
 * lazily ensures the webRequest listener is active so the override takes effect
 * on the wire.
 */
export function setTabUserAgent(tabId: number, userAgent: string): void {
  userAgents.set(tabId, userAgent);
  // Make sure the blocking header-rewrite listener is registered now that at
  // least one override exists. Idempotent.
  void registerHeaderListener();
}

/**
 * Clear a tab's User-Agent override (called on tab removal, or to stop
 * emulating). Idempotent.
 */
export function clearTabUserAgent(tabId: number): void {
  userAgents.delete(tabId);
}

/**
 * Read a tab's current User-Agent override, or undefined if none.
 */
export function getTabUserAgent(tabId: number): string | undefined {
  return userAgents.get(tabId);
}

/**
 * Drop ALL per-tab User-Agent overrides. Called when Automation Mode turns off:
 * the header-rewrite listener is removed at the same time, so the overrides are
 * inert anyway, but clearing them ensures a later re-enable does not resurrect
 * stale prior-session UA spoofing for tabs that were emulated before.
 */
export function clearAllUserAgents(): void {
  userAgents.clear();
}

// Test-only accessor for the live module map, so tests can prove that
// setTabUserAgent/clearTabUserAgent drive the same map the rewriter consults.
export function __getUserAgentMap(): Map<number, string> {
  return userAgents;
}

// The subset of onBeforeSendHeaders `details` we read. Kept permissive so
// synthetic test objects and real events both fit.
interface BeforeSendHeadersDetails {
  tabId?: number;
  requestHeaders?: NetworkHeader[];
}

/**
 * PURE rewriter for a blocking `onBeforeSendHeaders` listener.
 *
 * If `details.tabId` is in `map`, returns `{ requestHeaders }` with the
 * `User-Agent` header replaced by the mapped value (case-insensitive match), or
 * a new `User-Agent` header appended if none was present. Returns `undefined`
 * (i.e. "no change") when the tab has no override, so the browser sends the
 * request unmodified.
 *
 * Does not mutate the input array; it builds a fresh header list.
 */
export function rewriteUserAgentHeader(
  details: BeforeSendHeadersDetails,
  map: Map<number, string>
): { requestHeaders: NetworkHeader[] } | undefined {
  const tabId = details.tabId;
  if (typeof tabId !== "number") {
    return undefined;
  }
  const ua = map.get(tabId);
  if (ua === undefined) {
    return undefined;
  }

  const original = details.requestHeaders ?? [];
  const headers: NetworkHeader[] = [];
  let replaced = false;
  for (const h of original) {
    if (h.name && h.name.toLowerCase() === "user-agent") {
      headers.push({ name: h.name, value: ua });
      replaced = true;
    } else {
      headers.push(h);
    }
  }
  if (!replaced) {
    headers.push({ name: "User-Agent", value: ua });
  }
  return { requestHeaders: headers };
}

// ---- webRequest listener registration ----

// The listener reference, kept so it could be removed. `null` means not
// registered. Registration is idempotent.
let headerListener: ((d: any) => any) | null = null;

/**
 * Register the blocking onBeforeSendHeaders listener for all URLs. Idempotent:
 * a no-op if already registered. Wrapped in try/catch because it needs the
 * `webRequest`/`webRequestBlocking` permissions; on failure we log and ignore so
 * the rest of the extension keeps working.
 */
export async function registerHeaderListener(): Promise<void> {
  if (headerListener) {
    return;
  }
  try {
    const listener = (details: any): any => {
      return rewriteUserAgentHeader(details, userAgents);
    };
    browser.webRequest.onBeforeSendHeaders.addListener(
      listener,
      { urls: ["<all_urls>"] },
      ["blocking", "requestHeaders"]
    );
    headerListener = listener;
  } catch (error) {
    console.error(
      "emulate: failed to register onBeforeSendHeaders listener:",
      error
    );
  }
}

/**
 * Remove the onBeforeSendHeaders listener if registered. Idempotent.
 */
export async function unregisterHeaderListener(): Promise<void> {
  const l = headerListener;
  headerListener = null;
  if (!l) {
    return;
  }
  try {
    browser.webRequest.onBeforeSendHeaders.removeListener(l);
  } catch (error) {
    console.error(
      "emulate: failed to unregister onBeforeSendHeaders listener:",
      error
    );
  }
}

/**
 * Initialize background UA emulation. Call ONCE from background.ts after the
 * config is loaded. Importing this module must NOT trigger any browser API call
 * (so tests can import the pure rewriter and the map helpers freely) — all
 * listener registration happens here or lazily on the first setTabUserAgent.
 *
 * Like network-capture, the header listener is gated on Automation Mode: it is
 * registered when Automation Mode is on (and on the first override) and removed
 * when Automation Mode turns off.
 */
export function initEmulate(): void {
  try {
    // 1) Drop a tab's UA override when the tab goes away.
    browser.tabs.onRemoved.addListener((tabId: number) => {
      clearTabUserAgent(tabId);
    });

    // 2) Register/unregister the header listener as Automation Mode flips.
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
        if (enabled) {
          void registerHeaderListener();
        } else {
          void unregisterHeaderListener();
          // Drop every per-tab UA override too, so a later re-enable does not
          // resurrect stale prior-session spoofing.
          clearAllUserAgents();
        }
      }
    );

    // 3) If Automation Mode is already on at startup, register immediately.
    void isAutomationModeEnabled().then((enabled) => {
      if (enabled) {
        void registerHeaderListener();
      }
    });
  } catch (error) {
    console.error("emulate: initEmulate failed:", error);
  }
}
