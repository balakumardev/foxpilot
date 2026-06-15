import { getOrCreateBrowserId } from "./extension-config";
import type { BrokerBrowserInfo } from "./transport";

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
 * Render the other browsers currently connected to the broker into
 * #connected-browsers, so STANDBY is self-explanatory ("X is driving"). The
 * caller passes the welcome/healthcheck roster and THIS browser's id; the
 * current browser is excluded and disconnected entries are skipped. When no
 * other browser is connected, an "only this browser" message is shown instead
 * of an empty box.
 */
export function renderConnectedBrowsers(
  browsers: BrokerBrowserInfo[],
  myBrowserId: string
): void {
  const container = document.getElementById("connected-browsers");
  if (!container) {
    return;
  }
  const others = (browsers || []).filter(
    (b) => b && b.connected && b.browserId !== myBrowserId
  );
  if (others.length === 0) {
    container.textContent = "Only this browser is connected to the broker.";
    return;
  }
  container.textContent = "";
  const intro = document.createElement("div");
  intro.textContent = "Other browsers connected to the broker:";
  intro.style.marginBottom = "6px";
  container.appendChild(intro);

  const list = document.createElement("ul");
  list.style.margin = "0";
  list.style.paddingLeft = "18px";
  for (const b of others) {
    const li = document.createElement("li");
    const label = b.label || b.type || b.browserId;
    li.textContent = b.active ? `${label} (${b.type}) — ACTIVE` : `${label} (${b.type})`;
    list.appendChild(li);
  }
  container.appendChild(list);
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
 * its cached `lastActiveStatus` (welcome-derived, so a LONE browser correctly
 * reports ACTIVE) plus the connected-browser roster, which we render so STANDBY
 * is self-explanatory. If the background is asleep / does not answer, default to
 * STANDBY without throwing — the live relay corrects the badge on the next push.
 */
export async function fetchInitialActiveStatus(): Promise<void> {
  try {
    const resp: any = await browser.runtime.sendMessage({
      type: "get-active-status",
    });
    applyActiveStatus(!!(resp && resp.active));
    if (resp && Array.isArray(resp.browsers)) {
      const myBrowserId =
        typeof resp.browserId === "string"
          ? resp.browserId
          : await getOrCreateBrowserId();
      renderConnectedBrowsers(resp.browsers, myBrowserId);
    }
  } catch {
    // Background asleep or no receiver — leave the default STANDBY.
    applyActiveStatus(false);
  }
}
