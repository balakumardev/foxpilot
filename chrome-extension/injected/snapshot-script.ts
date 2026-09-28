/**
 * Accessibility-style snapshot builder.
 *
 * CRITICAL: `buildSnapshot` is used in TWO ways:
 *   (a) Imported and unit-tested directly in jsdom.
 *   (b) Called by content-script.ts in the extension's isolated
 *       content-script world. Its Firefox twin is stringified and injected,
 *       and the two bodies must stay byte-identical.
 *
 * Because of (b) the function MUST be fully self-contained: it may NOT
 * reference any imports, module-scope variables, or sibling functions. Every
 * helper it needs is defined as an inner function. It operates ONLY on the
 * `doc` argument passed to it.
 *
 * It also avoids any layout-dependent APIs (`offsetParent`, `getClientRects`,
 * `getComputedStyle`) because jsdom has no layout engine — relying on those
 * would filter out every element. Visibility is judged purely from explicit
 * markup signals.
 *
 * Shadow DOM: every pass enumerates the FLAT tree (what actually renders), so
 * controls inside open shadow roots — and closed ones, through the
 * content-script-only APIs — are listed once each, in reading order.
 */
export function buildSnapshot(
  doc: Document,
  options: {
    verbose: boolean;
    maxLength: number;
    // Phase-1 additions (all optional; back-compatible):
    includePointer?: boolean; // default true — capture cursor:pointer elements
    maxInteractive?: number; // cap on the pointer pass (default 500)
    selector?: string; // CSS-selector query mode (Task 5)
    textContains?: string; // visible-text query mode (Task 6)
    rootSelector?: string; // region scoping (Task 7)
    offset?: number; // paging (Task 8)
    limit?: number; // paging (Task 8)
  }
): {
  tree: string;
  isTruncated: boolean;
  total?: number;
  hasMore?: boolean;
  error?: string;
  // Document state at snapshot time. A bare 0-element result is otherwise
  // ambiguous: a page mid-navigation, a blank/torn-down document and a page
  // that genuinely has no interactive controls all produce the same empty
  // tree. Reported on the success paths only — the error paths above already
  // say why they returned nothing.
  docState?: { readyState: string; url: string; bodyChildren: number };
} {
  const verbose = !!options.verbose;
  const maxLength = options.maxLength;
  const includePointer = options.includePointer !== false; // default true
  const maxInteractive =
    typeof options.maxInteractive === "number" ? options.maxInteractive : 500;

  const UID_ATTR = "data-bcmcp-uid";
  const SIG_ATTR = "data-bcmcp-sig";
  const NAME_MAX = 120;
  const HINT_NAME_MAX = 60;

  // --- inner helpers (must stay inside this function body) ---

  // Short signature of an element's identity (tag|role|id|name). Stamped
  // alongside the uid so a resolve() at action time can detect a framework node
  // recycled under the same uid and force a fresh snapshot instead of acting on
  // the wrong element. Same algorithm as the copy the input executors carry.
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

  // --- shadow DOM (flat-tree) helpers ---
  // The same bodies are inlined in every injected module that needs them;
  // keep them identical so they can be diffed across modules.

  // Elements allowed to host a shadow root (attachShadow's list) plus autonomous custom elements —
  // the closed-root APIs are only worth calling for these.
  const SHADOW_HOST_TAGS: Record<string, true> = { article: true, aside: true, blockquote: true, body: true,
    div: true, footer: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, header: true,
    main: true, nav: true, p: true, section: true, span: true };

  // Each closed-root probe is an extension-API call (microseconds apiece, several per element per
  // snapshot without this); scoped to this call, so a cached answer is never stale across snapshots.
  const closedRootCache = new Map<Element, ShadowRoot | null>();

  // Open root, else a closed root via the extension-only APIs (content-script world only):
  // Firefox exposes a read-only `openOrClosedShadowRoot` PROPERTY (Fx 63+); Chrome exposes
  // `chrome.dom.openOrClosedShadowRoot(el)` (Chrome 88+, no permission). Neither exists in the page world.
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
  function isInShadowTree(n: Node): boolean {
    const r = n.getRootNode ? n.getRootNode() : null;
    return !!r && r.nodeType === 11 && !!(r as any).host;
  }
  // FLAT-TREE children: a host renders its shadow root's children (its light children only via slots);
  // a <slot> inside a shadow tree renders assignedElements({flatten:true}) (fallback content when nothing
  // is assigned). This is what guarantees nothing is listed twice and unassigned light children are skipped.
  function composedChildren(node: Document | ShadowRoot | Element): Element[] {
    if (node.nodeType === 1) {
      const el = node as Element;
      const sr = shadowRootOf(el);
      if (sr) return Array.from(sr.children);
      if (el.localName === "slot" && isInShadowTree(el)) return Array.from((el as HTMLSlotElement).assignedElements({ flatten: true }));
    }
    return Array.from(node.children);
  }
  // All elements under `root` (exclusive) in flat-tree pre-order. For a tree with no shadow roots this is
  // exactly document order, i.e. the same order root.querySelectorAll("*") gives. Iterative (no recursion).
  function collectComposed(root: Document | ShadowRoot | Element): Element[] {
    const out: Element[] = [];
    const stack = composedChildren(root).reverse();
    while (stack.length) {
      const el = stack.pop() as Element;
      out.push(el);
      const kids = composedChildren(el);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  }
  // Tree-of-trees search (document tree + every reachable shadow tree, incl. unassigned light nodes'
  // roots). Use for uid resolution and for clearing stale uids — NOT for listing (listing is flat-tree).
  function deepQuery(root: Document | ShadowRoot, sel: string): Element | null {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      const sr = shadowRootOf(all[i]);
      if (sr) { const h = deepQuery(sr, sel); if (h) return h; }
    }
    return null;
  }
  function deepQueryAll(root: Document | ShadowRoot, sel: string, out: Element[] = []): Element[] {
    const hits = root.querySelectorAll(sel);
    for (let i = 0; i < hits.length; i++) out.push(hits[i]);
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) { const sr = shadowRootOf(all[i]); if (sr) deepQueryAll(sr, sel, out); }
    return out;
  }
  // Flat-tree parent: slotted node → its slot, top-level node of a shadow tree → host, else parentNode.
  // assignedSlot is ALWAYS null when the host's root is closed (even for extensions), so for a child of a
  // closed host we find the slot from the root side (root.querySelectorAll("slot") + assignedNodes()).
  function composedParent(n: Node): Node | null {
    const slot = (n as any).assignedSlot as Element | null | undefined;
    if (slot) return slot;
    const p = n.parentNode;
    if (!p) return null;
    if (p.nodeType === 11 && (p as any).host) return (p as any).host as Element;
    if (p.nodeType === 1 && !(p as any).shadowRoot) {
      const sr = shadowRootOf(p as Element); // non-null here only for a closed root
      if (sr) {
        const slots = sr.querySelectorAll("slot");
        for (let i = 0; i < slots.length; i++) {
          const assigned = (slots[i] as HTMLSlotElement).assignedNodes();
          for (let j = 0; j < assigned.length; j++) if (assigned[j] === n) return slots[i];
        }
      }
    }
    return p;
  }

  // composedParent, memoized: the hidden-ancestor walk and the descendant
  // marking passes below all climb the same chains.
  const parentMemo = new Map<Node, Node | null>();
  function flatParent(n: Node): Node | null {
    const known = parentMemo.get(n);
    if (known !== undefined) {
      return known;
    }
    const p = composedParent(n);
    parentMemo.set(n, p);
    return p;
  }

  // Flat-tree child NODES (text included) — the text-bearing counterpart of
  // composedChildren, with the same host / slot rules.
  function composedChildNodes(el: Element): ArrayLike<Node> {
    const sr = shadowRootOf(el);
    if (sr) {
      return sr.childNodes;
    }
    if (el.localName === "slot" && isInShadowTree(el)) {
      return (el as HTMLSlotElement).assignedNodes({ flatten: true });
    }
    return el.childNodes;
  }

  function isLabelControlTag(tag: string): boolean {
    return (
      tag === "input" || tag === "select" || tag === "textarea" || tag === "button"
    );
  }

  // <style>/<script> render no text. textContent counts them anyway, and so
  // does the light-DOM path here (unchanged output); but nearly every shadow
  // root carries a <style>, and its CSS must not leak into names or matches.
  function isUnrenderedShadowText(el: Element): boolean {
    const tag = el.localName;
    return (tag === "style" || tag === "script") && isInShadowTree(el);
  }

  // Text query mode reads the composed text of EVERY element, so it is indexed
  // in one flat-tree walk instead of walking each subtree again: textRaw is all
  // text under the snapshot root in flat-tree order and textIndex maps each
  // element to [start, end) in it, plus the same span in textLower (lowercasing
  // can change the length, so the lowercased copy keeps its own offsets).
  let textIndex: Map<Element, number[]> | null = null;
  let textRaw = "";
  let textLower = "";
  function indexComposedText(from: Document | Element): void {
    const index = new Map<Element, number[]>();
    const raw: string[] = [];
    const low: string[] = [];
    let rawPos = 0;
    let lowPos = 0;
    // Entries: a node to visit, or the span of an element whose subtree has
    // just been emitted (closed at the current positions).
    const stack: Array<Node | number[]> = [];
    const top: ArrayLike<Node> =
      from.nodeType === 1 ? composedChildNodes(from as Element) : from.childNodes;
    for (let i = top.length - 1; i >= 0; i--) {
      stack.push(top[i]);
    }
    while (stack.length) {
      const item = stack.pop() as Node | number[];
      if (Array.isArray(item)) {
        item[1] = rawPos;
        item[3] = lowPos;
        continue;
      }
      const n = item as Node;
      if (n.nodeType === 3 || n.nodeType === 4) {
        const s = (n as CharacterData).data;
        const l = s.toLowerCase();
        raw.push(s);
        low.push(l);
        rawPos += s.length;
        lowPos += l.length;
      } else if (n.nodeType === 1) {
        const span = [rawPos, rawPos, lowPos, lowPos];
        index.set(n as Element, span);
        if (isUnrenderedShadowText(n as Element)) {
          continue; // an empty span, as textOf reports
        }
        stack.push(span);
        const kids = composedChildNodes(n as Element);
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push(kids[i]);
        }
      }
    }
    textRaw = raw.join("");
    textLower = low.join("");
    textIndex = index;
  }

  // The element's text content read through the FLAT tree: a host contributes
  // its shadow tree's text (and its light children only where slotted), a slot
  // its assigned nodes (else its fallback). With no shadow roots involved this
  // is exactly el.textContent. skipControls leaves out the text of embedded
  // form controls (a <label>'s own name).
  function textOf(el: Element, skipControls?: boolean): string {
    if (!skipControls && textIndex) {
      const span = textIndex.get(el);
      if (span) {
        return textRaw.slice(span[0], span[1]);
      }
    }
    if (isUnrenderedShadowText(el)) {
      return "";
    }
    const parts: string[] = [];
    const stack: Node[] = [];
    let kids = composedChildNodes(el);
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push(kids[i]);
    }
    while (stack.length) {
      const n = stack.pop() as Node;
      if (n.nodeType === 3 || n.nodeType === 4) {
        parts.push((n as CharacterData).data);
      } else if (
        n.nodeType === 1 &&
        !isUnrenderedShadowText(n as Element) &&
        !(skipControls && isLabelControlTag((n as Element).localName))
      ) {
        kids = composedChildNodes(n as Element);
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push(kids[i]);
        }
      }
    }
    return parts.join("");
  }

  // Is a real layout engine active? In jsdom every getBoundingClientRect() is
  // 0x0, so the pure-geometry visibility check below must be disabled there or it
  // would hide every element. documentElement has a non-zero height only under a
  // real layout engine.
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

  function collapseWhitespace(s: string): string {
    return s.replace(/\s+/g, " ").trim();
  }

  function clip(s: string): string {
    const collapsed = collapseWhitespace(s);
    if (collapsed.length > NAME_MAX) {
      return collapsed.slice(0, NAME_MAX);
    }
    return collapsed;
  }

  function getInlineStyle(el: Element): string {
    return (el.getAttribute("style") || "").toLowerCase();
  }

  // Per-snapshot memo: the DOM does not change while the snapshot runs, and the
  // collapse checks re-ask about elements the main passes also visit.
  const hiddenMemo = new Map<Element, boolean>();
  function isHidden(el: Element): boolean {
    const known = hiddenMemo.get(el);
    if (known !== undefined) {
      return known;
    }
    const hidden = computeHidden(el);
    hiddenMemo.set(el, hidden);
    return hidden;
  }

  // Whether a flat-tree ANCESTOR of el has computed display:none. The walk
  // crosses shadow boundaries (slotted node → slot, shadow tree → host), since a
  // host under display:none renders none of its shadow tree. Memoized per
  // ancestor, inclusive: every node on a walked chain shares the result.
  const displayNoneMemo = new Map<Node, boolean>();
  function displayNoneAbove(el: Element, dv: Window): boolean {
    const chain: Node[] = [];
    let result = false;
    let n: Node | null = flatParent(el);
    while (n && n.nodeType === 1) {
      const known = displayNoneMemo.get(n);
      if (known !== undefined) {
        result = known;
        break;
      }
      chain.push(n);
      let pcs: CSSStyleDeclaration | null = null;
      try {
        pcs = dv.getComputedStyle(n as Element);
      } catch (e) {
        pcs = null;
      }
      if (pcs && pcs.display === "none") {
        result = true;
        break;
      }
      n = flatParent(n);
    }
    for (let i = 0; i < chain.length; i++) {
      displayNoneMemo.set(chain[i], result);
    }
    return result;
  }

  function computeHidden(el: Element): boolean {
    if (el.hasAttribute("hidden")) {
      return true;
    }
    if (el.getAttribute("aria-hidden") === "true") {
      return true;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && el.getAttribute("type") === "hidden") {
      return true;
    }
    const style = getInlineStyle(el);
    // Match `display:none` / `visibility:hidden` allowing optional whitespace.
    if (/display\s*:\s*none/.test(style)) {
      return true;
    }
    if (/visibility\s*:\s*hidden/.test(style)) {
      return true;
    }
    // Computed-style + geometry, guarded for jsdom (no layout engine). The jsdom
    // defaults (display:block, visibility:visible, opacity:"") never match the
    // checks below, and the pure-geometry check is additionally gated on
    // `layoutActive` (false in jsdom, where every rect is 0x0). Mirrors the
    // pointer pass's getComputedStyle guard, so the inline-only behaviour is
    // preserved wherever getComputedStyle is absent.
    const dv = doc.defaultView;
    if (dv && typeof dv.getComputedStyle === "function") {
      let cs: CSSStyleDeclaration | null = null;
      try {
        cs = dv.getComputedStyle(el);
      } catch (e) {
        cs = null;
      }
      if (cs) {
        if (cs.display === "none") {
          return true;
        }
        if (cs.visibility === "hidden" || cs.visibility === "collapse") {
          return true;
        }
        // NOTE: opacity:0 is deliberately NOT treated as hidden — unlike
        // display:none / visibility:hidden, opacity:0 elements remain in the a11y
        // tree and stay focusable/clickable (visually-hidden-but-interactive
        // overlays, custom file pickers, checkbox-hack labels). Hiding them would
        // drop reachable controls.
      }
      if (layoutActive) {
        try {
          const r = el.getBoundingClientRect();
          if (r && r.width === 0 && r.height === 0) {
            return true;
          }
        } catch (e) {
          /* never throw on geometry */
        }
      }
      // A display:none ancestor hides the element even when its own computed
      // display is not none.
      if (displayNoneAbove(el, dv)) {
        return true;
      }
    }
    return false;
  }

  function getRole(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) {
      return explicit.trim();
    }
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();

    if (tag === "a" && el.hasAttribute("href")) {
      return "link";
    }
    if (tag === "summary") {
      return "button";
    }
    if (tag === "button") {
      return "button";
    }
    if (tag === "input") {
      if (type === "button" || type === "submit" || type === "reset") {
        return "button";
      }
      if (type === "checkbox") {
        return "checkbox";
      }
      if (type === "radio") {
        return "radio";
      }
      if (type === "search") {
        return "searchbox";
      }
      return "textbox";
    }
    if (tag === "textarea") {
      return "textbox";
    }
    if (tag === "select") {
      return "combobox";
    }
    if (el.hasAttribute("contenteditable")) {
      const ce = (el.getAttribute("contenteditable") || "").toLowerCase();
      if (ce !== "false") {
        return "textbox";
      }
    }
    if (/^h[1-6]$/.test(tag)) {
      return "heading";
    }
    return "clickable";
  }

  // IDs are scoped per tree: an element inside a shadow root resolves
  // aria-labelledby / label[for] against that root, never the document.
  function treeOf(el: Element): Document | ShadowRoot {
    const r = el.getRootNode ? el.getRootNode() : null;
    if (r && (r.nodeType === 9 || r.nodeType === 11)) {
      return r as Document | ShadowRoot;
    }
    return el.ownerDocument || doc;
  }

  function labelFromFor(el: Element): string {
    const id = el.getAttribute("id");
    if (!id) {
      return "";
    }
    // Escape the id for use in a CSS attribute selector.
    let selectorId = id;
    try {
      const anyWin = doc.defaultView as unknown as {
        CSS?: { escape?: (v: string) => string };
      } | null;
      if (anyWin && anyWin.CSS && typeof anyWin.CSS.escape === "function") {
        selectorId = anyWin.CSS.escape(id);
      }
    } catch (e) {
      selectorId = id;
    }
    let labelEl: Element | null = null;
    try {
      labelEl = treeOf(el).querySelector('label[for="' + selectorId + '"]');
    } catch (e) {
      labelEl = null;
    }
    if (labelEl) {
      const text = textOf(labelEl);
      if (text) {
        return text;
      }
    }
    return "";
  }

  function labelFromAncestor(el: Element): string {
    let node: Element | null = el.parentElement;
    while (node) {
      if (node.tagName.toLowerCase() === "label") {
        // The label's accessible name is its OWN text, excluding any embedded
        // form controls (the wrapped input/select/etc. and its value).
        return textOf(node, true);
      }
      node = node.parentElement;
    }
    return "";
  }

  function nameFromLabelledBy(el: Element): string {
    const ref = el.getAttribute("aria-labelledby");
    if (!ref) {
      return "";
    }
    const ids = ref.split(/\s+/);
    const parts: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) {
        continue;
      }
      let target: Element | null = null;
      try {
        target = treeOf(el).getElementById(id);
      } catch (e) {
        target = null;
      }
      if (target) {
        const text = textOf(target);
        if (text) {
          parts.push(text);
        }
      }
    }
    return parts.join(" ");
  }

  // Roles whose accessible name is computed FROM the element's own text content
  // (ARIA "Name From: contents"). For these the visible text IS the label, so a
  // textContent fallback is correct and safe (they are leaf-ish, not large
  // containers). Lets unlabelled IDS widgets read as option "E2E" / tab
  // "Secrets" instead of option "" / tab "".
  function isNameFromContentsRole(role: string): boolean {
    switch (role) {
      case "option":
      case "tab":
      case "menuitem":
      case "menuitemcheckbox":
      case "menuitemradio":
      case "treeitem":
      case "radio":
      case "checkbox":
      case "switch":
      case "gridcell":
      case "cell":
      case "columnheader":
      case "rowheader":
      case "listitem":
        return true;
      default:
        return false;
    }
  }

  function getAccessibleName(el: Element, role: string): string {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && collapseWhitespace(ariaLabel)) {
      return clip(ariaLabel);
    }

    const labelledBy = nameFromLabelledBy(el);
    if (collapseWhitespace(labelledBy)) {
      return clip(labelledBy);
    }

    const forLabel = labelFromFor(el);
    if (collapseWhitespace(forLabel)) {
      return clip(forLabel);
    }

    const ancestorLabel = labelFromAncestor(el);
    if (collapseWhitespace(ancestorLabel)) {
      return clip(ancestorLabel);
    }

    const tag = el.tagName.toLowerCase();
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt && collapseWhitespace(alt)) {
        return clip(alt);
      }
    }

    const title = el.getAttribute("title");
    if (title && collapseWhitespace(title)) {
      return clip(title);
    }

    const placeholder = el.getAttribute("placeholder");
    if (placeholder && collapseWhitespace(placeholder)) {
      return clip(placeholder);
    }

    // FIX 1: custom comboboxes (react-select) keep their label/value/placeholder
    // in CHILD nodes, not attributes — probe them for combobox/textbox roles.
    if (role === "combobox" || role === "textbox") {
      const childName = childValueText(el);
      if (collapseWhitespace(childName)) {
        return clip(childName);
      }
    }

    // Only fall back to raw textContent for roles where the text is the label
    // (avoid dumping the contents of large containers). FIX 2 widens this to
    // custom (explicit-role) combobox/textbox — but NEVER native
    // select/textarea/input, whose textContent is option/child noise. Plus the
    // ARIA "name from contents" roles (option/tab/menuitem/etc.), so IDS custom
    // widgets surface e.g. tab "Secrets" instead of tab "".
    const hasExplicitRole = !!el.getAttribute("role");
    if (
      role === "link" ||
      role === "button" ||
      role === "heading" ||
      isNameFromContentsRole(role) ||
      ((role === "combobox" || role === "textbox") && hasExplicitRole)
    ) {
      const text = textOf(el);
      if (collapseWhitespace(text)) {
        return clip(text);
      }
    }

    return "";
  }

  function getStateFlags(el: Element, role: string): string[] {
    const flags: string[] = [];

    const disabledAttr =
      (el as { disabled?: boolean }).disabled === true ||
      el.hasAttribute("disabled");
    if (disabledAttr || el.getAttribute("aria-disabled") === "true") {
      flags.push("disabled");
    }

    if (role === "checkbox" || role === "radio") {
      const checked =
        (el as { checked?: boolean }).checked === true ||
        el.hasAttribute("checked") ||
        el.getAttribute("aria-checked") === "true";
      if (checked) {
        flags.push("checked");
      }
    }

    const required =
      (el as { required?: boolean }).required === true ||
      el.hasAttribute("required") ||
      el.getAttribute("aria-required") === "true";
    if (required) {
      flags.push("required");
    }

    const expanded = el.getAttribute("aria-expanded");
    if (expanded === "true") {
      flags.push("expanded");
    } else if (expanded === "false") {
      flags.push("collapsed");
    }

    if (el.getAttribute("aria-selected") === "true") {
      flags.push("selected");
    }

    return flags;
  }

  const VALUE_MAX = 80;
  const SECTION_MAX = 60;

  function formatSlot(s: string, max: number): string {
    // Collapse whitespace, neutralize the slot delimiter (a literal "|" inside a
    // slot would make the row ambiguous — collapse it to "/"), then clip to the
    // slot budget.
    const cleaned = collapseWhitespace(s).replace(/\|/g, "/");
    if (cleaned.length > max) {
      return cleaned.slice(0, max);
    }
    return cleaned;
  }

  function getCurrentValue(el: Element, role: string): string {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") {
      return (el as HTMLTextAreaElement).value || "";
    }
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      // Checkbox/radio carry their state in flags; button/file/hidden/image have
      // no displayable value; password is excluded so a typed/autofilled secret
      // never leaks into the snapshot value slot. Only text-entry inputs
      // contribute a value slot.
      if (
        type === "checkbox" ||
        type === "radio" ||
        type === "button" ||
        type === "submit" ||
        type === "reset" ||
        type === "hidden" ||
        type === "file" ||
        type === "image" ||
        type === "password"
      ) {
        return "";
      }
      return (el as HTMLInputElement).value || "";
    }
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const opts = sel.selectedOptions;
      if (opts && opts.length > 0 && opts[0].textContent) {
        return opts[0].textContent;
      }
      const idx = sel.selectedIndex;
      if (
        idx >= 0 &&
        sel.options &&
        sel.options[idx] &&
        sel.options[idx].textContent
      ) {
        return sel.options[idx].textContent as string;
      }
      return "";
    }
    // Custom combobox (react-select and similar): value in ARIA or child nodes.
    if (role === "combobox") {
      const valueText = el.getAttribute("aria-valuetext");
      if (valueText && collapseWhitespace(valueText)) {
        return valueText;
      }
      const valueNow = el.getAttribute("aria-valuenow");
      if (valueNow && collapseWhitespace(valueNow)) {
        return valueNow;
      }
      const single = el.querySelector(
        '[class*="singleValue"], [class*="single-value"]'
      );
      if (single && collapseWhitespace(single.textContent || "")) {
        return single.textContent || "";
      }
      // Nothing selected → the placeholder identifies the empty control.
      const ph = el.querySelector('[class*="placeholder"]');
      if (ph && collapseWhitespace(ph.textContent || "")) {
        return ph.textContent || "";
      }
      const phAttr = el.getAttribute("placeholder");
      if (phAttr && collapseWhitespace(phAttr)) {
        return phAttr;
      }
    }
    return "";
  }

  function childValueText(el: Element): string {
    // react-select / Downshift render the selected value or placeholder in CHILD
    // nodes rather than an attribute; surface them so a bare combobox is nameable.
    const single = el.querySelector(
      '[class*="singleValue"], [class*="single-value"]'
    );
    if (single && collapseWhitespace(single.textContent || "")) {
      return single.textContent || "";
    }
    const ph = el.querySelector('[class*="placeholder"]');
    if (ph && collapseWhitespace(ph.textContent || "")) {
      return ph.textContent || "";
    }
    return "";
  }

  function makeRow(
    el: Element,
    role: string,
    name: string,
    value: string,
    section: string,
    flags: string[],
    uid: string
  ): string {
    // el is part of the shared signature both the base and pointer passes call
    // through; every slot is precomputed by the caller, so el is not read here.
    const nameSlot = formatSlot(name, NAME_MAX);
    const valueClean = formatSlot(value, VALUE_MAX);
    const sectionSlot = formatSlot(section, SECTION_MAX);
    // Drop a value that merely repeats the name (a bare custom combobox whose
    // only signal is its placeholder ends up in both — show it once, as name).
    const valueSlot =
      valueClean && valueClean !== nameSlot ? '"' + valueClean + '"' : "";
    let line =
      role +
      ' "' +
      nameSlot +
      '" | ' +
      valueSlot +
      " | " +
      sectionSlot +
      " [uid=" +
      uid +
      "]";
    if (flags.length > 0) {
      line += " (" + flags.join(", ") + ")";
    }
    return line;
  }

  function isHeading(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      return true;
    }
    return el.getAttribute("role") === "heading";
  }

  function getSectionInTree(el: Element): string {
    // 1. fieldset > legend
    const fs = el.closest("fieldset");
    if (fs) {
      const legend = fs.querySelector("legend");
      if (legend && collapseWhitespace(textOf(legend))) {
        return textOf(legend);
      }
    }
    // 2. nearest titled container: section / role=group / *card* / labelledby.
    const container = el.closest(
      'section,[role="group"],[class*="card"],[aria-labelledby]'
    );
    if (container) {
      const labelled = nameFromLabelledBy(container);
      if (collapseWhitespace(labelled)) {
        return labelled;
      }
      const heading = container.querySelector(
        'h1,h2,h3,h4,h5,h6,[role="heading"]'
      );
      if (heading && collapseWhitespace(textOf(heading))) {
        return textOf(heading);
      }
    }
    // 3. ancestor + previousElementSibling walk for the nearest heading.
    let node: Element | null = el.parentElement;
    while (node) {
      let sib: Element | null = node.previousElementSibling;
      while (sib) {
        if (isHeading(sib) && collapseWhitespace(textOf(sib))) {
          return textOf(sib);
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  }

  function getSection(el: Element): string {
    // A control with no titled context inside its own shadow tree takes its
    // host's breadcrumb (repeated outward through nested hosts).
    let cur: Element | null = el;
    for (let depth = 0; cur && depth < 32; depth++) {
      const section = getSectionInTree(cur);
      if (section) {
        return section;
      }
      const r: Node | null = cur.getRootNode ? cur.getRootNode() : null;
      cur = r && r.nodeType === 11 && (r as any).host ? ((r as any).host as Element) : null;
    }
    return "";
  }

  // --- role-wrapper collapse ---
  // A menu/list/grid row whose ONE visible interactive descendant has the same
  // name (`<li role=menuitem><button>Draft…</button></li>`) is a single target.
  // Listing both invites a click on the wrapper, which lands on the inner
  // control's text rather than the control; so the wrapper's row is kept (its
  // role, name and states) while its uid goes on the inner control.
  function isWrapperRole(role: string): boolean {
    switch (role) {
      case "menuitem":
      case "menuitemcheckbox":
      case "menuitemradio":
      case "option":
      case "tab":
      case "treeitem":
      case "row":
      case "gridcell":
      case "listitem":
        return true;
      default:
        return false;
    }
  }

  function isInteractiveRole(role: string): boolean {
    switch (role) {
      case "button":
      case "link":
      case "checkbox":
      case "radio":
      case "switch":
      case "menuitem":
      case "menuitemcheckbox":
      case "menuitemradio":
      case "option":
      case "tab":
      case "treeitem":
      case "textbox":
      case "searchbox":
      case "combobox":
      case "slider":
      case "spinbutton":
        return true;
      default:
        return false;
    }
  }

  function firstRoleToken(el: Element): string {
    return (el.getAttribute("role") || "").trim().split(/\s+/)[0].toLowerCase();
  }

  // Something a user operates (the predicate click retargeting shares).
  function isInteractiveControl(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "select" || tag === "textarea" || tag === "summary") {
      return true;
    }
    if ((tag === "a" || tag === "area") && el.hasAttribute("href")) {
      return true;
    }
    if (tag === "input") {
      return (el.getAttribute("type") || "").toLowerCase() !== "hidden";
    }
    if (
      el.hasAttribute("contenteditable") &&
      (el.getAttribute("contenteditable") || "").toLowerCase() !== "false"
    ) {
      return true;
    }
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && parseInt(tabindex, 10) >= 0) {
      return true;
    }
    return isInteractiveRole(firstRoleToken(el));
  }

  // The single visible interactive flat-tree descendant of w, or null when it
  // has none or several. Stops at the second one, so a tree item holding a
  // whole nested tree costs no more than a leaf.
  function soleInteractiveDescendant(w: Element): Element | null {
    let found: Element | null = null;
    const stack = composedChildren(w).reverse();
    while (stack.length) {
      const el = stack.pop() as Element;
      if (isInteractiveControl(el) && !isHidden(el)) {
        if (found) {
          return null;
        }
        found = el;
      }
      const kids = composedChildren(el);
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push(kids[i]);
      }
    }
    return found;
  }

  function sameName(a: Element, b: Element): boolean {
    const x = collapseWhitespace(getAccessibleName(a, getRole(a))).toLowerCase();
    return (
      x !== "" &&
      x === collapseWhitespace(getAccessibleName(b, getRole(b))).toLowerCase()
    );
  }

  // The inner control a wrapper row carries the uid of, or null.
  function collapseTargetOf(w: Element): Element | null {
    if (!isWrapperRole(firstRoleToken(w))) {
      return null;
    }
    const inner = soleInteractiveDescendant(w);
    return inner && sameName(w, inner) ? inner : null;
  }

  // --- 1. clear stale uids (and their signatures) from prior runs, in the
  // document AND every reachable shadow tree (a uid left inside a shadow root
  // would otherwise be issued twice) ---
  const stale = deepQueryAll(doc, "[" + UID_ATTR + "]");
  for (let i = 0; i < stale.length; i++) {
    stale[i].removeAttribute(UID_ATTR);
    stale[i].removeAttribute(SIG_ATTR);
  }

  // --- 2. select candidate elements ---
  const baseSelectors = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "[role]",
    "[tabindex]",
    "[onclick]",
    "summary",
    '[contenteditable]:not([contenteditable="false"])',
  ];
  const verboseSelectors = ["h1", "h2", "h3", "h4", "h5", "h6", "[aria-label]"];
  const baseSelectorString = (verbose
    ? baseSelectors.concat(verboseSelectors)
    : baseSelectors
  ).join(",");

  // Query mode: an explicit CSS `selector` returns exactly its matches (fresh
  // uids), interactive or not, and is self-contained (no pointer pass).
  const selectorMode =
    typeof options.selector === "string" && options.selector.length > 0;

  const textMode =
    typeof options.textContains === "string" && options.textContains.length > 0;
  const textNeedle = textMode
    ? (options.textContains as string).toLowerCase()
    : "";

  // Region scoping: restrict collection to the subtree of the first element
  // matching rootSelector — in the document tree first, else inside a shadow
  // tree (a host root walks its shadow content). A miss is an explicit,
  // recoverable error. Name resolution still reads each element's own tree.
  let root: Document | Element = doc;
  if (
    typeof options.rootSelector === "string" &&
    options.rootSelector.length > 0
  ) {
    let scoped: Element | null = null;
    try {
      scoped = doc.querySelector(options.rootSelector);
    } catch (e) {
      return {
        tree: "",
        isTruncated: false,
        total: 0,
        hasMore: false,
        error: "Invalid rootSelector: " + options.rootSelector,
      };
    }
    if (!scoped) {
      try {
        scoped = deepQuery(doc, options.rootSelector);
      } catch (e) {
        scoped = null;
      }
    }
    if (!scoped) {
      return {
        tree: "",
        isTruncated: false,
        total: 0,
        hasMore: false,
        error: "rootSelector matched no element: " + options.rootSelector,
      };
    }
    root = scoped;
  }

  let selectorHits: NodeListOf<Element> | null = null;
  if (selectorMode) {
    try {
      selectorHits = root.querySelectorAll(options.selector as string);
    } catch (e) {
      return {
        tree: "",
        isTruncated: false,
        total: 0,
        hasMore: false,
        error: "Invalid CSS selector: " + options.selector,
      };
    }
  }

  // Every pass enumerates the flat tree under root, in reading order.
  const all = collectComposed(root);

  let candidates: Element[] = [];
  if (selectorHits) {
    // In root's own tree querySelectorAll already decided (it also honours
    // :scope); inside shadow trees the selector is matched per element, so
    // combinators apply within a tree, never across a boundary.
    const hitSet = new Set<Element>();
    for (let i = 0; i < selectorHits.length; i++) {
      hitSet.add(selectorHits[i]);
    }
    const rootTree = root.nodeType === 9 ? root : root.getRootNode();
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      let hit = hitSet.has(el);
      if (!hit && el.getRootNode() !== rootTree) {
        try {
          hit = el.matches(options.selector as string);
        } catch (e) {
          hit = false;
        }
      }
      if (hit) {
        candidates.push(el);
      }
    }
  } else if (textMode) {
    // Text query mode with no selector scans all elements; the text filter and
    // leaf-preference below narrow it down.
    candidates = all.slice();
  } else {
    for (let i = 0; i < all.length; i++) {
      if (all[i].matches(baseSelectorString)) {
        candidates.push(all[i]);
      }
    }
  }

  if (textMode) {
    // Match the composed text (text content, including text hidden with CSS)
    // OR the accessible name, deepest match wins: an element is dropped when a
    // flat-tree descendant also matches by either. Linear: index the text once,
    // then mark the ancestors of every match instead of re-scanning subtrees.
    indexComposedText(root);
    const occurrences: number[] = [];
    for (
      let at = textLower.indexOf(textNeedle);
      at !== -1;
      at = textLower.indexOf(textNeedle, at + 1)
    ) {
      occurrences.push(at);
    }
    // Only elements that carry a name of their own are name-matched; otherwise
    // every descendant of a <label> would match through the label's text.
    const nameCarrier = baseSelectors
      .concat(["[aria-label]", "[aria-labelledby]", "[alt]", "[title]"])
      .join(",");
    const textHasNeedle = function (el: Element): boolean {
      const span = textIndex ? textIndex.get(el) : undefined;
      if (!span) {
        return textOf(el).toLowerCase().indexOf(textNeedle) !== -1;
      }
      // First occurrence starting inside the span (binary search).
      let lo = 0;
      let hi = occurrences.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (occurrences[mid] < span[2]) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      return lo < occurrences.length && occurrences[lo] + textNeedle.length <= span[3];
    };
    const matched = new Set<Element>();
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (
        textHasNeedle(el) ||
        (el.matches(nameCarrier) &&
          getAccessibleName(el, getRole(el)).toLowerCase().indexOf(textNeedle) !== -1)
      ) {
        matched.add(el);
      }
    }
    const matchBelow = new Set<Node>();
    matched.forEach(function (el) {
      for (let n = flatParent(el); n && !matchBelow.has(n); n = flatParent(n)) {
        matchBelow.add(n);
      }
    });
    candidates = candidates.filter(function (el) {
      return matched.has(el) && !matchBelow.has(el);
    });
  }

  // Default mode: settle the role-wrapper collapses up front — a wrapper row
  // precedes its inner control in reading order, and when nested wrappers
  // collapse onto one control only the innermost keeps a row.
  const collapseOf = new Map<Element, Element>(); // wrapper → inner control
  const wrapperOf = new Map<Element, Element>(); // inner control → innermost wrapper
  if (!selectorMode && !textMode) {
    for (let i = 0; i < candidates.length; i++) {
      const w = candidates[i];
      if (isHidden(w)) {
        continue;
      }
      const inner = collapseTargetOf(w);
      if (inner) {
        collapseOf.set(w, inner);
        wrapperOf.set(inner, w); // visited later = nested deeper, so it wins
      }
    }
  }

  // Text mode: the innermost wrapper (under root) that collapses onto d.
  function collapsingWrapperOf(d: Element): Element | null {
    if (!isInteractiveControl(d)) {
      return null;
    }
    for (let n = flatParent(d); n && n !== root && n.nodeType === 1; n = flatParent(n)) {
      const w = n as Element;
      if (!isWrapperRole(firstRoleToken(w)) || isHidden(w)) {
        continue;
      }
      if (soleInteractiveDescendant(w) !== d) {
        return null; // w holds other controls too, and so does every outer wrapper
      }
      if (sameName(w, d)) {
        return w;
      }
    }
    return null;
  }

  // --- 3..6. walk, compute, stamp, and build the output ---
  const lines: string[] = [];
  let uidCounter = 0;
  const stamped: Element[] = [];

  // Stamp a fresh uid (+ signature), or return the one el already got in this
  // run — a selector-mode hint can stamp an inner control before its own row.
  function stampUid(el: Element): string {
    const have = el.getAttribute(UID_ATTR);
    if (have) {
      return have;
    }
    uidCounter += 1;
    const uid = "e" + uidCounter;
    el.setAttribute(UID_ATTR, uid);
    el.setAttribute(SIG_ATTR, bcmcpSig(el));
    stamped.push(el);
    return uid;
  }

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];

    if (isHidden(el)) {
      continue;
    }

    // rowEl supplies the row's role, name and states; uidEl carries the uid.
    // They differ only for a collapsed role wrapper.
    let rowEl = el;
    let uidEl = el;
    if (!selectorMode && !textMode) {
      const inner = collapseOf.get(el);
      if (inner) {
        if (wrapperOf.get(inner) !== el) {
          continue; // a nested wrapper owns this control's row
        }
        uidEl = inner;
      } else if (wrapperOf.has(el)) {
        continue; // listed through its wrapper's row
      }
    } else if (!selectorMode) {
      // Text mode: a match is shown as its collapsing wrapper's row either way.
      const inner = collapseTargetOf(el);
      if (inner) {
        uidEl = inner;
      } else {
        const wrapper = collapsingWrapperOf(el);
        if (wrapper) {
          rowEl = wrapper;
        }
      }
    }

    const role = getRole(rowEl);
    let name = getAccessibleName(rowEl, role);
    if (textMode && !name) {
      // Text query mode targets leaf elements matched purely by their visible
      // text (e.g. a role-less "Open" card), which the accessible-name rules
      // leave unnamed. Fall back to the leaf's own trimmed text (clip respects
      // NAME_MAX) so the match is identifiable. Strictly text-mode-local, so the
      // base / pointer / selector passes are unaffected.
      name = clip(textOf(rowEl));
    }
    const flags = getStateFlags(rowEl, role);
    const uid = stampUid(uidEl);

    let line = makeRow(
      rowEl,
      role,
      name,
      getCurrentValue(rowEl, role),
      getSection(rowEl),
      flags,
      uid
    );
    if (uidEl !== rowEl) {
      // The [uid=eN] token stays intact; the marker says whom it targets.
      line += " → inner " + getRole(uidEl);
    } else if (selectorMode) {
      // Selector mode lists exactly what matched, but points at the control a
      // matched wrapper stands for.
      const inner = collapseTargetOf(el);
      if (inner) {
        const innerRole = getRole(inner);
        line +=
          "\n  ↳ " +
          uid +
          " wraps one interactive " +
          innerRole +
          ' "' +
          formatSlot(getAccessibleName(inner, innerRole), HINT_NAME_MAX) +
          '" [uid=' +
          stampUid(inner) +
          "]";
      }
    }
    lines.push(line);
  }

  // --- 6b. (default via includePointer) second pass: visually-clickable non-semantic
  // elements. Modern React apps build dialogs/menus from `<div onClick>`-style
  // controls that carry no role/tabindex/href/onclick attribute (the handler is
  // attached via addEventListener), so the base pass can't see them. They are
  // distinguishable only by `cursor: pointer`, which needs getComputedStyle.
  //
  // This pass runs by default (includePointer, on by default) so React `<div onClick>` cards appear in the default snapshot, and
  // it is feature-guarded so jsdom — which has no layout engine and returns
  // default styles — neither crashes nor alters existing behaviour. The
  // getComputedStyle call is wrapped in try/catch as a further safety net.
  const win = doc.defaultView;
  if (includePointer && !selectorMode && !textMode && win && typeof win.getComputedStyle === "function") {
    const MAX_CLICKABLES = maxInteractive;
    let added = 0;

    function ownDirectText(el: Element): string {
      // Build the name from the element's IMMEDIATE text only (its direct child
      // text nodes), never the deep textContent of a large container.
      const parts: string[] = [];
      const kids = el.childNodes;
      for (let k = 0; k < kids.length; k++) {
        const node = kids[k];
        if (node.nodeType === 3) {
          parts.push(node.textContent || "");
        }
      }
      return parts.join(" ");
    }

    // Flat-tree ancestors of everything the base pass stamped: a pointer
    // candidate among them wraps a real control (possibly in a shadow root).
    const wrapsStamped = new Set<Node>();
    for (let s = 0; s < stamped.length; s++) {
      for (let n = flatParent(stamped[s]); n && !wrapsStamped.has(n); n = flatParent(n)) {
        wrapsStamped.add(n);
      }
    }

    for (let i = 0; i < all.length && added < MAX_CLICKABLES; i++) {
      const el = all[i];

      // Already captured by the base pass.
      if (el.hasAttribute(UID_ATTR)) {
        continue;
      }
      if (isHidden(el)) {
        continue;
      }

      let cursor = "";
      try {
        cursor = win.getComputedStyle(el).cursor || "";
      } catch (e) {
        cursor = "";
      }
      if (cursor !== "pointer") {
        continue;
      }

      // Prefer leaf-ish clickables: if this element already contains a stamped
      // descendant, it is a wrapper around a real control — skip it to avoid
      // duplicating a bigger target.
      if (wrapsStamped.has(el)) {
        continue;
      }

      // Name: aria-label/title, else the element's OWN direct text. A clickable
      // with no derivable label is noise — skip it.
      const ariaLabel = el.getAttribute("aria-label");
      let name = "";
      if (ariaLabel && collapseWhitespace(ariaLabel)) {
        name = clip(ariaLabel);
      } else {
        const direct = ownDirectText(el);
        if (collapseWhitespace(direct)) {
          name = clip(direct);
        } else {
          const title = el.getAttribute("title");
          if (title && collapseWhitespace(title)) {
            name = clip(title);
          }
        }
      }
      if (!name) {
        continue;
      }

      const flags = getStateFlags(el, "clickable");

      const uid = stampUid(el);
      added += 1;

      lines.push(
        makeRow(
          el,
          "clickable",
          name,
          getCurrentValue(el, "clickable"),
          getSection(el),
          flags,
          uid
        )
      );
    }
  }

  // --- 6c. page over the collected candidate lines (before the char cut) ---
  const total = lines.length;
  const offset =
    typeof options.offset === "number" && options.offset > 0
      ? Math.floor(options.offset)
      : 0;
  const hasLimit = typeof options.limit === "number" && options.limit >= 0;
  const limit = hasLimit ? Math.floor(options.limit as number) : undefined;
  let pagedLines = lines;
  if (offset > 0 || limit !== undefined) {
    pagedLines = lines.slice(
      offset,
      limit !== undefined ? offset + limit : undefined
    );
  }
  const moreAfterPage = offset + pagedLines.length < total;

  // --- 6d. document state, so an empty tree can be explained ---
  // Read here rather than at entry: these are cheap property reads and taking
  // them next to the result keeps them describing the document the tree was
  // actually built from. Every field is defensive — a torn-down document can
  // have a null body, and `doc.URL` is absent on some synthetic documents.
  let readyState = "";
  try {
    readyState = String(doc.readyState || "");
  } catch (e) {
    /* unreadable — report as unknown */
  }
  let docUrl = "";
  try {
    docUrl = String(doc.URL || (doc.location ? doc.location.href : "") || "");
  } catch (e) {
    /* cross-origin or torn down */
  }
  let bodyChildren = 0;
  try {
    bodyChildren = doc.body ? doc.body.children.length : 0;
  } catch (e) {
    /* no body yet */
  }
  const docState = {
    readyState: readyState,
    url: docUrl,
    bodyChildren: bodyChildren,
  };

  // --- 7. join and truncate ---
  const full = pagedLines.join("\n");
  if (full.length > maxLength) {
    // Truncate to the last COMPLETE line so no `[uid=eN]` token is cut.
    const sliced = full.slice(0, maxLength);
    const lastNewline = sliced.lastIndexOf("\n");
    const tree = lastNewline >= 0 ? sliced.slice(0, lastNewline) : "";
    // The char cut dropped lines too, so more content exists either way.
    return {
      tree: tree,
      isTruncated: true,
      total: total,
      hasMore: true,
      docState: docState,
    };
  }
  return {
    tree: full,
    isTruncated: false,
    total: total,
    hasMore: moreAfterPage,
    docState: docState,
  };
}
