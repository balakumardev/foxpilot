/**
 * Background-side navigation race for input dispatch. A click whose handler does
 * `window.location.href = <cross-origin URL>` tears down the content-script
 * world before its ack can return, so the content-script reply promise hangs and
 * the broker times out — even though the click WORKED. The background context
 * survives the navigation, so we watch tabs.onUpdated(status:"loading") on the
 * target tab and, if it fires before the ack, report success with navigated:true.
 * tabs.onUpdated needs only the "tabs" permission (already granted) — no
 * webNavigation, no new AMO scope. Firefox uses the `browser` WebExtension
 * global (the rest of this extension does too); the onUpdated callback signature
 * is (tabId, changeInfo, tab), same shape Chrome uses.
 */
export async function raceInputAgainstNavigation<T extends { ok: boolean }>(
  tabId: number,
  dispatch: Promise<T>
): Promise<T | { ok: true; navigated: true }> {
  let onUpdated: ((id: number, info: { status?: string }) => void) | null = null;
  const navPromise = new Promise<{ ok: true; navigated: true }>((resolve) => {
    onUpdated = (id, info) => {
      if (id === tabId && info && info.status === "loading") {
        resolve({ ok: true, navigated: true });
      }
    };
    (browser as any).tabs.onUpdated.addListener(onUpdated);
  });
  try {
    return await Promise.race([dispatch, navPromise]);
  } finally {
    if (onUpdated) {
      (browser as any).tabs.onUpdated.removeListener(onUpdated);
    }
  }
}
