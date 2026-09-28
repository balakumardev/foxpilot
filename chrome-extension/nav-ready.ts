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

/**
 * Runs `start` (the tabs.update / tabs.reload that issues a navigation) and
 * waits until the tab has finished loading the page THAT navigation produced,
 * or the navigation ended without one (a 204, a download, a cancelled load).
 * Bounded by `timeoutMs`; never rejects on timeout. Resolves `committed: true`
 * once the tab reported committing a navigation after `start` began.
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
 * and "complete with nothing pending" means the navigation is over either way.
 * A commit event whose tab still has a pendingUrl belongs to the OLD page
 * changing its own url while ours is in flight, so it does not count.
 */
export async function navigateAndSettle(
  tabId: number,
  start: () => Promise<unknown>,
  opts: { timeoutMs: number }
): Promise<{ committed: boolean }> {
  const deadline =
    Date.now() + Math.min(Math.max(opts.timeoutMs, 0), READY_MAX_TIMEOUT_MS);
  let committed = false;
  let events = 0;
  let wake: (() => void) | null = null;
  const listener = (
    id: number,
    info: { status?: string; url?: string },
    tab?: { pendingUrl?: string }
  ) => {
    if (id !== tabId || !info) return;
    if ((info.status === "loading" || info.url) && !(tab && tab.pendingUrl)) {
      committed = true;
    }
    events++;
    if (wake) wake();
  };
  chrome.tabs.onUpdated.addListener(listener);
  try {
    await start();
    while (true) {
      const seen = events;
      let tab: { status?: string; pendingUrl?: string } | undefined;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        break; // tab gone — nothing left to wait for
      }
      if (tab && tab.status === "complete" && !tab.pendingUrl) break;
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
    return { committed };
  } finally {
    try {
      chrome.tabs.onUpdated.removeListener(listener);
    } catch {
      /* ignore */
    }
  }
}
