/**
 * Input-action executor for the snapshot uid model.
 *
 * CRITICAL: `performInputAction` is used in TWO ways:
 *   (a) Imported and unit-tested directly in jsdom.
 *   (b) Stringified via `performInputAction.toString()` and injected into the
 *       page with `browser.tabs.executeScript`, where it runs in the page's own
 *       JS world with no access to this module.
 *
 * Because of (b) the function MUST be fully self-contained: it may NOT
 * reference any imports, module-scope variables, or sibling functions. Every
 * helper it needs is defined as an inner function. It operates ONLY on the
 * `doc` argument passed to it.
 *
 * It avoids layout-throwing APIs. `scrollIntoView` is wrapped in try/catch
 * because jsdom has no layout engine and may treat it as a no-op or omit it.
 *
 * Elements are located by the `data-bcmcp-uid` attribute stamped by
 * `buildSnapshot`. uids are reassigned on every snapshot, so a stale uid is a
 * normal, recoverable error: the caller is told to take a fresh snapshot.
 */

type InputActionArgs =
  | { action: "click"; uid: string; doubleClick?: boolean; failIfIntercepted?: boolean }
  | { action: "hover"; uid: string }
  | { action: "fill"; uid: string; value: string }
  | { action: "fill-form"; fields: { uid: string; value: string }[] }
  | { action: "type"; text: string; submit?: boolean }
  | { action: "press-key"; key: string; modifiers?: string[] }
  | { action: "drag"; fromUid: string; toUid: string }
  | { action: "classify-intercept"; uid: string };

interface InputActionResult {
  ok: boolean;
  error?: string;
  intercepted?: {
    tag: string;
    id?: string;
    classes?: string;
    role?: string;
    name?: string;
  };
  // Set only when a click was dispatched on an interactive DESCENDANT of the
  // uid element (see activationTargetFor), never when it went to the uid
  // element itself.
  dispatchedTo?: { tag: string; name?: string };
}

// type into a contenteditable waits for the editor before it answers (see
// typeIntoEditor), so it can return a Promise; every other action answers
// synchronously.
export function performInputAction(
  doc: Document,
  args: Extract<InputActionArgs, { action: "type" }>
): InputActionResult | Promise<InputActionResult>;
export function performInputAction(
  doc: Document,
  args: Exclude<InputActionArgs, { action: "type" }>
): InputActionResult;
export function performInputAction(
  doc: Document,
  args: InputActionArgs
): InputActionResult | Promise<InputActionResult>;
export function performInputAction(
  doc: Document,
  args: InputActionArgs
): InputActionResult | Promise<InputActionResult> {
  const UID_ATTR = "data-bcmcp-uid";

  try {
    const win = doc.defaultView as (Window & typeof globalThis) | null;

    // --- inner helpers (must stay inside this function body) ---

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
    // document.elementFromPoint retargets to the outermost host; ShadowRoot.elementFromPoint drills one level
    // only, so loop. Stops when a root has no elementFromPoint or returns the host itself.
    function deepElementFromPoint(doc: Document, x: number, y: number): Element | null {
      let hit = doc.elementFromPoint(x, y);
      for (let depth = 0; hit && depth < 32; depth++) {
        const sr = shadowRootOf(hit);
        const efp = sr ? (sr as any).elementFromPoint : null;
        if (typeof efp !== "function") break;
        const inner = efp.call(sr, x, y) as Element | null;
        // Engines disagree off-root: Chrome can return an element OUTSIDE the root (a slotted child or an
        // unrelated page element), Firefox returns null. Only accept a hit that lives in this root.
        if (!inner || inner === hit || inner.getRootNode() !== sr) break;
        hit = inner;
      }
      return hit;
    }
    // Native accessors, read once per call. A <form> exposes its controls as named properties that SHADOW
    // built-ins ([LegacyOverrideBuiltIns]): `<form><select name="children">` makes `form.children` return the
    // select, and `<input name="parentNode">` makes `form.parentNode` return that input, which turns every walk
    // up through the form into a cycle. Prototype getters are immune; where an environment lacks one, the plain
    // property is read. Documents and shadow roots have no such named properties.
    function protoGetter(proto: () => object, name: string): ((this: unknown) => unknown) | undefined {
      try { const d = Object.getOwnPropertyDescriptor(proto(), name); return d && d.get; } catch (_) { return undefined; }
    }
    const nativeParentNode = protoGetter(() => Node.prototype, "parentNode");
    const nativeAssignedSlot = protoGetter(() => Element.prototype, "assignedSlot");
    // Flat-tree parent: slotted node → its slot, top-level node of a shadow tree → host, else parentNode.
    // assignedSlot is ALWAYS null when the host's root is closed (even for extensions), so for a child of a
    // closed host we find the slot from the root side (root.querySelectorAll("slot") + assignedNodes()).
    function composedParent(n: Node): Node | null {
      const slot = (n.nodeType === 1 && nativeAssignedSlot ? nativeAssignedSlot.call(n) : (n as any).assignedSlot) as Element | null | undefined;
      if (slot) return slot;
      const p = (nativeParentNode ? nativeParentNode.call(n) : n.parentNode) as Node | null;
      if (!p) return null;
      if (p.nodeType === 11 && (p as any).host) return (p as any).host as Element;
      if (p.nodeType === 1 && !(p as any).shadowRoot) {
        const sr = shadowRootOf(p as Element); // non-null here only for a closed root
        if (sr) {
          const slots = sr.querySelectorAll("slot");
          for (let i = 0; i < slots.length; i++) {
            if (typeof (slots[i] as any).assignedNodes !== "function") continue; // <svg><slot>
            const assigned = (slots[i] as HTMLSlotElement).assignedNodes();
            for (let j = 0; j < assigned.length; j++) if (assigned[j] === n) return slots[i];
          }
        }
      }
      return p;
    }
    // Capped: a content script shares the page's main thread, so no page may turn this walk into an endless loop.
    function composedContains(ancestor: Node, node: Node | null): boolean {
      let n: Node | null = node;
      for (let steps = 0; n && steps < 4096; steps++, n = composedParent(n)) if (n === ancestor) return true;
      return false;
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

    function resolve(uid: string): Element | null {
      // deepQuery: a uid stamped inside a shadow root (open, or closed via the
      // extension APIs) resolves too; a light-DOM uid still resolves on the
      // first querySelector, exactly as before.
      const node = deepQuery(doc, "[" + UID_ATTR + '="' + uid + '"]');
      if (!node) {
        return null;
      }
      // Identity guard: the snapshot also stamps data-bcmcp-sig. If the stored
      // signature no longer matches the node's current identity, the framework
      // recycled this DOM node under a reassigned uid — treat it as stale so the
      // caller takes a fresh snapshot instead of silently acting on the wrong
      // element. A node with no sig (older snapshot) skips the check (back-compat).
      const sig = node.getAttribute("data-bcmcp-sig");
      if (sig && bcmcpSig(node) !== sig) {
        return null;
      }
      return node;
    }

    function notFound(uid: string): { ok: boolean; error?: string } {
      return {
        ok: false,
        error:
          "Element uid '" +
          uid +
          "' not found — take a fresh snapshot (uids are reassigned each snapshot).",
      };
    }

    function scrollTo(el: Element): void {
      try {
        (el as { scrollIntoView?: (opts?: unknown) => void }).scrollIntoView?.({
          block: "center",
        });
      } catch (e) {
        /* jsdom may lack a layout engine — never throw on scroll */
      }
    }

    function elementCenter(el: Element): { x: number; y: number } {
      try {
        const r = el.getBoundingClientRect();
        if (r && (r.width || r.height || r.left || r.top)) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      } catch (e) {
        /* jsdom / detached — fall through to origin */
      }
      return { x: 0, y: 0 };
    }

    // Builds a MouseEvent (or PointerEvent for `pointer*` types when the engine
    // has PointerEvent) carrying viewport coordinates, the pressed-button bitmask
    // and `composed:true`. screenX/screenY approximate clientX/clientY; pageX/pageY
    // are derived natively by the engine from clientX/clientY + scroll. `enter`
    // variants correctly do not bubble.
    function mouseEvt(
      type: string,
      opts?: { x?: number; y?: number; buttons?: number }
    ): Event {
      const o = opts || {};
      const x = typeof o.x === "number" ? o.x : 0;
      const y = typeof o.y === "number" ? o.y : 0;
      const isEnter =
        type === "mouseenter" ||
        type === "mouseleave" ||
        type === "pointerenter" ||
        type === "pointerleave";
      const init: MouseEventInit = {
        bubbles: !isEnter,
        cancelable: true,
        composed: true,
        view: win as Window,
        button: 0,
        buttons: typeof o.buttons === "number" ? o.buttons : 0,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      };
      const PE =
        win && (win as { PointerEvent?: typeof PointerEvent }).PointerEvent;
      if (type.indexOf("pointer") === 0 && typeof PE === "function") {
        const pinit = init as PointerEventInit;
        pinit.pointerId = 1;
        pinit.pointerType = "mouse";
        pinit.isPrimary = true;
        return new (PE as typeof PointerEvent)(type, pinit);
      }
      return new MouseEvent(type, init);
    }

    // A trusted click on a <label> — or on anything inside it — runs the label's
    // activation behavior and toggles the labeled control. Firefox does NOT run
    // that forwarding for an UNTRUSTED (script-dispatched) click, so a synthetic
    // click on antd's .ant-checkbox-wrapper label, or on the painted
    // .ant-checkbox-inner span stacked over its visually-hidden input, did
    // nothing at all while still reporting ok:true. Chromium does forward it,
    // which is why this only ever reproduced on Firefox — the one browser where
    // there is no CDP/trusted-input fallback to escape to.
    //
    // Forward it ourselves, but ONLY when the browser demonstrably did not: a
    // capture-phase listener on the control records whether the click actually
    // reached it, so on Chromium (where it did) we never activate a second time
    // and toggle the box straight back off.
    function labeledCheckControl(el: Element): Element | null {
      try {
        const label = (
          el.localName === "label"
            ? el
            : typeof (el as { closest?: (s: string) => Element | null })
                .closest === "function"
            ? el.closest("label")
            : null
        ) as ({ control?: Element | null } & Element) | null;
        if (!label) {
          return null;
        }
        const ctl = label.control;
        if (!ctl || ctl === el) {
          return null;
        }
        // Restricted to checkbox/radio: their state is driven purely by the
        // label forwarding, and a missed forward is silent. Other labelable
        // controls (text inputs, selects) are left untouched — a trusted label
        // click only focuses those, which the press sequence already does.
        const type = (ctl.getAttribute("type") || "").toLowerCase();
        if (ctl.localName !== "input" || (type !== "checkbox" && type !== "radio")) {
          return null;
        }
        // A click on interactive content inside the label — a link, a button,
        // another field — or on anything inside it runs THAT element's
        // activation and never the label's (the browsers skip label activation
        // for such targets). So "Terms" in `<label>I agree to the <a
        // href=#terms>Terms</a> <input type=checkbox></label>` follows the link
        // and leaves the box alone; forwarding here would do both. The walk
        // reads the native parentElement getter (a form control named
        // "parentElement" shadows the form's own) and is capped.
        const parentOf = Object.getOwnPropertyDescriptor(Node.prototype, "parentElement")!.get!;
        let n: Element | null = el;
        for (let steps = 0; n && n !== label && steps < 4096; steps++) {
          if (n !== ctl && isInteractiveContent(n)) {
            return null;
          }
          n = parentOf.call(n) as Element | null;
        }
        return ctl;
      } catch (e) {
        return null;
      }
    }

    // HTML "interactive content" as the browsers apply it to label activation:
    // element kinds, not ARIA roles or tabindex.
    function isInteractiveContent(n: Element): boolean {
      if (n.namespaceURI !== "http://www.w3.org/1999/xhtml") {
        return false;
      }
      switch (n.localName) {
        case "a":
          return n.hasAttribute("href");
        case "audio":
        case "video":
          return n.hasAttribute("controls");
        case "img":
        case "object":
          return n.hasAttribute("usemap");
        case "input":
          return (n.getAttribute("type") || "").toLowerCase() !== "hidden";
        case "button":
        case "details":
        case "embed":
        case "iframe":
        case "label":
        case "select":
        case "textarea":
          return true;
        default:
          return false;
      }
    }

    function clickWithLabelForwarding(el: Element): void {
      const ctl = labeledCheckControl(el);
      let reached = false;
      const mark = function (): void {
        reached = true;
      };
      if (ctl) {
        try {
          ctl.addEventListener("click", mark, true);
        } catch (e) {
          /* ignore */
        }
      }
      try {
        (el as { click?: () => void }).click?.();
      } catch (e) {
        /* ignore activation errors */
      }
      if (ctl) {
        try {
          ctl.removeEventListener("click", mark, true);
        } catch (e) {
          /* ignore */
        }
        if (!reached) {
          try {
            (ctl as { click?: () => void }).click?.();
          } catch (e) {
            /* ignore activation errors */
          }
        }
      }
    }

    // `at` overrides the event coordinates: a retargeted click (see
    // activationTargetFor) reports the point the hit-test actually landed on,
    // not the centre of the inner control it was forwarded to.
    function dispatchClickSequence(
      el: Element,
      doubleClick?: boolean,
      at?: { x: number; y: number }
    ): void {
      const c = at || elementCenter(el);
      // Realistic covert press sequence: symmetric pointer/mouse pairs with
      // coordinates and button state. None of these activate the element, so they
      // are safe to dispatch alongside the single real activation below.
      el.dispatchEvent(mouseEvt("pointerover", { x: c.x, y: c.y }));
      el.dispatchEvent(mouseEvt("pointerenter", { x: c.x, y: c.y }));
      el.dispatchEvent(mouseEvt("pointermove", { x: c.x, y: c.y }));
      el.dispatchEvent(mouseEvt("pointerdown", { x: c.x, y: c.y, buttons: 1 }));
      el.dispatchEvent(mouseEvt("mousedown", { x: c.x, y: c.y, buttons: 1 }));
      // Real clicks move focus to the clicked element so a following type-text
      // targets it. Synthetic el.click() does NOT move focus, so do it
      // explicitly (no-op for non-focusable elements).
      try {
        (el as { focus?: () => void }).focus?.();
      } catch (e) {
        /* not focusable — ignore */
      }
      el.dispatchEvent(mouseEvt("pointerup", { x: c.x, y: c.y, buttons: 0 }));
      el.dispatchEvent(mouseEvt("mouseup", { x: c.x, y: c.y, buttons: 0 }));
      // Exactly ONE activation: el.click() fires the element's `click` event
      // AND performs the default action (follows links, toggles checkboxes,
      // submits forms). We deliberately do NOT also dispatch a synthetic
      // `click` MouseEvent — doing so would double-activate the element.
      clickWithLabelForwarding(el);
      if (doubleClick) {
        // A real double-click fires `dblclick` after the click above.
        el.dispatchEvent(mouseEvt("dblclick", { x: c.x, y: c.y }));
      }
    }

    // --- interception hit-test helpers (inner; classifyHit's decision body is a
    //     byte-identical twin of the exported module-scope classifyHit the unit
    //     tests import, which carries its own copies of the composed helpers) ---

    // Containment is COMPOSED (flat-tree): a node inside a shadow root is a
    // descendant of its host, and slotted light content is a descendant of its
    // slot. Plain contains() stops at every shadow boundary, so a click on a
    // shadow-DOM button used to read as "intercepted by <its host>".
    function classifyHit(
      target: Element | null,
      topmost: Element | null
    ): "self" | "ancestor" | "descendant" | "unrelated" {
      if (!target || !topmost) {
        return "self";
      }
      if (topmost === target) {
        return "self";
      }
      if (composedContains(target, topmost)) {
        return "descendant";
      }
      if (composedContains(topmost, target)) {
        return "ancestor";
      }
      return "unrelated";
    }

    // The element to NAME for an interception: the cover as seen from a tree the
    // target is rendered through. A cover inside some OTHER component's shadow
    // root is named by that component's host (a cookie banner built as a web
    // component reads as its host element, exactly as the old document-level
    // hit-test reported it); a cover in any tree on the target's composed path —
    // its own, or the shadow tree of an ancestor host it is slotted into (an app
    // shell's scrim) — is named itself. Without shadow roots this is always the
    // topmost element. The upward walk is capped (see isRenderedWithin).
    function interceptSubject(target: Element, cover: Element): Element {
      const shared: Node[] = [];
      let n: Node | null = target;
      for (let steps = 0; n && steps < 4096; steps++) {
        const r = n.getRootNode();
        if (shared.indexOf(r) < 0) {
          shared.push(r);
        }
        n = composedParent(n);
      }
      let c: Element = cover;
      for (let depth = 0; depth < 32; depth++) {
        const r = c.getRootNode();
        const h = (r as any).host as Element | undefined;
        if (shared.indexOf(r) >= 0 || !h) {
          break;
        }
        c = h;
      }
      return c;
    }

    // --- role-wrapper click retargeting ---
    // A menu/list/grid row whose ONE control fills it (`<li role=menuitem>
    // <button>Draft…</button></li>`) is a single target: a real click at the
    // row's centre lands on the button's text and activates the button, while a
    // click dispatched on the row never reaches the button's own handler. So a
    // click on such a wrapper goes to that control. Everything else keeps the
    // click: containers with several controls, dialogs / radiogroups / tablists
    // / backdrops (not wrapper roles), elements with an activation of their own
    // (a link, a label, an editor), a row that shows text of its own ("Invoice
    // 42 · Acme · Paid" with only "Acme" a link), and a disabled or unrendered
    // control. The wrapper roles and the one-control rule mirror the snapshot's
    // role-wrapper collapse (snapshot-script.ts).
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

    function firstRoleToken(el: Element): string {
      return (el.getAttribute("role") || "").trim().split(/\s+/)[0].toLowerCase();
    }

    // First role token that makes an element an interactive control (the shared
    // interactive-control predicate; the snapshot's role-wrapper collapse keys
    // on the same list).
    const INTERACTIVE_ROLES: Record<string, true> = {
      button: true, link: true, checkbox: true, radio: true, switch: true,
      menuitem: true, menuitemcheckbox: true, menuitemradio: true, option: true,
      tab: true, treeitem: true, textbox: true, searchbox: true, combobox: true,
      slider: true, spinbutton: true,
    };

    function isInteractiveControl(el: Element): boolean {
      const tag = el.localName;
      if (tag === "button" || tag === "select" || tag === "textarea" || tag === "summary") {
        return true;
      }
      if ((tag === "a" || tag === "area") && el.hasAttribute("href")) {
        return true;
      }
      if (tag === "input") {
        return (el.getAttribute("type") || "").toLowerCase() !== "hidden";
      }
      const ce = el.getAttribute("contenteditable");
      if (ce !== null && ce.toLowerCase() !== "false") {
        return true;
      }
      const ti = el.getAttribute("tabindex");
      if (ti !== null && parseInt(ti, 10) >= 0) {
        return true;
      }
      const role = (el.getAttribute("role") || "").trim().split(/\s+/)[0].toLowerCase();
      return INTERACTIVE_ROLES[role] === true;
    }

    // Elements whose own click already does something — follows a link, presses
    // a button, edits, forwards to a labeled control. Such a uid is never
    // unwrapped: the click is meant for it, whatever sits at its centre.
    function hasOwnActivation(el: Element): boolean {
      const tag = el.localName;
      if (
        tag === "button" ||
        tag === "input" ||
        tag === "select" ||
        tag === "textarea" ||
        tag === "summary" ||
        tag === "label"
      ) {
        return true;
      }
      if ((tag === "a" || tag === "area") && el.hasAttribute("href")) {
        return true;
      }
      if ((el as { isContentEditable?: boolean }).isContentEditable === true) {
        return true;
      }
      const ce = el.getAttribute("contenteditable");
      return ce !== null && ce.toLowerCase() !== "false";
    }

    function isDisabledControl(el: Element): boolean {
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") {
        return true;
      }
      try {
        return el.matches(":disabled"); // e.g. inside a disabled <fieldset>
      } catch (e) {
        return false;
      }
    }

    function computedStyleOf(el: Element): CSSStyleDeclaration | null {
      try {
        return win && typeof win.getComputedStyle === "function"
          ? win.getComputedStyle(el)
          : null;
      } catch (e) {
        return null;
      }
    }

    // Rendered: not visibility:hidden, and nothing hidden / display:none between
    // it and `stop` (a display:none ancestor hides it although its own computed
    // display is not "none"). Every upward walk here is capped: a form control
    // named "parentNode" makes the form's parentNode lie, and the walk would
    // cycle.
    function isRenderedWithin(el: Element, stop: Element): boolean {
      let n: Node | null = el;
      for (let steps = 0; n && n !== stop && steps < 4096; steps++) {
        if (n.nodeType === 1) {
          if ((n as Element).hasAttribute("hidden")) {
            return false;
          }
          const cs = computedStyleOf(n as Element);
          if (cs && cs.display === "none") {
            return false;
          }
        }
        n = composedParent(n);
      }
      const own = computedStyleOf(el);
      return !(own && (own.visibility === "hidden" || own.visibility === "collapse"));
    }

    // w and every shadow root hosted inside it (open, or closed via the
    // extension APIs). Walked with querySelectorAll, never .children, which a
    // form control named "children" shadows.
    function scopesWithin(w: Element): (Element | ShadowRoot)[] {
      const scopes: (Element | ShadowRoot)[] = [w];
      const own = shadowRootOf(w);
      if (own) {
        scopes.push(own);
      }
      for (let s = 0; s < scopes.length; s++) {
        const all = scopes[s].querySelectorAll("*");
        for (let i = 0; i < all.length; i++) {
          const sr = shadowRootOf(all[i]);
          if (sr) {
            scopes.push(sr);
          }
        }
      }
      return scopes;
    }

    // The ONE visible, enabled interactive control rendered inside w, or null
    // when there is none or there are several.
    function soleEnabledControl(w: Element, scopes: (Element | ShadowRoot)[]): Element | null {
      let found: Element | null = null;
      for (let s = 0; s < scopes.length; s++) {
        const all = scopes[s].querySelectorAll("*");
        for (let i = 0; i < all.length; i++) {
          const e = all[i];
          // aria-hidden too: the snapshot never lists such a control.
          if (
            isInteractiveControl(e) &&
            e.getAttribute("aria-hidden") !== "true" &&
            !isDisabledControl(e) &&
            isRenderedWithin(e, w)
          ) {
            if (found) {
              return null;
            }
            found = e;
          }
        }
      }
      return found;
    }

    // True when w shows text of its own outside `inner`: it then says more than
    // its one control (a row reading "Invoice 42 · Acme · Paid" whose only link
    // is "Acme") and stays the click target. Stands in for the snapshot's rule
    // that a collapsed wrapper and its control carry the same name. Only
    // rendered text counts; a hidden subtree's text is not shown.
    function hasOwnText(
      w: Element,
      scopes: (Element | ShadowRoot)[],
      inner: Element
    ): boolean {
      for (let s = 0; s < scopes.length; s++) {
        const walker = doc.createTreeWalker(scopes[s], 4 /* NodeFilter.SHOW_TEXT */);
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          if (!/\S/.test(t.nodeValue || "") || composedContains(inner, t)) {
            continue;
          }
          const p = t.parentNode as Node | null;
          const pe = (p && p.nodeType === 11 ? (p as ShadowRoot).host : p) as Element | null;
          if (!pe || pe.localName === "style" || pe.localName === "script") {
            continue;
          }
          if (isRenderedWithin(pe, w)) {
            return true;
          }
        }
      }
      return false;
    }

    // Where a real click at a role wrapper's centre lands its activation: on the
    // wrapper's one control when the centre hit lies inside that control, or
    // inside a <label> for it (label forwarding then runs on the label). Every
    // other case — see the rules above — returns the uid element itself, which
    // is exactly what was clicked before retargeting existed.
    function activationTargetFor(target: Element, hit: Element): Element {
      if (hasOwnActivation(target) || !isWrapperRole(firstRoleToken(target))) {
        return target;
      }
      const scopes = scopesWithin(target);
      const only = soleEnabledControl(target, scopes);
      if (!only || typeof (only as { click?: unknown }).click !== "function") {
        return target;
      }
      let chosen: Element | null = null;
      let n: Node | null = hit;
      for (let steps = 0; n && n !== target && steps < 4096; steps++) {
        if (
          n === only ||
          (n.nodeType === 1 &&
            (n as Element).localName === "label" &&
            (n as { control?: Element | null }).control === only)
        ) {
          chosen = n as Element;
          break;
        }
        n = composedParent(n);
      }
      if (!chosen || hasOwnText(target, scopes, chosen)) {
        return target;
      }
      return chosen;
    }

    function describeTarget(el: Element): { tag: string; name?: string } {
      const label = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const text = label || (el.textContent || "").replace(/\s+/g, " ").trim();
      const name = text ? text.slice(0, 80) : undefined;
      return {
        tag: el.tagName.toLowerCase(),
        ...(name ? { name: name } : {}),
      };
    }

    function describeIntercept(el: Element): {
      tag: string;
      id?: string;
      classes?: string;
      role?: string;
      name?: string;
    } {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? el.id : undefined;
      const clsAttr = (el.getAttribute("class") || "")
        .replace(/\s+/g, " ")
        .trim();
      const classes = clsAttr ? clsAttr : undefined;
      const role = el.getAttribute("role") || undefined;
      const ariaLabel = el.getAttribute("aria-label");
      const rawName =
        ariaLabel || (el.textContent || "").replace(/\s+/g, " ").trim();
      const name = rawName ? rawName.slice(0, 80) : undefined;
      return {
        tag: tag,
        ...(id ? { id: id } : {}),
        ...(classes ? { classes: classes } : {}),
        ...(role ? { role: role } : {}),
        ...(name ? { name: name } : {}),
      };
    }

    function selectorFor(desc: {
      tag: string;
      id?: string;
      classes?: string;
      role?: string;
      name?: string;
    }): string {
      if (desc.id) {
        return "#" + desc.id;
      }
      if (desc.classes) {
        return desc.tag + "." + desc.classes.split(" ")[0];
      }
      return desc.tag;
    }

    // Tag tests use localName: in an application/xhtml+xml document tagName
    // keeps its lowercase spelling ("input"), so tagName === "INPUT" fails there.
    function isCheckable(el: Element): boolean {
      if (el.localName !== "input") {
        return false;
      }
      const type = ((el.getAttribute("type") || "") as string).toLowerCase();
      return type === "checkbox" || type === "radio";
    }

    function truthyValue(value: string): boolean {
      return value === "true" || value === "on" || value === "1";
    }

    function nativeSetValue(el: Element, value: string): void {
      // Use the prototype's native value setter so framework-managed inputs
      // (React, etc.) observe the change instead of swallowing it.
      const proto =
        el.localName === "textarea"
          ? win!.HTMLTextAreaElement.prototype
          : win!.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = descriptor && descriptor.set;
      if (setter) {
        setter.call(el, value);
      } else {
        (el as { value?: string }).value = value;
      }
    }

    function focusSafely(el: Element): void {
      try {
        (el as { focus?: () => void }).focus?.();
      } catch (e) {
        /* ignore focus errors */
      }
    }

    function fillElement(
      el: Element,
      value: string,
      uid: string
    ): { ok: boolean; error?: string } {
      scrollTo(el);

      if (el.localName === "select") {
        // Resolve the option by exact value OR trimmed visible text / label, then
        // set it through the native HTMLSelectElement value setter so a
        // React-controlled <select> observes the change; fire input + change.
        const sel = el as HTMLSelectElement;
        const opts = sel.options;
        const wantNorm = (value || "").replace(/\s+/g, " ").trim();
        let chosen: HTMLOptionElement | null = null;
        for (let i = 0; i < opts.length; i++) {
          if (opts[i].value === value) {
            chosen = opts[i];
            break;
          }
        }
        if (!chosen) {
          for (let j = 0; j < opts.length; j++) {
            const o = opts[j];
            const t = (o.textContent || "").replace(/\s+/g, " ").trim();
            const lbl = (o.getAttribute("label") || "").replace(/\s+/g, " ").trim();
            if (t === wantNorm || lbl === wantNorm) {
              chosen = o;
              break;
            }
          }
        }
        if (!chosen) {
          return {
            ok: false,
            error:
              'No <option> matching "' +
              value +
              '" in the <select> (matched neither an option value nor its visible text).',
          };
        }
        const proto = win!.HTMLSelectElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        const setter = descriptor && descriptor.set;
        if (setter) {
          setter.call(el, chosen.value);
        } else {
          (el as { value?: string }).value = chosen.value;
        }
        // input is composed (it crosses shadow boundaries, as the browser's own
        // does); change is not.
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }

      if (isCheckable(el)) {
        // React binds a checkbox/radio's onChange to the native CLICK (its
        // ChangeEventPlugin uses shouldUseClickEvent), so assigning `.checked`
        // directly is swallowed and reverts on the next render. Drive the real
        // covert click sequence instead — it toggles the state AND fires the
        // input/change that React observes. Let the click flip the state; do NOT
        // also assign `.checked` (that would double-toggle or fight the click).
        const target = truthyValue(value);
        const isRadio = (el.getAttribute("type") || "").toLowerCase() === "radio";
        const cur = (el as { checked?: boolean }).checked === true;
        if (isRadio) {
          if (target && !cur) {
            dispatchClickSequence(el);
          }
        } else if (cur !== target) {
          dispatchClickSequence(el);
        }
        return { ok: true };
      }

      // Anything that is not an <input>/<textarea> (a shadow host, a plain div, a
      // contenteditable editor) has no value to set: the native
      // HTMLInputElement setter would throw "Illegal invocation" at it, which
      // told the caller nothing. Say what the element is instead.
      if (el.localName !== "input" && el.localName !== "textarea") {
        return {
          ok: false,
          error:
            "Element uid '" +
            uid +
            "' (<" +
            el.localName +
            ">) is not a fillable field — fill-element sets <input>, <textarea> and <select> values. Target the field itself (take a fresh snapshot); for a contenteditable editor, click it and use type-text.",
        };
      }

      // Text input / textarea.
      focusSafely(el);
      nativeSetValue(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    // Maps a KeyboardEvent.key to its physical `code` and legacy `keyCode`, so
    // synthetic key events carry the identity that React/editor handlers branch
    // on (e.g. keyCode===13 for Enter). Without this they see keyCode 0 and no-op.
    function keyInfo(key: string): { code: string; keyCode: number } {
      const named: { [k: string]: [string, number] } = {
        Enter: ["Enter", 13],
        Tab: ["Tab", 9],
        Escape: ["Escape", 27],
        Esc: ["Escape", 27],
        Backspace: ["Backspace", 8],
        Delete: ["Delete", 46],
        ArrowUp: ["ArrowUp", 38],
        ArrowDown: ["ArrowDown", 40],
        ArrowLeft: ["ArrowLeft", 37],
        ArrowRight: ["ArrowRight", 39],
        Home: ["Home", 36],
        End: ["End", 35],
        PageUp: ["PageUp", 33],
        PageDown: ["PageDown", 34],
        " ": ["Space", 32],
        Spacebar: ["Space", 32],
      };
      if (named[key]) {
        return { code: named[key][0], keyCode: named[key][1] };
      }
      if (key && key.length === 1) {
        const c = key;
        if (c >= "a" && c <= "z") {
          return { code: "Key" + c.toUpperCase(), keyCode: c.toUpperCase().charCodeAt(0) };
        }
        if (c >= "A" && c <= "Z") {
          return { code: "Key" + c, keyCode: c.charCodeAt(0) };
        }
        if (c >= "0" && c <= "9") {
          return { code: "Digit" + c, keyCode: c.charCodeAt(0) };
        }
        return { code: "", keyCode: c.charCodeAt(0) };
      }
      return { code: "", keyCode: 0 };
    }

    function isPrintableKey(key: string): boolean {
      return !!key && key.length === 1;
    }

    function keyEvt(
      type: string,
      key: string,
      modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
    ): KeyboardEvent {
      const mods = modifiers || {};
      const info = keyInfo(key);
      const ev = new KeyboardEvent(type, {
        key: key,
        code: info.code,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win as Window,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        altKey: !!mods.alt,
        metaKey: !!mods.meta,
      });
      // Chrome ignores keyCode/which passed to the KeyboardEvent constructor, so
      // define them after construction.
      try {
        Object.defineProperty(ev, "keyCode", {
          get: function () {
            return info.keyCode;
          },
        });
        Object.defineProperty(ev, "which", {
          get: function () {
            return info.keyCode;
          },
        });
      } catch (e) {
        /* some engines disallow redefining — best effort */
      }
      return ev;
    }

    function contentEditableHost(el: Element): boolean {
      if ((el as { isContentEditable?: boolean }).isContentEditable === true) {
        return true;
      }
      const ce = el.getAttribute("contenteditable");
      return ce === "" || ce === "true" || ce === "plaintext-only";
    }

    // --- contenteditable typing helpers. The same bodies are inlined in every
    //     injected module that types into an editor; keep the copies identical. ---

    // The editing host: the outermost ancestor in the element's own tree that is
    // still editable. Only the host takes focus and holds a caret, and it is
    // where an editor listens for beforeinput: focus() on a <p> inside it does
    // nothing, so typing aimed at that <p> never reached the editor. The walk
    // reads the native parentElement getter (a form control named
    // "parentElement" shadows the form's own), stops at a shadow root and is
    // capped.
    function editingHost(el: Element): Element {
      const parentOf = Object.getOwnPropertyDescriptor(Node.prototype, "parentElement")!.get!;
      let host = el;
      for (let steps = 0; steps < 4096; steps++) {
        const p = parentOf.call(host) as Element | null;
        if (!p || !contentEditableHost(p)) {
          break;
        }
        host = p;
      }
      return host;
    }

    // The text the editor shows. innerText follows rendering (line breaks
    // included); jsdom has no innerText, so tests read textContent.
    function renderedText(host: Element): string {
      const shown = (host as { innerText?: unknown }).innerText;
      return typeof shown === "string" ? shown : host.textContent || "";
    }

    // Chrome scopes a shadow tree's selection to its root
    // (ShadowRoot.getSelection); elsewhere the window's selection reaches it.
    function editorSelection(host: Element): Selection | null {
      const root = host.getRootNode() as unknown as {
        host?: unknown;
        getSelection?: () => Selection | null;
      };
      if (root.host && typeof root.getSelection === "function") {
        return root.getSelection();
      }
      return win && typeof win.getSelection === "function" ? win.getSelection() : null;
    }

    // The caret a click at (x, y) leaves: caretPositionFromPoint (Firefox,
    // Chrome 128+), else caretRangeFromPoint (older Chrome, Safari).
    function caretAtPoint(x: number, y: number): { node: Node; offset: number } | null {
      const d = doc as unknown as {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      if (typeof d.caretPositionFromPoint === "function") {
        try {
          const p = d.caretPositionFromPoint(x, y);
          if (p && p.offsetNode) {
            return { node: p.offsetNode, offset: p.offset };
          }
        } catch (e) {
          /* fall through to caretRangeFromPoint */
        }
      }
      if (typeof d.caretRangeFromPoint === "function") {
        try {
          const r = d.caretRangeFromPoint(x, y);
          if (r && r.startContainer) {
            return { node: r.startContainer, offset: r.startOffset };
          }
        } catch (e) {
          /* no caret at the point */
        }
      }
      return null;
    }

    // The end of the editor's text: after its last text node, else inside its
    // innermost last element short of a <br>. An empty Lexical editor is
    // <div><p><br></p></div>, so the caret goes into the <p> and the text lands
    // in the paragraph, not beside it.
    function endOfHost(host: Element): { node: Node; offset: number } {
      const walker = doc.createTreeWalker(host, 4 /* NodeFilter.SHOW_TEXT */);
      let last: Node | null = null;
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        last = t;
      }
      if (last) {
        return { node: last, offset: (last.nodeValue || "").length };
      }
      let n: Element = host;
      for (let steps = 0; steps < 4096; steps++) {
        const c: Element | null = n.lastElementChild;
        if (!c || c.localName === "br") {
          break;
        }
        n = c;
      }
      return { node: n, offset: 0 };
    }

    // Puts the caret where the text should go. type-at passes its point: the
    // caret goes where a real click there leaves it, when that is inside the
    // host. type-text and the humanized step pass null: a caret already in the
    // host stays put (a click placed it, or typing is under way). Anything else
    // goes to the end of the host.
    function placeCaret(host: Element, at: { x: number; y: number } | null): void {
      const sel = editorSelection(host);
      if (!sel) {
        return;
      }
      let pos: { node: Node; offset: number } | null = null;
      if (at) {
        pos = caretAtPoint(at.x, at.y);
        if (pos && !host.contains(pos.node)) {
          pos = null;
        }
      } else if (sel.anchorNode && host.contains(sel.anchorNode)) {
        return;
      }
      if (!pos) {
        pos = endOfHost(host);
      }
      try {
        sel.collapse(pos.node, pos.offset);
      } catch (e) {
        /* the selection refused the node; typing goes wherever the caret is */
      }
    }

    // Inserts text into the editing host the way a real edit does: a
    // cancelable beforeinput, then (if not prevented) the browser's own
    // insertText, which fires the real input event itself. Only where
    // execCommand is missing or refuses (no caret in an editable region) does a
    // Text node go in at the caret, followed by an input event. textContent is
    // never reassigned: that wipes the editor's own nodes, and an editor that
    // owns its DOM (Lexical) puts them straight back. A canceled beforeinput
    // means the editor drives its own model; whether it inserted anything is
    // for the caller's check to find out.
    function insertIntoContentEditable(host: Element, text: string): void {
      const IE = (win as { InputEvent?: typeof InputEvent } | null) &&
        (win as { InputEvent?: typeof InputEvent }).InputEvent;
      // An InputEvent carrying inputType:"insertText" + data, or a plain Event
      // with the same props where InputEvent is unavailable.
      function inputEvt(type: string, cancelable: boolean): Event {
        if (typeof IE === "function") {
          return new (IE as typeof InputEvent)(type, {
            inputType: "insertText",
            data: text,
            bubbles: true,
            cancelable: cancelable,
            composed: true,
          });
        }
        const ev = new Event(type, { bubbles: true, cancelable: cancelable, composed: true });
        try {
          Object.defineProperty(ev, "inputType", { value: "insertText" });
          Object.defineProperty(ev, "data", { value: text });
        } catch (e) {
          /* best effort */
        }
        return ev;
      }
      // dispatchEvent returns false = canceled.
      if (!host.dispatchEvent(inputEvt("beforeinput", true))) {
        return;
      }
      const doExec = (doc as {
        execCommand?: (c: string, s?: boolean, v?: string) => boolean;
      }).execCommand;
      if (typeof doExec === "function") {
        try {
          if (doExec.call(doc, "insertText", false, text)) {
            // Inserted, and the browser fired the real input event. A second,
            // synthetic one makes an editor that inserts on input do it twice.
            return;
          }
        } catch (e) {
          /* fall back to inserting the node */
        }
      }
      const node = doc.createTextNode(text);
      const sel = editorSelection(host);
      let placed = false;
      try {
        const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        if (range && host.contains(range.startContainer)) {
          range.insertNode(node);
          placed = true;
          sel!.collapse(node, text.length);
        }
      } catch (e) {
        /* no usable caret; append below */
      }
      if (!placed) {
        host.appendChild(node);
      }
      host.dispatchEvent(inputEvt("input", false));
    }

    // Whether the editor kept what was typed: its text differs from `before`
    // and, after a bulk insertion (settleMs > 0), still differs settleMs later,
    // since an editor that undoes a change it did not make (a MutationObserver
    // putting its own DOM back) does so within that window. Polled every 20 ms
    // for up to 600 ms. The first look waits one task, so the editor's own
    // microtask work and any such undo have run. "Differs", not "contains the
    // text": editors rewrite input (a Markdown shortcut turns *abc* into an
    // italic "abc").
    function keptAfter(host: Element, before: string, settleMs: number): Promise<boolean> {
      const deadline = Date.now() + 600;
      function differs(): boolean {
        try {
          return renderedText(host) !== before;
        } catch (e) {
          return false;
        }
      }
      return new Promise(function (resolve) {
        function again(): void {
          if (Date.now() >= deadline) {
            resolve(false);
          } else {
            setTimeout(look, 20);
          }
        }
        function look(): void {
          if (!differs()) {
            again();
          } else if (settleMs <= 0) {
            resolve(true);
          } else {
            setTimeout(function () {
              if (differs()) {
                resolve(true);
              } else {
                again();
              }
            }, settleMs);
          }
        }
        setTimeout(look, 0);
      });
    }

    // The error for text the editor did not keep, naming the editing host.
    function notKeptError(host: Element): string {
      const role = host.getAttribute("role");
      return (
        "The editor did not keep the typed text: <" +
        host.localName +
        (role ? ' role="' + role + '"' : "") +
        '> ignores or undoes synthetic input, so nothing was entered. Trusted input works where synthetic input does not: on Chrome/Edge retry type-at with engine:"cdp"; on Firefox set Input Realism to Native in the FoxPilot options (needs the input sidecar), then click-element and type-text.'
      );
    }

    // Types text into a contenteditable for type-at and type-text: focus the
    // editing host, put the caret where the keys should land, yield once so the
    // page sees the focus and selectionchange (editors sync their own selection
    // there, and a placeholder that drops out on focus is gone before the
    // baseline), insert, press the keys on the host (keys go to the focused
    // element), then check that the editor kept the text BEFORE any Enter: a
    // chat box that sends on Enter clears itself. Empty text (the humanized path
    // submitting after typing char by char) skips the insertion and the check.
    // Never rejects.
    async function typeIntoEditor(
      host: Element,
      text: string,
      submit: boolean,
      at: { x: number; y: number } | null
    ): Promise<{ ok: boolean; error?: string }> {
      try {
        try {
          (host as { focus?: () => void }).focus?.();
        } catch (e) {
          /* not focusable */
        }
        placeCaret(host, at);
        if (text !== "") {
          await new Promise(function (resolve) {
            setTimeout(resolve, 0);
          });
          const before = renderedText(host);
          insertIntoContentEditable(host, text);
          for (let i = 0; i < text.length; i++) {
            const ch = text.charAt(i);
            host.dispatchEvent(keyEvt("keydown", ch));
            if (isPrintableKey(ch)) {
              host.dispatchEvent(keyEvt("keypress", ch));
            }
            host.dispatchEvent(keyEvt("keyup", ch));
          }
          if (!(await keptAfter(host, before, 40))) {
            return { ok: false, error: notKeptError(host) };
          }
        }
        if (submit) {
          host.dispatchEvent(keyEvt("keydown", "Enter"));
          host.dispatchEvent(keyEvt("keyup", "Enter"));
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }

    // --- dispatch on the requested action ---

    if (args.action === "click") {
      const el = resolve(args.uid);
      if (!el) {
        return notFound(args.uid);
      }
      scrollTo(el);
      // Interception hit-test BEFORE dispatch. elementFromPoint is called HERE
      // (the caller); the topmost node is handed to the PURE classifyHit, so the
      // decision logic is unit-testable. jsdom has no layout (elementFromPoint
      // undefined, zero rects) so this whole block no-ops there — existing click
      // tests are unaffected; real geometry is Playwright-covered. The hit-test
      // pierces shadow roots: document.elementFromPoint alone stops at the
      // outermost host.
      let intercepted:
        | {
            tag: string;
            id?: string;
            classes?: string;
            role?: string;
            name?: string;
          }
        | undefined;
      // What receives the pointer sequence: the uid element, or the interactive
      // descendant a real click at its centre would activate.
      let dispatchEl: Element = el;
      let hitPoint: { x: number; y: number } | undefined;
      const efp = (doc as {
        elementFromPoint?: (x: number, y: number) => Element | null;
      }).elementFromPoint;
      if (typeof efp === "function") {
        try {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const topmost = deepElementFromPoint(doc, cx, cy);
            const rel = topmost ? classifyHit(el, topmost) : "self";
            if (topmost && rel === "unrelated") {
              intercepted = describeIntercept(interceptSubject(el, topmost));
            } else if (topmost && rel === "descendant") {
              dispatchEl = activationTargetFor(el, topmost);
              if (dispatchEl !== el) {
                hitPoint = { x: cx, y: cy };
              }
            }
          }
        } catch (e) {
          /* no layout / detached — skip the hit-test, never throw */
        }
      }
      if (intercepted && args.failIfIntercepted) {
        return {
          ok: false,
          intercepted: intercepted,
          error: "click intercepted by " + selectorFor(intercepted),
        };
      }
      dispatchClickSequence(dispatchEl, args.doubleClick, hitPoint);
      const dispatchedTo = dispatchEl !== el ? describeTarget(dispatchEl) : undefined;
      return {
        ok: true,
        ...(intercepted ? { intercepted: intercepted } : {}),
        ...(dispatchedTo ? { dispatchedTo: dispatchedTo } : {}),
      };
    }

    if (args.action === "classify-intercept") {
      // Read-only interception probe for the CDP engine, which dispatches trusted
      // events from the BACKGROUND and so cannot run this isolated-world hit-test
      // itself. Resolves the uid, scrolls it into view (so the measured center
      // matches the coordinate the CDP click will use), and returns the SAME
      // `intercepted` descriptor the synthetic click arm above computes — WITHOUT
      // dispatching anything. Best-effort: any miss/failure is ok:true with no
      // interception, so it never blocks the click that follows.
      const el = resolve(args.uid);
      if (!el) {
        return { ok: true };
      }
      // Match readElementRect's scroll (block+inline center) — the CDP click's
      // coordinate comes from there, so hit-testing at the SAME resulting center
      // keeps the verdict aligned with where the trusted click actually lands
      // (a bare block:"center" leaves inline at "nearest", diverging on X for a
      // horizontally-scrollable target).
      try {
        (el as { scrollIntoView?: (opts?: unknown) => void }).scrollIntoView?.({
          block: "center",
          inline: "center",
        });
      } catch (e) {
        /* jsdom / no layout — never throw on scroll */
      }
      let intercepted:
        | {
            tag: string;
            id?: string;
            classes?: string;
            role?: string;
            name?: string;
          }
        | undefined;
      const efp = (doc as {
        elementFromPoint?: (x: number, y: number) => Element | null;
      }).elementFromPoint;
      if (typeof efp === "function") {
        try {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const topmost = deepElementFromPoint(doc, cx, cy);
            if (topmost && classifyHit(el, topmost) === "unrelated") {
              intercepted = describeIntercept(interceptSubject(el, topmost));
            }
          }
        } catch (e) {
          /* no layout / detached — skip the hit-test, never throw */
        }
      }
      return intercepted ? { ok: true, intercepted: intercepted } : { ok: true };
    }

    if (args.action === "hover") {
      const el = resolve(args.uid);
      if (!el) {
        return notFound(args.uid);
      }
      scrollTo(el);
      const hc = elementCenter(el);
      el.dispatchEvent(mouseEvt("pointerover", { x: hc.x, y: hc.y }));
      el.dispatchEvent(mouseEvt("pointerenter", { x: hc.x, y: hc.y }));
      el.dispatchEvent(mouseEvt("pointermove", { x: hc.x, y: hc.y }));
      el.dispatchEvent(mouseEvt("mouseover", { x: hc.x, y: hc.y }));
      el.dispatchEvent(mouseEvt("mouseenter", { x: hc.x, y: hc.y }));
      el.dispatchEvent(mouseEvt("mousemove", { x: hc.x, y: hc.y }));
      return { ok: true };
    }

    if (args.action === "fill") {
      const el = resolve(args.uid);
      if (!el) {
        return notFound(args.uid);
      }
      return fillElement(el, args.value, args.uid);
    }

    if (args.action === "fill-form") {
      for (let i = 0; i < args.fields.length; i++) {
        const field = args.fields[i];
        const el = resolve(field.uid);
        if (!el) {
          return notFound(field.uid);
        }
        const r = fillElement(el, field.value, field.uid);
        if (!r.ok) {
          return r;
        }
      }
      return { ok: true };
    }

    if (args.action === "type") {
      // Focus inside a shadow tree leaves document.activeElement on the
      // outermost host; drill down to the element that actually has focus.
      const active = deepActiveElement(doc);
      const tag = active ? active.localName : "";
      const isField = tag === "input" || tag === "textarea";
      const isCE = !!active && contentEditableHost(active as Element);
      if (!active || (!isField && !isCE)) {
        return {
          ok: false,
          error: "No focused element to type into — click or fill an input first.",
        };
      }
      const el = active as Element;
      const text = args.text;
      if (isField) {
        const current = ((el as { value?: string }).value || "") as string;
        nativeSetValue(el, current + text);
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      } else {
        // contenteditable (the SPA rich-text-editor case): typed through its
        // editing host at the caret, and ok only when the editor kept the text
        // (see typeIntoEditor).
        return typeIntoEditor(editingHost(el), text, !!args.submit, null);
      }
      for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        el.dispatchEvent(keyEvt("keydown", ch));
        if (isPrintableKey(ch)) {
          el.dispatchEvent(keyEvt("keypress", ch));
        }
        el.dispatchEvent(keyEvt("keyup", ch));
      }
      if (args.submit) {
        el.dispatchEvent(keyEvt("keydown", "Enter"));
        el.dispatchEvent(keyEvt("keyup", "Enter"));
        const form = (el as { form?: HTMLFormElement }).form;
        if (form) {
          try {
            const rs = (form as { requestSubmit?: () => void }).requestSubmit;
            if (typeof rs === "function") {
              rs.call(form);
            } else {
              form.submit();
            }
          } catch (e) {
            /* ignore submit errors */
          }
        }
      }
      return { ok: true };
    }

    if (args.action === "press-key") {
      // deepActiveElement: keys land on the focused element inside a shadow
      // root, not on its host (they still bubble out, composed).
      const target: EventTarget = deepActiveElement(doc) || doc.body;
      const mods: {
        ctrl?: boolean;
        shift?: boolean;
        alt?: boolean;
        meta?: boolean;
      } = {};
      const list = args.modifiers || [];
      for (let i = 0; i < list.length; i++) {
        const m = (list[i] || "").toLowerCase();
        if (m === "ctrl" || m === "control") {
          mods.ctrl = true;
        } else if (m === "shift") {
          mods.shift = true;
        } else if (m === "alt") {
          mods.alt = true;
        } else if (m === "meta" || m === "cmd" || m === "command") {
          mods.meta = true;
        }
      }
      target.dispatchEvent(keyEvt("keydown", args.key, mods));
      // A printable key with no ctrl/alt/meta held also produces a keypress (the
      // legacy character-input signal some handlers still read). Modifier chords
      // (Ctrl+A etc.) and named keys do not.
      if (isPrintableKey(args.key) && !mods.ctrl && !mods.alt && !mods.meta) {
        target.dispatchEvent(keyEvt("keypress", args.key, mods));
      }
      target.dispatchEvent(keyEvt("keyup", args.key, mods));
      return { ok: true };
    }

    if (args.action === "drag") {
      const from = resolve(args.fromUid);
      if (!from) {
        return notFound(args.fromUid);
      }
      const to = resolve(args.toUid);
      if (!to) {
        return notFound(args.toUid);
      }

      scrollTo(from);

      // A single DataTransfer is shared across the whole drag sequence so the
      // payload set on dragstart survives through to drop, the way a real drag
      // works. It may be unavailable (older engines / jsdom) — fall back to null.
      let dt: DataTransfer | null;
      try {
        dt = win ? new win.DataTransfer() : null;
      } catch (e) {
        dt = null;
      }

      // Dispatch one HTML5 drag event of `type` on `target`. Prefer a real
      // DragEvent (which carries the dataTransfer natively); when DragEvent is
      // unavailable, fall back to a MouseEvent and best-effort attach the shared
      // dataTransfer so listeners reading event.dataTransfer still see it.
      function dragEvt(type: string, target: EventTarget): void {
        let ev: Event;
        const DragEventCtor = win
          ? (win as { DragEvent?: typeof DragEvent }).DragEvent
          : undefined;
        if (DragEventCtor) {
          ev = new DragEventCtor(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          } as DragEventInit);
        } else {
          ev = new MouseEvent(type, { bubbles: true, cancelable: true });
          try {
            Object.defineProperty(ev, "dataTransfer", { value: dt });
          } catch (e) {
            /* some engines disallow redefining — listeners just won't see it */
          }
        }
        target.dispatchEvent(ev);
      }

      // Pointer/mouse fallback for sites whose drag-and-drop is implemented with
      // pointer events rather than the HTML5 drag API. Prefer PointerEvent; fall
      // back to MouseEvent when it is unavailable.
      function pointerEvt(type: string, target: EventTarget): void {
        let ev: Event;
        const PointerEventCtor = win
          ? (win as { PointerEvent?: typeof PointerEvent }).PointerEvent
          : undefined;
        if (PointerEventCtor) {
          ev = new PointerEventCtor(type, { bubbles: true, cancelable: true });
        } else {
          ev = new MouseEvent(type, { bubbles: true, cancelable: true });
        }
        target.dispatchEvent(ev);
      }

      // Press on the source.
      pointerEvt("pointerdown", from);
      from.dispatchEvent(mouseEvt("mousedown"));
      // HTML5 drag handshake: start on the source, move over the target, drop on
      // the target, then end on the source.
      dragEvt("dragstart", from);
      dragEvt("dragenter", to);
      // Move over the target (both pointer-based and HTML5 listeners).
      pointerEvt("pointermove", to);
      to.dispatchEvent(mouseEvt("mousemove"));
      dragEvt("dragover", to);
      dragEvt("drop", to);
      dragEvt("dragend", from);
      // Release on the target.
      pointerEvt("pointerup", to);
      to.dispatchEvent(mouseEvt("mouseup"));

      // NOTE: HTML5 drag-and-drop driven by synthetic events is best-effort.
      // Real drags are produced by the OS/compositor, so some sites (especially
      // those relying on native dataTransfer side effects or trusted events)
      // will not respond to this. The pointer/mouse fallback covers many
      // JS-based DnD libraries, but not all.
      return { ok: true };
    }

    return { ok: false, error: "Unknown action" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Pure hit-test classifier for click-interception detection. Given the intended
 * click `target` and the `topmost` element the (shadow-piercing) hit-test found
 * at the target's center, classify their relationship in the COMPOSED (flat)
 * tree: a node inside a shadow root is inside its host, slotted light content is
 * inside its slot. elementFromPoint is deliberately NOT called here — the CALLER
 * passes `topmost` in — so this stays a pure function that jsdom unit tests
 * exercise with fabricated nodes (jsdom has no layout / no elementFromPoint).
 * Only "unrelated" (a foreign overlay covering the target) counts as an
 * interception.
 *
 *   "self"        topmost IS the target.
 *   "descendant"  topmost is inside the target (e.g. an inner label) — the click
 *                 still lands on the target's own subtree; NOT intercepted.
 *   "ancestor"    the target is inside topmost (topmost is the target's own
 *                 wrapper / shadow host) — same subtree; NOT intercepted.
 *   "unrelated"   topmost is in a DIFFERENT subtree — a foreign overlay covers
 *                 the target. THIS is an interception.
 *
 * DUPLICATION NOTE: `performInputAction` carries a byte-identical INNER copy of
 * the decision body below (it is stringified-and-injected and may not reference
 * module scope). Both rely on the shared shadow-DOM helper bodies, which this
 * export inlines for itself. Keep the copies in sync.
 */
export function classifyHit(
  target: Element | null,
  topmost: Element | null
): "self" | "ancestor" | "descendant" | "unrelated" {
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
  // Native accessors, read once per call. A <form> exposes its controls as named properties that SHADOW
  // built-ins ([LegacyOverrideBuiltIns]): `<form><select name="children">` makes `form.children` return the
  // select, and `<input name="parentNode">` makes `form.parentNode` return that input, which turns every walk
  // up through the form into a cycle. Prototype getters are immune; where an environment lacks one, the plain
  // property is read. Documents and shadow roots have no such named properties.
  function protoGetter(proto: () => object, name: string): ((this: unknown) => unknown) | undefined {
    try { const d = Object.getOwnPropertyDescriptor(proto(), name); return d && d.get; } catch (_) { return undefined; }
  }
  const nativeParentNode = protoGetter(() => Node.prototype, "parentNode");
  const nativeAssignedSlot = protoGetter(() => Element.prototype, "assignedSlot");
  // Flat-tree parent: slotted node → its slot, top-level node of a shadow tree → host, else parentNode.
  // assignedSlot is ALWAYS null when the host's root is closed (even for extensions), so for a child of a
  // closed host we find the slot from the root side (root.querySelectorAll("slot") + assignedNodes()).
  function composedParent(n: Node): Node | null {
    const slot = (n.nodeType === 1 && nativeAssignedSlot ? nativeAssignedSlot.call(n) : (n as any).assignedSlot) as Element | null | undefined;
    if (slot) return slot;
    const p = (nativeParentNode ? nativeParentNode.call(n) : n.parentNode) as Node | null;
    if (!p) return null;
    if (p.nodeType === 11 && (p as any).host) return (p as any).host as Element;
    if (p.nodeType === 1 && !(p as any).shadowRoot) {
      const sr = shadowRootOf(p as Element); // non-null here only for a closed root
      if (sr) {
        const slots = sr.querySelectorAll("slot");
        for (let i = 0; i < slots.length; i++) {
          if (typeof (slots[i] as any).assignedNodes !== "function") continue; // <svg><slot>
          const assigned = (slots[i] as HTMLSlotElement).assignedNodes();
          for (let j = 0; j < assigned.length; j++) if (assigned[j] === n) return slots[i];
        }
      }
    }
    return p;
  }
  // Capped: a content script shares the page's main thread, so no page may turn this walk into an endless loop.
  function composedContains(ancestor: Node, node: Node | null): boolean {
    let n: Node | null = node;
    for (let steps = 0; n && steps < 4096; steps++, n = composedParent(n)) if (n === ancestor) return true;
    return false;
  }

  if (!target || !topmost) {
    return "self";
  }
  if (topmost === target) {
    return "self";
  }
  if (composedContains(target, topmost)) {
    return "descendant";
  }
  if (composedContains(topmost, target)) {
    return "ancestor";
  }
  return "unrelated";
}
