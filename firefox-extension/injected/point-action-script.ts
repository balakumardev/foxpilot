/**
 * Coordinate (synthetic) interaction executor for the -at tools + the scroll
 * tools. Like action-script.ts's performInputAction, every exported function
 * here is used TWO ways: (a) imported and unit-tested in jsdom; (b) run in the
 * ISOLATED content-script world — Chrome imports it into content-script.ts and
 * calls it directly; Firefox stringifies it via `.toString()` and injects it
 * with browser.tabs.executeScript. Both are CSP-IMMUNE: pure DOM ops
 * (elementFromPoint, dispatchEvent, scrollBy, scrollIntoView) — no eval, no
 * page-world <script>. So each function MUST be fully self-contained: inner
 * helpers only, no imports, no module-scope references (enforced by
 * self-containment.test.ts).
 *
 * jsdom caveat: document.elementFromPoint returns null (no layout) and
 * getBoundingClientRect returns zeros, so unit tests stub elementFromPoint and
 * do not assert rect values.
 */

export interface PointElementDescriptor {
  tag: string;
  id?: string;
  classes: string[];
  role?: string;
  name?: string;
  rect: { x: number; y: number; w: number; h: number };
  editable?: boolean;
}

type PointActionArgs =
  | {
      action: "click-at";
      x: number;
      y: number;
      doubleClick?: boolean;
      button?: "left" | "middle" | "right";
    }
  | { action: "type-at"; x: number; y: number; text: string; submit?: boolean }
  | { action: "hover-at"; x: number; y: number }
  | { action: "scroll-at"; x: number; y: number; dx?: number; dy?: number }
  | { action: "describe-at"; x: number; y: number };

interface PointActionResult {
  ok: boolean;
  error?: string;
  element?: PointElementDescriptor;
}

// type-at into a contenteditable waits for the editor before it answers (see
// typeIntoEditor), so it can return a Promise; every other action answers
// synchronously.
export function performPointAction(
  doc: Document,
  args: Extract<PointActionArgs, { action: "type-at" }>
): PointActionResult | Promise<PointActionResult>;
export function performPointAction(
  doc: Document,
  args: Exclude<PointActionArgs, { action: "type-at" }>
): PointActionResult;
export function performPointAction(
  doc: Document,
  args: PointActionArgs
): PointActionResult | Promise<PointActionResult>;
export function performPointAction(
  doc: Document,
  args: PointActionArgs
): PointActionResult | Promise<PointActionResult> {
  try {
    const win = doc.defaultView as (Window & typeof globalThis) | null;

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

    // The element under the point, drilled through shadow roots (open, and
    // closed via the extension APIs): document.elementFromPoint alone stops at
    // the outermost host, so the -at tools acted on — and described — the host.
    function elementAt(x: number, y: number): Element | null {
      const efp = (doc as {
        elementFromPoint?: (x: number, y: number) => Element | null;
      }).elementFromPoint;
      if (typeof efp !== "function") {
        return null;
      }
      return deepElementFromPoint(doc, x, y);
    }

    function offPoint(x: number, y: number): { ok: boolean; error?: string } {
      return {
        ok: false,
        error:
          "No element at point (" +
          x +
          ", " +
          y +
          ") — the coordinates may be outside the visible viewport or over a cross-origin frame.",
      };
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

    function isEditable(el: Element): boolean {
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return true;
      }
      return (el as { isContentEditable?: boolean }).isContentEditable === true;
    }

    function describeElement(el: Element): PointElementDescriptor {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? el.id : undefined;
      const classes =
        typeof (el as { className?: unknown }).className === "string"
          ? (el.getAttribute("class") || "").split(/\s+/).filter(Boolean)
          : [];
      const role = el.getAttribute("role") || undefined;
      const ariaLabel = el.getAttribute("aria-label");
      const rawName =
        ariaLabel || (el.textContent || "").replace(/\s+/g, " ").trim();
      const name = rawName ? rawName.slice(0, 80) : undefined;
      let rect = { x: 0, y: 0, w: 0, h: 0 };
      try {
        const r = (el as Element).getBoundingClientRect();
        rect = { x: r.left, y: r.top, w: r.width, h: r.height };
      } catch (e) {
        /* jsdom / detached — zero rect */
      }
      return {
        tag,
        ...(id ? { id } : {}),
        classes,
        ...(role ? { role } : {}),
        ...(name ? { name } : {}),
        rect,
        editable: isEditable(el),
      };
    }

    // Builds a MouseEvent (or PointerEvent for `pointer*` types when the engine
    // has PointerEvent) carrying viewport coordinates, the pressed button + button
    // bitmask and `composed:true`. screenX/screenY approximate clientX/clientY;
    // pageX/pageY are derived natively from clientX/clientY + scroll. `enter`
    // variants correctly do not bubble.
    function mouseEvt(
      type: string,
      opts?: { button?: number; buttons?: number; x?: number; y?: number }
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
        button: typeof o.button === "number" ? o.button : 0,
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

    // The `buttons` bitmask for a held mouse button: 1=left, 2=right, 4=middle.
    function buttonsMask(b: number): number {
      if (b === 2) return 2;
      if (b === 1) return 4;
      return 1;
    }

    function buttonCode(b?: "left" | "middle" | "right"): number {
      if (b === "middle") return 1;
      if (b === "right") return 2;
      return 0;
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

    function keyEvt(type: string, key: string): KeyboardEvent {
      const info = keyInfo(key);
      const ev = new KeyboardEvent(type, {
        key: key,
        code: info.code,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win as Window,
      });
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

    function nativeSetValue(el: Element, value: string): void {
      const proto =
        el.tagName === "TEXTAREA"
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

    // True when the element is a contenteditable host. Prefers the IDL
    // isContentEditable property (which a real browser also reports true for
    // descendants of an editable host); falls back to the contenteditable
    // attribute for environments that don't reflect that property (e.g. jsdom).
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

    if (args.action === "click-at") {
      const el = elementAt(args.x, args.y);
      if (!el) {
        return offPoint(args.x, args.y);
      }
      const b = buttonCode(args.button);
      const x = args.x;
      const y = args.y;
      const bm = buttonsMask(b);
      // Realistic covert press sequence (none activate the element) + focus,
      // mirroring action-script.ts's dispatchClickSequence: symmetric
      // pointer/mouse pairs, coordinates and button state.
      el.dispatchEvent(mouseEvt("pointerover", { x, y, button: b }));
      el.dispatchEvent(mouseEvt("pointerenter", { x, y, button: b }));
      el.dispatchEvent(mouseEvt("pointermove", { x, y, button: b }));
      el.dispatchEvent(mouseEvt("pointerdown", { x, y, button: b, buttons: bm }));
      el.dispatchEvent(mouseEvt("mousedown", { x, y, button: b, buttons: bm }));
      try {
        (el as { focus?: () => void }).focus?.();
      } catch (e) {
        /* not focusable */
      }
      el.dispatchEvent(mouseEvt("pointerup", { x, y, button: b, buttons: 0 }));
      el.dispatchEvent(mouseEvt("mouseup", { x, y, button: b, buttons: 0 }));
      if (b === 2) {
        el.dispatchEvent(mouseEvt("contextmenu", { x, y, button: b }));
      } else if (b === 1) {
        el.dispatchEvent(mouseEvt("auxclick", { x, y, button: b }));
      } else {
        // Exactly ONE left activation: el.click() fires `click` + default action.
        clickWithLabelForwarding(el);
      }
      if (args.doubleClick) {
        el.dispatchEvent(mouseEvt("dblclick", { x, y, button: b }));
      }
      return { ok: true, element: describeElement(el) };
    }

    if (args.action === "type-at") {
      const el = elementAt(args.x, args.y);
      if (!el) {
        return offPoint(args.x, args.y);
      }
      const x = args.x;
      const y = args.y;
      // Click-to-focus (press sequence + focus + activate) so the type targets it.
      el.dispatchEvent(mouseEvt("pointerdown", { x, y, buttons: 1 }));
      el.dispatchEvent(mouseEvt("mousedown", { x, y, buttons: 1 }));
      try {
        (el as { focus?: () => void }).focus?.();
      } catch (e) {
        /* ignore */
      }
      el.dispatchEvent(mouseEvt("pointerup", { x, y, buttons: 0 }));
      el.dispatchEvent(mouseEvt("mouseup", { x, y, buttons: 0 }));
      try {
        (el as { click?: () => void }).click?.();
      } catch (e) {
        /* ignore */
      }
      const text = args.text;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        // Framework-safe native-setter append + input (mirrors action-script.ts).
        const current = ((el as { value?: string }).value || "") as string;
        nativeSetValue(el, current + text);
        // Composed like the browser's own input event, so listeners outside a
        // shadow root see it.
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      } else if (contentEditableHost(el)) {
        // contenteditable (the SPA chat-input case). The point usually lands
        // on a <p> or <span> inside the editor, so the typing goes through its
        // editing host, starting where a click at the point leaves the caret,
        // and reports ok only when the editor kept the text.
        return typeIntoEditor(editingHost(el), text, !!args.submit, { x: x, y: y })
          .then(function (r) {
            return r.ok
              ? { ok: true, element: describeElement(el) }
              : { ok: false, error: r.error, element: describeElement(el) };
          })
          .catch(function (e) {
            return { ok: false, error: String(e) };
          });
      } else {
        return {
          ok: false,
          error:
            "Element at point is not typable (not an input, textarea, or contenteditable).",
          element: describeElement(el),
        };
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
            /* ignore */
          }
        }
      }
      return { ok: true, element: describeElement(el) };
    }

    if (args.action === "hover-at") {
      const el = elementAt(args.x, args.y);
      if (!el) {
        return offPoint(args.x, args.y);
      }
      const x = args.x;
      const y = args.y;
      el.dispatchEvent(mouseEvt("pointerover", { x, y }));
      el.dispatchEvent(mouseEvt("pointerenter", { x, y }));
      el.dispatchEvent(mouseEvt("pointermove", { x, y }));
      el.dispatchEvent(mouseEvt("mouseover", { x, y }));
      el.dispatchEvent(mouseEvt("mouseenter", { x, y }));
      el.dispatchEvent(mouseEvt("mousemove", { x, y }));
      return { ok: true, element: describeElement(el) };
    }

    if (args.action === "scroll-at") {
      const el = elementAt(args.x, args.y);
      if (!el) {
        return offPoint(args.x, args.y);
      }
      function isScrollable(node: Element): boolean {
        if (!win || typeof win.getComputedStyle !== "function") {
          return false;
        }
        let oy = "";
        let ox = "";
        try {
          const cs = win.getComputedStyle(node);
          oy = cs.overflowY || "";
          ox = cs.overflowX || "";
        } catch (e) {
          return false;
        }
        const canY =
          (oy === "auto" || oy === "scroll") &&
          node.scrollHeight > node.clientHeight;
        const canX =
          (ox === "auto" || ox === "scroll") &&
          node.scrollWidth > node.clientWidth;
        return canY || canX;
      }
      // Walk the COMPOSED ancestors: out of a shadow root to its host, and from
      // slotted content into the shadow container it renders in. parentElement
      // stops dead at a shadow root's top level. Capped: a form control named
      // "parentNode" makes the form's parentNode lie and the walk would cycle —
      // past the cap, fall back to scrolling the window.
      let container: Element | null = el;
      for (let steps = 0; container && !isScrollable(container); steps++) {
        if (steps >= 4096) {
          container = null;
          break;
        }
        const up: Node | null = composedParent(container);
        container = up && up.nodeType === 1 ? (up as Element) : null;
      }
      const dx = typeof args.dx === "number" ? args.dx : 0;
      const viewportH = win ? win.innerHeight || 0 : 0;
      if (container) {
        const dy =
          typeof args.dy === "number"
            ? args.dy
            : container.clientHeight || viewportH || 600;
        const sb = (container as {
          scrollBy?: (x: number, y: number) => void;
        }).scrollBy;
        if (typeof sb === "function") {
          sb.call(container, dx, dy);
        } else {
          (container as { scrollTop: number }).scrollTop += dy;
          (container as { scrollLeft: number }).scrollLeft += dx;
        }
        return { ok: true, element: describeElement(container) };
      }
      // No scrollable ancestor — scroll the window.
      const dyWin = typeof args.dy === "number" ? args.dy : viewportH || 600;
      if (win && typeof win.scrollBy === "function") {
        win.scrollBy(dx, dyWin);
      }
      return { ok: true, element: describeElement(el) };
    }

    if (args.action === "describe-at") {
      // Read-only: describe the element under the point WITHOUT acting on it.
      // Used by the CDP engine to return the same descriptor shape as the
      // synthetic path AFTER it has dispatched the trusted Input.* events.
      const el = elementAt(args.x, args.y);
      if (!el) {
        return offPoint(args.x, args.y);
      }
      return { ok: true, element: describeElement(el) };
    }

    return { ok: false, error: "Unknown point action" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function scrollWindowTo(
  doc: Document,
  x?: number,
  y?: number
): { ok: boolean; error?: string } {
  try {
    const win = doc.defaultView as (Window & typeof globalThis) | null;
    if (!win || typeof win.scrollTo !== "function") {
      return { ok: false, error: "Window is not scrollable in this context." };
    }
    const toX = typeof x === "number" ? x : win.scrollX || 0;
    const toY = typeof y === "number" ? y : win.scrollY || 0;
    win.scrollTo(toX, toY);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function scrollElementIntoView(
  doc: Document,
  uid: string
): { ok: boolean; error?: string } {
  try {
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
    // --- shadow-DOM helpers (same bodies as in performPointAction above) ---
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
    const el = deepQuery(doc, '[data-bcmcp-uid="' + uid + '"]');
    if (!el) {
      return {
        ok: false,
        error:
          "Element uid '" +
          uid +
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
          uid +
          "' not found — take a fresh snapshot (uids are reassigned each snapshot).",
      };
    }
    try {
      (el as { scrollIntoView?: (opts?: unknown) => void }).scrollIntoView?.({
        block: "center",
        inline: "center",
      });
    } catch (e) {
      /* jsdom lacks a layout engine — never throw on scroll */
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
