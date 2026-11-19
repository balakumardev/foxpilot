/**
 * browser-fetch with a `tabId` (Firefox MV2 background page side).
 *
 * The request itself runs in the tab's page context, in the extension's
 * content-script sandbox, through tabs.executeScript with a code string
 * (injected/fetch-in-tab-script.ts) — no page-world <script>, so the page's CSP
 * `connect-src` and a monkey-patched page `fetch` are not involved. In that
 * sandbox the injected function uses `content.fetch` (the page-principal fetch):
 * a plain content-script fetch carries the EXTENSION principal. That function
 * does not sleep and sets no timers, so the timeout is raced HERE against a
 * background-page timer, and on expiry the request is aborted in the page.
 *
 * Mirrors chrome-extension/tab-fetch.ts: the gating helpers and the timeout
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
 * (about:, file:, a moz-extension: page, no readable URL) — checked BEFORE any
 * `new URL(url).origin` permission lookup, which yields the opaque origin
 * "null" for such pages — and for a URL that cannot be
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
        `(about:, file: and extension pages are off limits). ` +
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
    const results = await browser.tabs.executeScript(tabId, {
      code: `(${fetchInTab.toString()})(${JSON.stringify(args)})`,
    });
    const first = results && results[0];
    if (first === undefined || first === null) {
      return {
        ok: false,
        error:
          "The page returned no result: the tab navigated or the frame was removed while the request was running. " +
          "The request may or may not have reached the server.",
      };
    }
    return first as FetchInTabResult;
  } catch (e) {
    return {
      ok: false,
      error: `Could not run the fetch inside tab ${tabId}: ${redactAccessMessage(messageOf(e))}`,
    };
  }
}

async function injectAbort(tabId: number, requestId: string): Promise<void> {
  try {
    await browser.tabs.executeScript(tabId, {
      code: `(${abortFetchInTab.toString()})(${JSON.stringify(requestId)})`,
    });
  } catch {
    /* tab gone or navigated: nothing left to abort */
  }
}

/**
 * Runs the fetch inside `tabId` and resolves with its result. Never rejects.
 * `args.url` must already be absolute and gated; `args.expectOrigin` is the
 * origin that was gated. The timeout is a background-page timer that is always
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
