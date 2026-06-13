/**
 * Single-step injected helpers for the synthetic (Tier 1) human-like executor.
 *
 * CRITICAL - like `performInputAction`, each exported function here is
 * stringified via `.toString()` and injected with `browser.tabs.executeScript`,
 * so each MUST be fully self-contained: no imports, no module-scope references,
 * no sibling-function calls. Every helper is an inner function. (Guarded by
 * self-containment.test.ts.)
 *
 * The background paces these: it calls one step, waits, calls the next. None of
 * these perform an authoritative mutation that the instant path doesn't already
 * perform - `dispatchMouseMoveStep` only emits movement events, and
 * `typeCharStep` appends exactly one character (the same net effect as the
 * instant `type` action, just one char at a time).
 */

export function dispatchMouseMoveStep(
  doc: Document,
  x: number,
  y: number
): { ok: boolean; error?: string } {
  try {
    const win = doc.defaultView as (Window & typeof globalThis) | null;
    const target: EventTarget =
      (doc.elementFromPoint ? doc.elementFromPoint(x, y) : null) ||
      doc.documentElement;

    function move(type: string): Event {
      const init = {
        bubbles: true,
        cancelable: true,
        view: win as Window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      };
      const PE =
        win && (win as { PointerEvent?: typeof PointerEvent }).PointerEvent;
      if (type.indexOf("pointer") === 0 && PE) {
        return new PE(type, init as PointerEventInit);
      }
      return new MouseEvent(type, init as MouseEventInit);
    }

    target.dispatchEvent(move("pointermove"));
    target.dispatchEvent(move("mousemove"));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function typeCharStep(
  doc: Document,
  ch: string
): { ok: boolean; error?: string } {
  try {
    const active = doc.activeElement;
    const tag = active ? active.tagName : "";
    if (!active || (tag !== "INPUT" && tag !== "TEXTAREA")) {
      return { ok: false, error: "No focused field to type into." };
    }
    const el = active as Element;
    const win = doc.defaultView as (Window & typeof globalThis) | null;

    function nativeSetValue(target: Element, value: string): void {
      const proto =
        target.tagName === "TEXTAREA"
          ? win!.HTMLTextAreaElement.prototype
          : win!.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = descriptor && descriptor.set;
      if (setter) {
        setter.call(target, value);
      } else {
        (target as { value?: string }).value = value;
      }
    }

    function keyEvt(type: string): KeyboardEvent {
      return new KeyboardEvent(type, { key: ch, bubbles: true });
    }

    el.dispatchEvent(keyEvt("keydown"));
    const current = ((el as { value?: string }).value || "") as string;
    nativeSetValue(el, current + ch);
    try {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: ch,
        })
      );
    } catch (e) {
      /* InputEvent may be unavailable in some engines - input below suffices */
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(keyEvt("keyup"));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Reads an element's bounding rect in absolute SCREEN coordinates so the native
 * sidecar can move the real OS cursor to the right pixel. Firefox exposes the
 * exact viewport->screen offset as `window.mozInnerScreenX/Y`; where that is
 * unavailable (e.g. jsdom, non-Firefox engines) we fall back to a 0 offset, so
 * the returned rect degrades to client coordinates. Self-contained: like the
 * steps above it is stringified and injected, so all logic stays inline.
 */
export function readElementScreenRect(
  doc: Document,
  uid: string
): { screenX: number; screenY: number; width: number; height: number; dpr: number } | null {
  try {
    const el = doc.querySelector('[data-bcmcp-uid="' + uid + '"]');
    if (!el) return null;
    try {
      (el as { scrollIntoView?: (o?: unknown) => void }).scrollIntoView?.({
        block: "center",
        inline: "center",
      });
    } catch (e) {}
    const rect = (el as Element).getBoundingClientRect();
    const win = doc.defaultView as (Window & typeof globalThis) | null;
    const w = win as unknown as {
      mozInnerScreenX?: number;
      mozInnerScreenY?: number;
      devicePixelRatio?: number;
    } | null;
    const offX = w && typeof w.mozInnerScreenX === "number" ? w.mozInnerScreenX : 0;
    const offY = w && typeof w.mozInnerScreenY === "number" ? w.mozInnerScreenY : 0;
    const dpr = w && w.devicePixelRatio ? w.devicePixelRatio : 1;
    return {
      screenX: offX + rect.left,
      screenY: offY + rect.top,
      width: rect.width,
      height: rect.height,
      dpr,
    };
  } catch (e) {
    return null;
  }
}
