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

    function mouseEvt(type: string, button: number): Event {
      return new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: win as Window,
        button,
      });
    }

    function buttonCode(b?: "left" | "middle" | "right"): number {
      if (b === "middle") return 1;
      if (b === "right") return 2;
      return 0;
    }

    function keyEvt(type: string, key: string): KeyboardEvent {
      return new KeyboardEvent(type, { key: key, bubbles: true });
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
      // Realistic press sequence (none activate the element) + focus, mirroring
      // action-script.ts's dispatchClickSequence.
      el.dispatchEvent(mouseEvt("pointerdown", b));
      el.dispatchEvent(mouseEvt("mousedown", b));
      el.dispatchEvent(mouseEvt("mouseup", b));
      try {
        (el as { focus?: () => void }).focus?.();
      } catch (e) {
        /* not focusable */
      }
      if (b === 2) {
        el.dispatchEvent(mouseEvt("contextmenu", b));
      } else if (b === 1) {
        el.dispatchEvent(mouseEvt("auxclick", b));
      } else {
        // Exactly ONE left activation: el.click() fires `click` + default action.
        try {
          (el as { click?: () => void }).click?.();
        } catch (e) {
          /* ignore */
        }
      }
      if (args.doubleClick) {
        el.dispatchEvent(mouseEvt("dblclick", b));
      }
      return { ok: true, element: describeElement(el) };
    }

    if (args.action === "type-at") {
      const el = elementAt(args.x, args.y);
      if (!el) {
        return offPoint(args.x, args.y);
      }
      // Click-to-focus (press sequence + focus + activate) so the type targets it.
      el.dispatchEvent(mouseEvt("pointerdown", 0));
      el.dispatchEvent(mouseEvt("mousedown", 0));
      el.dispatchEvent(mouseEvt("mouseup", 0));
      try {
        (el as { focus?: () => void }).focus?.();
      } catch (e) {
        /* ignore */
      }
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
        // contenteditable (the SPA chat-input case): insert text + fire input.
        const doExec = (doc as {
          execCommand?: (c: string, s?: boolean, v?: string) => boolean;
        }).execCommand;
        let inserted = false;
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
        el.dispatchEvent(new Event("input", { bubbles: true }));
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
      el.dispatchEvent(mouseEvt("mouseover", 0));
      el.dispatchEvent(
        new MouseEvent("mouseenter", {
          bubbles: false,
          cancelable: true,
          view: win as Window,
        })
      );
      el.dispatchEvent(mouseEvt("mousemove", 0));
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

    return { ok: false, error: "Unknown point action" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
