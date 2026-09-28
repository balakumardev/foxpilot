/**
 * Background-side tab-readiness for Firefox (MV2). `browser.tabs.update`
 * resolves as soon as a navigation is REQUESTED — before it has even started
 * loading, let alone committed — so the next DOM tool can run against the page
 * being left, or mid-navigation once the old isolated world is torn down.
 * `navigateAndSettle` waits out a navigation it issues itself.
 * `waitForTabReady` settles on status:"complete" and then confirms the frame is
 * injectable with a trivial executeScript probe. It NEVER
 * rejects on timeout — it resolves best-effort so the caller proceeds (the tool
 * dispatch that follows surfaces any genuine failure). No new permissions
 * (`tabs` is already granted); the readiness handshake mirrors the nav-race
 * convention (Firefox uses the `browser` global; Chrome's copy uses `chrome`).
 */
const POLL_MS = 100;
const READY_DEFAULT_TIMEOUT_MS = 8000;
// Clamp strictly under the 30s navigate-tab broker budget (timeouts.ts).
const READY_MAX_TIMEOUT_MS = 29000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Best-effort settle: resolve immediately if already complete, else wait for a
// tabs.onUpdated status:"complete" (or the deadline). The executeScript probe in
// waitForTabReady is the AUTHORITATIVE readiness gate, so a missed onUpdated
// event only means we fall back to the probe loop.
async function waitForComplete(tabId: number, deadline: number): Promise<void> {
  try {
    const tab = await browser.tabs.get(tabId);
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
        browser.tabs.onUpdated.removeListener(listener);
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info && info.status === "complete") finish();
    };
    browser.tabs.onUpdated.addListener(listener);
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

  // Confirm the frame is injectable. executeScript compiles+runs fresh each call
  // (no persistent content script on MV2), so a resolved probe means the new
  // document will accept our injected tools.
  while (Date.now() < deadline) {
    try {
      const r = await browser.tabs.executeScript(tabId, { code: "1" });
      if (r && r[0] === 1) return;
    } catch {
      /* not injectable yet — retry until the deadline */
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
 * once the tab reported a location change after `start` began.
 *
 * waitForTabReady cannot do this on its own: tabs.update resolves BEFORE the
 * load has even started. Right after it Firefox still reports the page being
 * left (status "complete", the old url), and that document keeps answering
 * executeScript — so a settle that trusts the first tabs.get settles on the
 * old page and reads back its url. Recorded on Firefox 151: tabs.update and a
 * tabs.get 12ms later both said complete + old url; the load started at 14ms.
 * And navigating while the previous load is still in flight first fires a
 * status:"complete" for that aborted load, then the new status:"loading".
 *
 * Firefox's onUpdated separates the phases: status:"loading" with NO url when
 * a load starts, a `url` on every top-level location change (the commit —
 * same-url reloads and same-document jumps included), status:"complete" when
 * it stops. So the listener is armed BEFORE `start` (a fast commit can land
 * before tabs.update resolves), and the wait only ends on a live "complete"
 * seen after this navigation's own start or commit.
 */
export async function navigateAndSettle(
  tabId: number,
  start: () => Promise<unknown>,
  opts: { timeoutMs: number }
): Promise<{ committed: boolean }> {
  const deadline =
    Date.now() + Math.min(Math.max(opts.timeoutMs, 0), READY_MAX_TIMEOUT_MS);
  let started = false;
  let committed = false;
  let events = 0;
  let wake: (() => void) | null = null;
  const listener = (id: number, info: { status?: string; url?: string }) => {
    if (id !== tabId || !info) return;
    if (info.url) committed = true;
    if (info.status === "loading") started = true;
    events++;
    if (wake) wake();
  };
  browser.tabs.onUpdated.addListener(listener);
  try {
    await start();
    while (true) {
      const seen = events;
      let tab: { status?: string } | undefined;
      try {
        tab = await browser.tabs.get(tabId);
      } catch {
        break; // tab gone — nothing left to wait for
      }
      if (tab && tab.status === "complete" && (started || committed)) break;
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
      browser.tabs.onUpdated.removeListener(listener);
    } catch {
      /* ignore */
    }
  }
}

// Firefox analog of the Chrome sendMessageToTab harden: run an injected probe,
// and on a transient mid-navigation / new-origin failure re-check host
// permission for the CURRENT origin, wait for readiness, and retry ONCE.
export async function execWithReadyRetry(
  tabId: number,
  details: { code: string }
): Promise<any[]> {
  try {
    return await browser.tabs.executeScript(tabId, details);
  } catch {
    const live = await browser.tabs.get(tabId);
    if (live && live.url) {
      const origin = new URL(live.url).origin;
      const granted = await browser.permissions.contains({
        origins: [`${origin}/*`],
      });
      if (!granted) {
        throw new Error(
          `Missing host permission for "${origin}" after navigation. Ask the user to grant access to this domain, then retry.`
        );
      }
    }
    await waitForTabReady(tabId, { timeoutMs: 8000 });
    return await browser.tabs.executeScript(tabId, details);
  }
}
