/**
 * Why a browser tab will not let FoxPilot in, and how to say so.
 *
 * The browsers answer every refusal with a few vague strings, and the vaguest
 * one blames the wrong thing. Observed in Chromium 140 (test-fixtures/
 * browser-probe/OBSERVED.json, cases 1 and 5):
 *
 *   S1  Cannot access contents of url "<full tab URL>". Extension manifest must
 *       request permission to access this host.
 *         host not granted, about:blank, data:, view-source:, an extension's own
 *         pages, file: URLs while "Allow access to file URLs" is off. It embeds
 *         the WHOLE tab URL (query string, data: payload), so it must be redacted.
 *   S2  Cannot access contents of the page. Extension manifest must request
 *       permission to access the respective host.
 *         what a DISCARDED tab produces, granted host or not. The tab's page is
 *         gone; reloading it (tabs.reload, or tabs.update {active:true}) brings it
 *         back in ~150 ms and loses nothing.
 *   Cannot access a chrome:// URL
 *   Cannot access a chrome-extension:// URL of different extension
 *   Frame with ID 0 is showing error page   (connection refused, offline, ...)
 *
 * This module turns the real state of the tab into one tagged message that names
 * the cause, the exact place to fix it and the right recovery. It is plain
 * functions only (no DOM, no browser APIs): esbuild bundles it into the server
 * and both extensions, jest maps `@foxpilot/common` to this directory, and the
 * browser calls it needs are injected through {@link TabAccessProbe}.
 *
 * No message built here ever contains a full URL: only a scheme, an origin, or
 * a redactTabUrl form.
 */

import { redactTabUrl } from "./tab-list";

export type TabBrowser = "chrome" | "firefox";

/**
 * What a tab URL means for scripting it:
 *  - web        an http(s)/ftp page (or a blob: page, which has its inner origin)
 *  - blank      about:blank (nothing in it, and still never scriptable)
 *  - restricted a page no extension can script and no grant can change
 *  - file       a file: URL (scriptable only with "Allow access to file URLs")
 *  - none       no URL at all (a tab that is still opening reports url "")
 */
export type TabUrlKind = "web" | "blank" | "restricted" | "file" | "none";

/**
 * Every message built here starts with exactly one of these, so callers and
 * tests can match the cause without parsing prose.
 */
export const TAB_ACCESS_TAGS = {
  restricted: "TAB NOT SCRIPTABLE (restricted page):",
  file: "TAB NOT SCRIPTABLE (file: URL):",
  discarded: "TAB DISCARDED:",
  loading: "TAB STILL LOADING:",
  errorPage: "TAB SHOWS A BROWSER ERROR PAGE:",
  notGranted: "SITE ACCESS NOT GRANTED:",
  refused: "TAB REFUSED ACCESS DESPITE GRANT:",
} as const;

export type TabAccessCause = keyof typeof TAB_ACCESS_TAGS;

/** Whether `message` is one of FoxPilot's own tagged diagnoses. */
export function isTabAccessMessage(message: unknown): boolean {
  return (
    typeof message === "string" &&
    Object.values(TAB_ACCESS_TAGS).some((tag) => message.includes(tag))
  );
}

/** How long the whole diagnosis may take (every browser call shares this budget). */
export const DIAGNOSIS_BUDGET_MS = 1500;

/** What stands in for the browser's error when FoxPilot refused before asking it. */
export const NO_BROWSER_ERROR_TEXT =
  "none (FoxPilot checked this before running the command, so the browser was never asked)";

/* ------------------------------------------------------------------------- *
 * URL classification
 * ------------------------------------------------------------------------- */

export interface ClassifyOptions {
  /** Selects browser-specific rules (the Chrome Web Store). Default "chrome". */
  browser?: TabBrowser;
  /**
   * The extension's own origin (Firefox: `moz-extension://<uuid>`). A page on it
   * is classified "web" so the caller's existing flow decides; every other
   * extension's page is restricted.
   */
  selfOrigin?: string;
}

const SCHEME = /^([a-z][a-z0-9+.\-]*):/i;

function schemeOf(url: string): string | undefined {
  const m = SCHEME.exec(url);
  return m ? `${m[1].toLowerCase()}:` : undefined;
}

function isChromeWebStore(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  if (host === "chromewebstore.google.com") {
    return true;
  }
  return (
    host === "chrome.google.com" &&
    (u.pathname === "/webstore" || u.pathname.startsWith("/webstore/"))
  );
}

function isOwnExtensionPage(text: string, selfOrigin: string | undefined): boolean {
  if (!selfOrigin) {
    return false;
  }
  const own = selfOrigin.replace(/\/+$/, "").toLowerCase();
  const lower = text.toLowerCase();
  return lower === own || lower.startsWith(`${own}/`);
}

/** Classifies a tab URL. Never throws. Unknown schemes are restricted. */
export function classifyTabUrl(
  url: string | null | undefined,
  options: ClassifyOptions = {}
): TabUrlKind {
  return classifyInner(url, options, 0);
}

function classifyInner(
  url: unknown,
  options: ClassifyOptions,
  depth: number
): TabUrlKind {
  if (typeof url !== "string") {
    return "none";
  }
  const text = url.trim();
  if (text === "") {
    return "none";
  }
  const scheme = schemeOf(text);
  if (!scheme) {
    return "none";
  }
  switch (scheme) {
    case "http:":
    case "https:":
    case "ftp:": {
      let parsed: URL;
      try {
        parsed = new URL(text);
      } catch {
        return "none";
      }
      if ((options.browser ?? "chrome") === "chrome" && isChromeWebStore(parsed)) {
        return "restricted";
      }
      return "web";
    }
    case "file:":
      return "file";
    case "blob:": {
      // A blob: page has the origin that created it, so its inner URL decides.
      if (depth >= 2) {
        return "restricted";
      }
      const inner = classifyInner(text.slice("blob:".length), options, depth + 1);
      return inner === "web" || inner === "file" ? inner : "restricted";
    }
    case "about:":
      return /^about:blank(?:[?#].*)?$/i.test(text) ? "blank" : "restricted";
    case "moz-extension:":
      return isOwnExtensionPage(text, options.selfOrigin) ? "web" : "restricted";
    default:
      // chrome:, chrome-extension:, chrome-untrusted:, chrome-search:,
      // chrome-error:, devtools:, edge:, brave:, view-source:, data:,
      // filesystem:, javascript:, and any scheme nobody has heard of.
      return "restricted";
  }
}

/**
 * The origin (scheme://host[:port], nothing else) a web tab URL belongs to, or
 * undefined when it has none (blank, restricted, file, unparsable). A blob: URL
 * has the origin of its inner URL.
 */
export function originOfTabUrl(url: string | null | undefined): string | undefined {
  return originInner(url, 0);
}

function originInner(url: unknown, depth: number): string | undefined {
  if (typeof url !== "string") {
    return undefined;
  }
  const text = url.trim();
  const scheme = schemeOf(text);
  if (!scheme) {
    return undefined;
  }
  if (scheme === "blob:") {
    return depth >= 2 ? undefined : originInner(text.slice("blob:".length), depth + 1);
  }
  if (scheme === "http:" || scheme === "https:" || scheme === "ftp:") {
    try {
      const origin = new URL(text).origin;
      return origin === "null" ? undefined : origin;
    } catch {
      return undefined;
    }
  }
  if (scheme === "moz-extension:") {
    const m = /^(moz-extension:\/\/[^/?#]+)/i.exec(text);
    return m ? m[1] : undefined;
  }
  return undefined;
}

/** Sites Firefox never lets an extension script (its default restrictedDomains list). */
const FIREFOX_RESTRICTED_HOSTS = new Set([
  "accounts-static.cdn.mozilla.net",
  "accounts.firefox.com",
  "addons.cdn.mozilla.net",
  "addons.mozilla.org",
  "api.accounts.firefox.com",
  "content.cdn.mozilla.net",
  "discovery.addons.mozilla.org",
  "install.mozilla.org",
  "oauth.accounts.firefox.com",
  "profile.accounts.firefox.com",
  "support.mozilla.org",
  "sync.services.mozilla.com",
]);

/**
 * Whether a web URL is on one of Firefox's restricted domains. Used only AFTER
 * the browser has refused (the list is a user-editable preference, so it must
 * not block a call that might still work).
 */
export function isFirefoxRestrictedHost(url: string | null | undefined): boolean {
  const origin = originOfTabUrl(url);
  if (!origin) {
    return false;
  }
  try {
    return FIREFOX_RESTRICTED_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** A short noun phrase for a restricted page, for the message. Scheme only, never a URL. */
export function describeRestrictedPage(
  url: string | null | undefined,
  browser: TabBrowser = "chrome"
): string {
  if (typeof url !== "string" || url.trim() === "") {
    return "a browser page";
  }
  const text = url.trim();
  const scheme = schemeOf(text);
  if (!scheme) {
    return "a browser page";
  }
  if (scheme === "about:") {
    return /^about:blank(?:[?#].*)?$/i.test(text)
      ? "a blank page (about:blank)"
      : "an about: page";
  }
  if (scheme === "chrome-extension:" || scheme === "moz-extension:") {
    return "an extension's page";
  }
  if (scheme === "view-source:") {
    return "a view-source: page (the source of a page, not the page)";
  }
  if (scheme === "http:" || scheme === "https:" || scheme === "ftp:") {
    if (browser === "chrome") {
      return "the Chrome Web Store";
    }
    if (isFirefoxRestrictedHost(text)) {
      return "a Mozilla site that Firefox keeps closed to extensions";
    }
    return "a page the browser keeps closed to extensions";
  }
  if (scheme === "blob:") {
    return "a blob: page";
  }
  return `a ${scheme} page`;
}

/* ------------------------------------------------------------------------- *
 * Raw browser errors
 * ------------------------------------------------------------------------- */

/**
 * The browser's own refusals (observed strings first, then defensive Firefox
 * ones). `Missing host permission for the tab` is matched exactly: FoxPilot's
 * own older `Missing host permission for "<origin>" after navigation` is not a
 * browser error and must not be diagnosed again.
 */
const PAGE_ACCESS_ERRORS: RegExp[] = [
  // S1 and S2.
  /Cannot access contents of (?:url\b|the page)/i,
  /Extension manifest must request permission to access/i,
  // "Cannot access a chrome:// URL", "Cannot access a chrome-extension:// URL of different extension".
  /Cannot access an? [a-z][a-z0-9+.\-]*:\/\/ URL/i,
  /showing error page/i,
  /The extensions gallery cannot be scripted/i,
  // Firefox (unverified here): the host grant is missing, or the page is privileged.
  /Missing host permission for the tab\b/i,
  /Cannot access ["']?(?:about|moz-extension|chrome|resource|view-source|data):/i,
];

/**
 * Whether `message` is a browser refusal to script a page, i.e. the kind this
 * module can diagnose. FoxPilot's own tagged messages are not.
 */
export function isPageAccessError(message: unknown): boolean {
  if (typeof message !== "string" || isTabAccessMessage(message)) {
    return false;
  }
  return PAGE_ACCESS_ERRORS.some((re) => re.test(message));
}

const MAX_RAW_MESSAGE = 400;

// S1 puts the whole tab URL in quotes; a data: URL may itself contain a quote,
// so the closing quote is the one that ends the sentence.
const QUOTED_TAB_URL = /(Cannot access contents of url )"([\s\S]*?)"(?=\. Extension manifest|\.?\s*$)/gi;
// Schemes whose payload may hold anything (view-source: nests another URL).
const OPAQUE_URL = /\b(?:about|data|view-source|javascript|vbscript|blob|filesystem):[^\s"']+/gi;
const AUTHORITY_URL =
  /\b(?:https?|wss?|ftp|file|moz-extension|chrome(?:-[a-z]+)?|edge|brave|devtools|resource):\/\/[^\s"'<>]*/gi;

function redactToken(token: string): string {
  // Sentence punctuation after a URL is not part of it.
  const m = /^([\s\S]*?)([.,;:!)]*)$/.exec(token);
  const body = m ? m[1] : token;
  const tail = m ? m[2] : "";
  return `${redactTabUrl(body)}${tail}`;
}

/**
 * Makes a raw browser error safe to show: every URL in it (the quoted tab URL of
 * S1, the bare URLs of an `Invalid value for origin pattern ...` error) goes
 * through redactTabUrl, so no query, fragment, userinfo or data: payload
 * survives. The result is one line, at most 400 characters. Idempotent.
 */
export function redactAccessMessage(message: string): string {
  let out = String(message ?? "");
  out = out.replace(
    QUOTED_TAB_URL,
    (_all, lead: string, url: string) => `${lead}"${redactTabUrl(url)}"`
  );
  out = out.replace(OPAQUE_URL, redactToken);
  out = out.replace(AUTHORITY_URL, redactToken);
  out = out.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return out.length > MAX_RAW_MESSAGE ? `${out.slice(0, MAX_RAW_MESSAGE)}...` : out;
}

/* ------------------------------------------------------------------------- *
 * Messages
 * ------------------------------------------------------------------------- */

export interface TabAccessContext {
  /** Selects the wording of the settings path. */
  browser: TabBrowser;
  /** scheme://host[:port] only. Anything longer is cut back to that. */
  origin?: string;
  tabId?: number;
  /** The browser's error, ALREADY passed through redactAccessMessage. Absent when FoxPilot refused before asking. */
  rawMessage?: string;
  /** restricted: what the page is, from describeRestrictedPage. */
  pageKind?: string;
  /** discarded: the failing call already carried activateTab:true, so do not suggest it again. */
  activateTabRequested?: boolean;
  /** notGranted: Automation Mode is on, so the all-sites grant is what is missing. */
  automationMode?: boolean;
  /** notGranted: a grant dialog is being opened for the user. */
  dialog?: "all-sites" | "site";
}

/** scheme://host[:port] from anything that starts with one; userinfo, path, query, fragment dropped. */
function originOnly(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const m = /^([a-z][a-z0-9+.\-]*:\/\/)(?:[^/?#@]*@)?([^/?#]*)/i.exec(value.trim());
  if (!m || m[2] === "") {
    return undefined;
  }
  return `${m[1].toLowerCase()}${m[2]}`;
}

function extensionsPage(browser: TabBrowser): string {
  return browser === "firefox"
    ? "about:addons"
    : "chrome://extensions (brave://extensions in Brave, edge://extensions in Edge)";
}

function tabWord(ctx: TabAccessContext): string {
  return typeof ctx.tabId === "number" ? `Tab ${ctx.tabId}` : "This tab";
}

function originalError(ctx: TabAccessContext): string {
  return `Original error: ${ctx.rawMessage ? ctx.rawMessage : NO_BROWSER_ERROR_TEXT}`;
}

/** Builds the final text for `cause`. Starts with the cause's tag, ends with "Original error: ...". */
export function buildTabAccessMessage(
  cause: TabAccessCause,
  ctx: TabAccessContext
): string {
  const tag = TAB_ACCESS_TAGS[cause];
  const origin = originOnly(ctx.origin);
  const where = origin ? ` (${origin})` : "";
  let body: string;
  switch (cause) {
    case "restricted": {
      const what = ctx.pageKind ?? "a browser page";
      const blank = what.startsWith("a blank page");
      body =
        `${tabWord(ctx)} shows ${what}, which browsers never let extensions read or act on, ` +
        `so retrying will fail the same way and nothing can be granted to change it. ` +
        (blank
          ? `It has no content yet: use navigate-tab to load an http(s) page in it, or open-browser-tab for a new tab.`
          : `Open the page you want in a normal http(s) tab with open-browser-tab and use that tab id instead.`);
      break;
    }
    case "file":
      body =
        ctx.browser === "firefox"
          ? `${tabWord(ctx)} shows a local file, and Firefox is not giving FoxPilot access to file: pages. ` +
            `Open about:addons → FoxPilot → Permissions and allow it if the browser lists a file option; ` +
            `otherwise serve the file from a local http server and open that address with open-browser-tab.`
          : `${tabWord(ctx)} shows a local file, and FoxPilot's "Allow access to file URLs" setting is off, so the browser refuses it. ` +
            `Turn it on: open ${extensionsPage(ctx.browser)} → FoxPilot → Details → "Allow access to file URLs", then retry.`;
      break;
    case "discarded": {
      const how =
        ctx.browser === "firefox"
          ? "the browser unloaded this tab to save memory"
          : "the browser unloaded this tab (Memory Saver)";
      const recovery = ctx.activateTabRequested
        ? `This call already passed activateTab:true and the tab is still unloaded, so use navigate-page-history with direction "reload" on it, or open-browser-tab for a fresh tab.`
        : `Retry this call with activateTab:true (it loads the tab, then returns the user to their previous tab), ` +
          `or use navigate-page-history with direction "reload", or open-browser-tab for a fresh tab.`;
      body =
        `${tabWord(ctx)}${where}: ${how}, so there is no page in it to read or act on. ` +
        `Its page state is already gone, so reloading loses nothing. ${recovery}`;
      break;
    }
    case "loading":
      body =
        `${tabWord(ctx)}${where} is still loading, so its page is not ready to read or act on. ` +
        `Wait a moment and retry this call (wait-for-text waits for a given text to appear). This is not a permission problem.`;
      break;
    case "errorPage":
      body =
        `${tabWord(ctx)} could not load its page (offline, connection refused, a DNS failure or a blocked request), ` +
        `so the browser is showing its own error page, which extensions cannot read. This is not a permission problem. ` +
        `Fix the address or the network, then retry the load with navigate-tab, or use navigate-page-history with direction "reload".`;
      break;
    case "notGranted": {
      const lead = ctx.automationMode
        ? `Automation Mode is on, but the browser has not given FoxPilot access to all sites, so FoxPilot has no access to ${origin ?? "this site"}.`
        : `FoxPilot has no access to ${origin ?? "this site"} in this browser.`;
      const dialog =
        ctx.dialog === "all-sites"
          ? ` A dialog to grant access to all sites is now being opened: ask the user to click Grant, then retry.`
          : ctx.dialog === "site"
            ? ` A dialog to grant access to this site is now being opened: ask the user to click Grant, then retry.`
            : "";
      const fix =
        ctx.browser === "firefox"
          ? `Where to fix it: open about:addons → FoxPilot → Permissions and allow access to this site (or to all websites).`
          : `Where to fix it: open ${extensionsPage(ctx.browser)} → FoxPilot → Details → Site access → "On all sites" ` +
            `(or add this site under "On specific sites"). ` +
            `If Automation Mode is on, switching it off and on again in FoxPilot's options page asks the browser again.`;
      body = `${lead}${dialog} ${fix}`;
      break;
    }
    case "refused":
      body =
        `The browser refused to let FoxPilot into ${tabWord(ctx).toLowerCase()} although FoxPilot has access to ${origin ?? "this page's origin"}, ` +
        `and the tab is loaded and is not one of the browser's restricted pages, so the cause is not known. ` +
        `A fresh tab on the same origin usually works: open it with open-browser-tab (same origin and path) and use the new tab id. ` +
        `Reloading this tab with navigate-page-history direction "reload" may also work, but it loses any unsaved page state, so do that only if the user agrees.`;
      break;
  }
  return `${tag} ${body} ${originalError(ctx)}`;
}

/* ------------------------------------------------------------------------- *
 * Diagnosis from the real state of the tab
 * ------------------------------------------------------------------------- */

/** The fields of a browser tab this module reads. */
export interface TabInfoForAccess {
  url?: string;
  pendingUrl?: string;
  status?: string;
  discarded?: boolean;
}

/** The browser calls diagnosis needs; each extension binds them to its own API. */
export interface TabAccessProbe {
  getTab(tabId: number): Promise<TabInfoForAccess | null | undefined>;
  /** permissions.contains({origins: [`${origin}/*`]}) */
  containsOrigin(origin: string): Promise<boolean>;
  /** permissions.contains({origins: ["file:///*"]}): "Allow access to file URLs" is on. */
  containsFileAccess(): Promise<boolean>;
}

type Bounded<T> = { ok: true; value: T } | { ok: false };

/** One shared deadline: every browser call races what is left of it, and none can throw. */
function makeBudget(totalMs: number): <T>(fn: () => Promise<T>) => Promise<Bounded<T>> {
  const deadline = Date.now() + totalMs;
  return async <T>(fn: () => Promise<T>): Promise<Bounded<T>> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race<Bounded<T>>([
        Promise.resolve()
          .then(fn)
          .then((value) => ({ ok: true as const, value })),
        new Promise<Bounded<T>>((resolve) => {
          timer = setTimeout(() => resolve({ ok: false }), remaining);
        }),
      ]);
    } catch {
      return { ok: false };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };
}

/**
 * Gate for a tab URL before anything is dispatched to it. Returns the tagged
 * message for a page no grant can fix (restricted, blank) or a file: tab while
 * file access is off, else null (the caller goes on). Never throws, makes no
 * browser call for an opaque origin, and treats an unreadable file-access state
 * as "proceed".
 */
export async function gateTabUrl(
  url: string | null | undefined,
  browser: TabBrowser,
  probe: Pick<TabAccessProbe, "containsFileAccess">,
  extra: { tabId?: number; selfOrigin?: string; timeoutMs?: number } = {}
): Promise<string | null> {
  const kind = classifyTabUrl(url, { browser, selfOrigin: extra.selfOrigin });
  if (kind === "restricted" || kind === "blank") {
    return buildTabAccessMessage("restricted", {
      browser,
      tabId: extra.tabId,
      pageKind: describeRestrictedPage(url, browser),
    });
  }
  if (kind === "file") {
    const bounded = makeBudget(extra.timeoutMs ?? DIAGNOSIS_BUDGET_MS);
    const granted = await bounded(() => probe.containsFileAccess());
    if (granted.ok && granted.value === false) {
      return buildTabAccessMessage("file", { browser, tabId: extra.tabId });
    }
  }
  return null;
}

export interface DiagnoseInput {
  browser: TabBrowser;
  tabId: number;
  /** The browser's error, as thrown (it is redacted here). */
  rawMessage: string;
  /** The failing call already carried activateTab:true. */
  activateTabRequested?: boolean;
  /** Firefox: the extension's own origin (see ClassifyOptions). */
  selfOrigin?: string;
  /** Overall budget for every browser call. Default 1500 ms. */
  timeoutMs?: number;
}

// Causes the browser's message names by itself, so they hold even when the tab
// cannot be read.
const MESSAGE_SAYS_RESTRICTED =
  /Cannot access an? (?:chrome|chrome-extension|chrome-untrusted|devtools|edge|brave):\/\/ URL|The extensions gallery cannot be scripted/i;
const MESSAGE_SAYS_ERROR_PAGE = /showing error page/i;

function restrictedKindFromMessage(raw: string): string {
  if (/chrome-extension:\/\/ URL/i.test(raw)) {
    return "an extension's page";
  }
  if (/gallery/i.test(raw)) {
    return "the Chrome Web Store";
  }
  const m = /Cannot access an? ([a-z][a-z0-9-]*):\/\/ URL/i.exec(raw);
  return m ? `a ${m[1].toLowerCase()}: page` : "a browser page";
}

/**
 * Says why a page-access error happened, from the real state of the tab.
 * The order of causes is fixed:
 *
 *   restricted page -> file: with file access off -> browser error page ->
 *   discarded -> still loading -> site access not granted -> refused despite grant
 *
 * It never throws and never takes longer than the shared budget: when the tab or
 * a permission cannot be read in time, the cause that remains unknown is not
 * claimed, and the result is the browser's own message (redacted) plus a note.
 */
export async function diagnoseTabAccess(
  input: DiagnoseInput,
  probe: TabAccessProbe
): Promise<string> {
  const raw = typeof input.rawMessage === "string" ? input.rawMessage : String(input.rawMessage);
  let redacted: string;
  try {
    redacted = redactAccessMessage(raw);
  } catch {
    redacted = "(the browser's message could not be shown safely)";
  }
  const unknownCause = `${redacted} (FoxPilot could not inspect the tab to say which case this is.)`;
  try {
    return await diagnoseInner(input, probe, raw, redacted, unknownCause);
  } catch {
    return unknownCause;
  }
}

async function diagnoseInner(
  input: DiagnoseInput,
  probe: TabAccessProbe,
  raw: string,
  redacted: string,
  unknownCause: string
): Promise<string> {
  const { browser, tabId } = input;
  const bounded = makeBudget(input.timeoutMs ?? DIAGNOSIS_BUDGET_MS);
  const base: TabAccessContext = {
    browser,
    tabId,
    rawMessage: redacted,
    activateTabRequested: input.activateTabRequested,
  };

  const tabRead = await bounded(() => probe.getTab(tabId));
  const tab = tabRead.ok ? tabRead.value ?? undefined : undefined;
  const url = tab ? tab.url || tab.pendingUrl || "" : "";
  const kind = classifyTabUrl(url, { browser, selfOrigin: input.selfOrigin });
  const isErrorScheme = /^chrome-error:/i.test(url.trim());

  // 1. A page nobody can script.
  const restrictedByUrl =
    (kind === "restricted" || kind === "blank") && !isErrorScheme;
  const restrictedByHost =
    browser === "firefox" && kind === "web" && isFirefoxRestrictedHost(url);
  if (restrictedByUrl || restrictedByHost) {
    return buildTabAccessMessage("restricted", {
      ...base,
      pageKind: describeRestrictedPage(url, browser),
    });
  }
  if (!tab && MESSAGE_SAYS_RESTRICTED.test(raw)) {
    return buildTabAccessMessage("restricted", {
      ...base,
      pageKind: restrictedKindFromMessage(raw),
    });
  }

  // 2. A file: tab while "Allow access to file URLs" is off.
  let fileAccessOn = false;
  if (kind === "file") {
    const granted = await bounded(() => probe.containsFileAccess());
    if (granted.ok && granted.value === false) {
      return buildTabAccessMessage("file", base);
    }
    fileAccessOn = granted.ok && granted.value === true;
  }

  // 3. The browser's own error page (the message says so even when the tab cannot be read).
  if (isErrorScheme || MESSAGE_SAYS_ERROR_PAGE.test(raw)) {
    return buildTabAccessMessage("errorPage", base);
  }

  if (!tab) {
    return unknownCause;
  }
  const origin = originOfTabUrl(url);

  // 4. An unloaded tab has no page; its state is already gone.
  if (tab.status === "unloaded" || (tab.discarded === true && tab.status !== "loading")) {
    return buildTabAccessMessage("discarded", { ...base, origin });
  }

  // 5. Not finished loading.
  if (tab.status === "loading") {
    return buildTabAccessMessage("loading", { ...base, origin });
  }

  // 6 and 7. A loaded web page: is the site granted?
  if (!origin) {
    // A file: tab whose file access is confirmed on has nothing left to blame.
    return fileAccessOn ? buildTabAccessMessage("refused", base) : unknownCause;
  }
  const contains = await bounded(() => probe.containsOrigin(origin));
  if (!contains.ok) {
    return unknownCause;
  }
  return buildTabAccessMessage(contains.value ? "refused" : "notGranted", {
    ...base,
    origin,
  });
}
