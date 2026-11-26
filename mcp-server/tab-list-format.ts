import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  filterTabsByText,
  redactTabUrl,
  singleLine,
  type BrowserTab,
} from "@foxpilot/common";
import type { TabListFilter, TabListResult } from "./browser-api";

dayjs.extend(relativeTime);

const MAX_LIMIT = 500;
/** Longest title kept per line in compact mode. */
const COMPACT_TITLE_MAX = 60;

export interface TabListFormatOptions {
  /** 0-based index of the first tab to show. */
  offset: number;
  /** Requested page size; clamped to 1..500. */
  limit: number;
  /** Filters the caller asked for. Any of them makes the header say "matching". */
  windowId?: number;
  activeOnly?: boolean;
  visibleOnly?: boolean;
  urlContains?: string;
  titleContains?: string;
  /** Print raw URLs (and match urlContains on them). Default: redacted. */
  fullUrls?: boolean;
  /** One short line per tab. */
  compact?: boolean;
  /**
   * True when the extension's reply carried filtersApplied. Without it,
   * activeOnly / visibleOnly cannot be verified here and a NOTE says so.
   */
  filtersApplied?: boolean;
  /** Reference time for "last accessed"; defaults to the current time. */
  now?: number;
}

type TextItem = { type: "text"; text: string };

/** Arguments of the get-list-of-open-tabs tool. */
export interface OpenTabsArgs {
  offset: number;
  limit: number;
  windowId?: number;
  activeOnly?: boolean;
  visibleOnly?: boolean;
  urlContains?: string;
  titleContains?: string;
  fullUrls?: boolean;
  compact?: boolean;
}

/**
 * The tool body: ask the extension (which filters and redacts in the browser),
 * then format. Kept apart from server.ts so a test can drive the real flow
 * against a mock extension.
 */
export async function listOpenTabs(
  api: { getTabListResult(filter: TabListFilter): Promise<TabListResult> },
  args: OpenTabsArgs,
  now?: number
): Promise<TextItem[]> {
  // An empty string means "no filter", not "match nothing".
  const urlContains = args.urlContains || undefined;
  const titleContains = args.titleContains || undefined;
  const result = await api.getTabListResult({
    windowId: args.windowId,
    activeOnly: args.activeOnly,
    visibleOnly: args.visibleOnly,
    urlContains,
    titleContains,
    // Always explicit, so an extension that knows the field redacts in the
    // browser by default and the tokens never reach this process.
    redactUrls: args.fullUrls !== true,
  });
  return formatTabList(result.tabs, {
    offset: args.offset,
    limit: args.limit,
    windowId: args.windowId,
    activeOnly: args.activeOnly,
    visibleOnly: args.visibleOnly,
    urlContains,
    titleContains,
    fullUrls: args.fullUrls,
    compact: args.compact,
    filtersApplied: result.filtersApplied,
    now,
  });
}

/**
 * Render the tab list the way get-list-of-open-tabs returns it: one pagination
 * header, then one line per tab on the requested page.
 *
 * The filters the server can verify from the reply (windowId, urlContains,
 * titleContains) are applied again here, so an extension that predates them and
 * returned every tab still yields a correct list; counting and paging happen
 * after that. activeOnly / visibleOnly cannot be checked from the reply, so
 * when the extension did not confirm them a NOTE is appended.
 */
export function formatTabList(
  tabs: BrowserTab[],
  options: TabListFormatOptions
): TextItem[] {
  const { windowId, activeOnly, visibleOnly, urlContains, titleContains } =
    options;

  const filtered =
    windowId !== undefined ||
    activeOnly === true ||
    visibleOnly === true ||
    !!urlContains ||
    !!titleContains;

  const matching = filtered
    ? filterTabsByText(tabs, {
        windowId,
        urlContains,
        titleContains,
        redactUrls: options.fullUrls !== true,
      })
    : tabs;

  const items = renderPage(matching, options, filtered);

  const unconfirmed: string[] = [];
  if (activeOnly === true) unconfirmed.push("activeOnly");
  if (visibleOnly === true) unconfirmed.push("visibleOnly");
  if (unconfirmed.length > 0 && options.filtersApplied !== true) {
    items.push({
      type: "text",
      text:
        `NOTE: ${unconfirmed.join(" and ")} could not be confirmed. This browser extension ` +
        "is older than the server and may have ignored it, so the list can include tabs that " +
        "do not match. Update or reload the FoxPilot extension.",
    });
  }
  return items;
}

function renderPage(
  list: BrowserTab[],
  options: TabListFormatOptions,
  filtered: boolean
): TextItem[] {
  const { offset, limit, compact, fullUrls, now } = options;
  const total = list.length;
  if (total === 0) {
    return [
      {
        type: "text",
        text: filtered
          ? "No open tabs match the given filters (windowId / activeOnly / visibleOnly / urlContains / titleContains)."
          : "No open tabs.",
      },
    ];
  }

  const kind = filtered ? "matching" : "total";
  if (offset >= total) {
    return [
      {
        type: "text",
        text: `No more tabs at offset=${offset}: there ${
          total === 1 ? "is 1" : `are ${total}`
        } ${kind} ${total === 1 ? "tab" : "tabs"} (use offset=0 to start from the first).`,
      },
    ];
  }

  const effectiveLimit = Math.min(Math.max(1, limit), MAX_LIMIT);
  const page = list.slice(offset, offset + effectiveLimit);
  const hasMore = offset + effectiveLimit < total;

  const header: TextItem = {
    type: "text",
    text: `Showing tabs ${offset + 1}-${offset + page.length} of ${total} ${kind} tabs${
      hasMore ? ` (use offset=${offset + effectiveLimit} to see more)` : ""
    }`,
  };

  const lines = page.map(
    (tab): TextItem => ({
      type: "text",
      text:
        compact === true
          ? compactLine(tab, fullUrls === true)
          : fullLine(tab, fullUrls === true, now),
    })
  );
  return [header, ...lines];
}

/** The URL as shown: redacted unless fullUrls, one line, "unknown" when absent. */
function shownUrl(tab: BrowserTab, fullUrls: boolean): string {
  if (typeof tab.url !== "string") return "unknown";
  // redactTabUrl is idempotent, so a URL the extension already redacted comes
  // out unchanged.
  return singleLine(fullUrls ? tab.url : redactTabUrl(tab.url));
}

function shownTitle(tab: BrowserTab): string {
  return singleLine(typeof tab.title === "string" ? tab.title : "");
}

function fullLine(
  tab: BrowserTab,
  fullUrls: boolean,
  now: number | undefined
): string {
  let lastAccessed = "unknown";
  if (tab.lastAccessed) {
    // LLM-friendly time ago
    lastAccessed =
      now === undefined
        ? dayjs(tab.lastAccessed).fromNow()
        : dayjs(tab.lastAccessed).from(dayjs(now));
  }
  const windowSuffix =
    typeof tab.windowId === "number" ? `, window id=${tab.windowId}` : "";
  const store = shownCookieStoreId(tab);
  const storeSuffix = store === "" ? "" : `, cookieStoreId=${store}`;
  return `tab id=${tab.id}, tab url=${shownUrl(tab, fullUrls)}, tab title=${shownTitle(tab)}, last accessed=${lastAccessed}${windowSuffix}${storeSuffix}`;
}

function compactLine(tab: BrowserTab, fullUrls: boolean): string {
  const win = typeof tab.windowId === "number" ? ` win=${tab.windowId}` : "";
  const store = shownCookieStoreId(tab);
  const storePart = store === "" ? "" : ` cookieStoreId=${store}`;
  // Host + path reads shorter without the scheme; other schemes keep theirs.
  const url = shownUrl(tab, fullUrls).replace(/^https?:\/\//i, "");
  const title = truncateTitle(shownTitle(tab));
  return `id=${tab.id}${win}${storePart} ${url}${title === "" ? "" : ` | ${title}`}`;
}

/**
 * The Firefox container of a tab, or "" for none. The extension only sends it
 * for a tab outside the default store; it is not printed for "firefox-default"
 * either way, so the line of an ordinary tab is unchanged.
 */
function shownCookieStoreId(tab: BrowserTab): string {
  if (typeof tab.cookieStoreId !== "string" || tab.cookieStoreId === "firefox-default") {
    return "";
  }
  return singleLine(tab.cookieStoreId);
}

function truncateTitle(title: string): string {
  if (title.length <= COMPACT_TITLE_MAX) return title;
  // Array.from so a surrogate pair is never cut in half.
  const chars = Array.from(title);
  return chars.length <= COMPACT_TITLE_MAX
    ? title
    : `${chars.slice(0, COMPACT_TITLE_MAX - 1).join("")}\u2026`;
}
