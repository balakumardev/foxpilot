import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import type { BrowserTab } from "@foxpilot/common";

dayjs.extend(relativeTime);

const MAX_LIMIT = 500;

export interface TabListFormatOptions {
  /** 0-based index of the first tab to show. */
  offset: number;
  /** Requested page size; clamped to 1..500. */
  limit: number;
  /** True when the caller passed any filter (windowId / activeOnly / visibleOnly). */
  filtered: boolean;
  /** Reference time for "last accessed"; defaults to the current time. */
  now?: number;
}

type TextItem = { type: "text"; text: string };

/**
 * Render the (already filtered) tab list the way get-list-of-open-tabs returns
 * it: one pagination header, then one line per tab on the requested page.
 */
export function formatTabList(
  tabs: BrowserTab[],
  { offset, limit, filtered, now }: TabListFormatOptions
): TextItem[] {
  const totalTabs = tabs.length;
  if (totalTabs === 0) {
    return [
      {
        type: "text",
        text: filtered
          ? "No open tabs match the given filters (windowId / activeOnly / visibleOnly)."
          : "No open tabs.",
      },
    ];
  }

  const effectiveLimit = Math.min(Math.max(1, limit), MAX_LIMIT);
  const page = tabs.slice(offset, offset + effectiveLimit);
  const hasMore = offset + effectiveLimit < totalTabs;

  const header: TextItem = {
    type: "text",
    text: `Showing tabs ${offset + 1}-${offset + page.length} of ${totalTabs} total tabs${
      hasMore ? ` (use offset=${offset + effectiveLimit} to see more)` : ""
    }`,
  };

  const lines = page.map((tab): TextItem => {
    let lastAccessed = "unknown";
    if (tab.lastAccessed) {
      // LLM-friendly time ago
      lastAccessed =
        now === undefined
          ? dayjs(tab.lastAccessed).fromNow()
          : dayjs(tab.lastAccessed).from(dayjs(now));
    }
    const windowId =
      typeof tab.windowId === "number" ? `, window id=${tab.windowId}` : "";
    return {
      type: "text",
      text: `tab id=${tab.id}, tab url=${tab.url}, tab title=${tab.title}, last accessed=${lastAccessed}${windowId}`,
    };
  });

  return [header, ...lines];
}
