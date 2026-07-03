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

    return { ok: false, error: "Unknown point action" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
