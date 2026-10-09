/**
 * select-option injected executor (ISOLATED world, CSP-immune, async).
 *
 * Drives BOTH a native <select> and a custom combobox (react-select / Downshift /
 * Radix-shaped: a role="combobox"/button trigger that opens a role="listbox" of
 * role="option" items, often in a portal appended to <body>). Used two ways like
 * the other injected fns: (a) imported + unit-tested in jsdom; (b) run in the
 * isolated content-script world — Firefox stringifies it via `.toString()` and
 * injects it with executeScript (native Firefox executeScript awaits the returned
 * Promise). MUST stay fully self-contained: inner helpers only, no imports /
 * module refs (guarded by self-containment.test.ts). Async is preserved by
 * esbuild(esnext) and the ES2022 tsconfig — no __awaiter/__generator helper
 * appears in .toString().
 */
export async function selectOption(
  doc: Document,
  args: { uid: string; option: string; exact?: boolean }
): Promise<{ ok: boolean; selected?: string; error?: string }> {
  const UID_ATTR = "data-bcmcp-uid";
  const wantExact = args.exact === true;
  const rawWant = args.option == null ? "" : String(args.option);
  const want = rawWant.replace(/\s+/g, " ").trim().toLowerCase();
  // Option rows across the supported combobox families. `.ant-select-item-option`
  // is antd 4 / rc-select, whose REAL rows carry NO role attribute at all: the
  // only role="option" nodes it renders live inside a 0x0 overflow:hidden
  // listbox that exists purely to back aria-activedescendant. Matching those and
  // nothing else is what made select-option click an invisible mirror row and
  // then report success while the value never changed.
  const OPTION_SELECTOR =
    '[role="option"], [role="listbox"] li, li[role="option"], .select__option, .ant-select-item-option';

  // Is a real layout engine active? In jsdom every getBoundingClientRect() is
  // 0x0, so the geometry guard below must be disabled there or it would reject
  // every option. Mirrors snapshot-script.ts's layoutActive.
  const layoutActive = (function (): boolean {
    try {
      const de = doc.documentElement as Element | null;
      if (de && typeof de.getBoundingClientRect === "function") {
        const r = de.getBoundingClientRect();
        return !!(r && r.height > 0);
      }
    } catch (e) {
      /* no layout — treat as inactive */
    }
    return false;
  })();

  // Reject option rows that cannot receive a real click: a closed dropdown's
  // rows (display:none) and rc-select's aria mirror, whose rows inherit zero
  // WIDTH from their 0x0 overflow:hidden listbox while keeping a nonzero height
  // (so a width-and-height test would miss them). Geometry is gated on
  // layoutActive, leaving the jsdom unit tests byte-for-byte unaffected.
  function isUnclickableOption(el: Element): boolean {
    const dv = doc.defaultView;
    if (dv && typeof dv.getComputedStyle === "function") {
      let cs: CSSStyleDeclaration | null = null;
      try {
        cs = dv.getComputedStyle(el);
      } catch (e) {
        cs = null;
      }
      if (cs && (cs.display === "none" || cs.visibility === "hidden")) {
        return true;
      }
    }
    if (layoutActive) {
      try {
        const r = el.getBoundingClientRect();
        if (r && (r.width === 0 || r.height === 0)) {
          return true;
        }
      } catch (e) {
        /* unreadable geometry — do not exclude on this basis */
      }
    }
    return false;
  }

  function norm(s: string | null | undefined): string {
    return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  }
  function textMatches(candidate: string): boolean {
    const c = norm(candidate).toLowerCase();
    if (c.length === 0) {
      return false;
    }
    return wantExact ? c === want : c.indexOf(want) !== -1;
  }
  // Deepest-wins option match (option-scoped variant of snapshot-script.ts
  // isLeafTextMatch): the element contains the needle AND no DESCENDANT OPTION
  // row also contains it. Scoping the descendant check to option rows (not every
  // element) means a plain option whose label is wrapped in <span>/<small> still
  // matches, while a genuinely nested option group still resolves to the deepest.
  function isLeafTextMatch(el: Element): boolean {
    if (!textMatches(el.textContent || "")) {
      return false;
    }
    const kids = el.querySelectorAll(OPTION_SELECTOR);
    for (let k = 0; k < kids.length; k++) {
      if (textMatches(kids[k].textContent || "")) {
        return false;
      }
    }
    return true;
  }
  function sleep(ms: number): Promise<void> {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function bcmcpSig(el: any): string {
    var role = el.getAttribute && (el.getAttribute("role") || "");
    var name =
      (el.getAttribute &&
        (el.getAttribute("aria-label") ||
          el.getAttribute("name") ||
          el.getAttribute("data-testid") ||
          "")) ||
      "";
    var t = (el.tagName || "") + "|" + role + "|" + (el.id || "") + "|" + name;
    var h = 0;
    for (var i = 0; i < t.length; i++) {
      h = ((h << 5) - h + t.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  // --- shadow-DOM helpers. The same bodies are inlined in every injected
  //     module that walks shadow roots; keep the copies identical. ---

  // Elements allowed to host a shadow root (attachShadow's list) plus autonomous custom elements —
  // the closed-root APIs are only worth calling for these.
  const SHADOW_HOST_TAGS: Record<string, true> = { article: true, aside: true, blockquote: true, body: true,
    div: true, footer: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, header: true,
    main: true, nav: true, p: true, section: true, span: true };

  // Open root, else a closed root via the extension-only APIs (content-script world only):
  // Firefox exposes a read-only `openOrClosedShadowRoot` PROPERTY (Fx 63+); Chrome exposes
  // `chrome.dom.openOrClosedShadowRoot(el)` (Chrome 88+, no permission). Neither exists in the page world.
  // PERF (measured): chrome.dom.openOrClosedShadowRoot costs 2.5-8.6 µs per call and div/span are host
  // candidates, so walks memoize the closed-root probe PER INJECTED-FUNCTION CALL. The cache is declared
  // inside the exported function (never module scope). Async selectOption must not reuse it across awaits.
  const closedRootCache = new Map<Element, ShadowRoot | null>();
  function shadowRootOf(el: Element): ShadowRoot | null {
    const open = (el as any).shadowRoot as ShadowRoot | null | undefined;
    if (open) return open;
    const tag = el.localName;
    if (tag.indexOf("-") < 0 && !SHADOW_HOST_TAGS[tag]) return null;
    if (closedRootCache.has(el)) return closedRootCache.get(el) as ShadowRoot | null;
    let found: ShadowRoot | null = null;
    try { const ff = (el as any).openOrClosedShadowRoot; if (ff) found = ff as ShadowRoot; } catch (_) {}
    if (!found) {
      try {
        const dom = (globalThis as any).chrome && (globalThis as any).chrome.dom;
        if (dom && typeof dom.openOrClosedShadowRoot === "function") found = (dom.openOrClosedShadowRoot(el) as ShadowRoot) || null;
      } catch (_) {}
    }
    closedRootCache.set(el, found);
    return found;
  }
  // Tree-of-trees search (document tree + every reachable shadow tree, incl. unassigned light nodes'
  // roots). Use for uid resolution and for clearing stale uids — NOT for listing (listing is flat-tree).
  // Two passes: OPEN roots first (a plain .shadowRoot read, no extension call), then — only on a miss —
  // closed roots too, so a light-DOM or open-root match never pays for the closed-root probe.
  function deepQuery(root: Document | ShadowRoot, sel: string): Element | null {
    function walk(r: Document | ShadowRoot, closed: boolean): Element | null {
      const hit = r.querySelector(sel);
      if (hit) return hit;
      const all = r.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const sr = closed ? shadowRootOf(all[i]) : ((all[i] as any).shadowRoot as ShadowRoot | null);
        if (sr) { const h = walk(sr, closed); if (h) return h; }
      }
      return null;
    }
    return walk(root, false) || walk(root, true);
  }
  function deepQueryAll(root: Document | ShadowRoot, sel: string, out: Element[] = []): Element[] {
    const hits = root.querySelectorAll(sel);
    for (let i = 0; i < hits.length; i++) out.push(hits[i]);
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) { const sr = shadowRootOf(all[i]); if (sr) deepQueryAll(sr, sel, out); }
    return out;
  }
  function deepActiveElement(doc: Document): Element | null {
    let a: Element | null = doc.activeElement;
    for (let depth = 0; a && depth < 32; depth++) {
      const sr = shadowRootOf(a);
      const inner = sr ? sr.activeElement : null;
      if (!inner || inner === a) break;
      a = inner;
    }
    return a;
  }

  try {
    const win = doc.defaultView as (Window & typeof globalThis) | null;
    // deepQuery: the uid may be stamped inside a shadow root.
    const el = deepQuery(doc, "[" + UID_ATTR + '="' + args.uid + '"]');
    if (!el) {
      return {
        ok: false,
        error:
          "Element uid '" +
          args.uid +
          "' not found — take a fresh snapshot (uids are reassigned each snapshot).",
      };
    }
    // Identity guard (see action-script.ts resolve): a recycled node under the
    // same uid is treated as stale so the caller re-snapshots.
    const sig = el.getAttribute("data-bcmcp-sig");
    if (sig && bcmcpSig(el) !== sig) {
      return {
        ok: false,
        error:
          "Element uid '" +
          args.uid +
          "' not found — take a fresh snapshot (uids are reassigned each snapshot).",
      };
    }

    try {
      (el as { scrollIntoView?: (opts?: unknown) => void }).scrollIntoView?.({
        block: "center",
      });
    } catch (e) {
      /* jsdom lacks a layout engine — never throw on scroll */
    }

    // --- focus-change helpers: the focus-event part. action-script.ts and
    //     point-action-script.ts carry the same bodies; keep them identical. ---

    // A document without system focus (a background tab, or a browser window
    // behind another app) still moves activeElement on focus() and blur(), but
    // the browser fires no blur, focusout, focus or focusin. changeFocus runs a
    // focus move, then fires each of those events the browser did not fire
    // itself (see action-script.ts). Here it wraps the trigger, search box and
    // option the pick focuses, so a field focused before select-option still
    // gets its blur in a background tab.
    const FOCUS_EVENT_TYPES = ["blur", "focusout", "focus", "focusin"];

    function focusEvt(type: string, related: Element | null): Event {
      const init = {
        bubbles: type === "focusin" || type === "focusout",
        cancelable: false,
        composed: true,
        relatedTarget: related,
        view: win as Window,
      };
      const FE = win && (win as { FocusEvent?: typeof FocusEvent }).FocusEvent;
      if (typeof FE === "function") {
        return new (FE as typeof FocusEvent)(type, init as FocusEventInit);
      }
      return new Event(type, init);
    }

    // The element that has focus, or null while the document itself has it.
    // With nothing focused (activeElement is the body) there is nothing to
    // drill into, so no closed-root probe is spent on the body.
    function focusedElement(): Element | null {
      const top = doc.activeElement;
      if (!top || top === doc.body || top === doc.documentElement) {
        return null;
      }
      return deepActiveElement(doc);
    }

    function changeFocus(move: () => void): void {
      const before = focusedElement();
      const fired: Record<string, boolean> = {};
      const note = function (e: Event): void {
        const t = e.target as Node | null;
        if (e.isTrusted && t && t.nodeType === 1) {
          fired[e.type] = true;
        }
      };
      const at: EventTarget = win || doc;
      for (let i = 0; i < FOCUS_EVENT_TYPES.length; i++) {
        at.addEventListener(FOCUS_EVENT_TYPES[i], note, true);
      }
      try {
        move();
      } finally {
        for (let i = 0; i < FOCUS_EVENT_TYPES.length; i++) {
          at.removeEventListener(FOCUS_EVENT_TYPES[i], note, true);
        }
      }
      const after = focusedElement();
      if (after === before) {
        return;
      }
      if (before && before.isConnected && !fired.blur && !fired.focusout) {
        before.dispatchEvent(focusEvt("blur", after));
        before.dispatchEvent(focusEvt("focusout", after));
      }
      if (after && !fired.focus && !fired.focusin) {
        after.dispatchEvent(focusEvt("focus", before));
        after.dispatchEvent(focusEvt("focusin", before));
      }
    }

    function mouseEvt(type: string): Event {
      return new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: win as Window,
      });
    }
    function activate(node: Element): void {
      node.dispatchEvent(mouseEvt("pointerdown"));
      node.dispatchEvent(mouseEvt("mousedown"));
      node.dispatchEvent(mouseEvt("mouseup"));
      changeFocus(function () {
        try {
          (node as { focus?: () => void }).focus?.();
        } catch (e) {
          /* not focusable */
        }
      });
      changeFocus(function () {
        try {
          (node as { click?: () => void }).click?.();
        } catch (e) {
          /* ignore activation errors */
        }
      });
    }

    // --- native <select> ---
    if (el.tagName === "SELECT") {
      const opts = (el as HTMLSelectElement).options;
      let chosen: HTMLOptionElement | null = null;
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i];
        if (textMatches(o.textContent || "") || textMatches(o.value || "")) {
          chosen = o;
          break;
        }
      }
      if (!chosen) {
        return {
          ok: false,
          error:
            'No <option> matching "' +
            rawWant +
            '" in the native <select> uid ' +
            args.uid +
            ".",
        };
      }
      (el as HTMLSelectElement).value = chosen.value;
      // input is composed (it crosses shadow boundaries, as the browser's own
      // does); change is not.
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, selected: norm(chosen.textContent || chosen.value) };
    }

    // --- custom combobox ---
    // 1. Open the menu.
    activate(el);

    // 2. If a search <input> appears (react-select/Downshift render one), type
    //    the wanted text to filter (framework-safe native setter + input event,
    //    the type-at pattern). The menu is often portaled, so look inside the
    //    control first, then across the document.
    function findSearchInput(control: Element): HTMLInputElement | null {
      // 0. The control may itself BE the search <input> (Downshift-style combobox
      //    where role="combobox" sits on the input). Trivially in-scope.
      if (
        control.tagName === "INPUT" &&
        (control.getAttribute("type") || "text").toLowerCase() !== "hidden"
      ) {
        return control as HTMLInputElement;
      }
      // 1. A filter <input> rendered INSIDE the combobox control (react-select /
      //    Downshift put one here). Scoped to the control's subtree.
      const local = control.querySelector(
        'input:not([type="hidden"])'
      ) as HTMLInputElement | null;
      if (local) {
        return local;
      }
      // 2. The control's OWNED popup: aria-controls / aria-owns point at the
      //    (often portaled) listbox/menu. Scope the search-input lookup to THAT
      //    container only. A document-wide input[type="search"] fallback is
      //    deliberately avoided — it could type the option text into an unrelated
      //    site search box and trigger the site's own search.
      const ref =
        (control.getAttribute("aria-controls") || "") +
        " " +
        (control.getAttribute("aria-owns") || "");
      const ids = ref.split(/\s+/);
      // IDs are scoped per tree: look the popup up in the control's own tree
      // (its shadow root, when it lives in one) first, then in the document for
      // a menu portaled out to <body>.
      const home = control.getRootNode() as Node;
      const scope: Document | ShadowRoot =
        home && (home.nodeType === 9 || home.nodeType === 11)
          ? (home as Document | ShadowRoot)
          : doc;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (!id) {
          continue;
        }
        const container =
          scope.getElementById(id) || (scope !== doc ? doc.getElementById(id) : null);
        if (container) {
          const scoped = container.querySelector(
            'input:not([type="hidden"])'
          ) as HTMLInputElement | null;
          if (scoped) {
            return scoped;
          }
        }
      }
      // 3. No in-scope search input — proceed WITHOUT typing (clicking the
      //    matching option alone drives the pick).
      return null;
    }
    const search = findSearchInput(el);
    if (search) {
      changeFocus(function () {
        try {
          (search as { focus?: () => void }).focus?.();
        } catch (e) {
          /* ignore */
        }
      });
      const proto = win!.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = descriptor && descriptor.set;
      if (setter) {
        setter.call(search, rawWant);
      } else {
        (search as { value?: string }).value = rawWant;
      }
      search.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      for (let i = 0; i < rawWant.length; i++) {
        const ch = rawWant.charAt(i);
        search.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
        search.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      }
    }

    // 3. Poll for a matching option to render (portal menus mount async). Bounded:
    //    ≤ 15 iterations × 300ms. First check is at iter 0 (no sleep) so an
    //    already-open menu resolves immediately.
    function pickOption(nodes: ArrayLike<Element>): Element | null {
      for (let i = 0; i < nodes.length; i++) {
        if (isUnclickableOption(nodes[i])) {
          continue;
        }
        if (isLeafTextMatch(nodes[i])) {
          return nodes[i];
        }
      }
      return null;
    }
    // Option rows inside every OPEN shadow root on the page, reached through
    // plain .shadowRoot reads (no extension call).
    function openShadowRows(r: Document | ShadowRoot, out: Element[]): Element[] {
      const all = r.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const sr = (all[i] as any).shadowRoot as ShadowRoot | null;
        if (sr) {
          const rows = sr.querySelectorAll(OPTION_SELECTOR);
          for (let j = 0; j < rows.length; j++) {
            out.push(rows[j]);
          }
          openShadowRows(sr, out);
        }
      }
      return out;
    }
    // Option rows in the closed shadow tree the control lives in or hosts — the
    // one closed tree a closed-root select renders its own listbox into (nested
    // roots within it included). Whatever is reachable through open roots alone
    // is openShadowRows' job already.
    function controlClosedRows(): Element[] {
      const out: Element[] = [];
      const home = el!.getRootNode();
      let openly = true;
      let r: Node = home;
      for (let depth = 0; r.nodeType === 11 && depth < 32; depth++) {
        const h = (r as ShadowRoot).host;
        if (!h || h.shadowRoot !== r) {
          openly = false;
          break;
        }
        r = h.getRootNode();
      }
      if (!openly) {
        deepQueryAll(home as ShadowRoot, OPTION_SELECTOR, out);
      } else {
        const own = shadowRootOf(el!);
        if (own && el!.shadowRoot !== own) {
          deepQueryAll(own, OPTION_SELECTOR, out);
        }
      }
      return out;
    }
    function findOption(): Element | null {
      // The light DOM first — exactly the old lookup, so a page without shadow
      // roots does no extra work when the option is there. Then open shadow
      // roots anywhere, then the control's own closed tree. A page-wide
      // closed-root probe on every 300 ms poll would cost one extension call per
      // element per poll, even on a page with no shadow roots at all.
      return (
        pickOption(doc.querySelectorAll(OPTION_SELECTOR)) ||
        pickOption(openShadowRows(doc, [])) ||
        pickOption(controlClosedRows())
      );
    }
    // Opening the menu ran the page's own handlers, and every await below lets
    // it run more — either can attach a new shadow root (a web-component
    // listbox rendering its rows). Never search with a closed-root probe cached
    // before that: clear it after the activation and after each await.
    closedRootCache.clear();
    let optionEl: Element | null = null;
    for (let iter = 0; iter < 15; iter++) {
      optionEl = findOption();
      if (optionEl) {
        break;
      }
      await sleep(300);
      closedRootCache.clear();
    }
    if (!optionEl) {
      return {
        ok: false,
        error:
          'No option matching "' +
          rawWant +
          '" appeared in the dropdown for uid ' +
          args.uid +
          " (opened the menu but the option never rendered — it may be a virtualized list, or the trigger is not a supported combobox).",
      };
    }

    // 4. Click the option.
    try {
      (optionEl as { scrollIntoView?: (o?: unknown) => void }).scrollIntoView?.({
        block: "center",
      });
    } catch (e) {
      /* ignore */
    }
    activate(optionEl);

    // 5. Re-read the control's displayed value: react-select shows it in a
    //    [class*="singleValue"] child; else aria-valuetext; else trigger text.
    await sleep(60);
    closedRootCache.clear();
    function readDisplayed(control: Element): string {
      const single = control.querySelector(
        '[class*="singleValue"], [class*="single-value"]'
      );
      if (single && norm(single.textContent || "")) {
        return norm(single.textContent || "");
      }
      // antd renders one .ant-select-selection-item per COMMITTED value (a
      // single select has exactly one; a multiple select has one tag each), so
      // reading it reports what the control actually holds instead of echoing
      // back the row we clicked. The remove button inside a tag carries the
      // class ant-select-selection-item-remove, a different class token, so it
      // is not matched here.
      const items = control.querySelectorAll(".ant-select-selection-item");
      const picked: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const t = norm(
          items[i].getAttribute("title") || items[i].textContent || ""
        );
        if (t) {
          picked.push(t);
        }
      }
      if (picked.length) {
        return picked.join(", ");
      }
      const vt = control.getAttribute("aria-valuetext");
      if (vt && norm(vt)) {
        return norm(vt);
      }
      return norm(control.textContent || "");
    }
    const shown = readDisplayed(el);
    return { ok: true, selected: shown || norm(optionEl.textContent || "") };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
