/**
 * Background-side tab-readiness for Firefox (MV2). `browser.tabs.update` resolves
 * when a navigation COMMITS, not when the document is ready — so the isolated
 * content-script world is torn down and the next DOM tool runs mid-navigation.
 * `waitForTabReady` closes that gap: it settles on status:"complete" and then
 * confirms the frame is injectable with a trivial executeScript probe. It NEVER
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
