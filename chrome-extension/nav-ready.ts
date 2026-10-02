/**
 * Background-side tab-readiness for Chrome/Edge (MV3). `browser.tabs.update`
 * resolves as soon as a navigation is REQUESTED — before it commits — and Chrome
 * injects the DOM content script lazily, so the next DOM tool can run against
 * the page being left, or mid-navigation with no live content script.
 * `navigateAndSettle` waits out a navigation it issues itself.
 * `waitForTabReady` settles on status:"complete", then
 * proactively injects `dist/content-script.js` and pings the (previously dead)
 * `case "ping"` responder until it answers {ok:true}. It NEVER rejects on
 * timeout — best-effort resolve so the caller proceeds. No new permissions
 * (`tabs`/`scripting` already granted). Mirrors firefox-extension/nav-ready.ts;
 * per the nav-race convention this copy uses the `chrome` global.
 */
const POLL_MS = 100;
const READY_DEFAULT_TIMEOUT_MS = 8000;
// Clamp strictly under the 30s navigate-tab broker budget (timeouts.ts).
const READY_MAX_TIMEOUT_MS = 29000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForComplete(tabId: number, deadline: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.status === "complete") return;
  } catch {
    /* tab not readable yet — fall through to the listener */
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, Math.max(deadline - Date.now(), 0));
  });
}

export async function waitForTabReady(
  tabId: number,
  opts?: { timeoutMs?: number }
): Promise<void> {
  const budget = Math.min(
    Math.max(opts?.timeoutMs ?? READY_DEFAULT_TIMEOUT_MS, 0),
    READY_MAX_TIMEOUT_MS
  );
  const deadline = Date.now() + budget;

  await waitForComplete(tabId, deadline);

  // Re-establish the content script, then confirm it answers the ping.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["dist/content-script.js"],
    });
  } catch {
    /* already injected / mid-nav — the ping poll below is the real gate */
  }
  while (Date.now() < deadline) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: "ping" });
      if (pong && pong.ok) return;
    } catch {
      /* content script not live yet — retry until the deadline */
    }
    await sleep(POLL_MS);
  }
  // Timeout: resolve best-effort (never reject) so the caller proceeds.
}

/** A navigation issued by navigateAndSettle, watched until dispose(). */
export interface NavigationWatch {
  /**
   * The tab has reported committing this navigation. When the settle ran out of
   * time with the navigation still in flight, this keeps updating until
   * dispose(), so a commit that lands later (say, during a waitFor* poll) still
   * counts — read it at the moment you read the tab. Once the navigation is
   * seen to end, during the settle or after it, the answer is final: a later
   * url change belongs to the page the tab is showing, not to this navigation.
   */
  committed(): boolean;
  /** The tab could no longer be read: closed, or replaced (see replacedBy). */
  gone(): boolean;
  /** The id of the tab Chrome swapped in for ours (tabs.onReplaced), if any. */
  replacedBy(): number | undefined;
  /** Stops listening. Idempotent; the caller must always call it. */
  dispose(): void;
}

/**
 * Runs `start` (the tabs.update / tabs.reload that issues a navigation) and
 * waits until the tab has finished loading the page THAT navigation produced,
 * or the navigation ended without one (a 204, a download, a cancelled load).
 * Bounded by `timeoutMs`; never rejects on timeout. Returns a watch that keeps
 * listening until the caller disposes it (on a failed `start` it disposes
 * itself and rethrows).
 *
 * waitForTabReady cannot do this on its own: tabs.update resolves BEFORE the
 * navigation commits, with url still the OLD page and the destination parked
 * in pendingUrl (recorded on Chromium 149). Until the commit, tabs.get keeps
 * reporting the old url and the old page's content script answers the ping,
 * so a settle that runs out its budget first — or a navigation that never
 * commits, which fires NO onUpdated event at all — reads back the old url.
 *
 * Chrome registers the navigation inside tabs.update (status "loading" plus
 * pendingUrl from its result onwards) and reports status:"loading" (with the
 * url when it changed) only when a navigation COMMITS. So the listener is
 * armed BEFORE `start` (a fast commit can land before tabs.update resolves),
 * and a live "complete" means the navigation is over either way. pendingUrl is
 * deliberately not part of that test, so a build that kept a stale pending
 * entry after the navigation ended cannot stall the wait. A commit event whose
 * tab still has a pendingUrl is the OLD page changing its own url while ours
 * is in flight, so it does not count — and nothing else can mark the tab as
 * moved, since the old page's own url changes look the same in tabs.get. For
 * the same reason nothing counts once the navigation has ended: with no
 * pendingUrl left to tell them apart, a later url change is the page's own.
 *
 * That pendingUrl test does not always hold: recorded on Chromium 149, the old
 * page's pushState while ours was in flight dropped pendingUrl, so its url
 * change counted as our commit. navigateTab corrects that before it replies:
 * when the tab still shows the document it marked before the navigation
 * (plantDocumentToken), nothing has committed. The mark needs a page the
 * extension can script; on any other page such a url change still counts.
 *
 * Chrome fires no event when a navigation ends WITHOUT a page, so after a
 * timed-out settle the watch keeps reading the tab until it reads "complete"
 * (or until dispose()) to see that end too. Between the end and that read — up
 * to 100ms, or until the page being left finishes a load of its own — a url
 * change the old page makes is still taken for ours here; navigateTab's
 * document check then catches it the same way.
 */
export async function navigateAndSettle(
  tabId: number,
  start: () => Promise<unknown>,
  opts: { timeoutMs: number }
): Promise<NavigationWatch> {
  const deadline =
    Date.now() + Math.min(Math.max(opts.timeoutMs, 0), READY_MAX_TIMEOUT_MS);
  let committed = false;
  let over = false; // the navigation ended: nothing after this is ours
  let gone = false;
  let replacedBy: number | undefined;
  let events = 0;
  let wake: (() => void) | null = null;
  const onUpdated = (
    id: number,
    info: { status?: string; url?: string },
    tab?: { pendingUrl?: string }
  ) => {
    if (id !== tabId || !info) return;
    if (!over && (info.status === "loading" || info.url) && !(tab && tab.pendingUrl)) {
      committed = true;
    }
    events++;
    if (wake) wake();
  };
  const onReplaced = (addedTabId: number, removedTabId: number) => {
    if (removedTabId !== tabId) return;
    replacedBy = addedTabId;
    gone = true;
    events++;
    if (wake) wake();
  };
  const replacedEvent = chrome.tabs.onReplaced;
  chrome.tabs.onUpdated.addListener(onUpdated);
  if (replacedEvent) replacedEvent.addListener(onReplaced);
  let disposed = false;
  let endPoll: ReturnType<typeof setTimeout> | null = null;
  const watch: NavigationWatch = {
    committed: () => committed,
    gone: () => gone,
    replacedBy: () => replacedBy,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (endPoll !== null) {
        clearTimeout(endPoll);
        endPoll = null;
      }
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        if (replacedEvent) replacedEvent.removeListener(onReplaced);
      } catch {
        /* ignore */
      }
    },
  };
  try {
    await start();
  } catch (e) {
    watch.dispose();
    throw e;
  }
  while (!gone) {
    const seen = events;
    let tab: { status?: string } | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      gone = true; // closed — nothing left to wait for
      break;
    }
    if (tab && tab.status === "complete") {
      over = true;
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // An event that landed during the read may already be stale in `tab`;
    // re-read at once rather than sleeping through it.
    if (events !== seen) continue;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, Math.min(POLL_MS, remaining));
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }
  if (!over && !gone) {
    // The settle ran out of time with the navigation still in flight, so the
    // watch stays live for a late commit. It must still learn when the
    // navigation ends without one, or the old page's next url change would be
    // taken for it — and Chrome fires no event for that end. So keep reading
    // the tab until it settles, or until dispose().
    const readUntilSettled = async (): Promise<void> => {
      endPoll = null;
      if (disposed || over) return;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.status === "complete") {
          over = true;
          return;
        }
      } catch {
        return; // closed: the caller's own read of the tab reports that
      }
      if (!disposed) endPoll = setTimeout(readUntilSettled, POLL_MS);
    };
    endPoll = setTimeout(readUntilSettled, POLL_MS);
  }
  return watch;
}

// The global, in the extension's own isolated world of a page, that holds the
// token marking that document (see plantDocumentToken).
const DOC_TOKEN_KEY = "__foxpilotDocToken";
// A frozen or half torn-down frame may never answer; navigate-tab must not
// wait on it.
const DOC_TOKEN_TIMEOUT_MS = 500;

// Runs in the page (serialized): this document's token, created on first use.
function plantToken(key: string): string {
  const w = window as unknown as Record<string, unknown>;
  if (typeof w[key] !== "string") {
    w[key] = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  return w[key] as string;
}

// Runs in the page (serialized): this document's token, or "" when it has none.
function readToken(key: string): string {
  const token = (window as unknown as Record<string, unknown>)[key];
  return typeof token === "string" ? token : "";
}

// undefined ("cannot tell") when the injection fails, does not answer within
// DOC_TOKEN_TIMEOUT_MS, or returns anything but a string.
async function runTokenScript(run: () => Promise<unknown>): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      run(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), DOC_TOKEN_TIMEOUT_MS);
      }),
    ]);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Marks the document the tab shows now, so navigateTab can tell later whether
 * the tab still shows that same document, whatever url it has moved to since.
 * The token is a global in the extension's own isolated world (the content
 * script's __bcmcpContentScriptLoaded guard relies on the same thing): it
 * lasts across injections into the same document, a new document starts
 * without it, and the page cannot see it. Recorded on Chromium 149: it
 * survived pushState and a fragment jump, and was gone after a commit or a
 * reload. injectImmediately runs it at once, even while the page is still
 * loading.
 *
 * Resolves the token (an existing one is reused), or undefined when the page
 * cannot be scripted or does not answer in time.
 */
export function plantDocumentToken(tabId: number): Promise<string | undefined> {
  return runTokenScript(async () => {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: plantToken,
      args: [DOC_TOKEN_KEY],
    });
    return r && r[0] && r[0].result;
  });
}

/**
 * Reads the token plantDocumentToken left in the document the tab shows now:
 * "" when that document has none (it is a new one), undefined when it cannot
 * tell. Never plants one.
 */
export function readDocumentToken(tabId: number): Promise<string | undefined> {
  return runTokenScript(async () => {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: readToken,
      args: [DOC_TOKEN_KEY],
    });
    return r && r[0] && r[0].result;
  });
}

/**
 * Whether a tab showing `url` is at `targetUrl`: the same url once both are
 * normalized, or, when the target has a fragment, the same url apart from the
 * fragment. Navigating to a fragment of the page being left is a same-document
 * jump, so the tab keeps its document, and a hash router may then move it on
 * within that document (#/settings to #/settings/general).
 */
export function isAtTarget(url: string | undefined, targetUrl: string): boolean {
  if (!url) return false;
  let at: URL;
  let target: URL;
  try {
    at = new URL(url);
    target = new URL(targetUrl);
  } catch {
    return url === targetUrl;
  }
  if (at.href === target.href) return true;
  if (!target.href.includes("#")) return false;
  at.hash = "";
  target.hash = "";
  return at.href === target.href;
}
