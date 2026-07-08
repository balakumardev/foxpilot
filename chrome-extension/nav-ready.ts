/**
 * Background-side tab-readiness for Chrome/Edge (MV3). `browser.tabs.update`
 * resolves on navigation COMMIT, not document-ready, and Chrome injects the DOM
 * content script lazily — so the next DOM tool can run mid-navigation with no
 * live content script. `waitForTabReady` settles on status:"complete", then
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
