/**
 * browser-fetch with a `tabId` (Chrome MV3 service worker side).
 *
 * The request itself runs in the tab's page context, in the extension's ISOLATED
 * content-script world, through scripting.executeScript (injected/fetch-in-tab-
 * script.ts) — never the MAIN world, so the page's CSP `connect-src` and a
 * monkey-patched page `fetch` are not involved. That function does not sleep and
 * sets no timers (a hidden tab clamps page timers to one tick per second), so
 * the timeout is raced HERE against a service-worker timer, and on expiry the
 * request is aborted in the page.
 *
 * Mirrors firefox-extension/tab-fetch.ts: the gating helpers and the timeout
 * race are the same; only the injection call differs.
 */
import { redactAccessMessage } from "@foxpilot/common";
import {
  abortFetchInTab,
  fetchInTab,
  type FetchInTabArgs,
  type FetchInTabResult,
} from "./injected/fetch-in-tab-script";

// Same default as the background path (browser-http.ts DEFAULT_FETCH_TIMEOUT_MS).
export const TAB_FETCH_DEFAULT_TIMEOUT_MS = 30000;
// The broker gives browser-fetch 45000 ms for the WHOLE call (mcp-server/
// timeouts.ts). Leave room for the tab lookup, the gating and the reply, so a
// slow request ends here with a clear error instead of the broker's generic
// "missing reply" timeout.
export const TAB_FETCH_MAX_TIMEOUT_MS = 40000;

export interface TabFetchTarget {
  /** scheme://host[:port] of the page the fetch will run in. */
  tabOrigin: string;
  /** Absolute URL that will be fetched (a relative URL resolved against the tab). */
  targetUrl: string;
}

/**
 * Validates that a tab can host a page-context fetch and resolves the target
 * URL against it. Throws a clear Error for a tab the extension cannot script
 * (chrome://, about:, a Web Store page, file:, an extension page, no readable
 * URL) — checked BEFORE any `new URL(url).origin` permission lookup, which
 * yields the opaque origin "null" for such pages — and for a URL that cannot be
 * resolved. Nothing else is rejected: a cross-origin target is allowed and is
 * simply subject to the page's CORS rules.
 */
export function resolveTabFetchTarget(
  tabId: number,
  tabUrl: string | undefined,
  rawUrl: string
): TabFetchTarget {
  let tab: URL | undefined;
  try {
    tab = tabUrl ? new URL(tabUrl) : undefined;
  } catch {
    tab = undefined;
  }
  if (!tab) {
    throw new Error(
      `Tab ${tabId} has no URL the extension can read, so a fetch cannot run inside it. ` +
        `Use browser-fetch without tabId, or point the tab at an http(s) page first.`
    );
  }
  if (tab.protocol !== "http:" && tab.protocol !== "https:") {
    throw new Error(
      `Tab ${tabId} is showing a ${tab.protocol} page, which extensions cannot run a fetch inside ` +
        `(browser-internal, file, extension and blank pages are off limits). ` +
        `Navigate it to an http(s) page of the site first, or use browser-fetch without tabId.`
    );
  }
  let target: URL;
  try {
    target = new URL(rawUrl, tab.href);
  } catch {
    throw new Error(
      `Invalid URL "${rawUrl}": it is neither absolute nor resolvable against the tab's URL.`
    );
  }
  return { tabOrigin: tab.origin, targetUrl: target.href };
}

let requestCounter = 0;

function messageOf(e: unknown): string {
  return String((e as { message?: unknown } | null | undefined)?.message ?? e);
}

async function injectFetch(
  tabId: number,
  args: FetchInTabArgs
): Promise<FetchInTabResult> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: fetchInTab,
      // Plain JSON: undefined-valued keys are dropped rather than left to
      // whatever the serializer does with them.
      args: [JSON.parse(JSON.stringify(args))],
    });
    const first = results && results[0];
    if (!first || first.result === undefined || first.result === null) {
      return {
        ok: false,
        error:
          "The page returned no result: the tab navigated or the frame was removed while the request was running. " +
          "The request may or may not have reached the server.",
      };
    }
    return first.result as FetchInTabResult;
  } catch (e) {
    return {
      ok: false,
      error: `Could not run the fetch inside tab ${tabId}: ${redactAccessMessage(messageOf(e))}`,
    };
  }
}

async function injectAbort(tabId: number, requestId: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: abortFetchInTab,
      args: [requestId],
    });
  } catch {
    /* tab gone or navigated: nothing left to abort */
  }
}

/**
 * Runs the fetch inside `tabId` and resolves with its result. Never rejects.
 * `args.url` must already be absolute and gated; `args.expectOrigin` is the
 * origin that was gated. The timeout is a service-worker timer that is always
 * cleared, so no timer outlives the call.
 */
export async function runFetchInTab(
  tabId: number,
  args: Omit<FetchInTabArgs, "requestId">,
  timeoutMs?: number
): Promise<FetchInTabResult> {
  const requestId = `ft-${Date.now().toString(36)}-${++requestCounter}`;
  const budget = Math.min(
    Math.max(timeoutMs ?? TAB_FETCH_DEFAULT_TIMEOUT_MS, 1),
    TAB_FETCH_MAX_TIMEOUT_MS
  );

  const TIMED_OUT = Symbol("timed-out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), budget);
  });

  let outcome: FetchInTabResult | typeof TIMED_OUT;
  try {
    outcome = await Promise.race([
      injectFetch(tabId, { ...args, requestId }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  if (outcome === TIMED_OUT) {
    // Best effort and not awaited: the reply must not wait on a stuck page.
    void injectAbort(tabId, requestId);
    return {
      ok: false,
      error:
        `Timed out after ${budget} ms waiting for the response inside tab ${tabId}. ` +
        `The page was asked to abort the request, but the server may already have received it: ` +
        `check the result before sending it again.`,
    };
  }
  return outcome;
}
