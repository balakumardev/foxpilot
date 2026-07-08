/**
 * dismiss-overlays injected executor (ISOLATED world, CSP-immune, synchronous).
 *
 * Clears cookie-consent banners and modal overlays. Staged, privacy-preserving:
 *   Phase 1 — click a known reject/decline control by id.
 *   Phase 2 — click a text-matched reject/decline control inside a known
 *             consent container.
 *   Phase 3 — remove known overlay node(s) + generic aria-modal dialogs +
 *             backdrops, and restore the page's scroll lock.
 * Idempotent (a second call finds nothing left → dismissed:[]). Used two ways
 * like the other injected fns: imported + unit-tested in jsdom, and run in the
 * isolated content-script world (Firefox stringifies via `.toString()` and
 * injects it with executeScript). Fully self-contained: inner helpers only, no
 * imports / module refs (guarded by self-containment.test.ts).
 */
export function dismissOverlays(
  doc: Document
): { ok: boolean; dismissed: string[]; method?: "reject" | "remove"; error?: string } {
  try {
    const dismissed: string[] = [];
    const win = doc.defaultView as (Window & typeof globalThis) | null;

    function isVisible(el: Element): boolean {
      if (win && typeof win.getComputedStyle === "function") {
        try {
          const cs = win.getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") {
            return false;
          }
        } catch (e) {
          /* ignore */
        }
      }
      return true;
    }
    function clickIfPresent(selector: string): boolean {
      const btn = doc.querySelector(selector) as HTMLElement | null;
      if (btn && isVisible(btn)) {
        try {
          btn.click();
          return true;
        } catch (e) {
          return false;
        }
      }
      return false;
    }
    // A reject/decline/"necessary only" control inside `container`, by text /
    // aria-label / value.
    function clickRejectByText(container: Element): boolean {
      const rejectRe =
        /(reject|decline|refuse|deny|necessary only|only necessary|essential only|reject all|decline all|do not (accept|agree))/i;
      const controls = container.querySelectorAll(
        'button, [role="button"], a[href], input[type="button"], input[type="submit"]'
      );
      for (let i = 0; i < controls.length; i++) {
        const c = controls[i] as HTMLElement;
        const label =
          (c.textContent || "") +
          " " +
          (c.getAttribute("aria-label") || "") +
          " " +
          ((c as HTMLInputElement).value || "");
        if (rejectRe.test(label) && isVisible(c)) {
          try {
            c.click();
            return true;
          } catch (e) {
            /* try the next control */
          }
        }
      }
      return false;
    }
    function removeAll(selector: string): boolean {
      const nodes = doc.querySelectorAll(selector);
      let removed = false;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n && n.parentNode) {
          n.parentNode.removeChild(n);
          removed = true;
        }
      }
      return removed;
    }
    function restoreScroll(): void {
      const body = doc.body;
      const de = doc.documentElement;
      if (body && (body as HTMLElement).style) {
        (body as HTMLElement).style.overflow = "";
        (body as HTMLElement).style.position = "";
      }
      if (de && (de as HTMLElement).style) {
        (de as HTMLElement).style.overflow = "";
      }
      const lockClasses = [
        "ot-overflow-hidden",
        "modal-open",
        "no-scroll",
        "overflow-hidden",
      ];
      for (let i = 0; i < lockClasses.length; i++) {
        if (body) {
          body.classList.remove(lockClasses[i]);
        }
        if (de) {
          de.classList.remove(lockClasses[i]);
        }
      }
    }

    // --- Phase 1: known reject/decline controls by id ---
    const idRejects: [string, string][] = [
      ["#onetrust-reject-all-handler", "OneTrust"],
      ["#CybotCookiebotDialogBodyButtonDecline", "Cookiebot"],
      [".ot-pc-refuse-all-handler", "OneTrust-pc"],
    ];
    for (let i = 0; i < idRejects.length; i++) {
      if (clickIfPresent(idRejects[i][0])) {
        dismissed.push(idRejects[i][1]);
      }
    }
    if (dismissed.length > 0) {
      return { ok: true, dismissed, method: "reject" };
    }

    // --- Phase 2: text-based reject inside a known consent container ---
    const rejectContainers: [string, string][] = [
      ["#onetrust-banner-sdk", "OneTrust"],
      ["#onetrust-pc-sdk", "OneTrust-pc"],
      ["#truste-consent-track", "TrustArc"],
      ["#truste-consent-content", "TrustArc"],
      ["#CybotCookiebotDialog", "Cookiebot"],
      [".osano-cm-window", "Osano"],
      [".qc-cmp2-container", "Quantcast"],
      ["#qc-cmp2-container", "Quantcast"],
    ];
    for (let i = 0; i < rejectContainers.length; i++) {
      const c = doc.querySelector(rejectContainers[i][0]);
      if (c && isVisible(c) && clickRejectByText(c)) {
        dismissed.push(rejectContainers[i][1]);
        return { ok: true, dismissed, method: "reject" };
      }
    }

    // --- Phase 3: remove known overlays + generic modals + backdrops ---
    const removeGroups: [string, string][] = [
      ["#onetrust-consent-sdk", "OneTrust"],
      ["#onetrust-banner-sdk", "OneTrust-banner"],
      ["#onetrust-pc-sdk", "OneTrust-pc"],
      [".onetrust-pc-dark-filter", "OneTrust-filter"],
      ["#truste-consent-track", "TrustArc"],
      [".truste_overlay", "TrustArc-overlay"],
      ["#CybotCookiebotDialog", "Cookiebot"],
      [".osano-cm-window", "Osano"],
      [".qc-cmp2-container", "Quantcast"],
      ["#qc-cmp2-container", "Quantcast"],
    ];
    let removedAny = false;
    for (let i = 0; i < removeGroups.length; i++) {
      if (removeAll(removeGroups[i][0])) {
        dismissed.push(removeGroups[i][1]);
        removedAny = true;
      }
    }

    // Generic aria-modal dialogs (prefer a text reject; else remove).
    const modals = doc.querySelectorAll(
      '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
    );
    for (let i = 0; i < modals.length; i++) {
      const m = modals[i];
      if (!isVisible(m)) {
        continue;
      }
      if (clickRejectByText(m)) {
        dismissed.push("modal:reject");
        // A reject click on a generic modal counts as reject even amid removals;
        // still fall through to backdrop cleanup below.
        continue;
      }
      if (m.parentNode) {
        m.parentNode.removeChild(m);
        dismissed.push("modal");
        removedAny = true;
      }
    }

    // Common backdrops/scrims.
    if (
      removeAll(
        '.modal-backdrop, .backdrop, .ReactModal__Overlay, [class*="overlay"][class*="backdrop"]'
      )
    ) {
      dismissed.push("backdrop");
      removedAny = true;
    }

    if (dismissed.length === 0) {
      return { ok: true, dismissed, method: undefined };
    }
    if (removedAny) {
      restoreScroll();
    }
    // method: "reject" only when EVERY dismissal was a reject click; else "remove".
    let anyReject = false;
    let anyRemove = false;
    for (let i = 0; i < dismissed.length; i++) {
      if (dismissed[i] === "modal:reject") {
        anyReject = true;
      } else {
        anyRemove = true;
      }
    }
    return {
      ok: true,
      dismissed,
      method: anyRemove ? "remove" : anyReject ? "reject" : undefined,
    };
  } catch (e) {
    return { ok: false, dismissed: [], error: String(e) };
  }
}
