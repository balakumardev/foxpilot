/**
 * Pure helpers behind get-list-of-open-tabs, shared by the MCP server and both
 * extensions so there is one definition of "what a tab URL looks like when it
 * leaves the browser" and of "which tabs match a text filter".
 *
 * Plain functions only (no DOM, no browser APIs, no imports of runtime code):
 * esbuild bundles this into the server and both extension builds, and jest maps
 * `@foxpilot/common` to this directory in all three packages.
 */

import type { BrowserTab } from "./extension-messages";

/** What replaces a removed part of a URL, so a reader knows something was cut. */
export const REDACTED_MARK = "[redacted]";

/** Network schemes whose host and path are kept (query, fragment, userinfo are not). */
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:"]);

/** Schemes whose whole body is payload (inline data, script, blob handles). */
const PAYLOAD_SCHEMES = new Set(["data:", "javascript:", "blob:", "vbscript:"]);

/** Longest path kept for non-network schemes (file:, chrome:, about:...). */
const MAX_SAFE_PATH = 120;

/** Longest text kept when a string is not a parsable URL at all. */
const MAX_UNPARSABLE = 200;

/** `view-source:view-source:...` must not recurse without bound. */
const MAX_VIEW_SOURCE_DEPTH = 2;

// Control characters (C0, DEL, C1) and the Unicode line/paragraph separators.
const CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * The form of a tab URL that is safe to show: scheme + host (+ port) + path for
 * http(s)/ws(s)/ftp. The query string, the fragment and any userinfo are removed
 * (an implicit-flow OAuth redirect carries `access_token` in the #fragment, and
 * login or magic-link URLs carry theirs in the query). When a query or fragment
 * was removed a marker is left in its place:
 *
 *   https://user:pw@app.example.test:8443/cb?code=x#access_token=y
 *     -> https://app.example.test:8443/cb?[redacted]#[redacted]
 *
 * Non-network URLs never leak their payload: data:, javascript:, blob: and
 * vbscript: become `data:[redacted]` etc.; chrome://, about:, file:// and
 * extension pages keep their (truncated) path; any other scheme is reduced to
 * `scheme:[redacted]`. A string that is not a URL is cut at its first `?` or
 * `#` and truncated. The function is idempotent, which lets an extension
 * redact before it sends and the server redact again without changing the text.
 *
 * Path segments and matrix parameters are NOT redacted: a secret that lives in
 * the path itself (`/reset/<token>`) still shows. That is the documented limit.
 */
export function redactTabUrl(raw: string): string {
  return redactInner(raw, 0);
}

function redactInner(raw: string, depth: number): string {
  // Check the head first so a multi-megabyte data: URL is never parsed or copied.
  const head = raw.slice(0, 64).replace(CONTROL_CHARS, "").trimStart();
  const headScheme = /^([a-z][a-z0-9+.\-]*):/i.exec(head);
  if (headScheme && PAYLOAD_SCHEMES.has(headScheme[1].toLowerCase() + ":")) {
    return `${headScheme[1].toLowerCase()}:${REDACTED_MARK}`;
  }

  const cleaned = raw.replace(CONTROL_CHARS, "").trim();
  let u: URL;
  try {
    u = new URL(cleaned);
  } catch {
    return redactUnparsable(cleaned);
  }

  const proto = u.protocol;
  const marks =
    (u.search ? `?${REDACTED_MARK}` : "") + (u.hash ? `#${REDACTED_MARK}` : "");

  if (PAYLOAD_SCHEMES.has(proto)) {
    return `${proto}${REDACTED_MARK}`;
  }
  if (NETWORK_SCHEMES.has(proto)) {
    return `${proto}//${u.host}${u.pathname}${marks}`;
  }
  if (proto === "view-source:") {
    if (depth >= MAX_VIEW_SOURCE_DEPTH) {
      return `${proto}${REDACTED_MARK}`;
    }
    // The inner URL (userinfo, query and all) is the rest of the string.
    return `${proto}${redactInner(cleaned.slice(proto.length), depth + 1)}`;
  }

  const hasAuthority = /^[a-z][a-z0-9+.\-]*:\/\//i.test(cleaned);
  if (proto === "about:" || hasAuthority) {
    const path =
      u.pathname.length > MAX_SAFE_PATH
        ? `${u.pathname.slice(0, MAX_SAFE_PATH)}...`
        : u.pathname;
    return `${proto}${hasAuthority ? `//${u.host}` : ""}${path}${marks}`;
  }
  return `${proto}${REDACTED_MARK}`;
}

/** Fallback for a string `new URL` rejects: cut at the first ? or #, drop userinfo. */
function redactUnparsable(text: string): string {
  const withoutUserinfo = text.replace(
    /^([a-z][a-z0-9+.\-]*:\/\/)[^/?#]*@/i,
    "$1"
  );
  const q = withoutUserinfo.indexOf("?");
  const h = withoutUserinfo.indexOf("#");
  const cut = q >= 0 && (h < 0 || q < h) ? q : h;
  const headText = cut >= 0 ? withoutUserinfo.slice(0, cut) : withoutUserinfo;
  const marks =
    (q >= 0 && (h < 0 || q < h) ? `?${REDACTED_MARK}` : "") +
    (h >= 0 ? `#${REDACTED_MARK}` : "");
  const kept =
    headText.length > MAX_UNPARSABLE
      ? `${headText.slice(0, MAX_UNPARSABLE)}...`
      : headText;
  return `${kept}${marks}`;
}

/** Collapse control characters and newlines so one tab is one line of text. */
export function singleLine(text: string): string {
  return text.replace(CONTROL_RUN, " ").trim();
}

/** The text filters get-list-of-open-tabs understands (case-insensitive substring, AND). */
export interface TabTextFilter {
  urlContains?: string;
  titleContains?: string;
}

/** A tab as the browsers report it: only the fields this module reads. */
export interface TabLike {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
  lastAccessed?: number;
  /** Firefox only; Chrome tabs have none. */
  cookieStoreId?: string;
}

/** Firefox's cookie store for tabs outside any container. */
const DEFAULT_COOKIE_STORE_ID = "firefox-default";

/**
 * The cookieStoreId values open-browser-tab accepts: Firefox's default store,
 * its private store, or a container ("firefox-container-N").
 */
export const COOKIE_STORE_ID_PATTERN = /^firefox-(default|private|container-\d+)$/;

/** Builds a predicate over (url as shown, title). Empty needles are no filter. */
function textMatcher(
  filter: TabTextFilter
): (url: string | undefined, title: string | undefined) => boolean {
  const urlNeedle = filter.urlContains ? filter.urlContains.toLowerCase() : "";
  const titleNeedle = filter.titleContains
    ? filter.titleContains.toLowerCase()
    : "";
  return (url, title) =>
    (urlNeedle === "" || (url ?? "").toLowerCase().includes(urlNeedle)) &&
    (titleNeedle === "" || (title ?? "").toLowerCase().includes(titleNeedle));
}

/**
 * Extension side: keep the tabs that match the text filter and reduce each to
 * the fields the server reads. With `redactUrls` the URL is replaced by its
 * redacted form (so tokens never leave the browser) and `urlContains` is
 * matched against that form; without it both use the raw URL. Matching on the
 * redacted form is what stops `urlContains` working as an oracle on the
 * values of a query string or fragment.
 */
export function selectTabs(
  tabs: readonly TabLike[],
  options: TabTextFilter & { redactUrls?: boolean }
): BrowserTab[] {
  const matches = textMatcher(options);
  const out: BrowserTab[] = [];
  for (const tab of tabs) {
    const url =
      tab.url !== undefined && options.redactUrls
        ? redactTabUrl(tab.url)
        : tab.url;
    if (!matches(url, tab.title)) {
      continue;
    }
    out.push({
      id: tab.id,
      windowId: tab.windowId,
      url,
      title: tab.title,
      lastAccessed: tab.lastAccessed,
      // Only a container (or private) tab carries it, so the reply stays as
      // small as before for everyone else.
      ...(tab.cookieStoreId !== undefined &&
      tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID
        ? { cookieStoreId: tab.cookieStoreId }
        : {}),
    });
  }
  return out;
}

/**
 * Server side: re-apply the filters the server can verify from the reply alone
 * (windowId and the two text filters), so an extension that predates them and
 * returned every tab still produces a correct list. Returns the original tab
 * objects. `redactUrls` selects which URL form `urlContains` is matched against.
 */
export function filterTabsByText(
  tabs: readonly BrowserTab[],
  options: TabTextFilter & { windowId?: number; redactUrls?: boolean }
): BrowserTab[] {
  const matches = textMatcher(options);
  return tabs.filter((tab) => {
    // A tab without a numeric windowId (a very old extension) cannot be
    // verified, so it is kept rather than dropping the whole list.
    if (
      options.windowId !== undefined &&
      typeof tab.windowId === "number" &&
      tab.windowId !== options.windowId
    ) {
      return false;
    }
    const url =
      tab.url !== undefined && options.redactUrls
        ? redactTabUrl(tab.url)
        : tab.url;
    return matches(url, tab.title);
  });
}
