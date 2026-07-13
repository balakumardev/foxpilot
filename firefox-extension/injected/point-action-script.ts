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

export function performPointAction(
  doc: Document,
  args:
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
    | { action: "describe-at"; x: number; y: number }
): { ok: boolean; error?: string; element?: PointElementDescriptor } {
  try {
    const win = doc.defaultView as (Window & typeof globalThis) | null;

    function elementAt(x: number, y: number): Element | null {
      const efp = (doc as {
        elementFromPoint?: (x: number, y: number) => Element | null;
      }).elementFromPoint;
      if (typeof efp !== "function") {
        return null;
      }
      return efp.call(doc, x, y);
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

    // Inserts text into a contenteditable host the way a real edit does: a
    // cancelable beforeinput, then (if not prevented) the insertion, then input —
    // both as InputEvent carrying inputType:"insertText" + data. Falls back to a
    // plain Event with the same props where InputEvent is unavailable.
    function insertIntoContentEditable(el: Element, text: string): void {
      const IE = (win as { InputEvent?: typeof InputEvent } | null) &&
        (win as { InputEvent?: typeof InputEvent }).InputEvent;
      let beforeEv: Event;
      if (typeof IE === "function") {
        beforeEv = new (IE as typeof InputEvent)("beforeinput", {
          inputType: "insertText",
          data: text,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
      } else {
        beforeEv = new Event("beforeinput", { bubbles: true, cancelable: true });
        try {
          Object.defineProperty(beforeEv, "inputType", { value: "insertText" });
          Object.defineProperty(beforeEv, "data", { value: text });
        } catch (e) {
          /* best effort */
        }
      }
      // A canceled beforeinput means the editor (Lexical/ProseMirror) is driving
      // its own model: perform NEITHER the insertion NOR the input — firing input
      // anyway would be a spurious signal. dispatchEvent returns false = canceled.
      const notPrevented = el.dispatchEvent(beforeEv);
      if (notPrevented) {
        let inserted = false;
        const doExec = (doc as {
          execCommand?: (c: string, s?: boolean, v?: string) => boolean;
        }).execCommand;
        if (typeof doExec === "function") {
          try {
            inserted = doExec.call(doc, "insertText", false, text);
          } catch (e) {
            inserted = false;
          }
        }
        if (!inserted) {
          (el as { textContent?: string }).textContent =
            (el.textContent || "") + text;
        }
        let inputEv: Event;
        if (typeof IE === "function") {
          inputEv = new (IE as typeof InputEvent)("input", {
            inputType: "insertText",
            data: text,
            bubbles: true,
            composed: true,
          });
        } else {
          inputEv = new Event("input", { bubbles: true });
          try {
            Object.defineProperty(inputEv, "inputType", { value: "insertText" });
            Object.defineProperty(inputEv, "data", { value: text });
          } catch (e) {
            /* best effort */
          }
        }
        el.dispatchEvent(inputEv);
      }
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
        try {
          (el as { click?: () => void }).click?.();
        } catch (e) {
          /* ignore */
        }
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
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (contentEditableHost(el)) {
        // contenteditable (the SPA chat-input case): insert via a real
        // beforeinput/input pair carrying inputType:"insertText" + data.
        insertIntoContentEditable(el, text);
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
      let container: Element | null = el;
      while (container && !isScrollable(container)) {
        container = container.parentElement;
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
    const el = doc.querySelector('[data-bcmcp-uid="' + uid + '"]');
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
