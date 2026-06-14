import { getOrCreateBrowserId } from "./extension-config";

/** Update the connection badge DOM to reflect ACTIVE/STANDBY. */
export function applyActiveStatus(active: boolean): void {
  const badge = document.getElementById("connection-badge");
  if (!badge) {
    return;
  }
  badge.textContent = active ? "ACTIVE" : "STANDBY";
  badge.classList.toggle("active", active);
  badge.classList.toggle("standby", !active);
}

/**
 * Ask the background page to make THIS browser the active driver. The
 * background holds the live broker connection, so it forwards a select to the
 * broker (sets activeBrowserId for this browser's id). Mirrors select-browser
 * for human use.
 */
export async function selectThisBrowser(): Promise<void> {
  const browserId = await getOrCreateBrowserId();
  await browser.runtime.sendMessage({
    type: "select-this-browser",
    browserId,
  });
}

/**
 * Fetch the current ACTIVE/STANDBY state from the background on options-page
 * open and reflect it on the badge immediately, so it is not stale until the
 * next broker push (which can be a long time away). The background replies with
 * its cached `lastActiveStatus`. If the background is asleep / does not answer
 * (no `{active}` in the reply), default to STANDBY without throwing — the live
 * relay will correct the badge on the next push.
 */
export async function fetchInitialActiveStatus(): Promise<void> {
  try {
    const resp: any = await browser.runtime.sendMessage({
      type: "get-active-status",
    });
    applyActiveStatus(!!(resp && resp.active));
  } catch {
    // Background asleep or no receiver — leave the default STANDBY.
    applyActiveStatus(false);
  }
}
