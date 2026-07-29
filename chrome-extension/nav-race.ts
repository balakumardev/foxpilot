/**
 * Background-side navigation race for input dispatch. A click whose handler does
 * `window.location.href = <cross-origin URL>` tears down the content-script
 * world before its ack can return, so the content-script reply promise hangs and
 * the broker times out — even though the click WORKED. The background context
 * survives the navigation, so we watch tabs.onUpdated(status:"loading") on the
 * target tab and, if it fires before the ack, report success with navigated:true.
 * tabs.onUpdated needs only the "tabs" permission (already granted) — no
 * webNavigation, no new CWS scope.
 *
 * THIRD ARM — the leak plug. Both arms above can hang forever: a frozen or
 * bfcached content-script world never acks, and a same-document / iframe
 * navigation (or one parked behind `beforeunload` or a blocking `confirm()`)
 * never fires status:"loading". When BOTH hang the `finally` below never runs
 * and the tabs.onUpdated listener leaks for the life of the service worker —
 * and each leaked listener then resolves some UNRELATED later click as
 * {ok:true, navigated:true}, i.e. reports success for a click that never
 * happened. A false positive is strictly worse than a timeout, so a deadline
 * arm guarantees the promise settles and the listener is always released.
 *
 * The plug deliberately does NOT try to beat the broker's response timer.
 * INVARIANT: LEAK_PLUG_MS >= the largest per-command budget in
 * mcp-server/timeouts.ts (45000 today — take-screenshot and browser-fetch). It
 * is pinned to REQUEST_TIMEOUT_MS (mcp-server/browser-api.ts) rather than to
 * that number, because the outer client cap enforces the invariant for free: a
 * per-command budget raised above the cap could never be honoured anyway, which
 * is why timeouts.ts already keeps browser-fetch "just under the 60000ms client
 * cap". While the invariant holds, the plug can never cut a healthy action
 * short: by the time it fires the broker has already failed the pending, and
 * the frame it produces is dropped as a late/unknown correlationId (logged).
 *
 * It resolves ok:false — never ok:true — because the action's fate is genuinely
 * unknown at that point, and resolving true would recreate the very
 * false-positive class this arm exists to close.
 *
 * Resolving rather than REJECTING is NOT about how the caller classifies it —
 * the two are classified identically. browser-api.ts's clickElement throws
 * `new Error(message.error)` on ok:false and point-format.ts sets isError:true
 * on it, so ok:false already surfaces as a CONFIRMED failure; the error TEXT is
 * the only lever in either design, which is why it names the outcome UNKNOWN
 * outright. Resolving wins on the wire instead. No call site wraps this in
 * try/catch, so a reject would unwind to background.ts's catch-all, which
 * answers with an unsigned ExtensionError frame ({correlationId, errorMessage})
 * in place of the signed action-result the call site sends — dropping the
 * append-only fields that frame carries (navigated / intercepted / element /
 * selected) and pooling "outcome unknown" in with the extension's genuine error
 * class (deny-list, missing host permission, Automation Mode off), which are
 * confirmed failures and safe to retry.
 *
 * `deadlineAt` is an absolute epoch-ms deadline and stays optional so every
 * existing two-arg call site is unaffected.
 */

/** Fallback deadline for the leak-plug arm when the caller supplies none. */
const LEAK_PLUG_MS = 60000;

export async function raceInputAgainstNavigation<T extends { ok: boolean }>(
  tabId: number,
  dispatch: Promise<T>,
  deadlineAt?: number
): Promise<T | { ok: true; navigated: true } | { ok: false; error: string }> {
  let onUpdated: ((id: number, info: { status?: string }) => void) | null = null;
  const navPromise = new Promise<{ ok: true; navigated: true }>((resolve) => {
    onUpdated = (id, info) => {
      if (id === tabId && info && info.status === "loading") {
        resolve({ ok: true, navigated: true });
      }
    };
    (chrome as any).tabs.onUpdated.addListener(onUpdated);
  });
  // Bare setTimeout/clearTimeout typed through ReturnType — deliberately NOT
  // self.setTimeout / window.setTimeout. The two client.ts files diverge on
  // exactly that global, and copying either one here would break the parity of
  // these two nav-race bodies (guarded by __tests__/mirror.test.ts).
  const plugMs = Math.max(
    0,
    (deadlineAt ?? Date.now() + LEAK_PLUG_MS) - Date.now()
  );
  let plugTimer: ReturnType<typeof setTimeout> | null = null;
  const plugPromise = new Promise<{ ok: false; error: string }>((resolve) => {
    plugTimer = setTimeout(() => {
      resolve({
        ok: false,
        error:
          `No dispatch ack and no navigation within ${plugMs}ms — the outcome of ` +
          `this input action is UNKNOWN. It may already have been applied to the ` +
          `page. Verify the page state before retrying.`,
      });
    }, plugMs);
  });
  try {
    return await Promise.race([dispatch, navPromise, plugPromise]);
  } finally {
    if (onUpdated) {
      (chrome as any).tabs.onUpdated.removeListener(onUpdated);
    }
    // Clearing matters even when dispatch or nav won the race: an un-cleared
    // 60s timer keeps the event loop (and jest) awake long after the action.
    if (plugTimer !== null) {
      clearTimeout(plugTimer);
    }
  }
}
