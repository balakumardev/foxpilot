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
