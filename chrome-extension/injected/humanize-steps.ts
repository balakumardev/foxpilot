/**
 * Single-step injected helpers for the synthetic (Tier 1) human-like executor.
 *
 * CRITICAL - like `performInputAction`, each exported function here is injected
 * into the page via `chrome.scripting.executeScript`, so each MUST be fully
 * self-contained: no imports, no module-scope references,
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
        composed: true,
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
    const win = doc.defaultView as (Window & typeof globalThis) | null;

    function contentEditableHost(el: Element): boolean {
      if ((el as { isContentEditable?: boolean }).isContentEditable === true) {
        return true;
      }
      const ce = el.getAttribute("contenteditable");
      return ce === "" || ce === "true" || ce === "plaintext-only";
    }

    const isField = tag === "INPUT" || tag === "TEXTAREA";
    const isCE = !!active && contentEditableHost(active as Element);
    if (!active || (!isField && !isCE)) {
      return { ok: false, error: "No focused field to type into." };
    }
    const el = active as Element;

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

    function keyEvt(type: string): KeyboardEvent {
      const info = keyInfo(ch);
      const ev = new KeyboardEvent(type, {
        key: ch,
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

    // Builds an InputEvent (or a plain Event carrying inputType/data where
    // InputEvent is unavailable) for the beforeinput/input pair.
    function makeInputEvt(type: string, data: string, cancelable: boolean): Event {
      const IE = win && (win as { InputEvent?: typeof InputEvent }).InputEvent;
      if (typeof IE === "function") {
        return new (IE as typeof InputEvent)(type, {
          inputType: "insertText",
          data: data,
          bubbles: true,
          cancelable: cancelable,
          composed: true,
        });
      }
      const ev = new Event(type, { bubbles: true, cancelable: cancelable });
      try {
        Object.defineProperty(ev, "inputType", { value: "insertText" });
        Object.defineProperty(ev, "data", { value: data });
      } catch (e) {
        /* best effort */
      }
      return ev;
    }

    el.dispatchEvent(keyEvt("keydown"));
    if (isField) {
      const notPrevented = el.dispatchEvent(makeInputEvt("beforeinput", ch, true));
      if (notPrevented) {
        const current = ((el as { value?: string }).value || "") as string;
        nativeSetValue(el, current + ch);
      }
      el.dispatchEvent(makeInputEvt("input", ch, false));
    } else {
      // contenteditable host — beforeinput, then (only if not canceled) insertion
      // and input. A canceled beforeinput (editor drives its own model) fires
      // NEITHER — the extra input would be a spurious signal.
      const notPrevented = el.dispatchEvent(makeInputEvt("beforeinput", ch, true));
      if (notPrevented) {
        let inserted = false;
        const doExec = (doc as {
          execCommand?: (c: string, s?: boolean, v?: string) => boolean;
        }).execCommand;
        if (typeof doExec === "function") {
          try {
            inserted = doExec.call(doc, "insertText", false, ch);
          } catch (e) {
            inserted = false;
          }
        }
        if (!inserted) {
          (el as { textContent?: string }).textContent =
            (el.textContent || "") + ch;
        }
        el.dispatchEvent(makeInputEvt("input", ch, false));
      }
    }
    if (isPrintableKey(ch)) {
      el.dispatchEvent(keyEvt("keypress"));
    }
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
 * steps above it is injected into the page, so all logic stays inline (no
 * imports or sibling-function calls).
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
