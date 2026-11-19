/**
 * take-snapshot on a tab that is still loading: wait for it, or say so.
 *
 * A snapshot of a just-opened tab can come back with zero elements while the page
 * is still loading or the app is still rendering (a client-rendered shell has a
 * root element and nothing interactive yet). Answering `[snapshot: 0 elements]`
 * is then indistinguishable from a page that really has no controls. Both
 * extensions call `settleSnapshot` after the first read: when the read is empty
 * AND the tab is still settling it re-reads on a short interval, until elements
 * appear or a budget runs out, and reports how long it waited.
 *
 * Pure and dependency-injected (clock, sleep, reads, tab state) so both
 * extensions share ONE definition and it is testable with a fake clock. The
 * caller must pace `sleep` from the service worker / background page: Chrome
 * clamps page timers in a hidden tab to one tick per second, so a wait driven by
 * a page timer would stall exactly when the tab is in the background.
 *
 * Plain functions only (no DOM, no browser APIs): esbuild bundles this into both
 * extension builds, and jest maps `@foxpilot/common` to this directory.
 */

/** How often an empty snapshot is re-read while the tab settles. */
export const SNAPSHOT_SETTLE_POLL_MS = 300;

/** Budget while the tab or document is not "complete" yet. */
export const SNAPSHOT_SETTLE_LOADING_MS = 5000;

/**
 * Budget for a loaded document that has rendered (almost) nothing: the unrendered
 * shell of a client-rendered app.
 */
export const SNAPSHOT_SETTLE_SHELL_MS = 1500;

/**
 * A complete document whose <body> has at most this many children counts as an
 * unrendered shell (`<div id="root">`, a script or two); more than this is a page
 * that is genuinely empty of interactive elements, so it must not be waited on.
 */
export const SNAPSHOT_SHELL_MAX_BODY_CHILDREN = 3;

/** The part of a snapshot result the settle logic looks at. */
export interface SettleRead {
  total?: number;
  error?: string;
  docState?: { readyState: string; bodyChildren: number };
}

/** The part of the tab the settle logic looks at (from tabs.get). */
export interface SettleTab {
  /** "loading" | "complete" | "unloaded"; undefined = unknown (treated as settled). */
  status?: string;
  discarded?: boolean;
}

/**
 * ready   = nothing to wait for (elements found, an error, or a real empty page);
 * loading = empty and the tab/document is not complete yet;
 * shell   = empty, complete, and the body is nearly bare.
 */
export type SettleState = "ready" | "loading" | "shell";

/**
 * Decides whether an EMPTY snapshot is worth waiting on. Only a numeric
 * `total === 0` with no query error and a `docState` counts as empty: a missing
 * total or docState (an older content script, a test double) never waits, and a
 * non-empty or paged-past-the-end result (`total > 0`) never waits.
 */
export function classifySnapshot(
  read: SettleRead,
  tabStatus: string | undefined
): SettleState {
  if (read.error) return "ready";
  if (typeof read.total !== "number" || read.total !== 0) return "ready";
  const doc = read.docState;
  if (!doc) return "ready";
  if ((tabStatus !== undefined && tabStatus !== "complete") || doc.readyState !== "complete") {
    return "loading";
  }
  return doc.bodyChildren <= SNAPSHOT_SHELL_MAX_BODY_CHILDREN ? "shell" : "ready";
}

export interface SettleDeps<R extends SettleRead> {
  /** One more snapshot read. Rejects when the page cannot be read right now. */
  read(): Promise<R>;
  /**
   * The tab as it is now. Rejects when the tab is gone (or must not be read any
   * more, e.g. its URL is now on the deny list): that error ends the wait.
   */
  getTab(): Promise<SettleTab>;
  /** Sleep, paced from the background (never a page timer). */
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface SettleOutcome<R> {
  result: R;
  /** Set only when it waited: how long, measured from the decision to wait. */
  waitedMs?: number;
  /** The tab's status at the end of the wait; set only when it waited. */
  tabStatus?: string;
}

/**
 * Given the FIRST (successful) read, wait for the page to produce elements.
 *
 * - First read has elements, an error, or the page is settled and genuinely
 *   empty: return it at once (`waitedMs` unset), after at most one `getTab()`.
 * - Otherwise re-read every `SNAPSHOT_SETTLE_POLL_MS`, recomputing "still
 *   settling" from every fresh read and tab state, until elements appear or
 *   the budget is spent. The budget is `SNAPSHOT_SETTLE_LOADING_MS` while the tab
 *   or document is not complete and `SNAPSHOT_SETTLE_SHELL_MS` for a complete
 *   shell; a tab that finishes loading into a shell gets a fresh shell budget,
 *   so the worst case is the sum of the two plus the time the reads themselves take.
 * - A re-read that fails (a navigation tore the content script down) is retried
 *   until the budget is spent; if the LAST attempt failed, its error is
 *   rethrown. A discarded tab is not retried: its error propagates at once, and
 *   so does a `getTab()` rejection (tab closed).
 * - The sleep never exceeds the time left, and no re-read starts after the
 *   deadline has passed.
 */
export async function settleSnapshot<R extends SettleRead>(
  first: R,
  deps: SettleDeps<R>
): Promise<SettleOutcome<R>> {
  let result = first;

  // Cheap exit first: only an empty candidate costs a tabs.get.
  if (!isEmptyCandidate(result)) return { result };
  let tab = await deps.getTab();
  let state = classifySnapshot(result, tab.status);
  if (state === "ready") return { result };

  const start = deps.now();
  let phaseStart = start;
  let lastError: unknown;
  let lastAttemptFailed = false;

  while (true) {
    const limit =
      state === "loading" ? SNAPSHOT_SETTLE_LOADING_MS : SNAPSHOT_SETTLE_SHELL_MS;
    const remaining = phaseStart + limit - deps.now();
    if (remaining <= 0) break;
    await deps.sleep(Math.min(SNAPSHOT_SETTLE_POLL_MS, remaining));

    tab = await deps.getTab();
    const discarded = tab.discarded === true || tab.status === "unloaded";
    try {
      result = await deps.read();
      lastAttemptFailed = false;
    } catch (e) {
      if (discarded) throw e;
      lastError = e;
      lastAttemptFailed = true;
      continue;
    }

    const next = classifySnapshot(result, tab.status);
    if (next === "ready") break;
    if (next === "shell" && state === "loading") phaseStart = deps.now();
    state = next;
  }

  if (lastAttemptFailed) throw lastError;
  return {
    result,
    waitedMs: deps.now() - start,
    ...(tab.status !== undefined ? { tabStatus: tab.status } : {}),
  };
}

// True when the read could possibly be an empty snapshot worth classifying
// (numeric total of 0, no error, docState present). Keeps the no-wait fast path
// from asking the tab anything.
function isEmptyCandidate(read: SettleRead): boolean {
  return !read.error && read.total === 0 && read.docState !== undefined;
}
