/**
 * Input-action executor for the snapshot uid model.
 *
 * CRITICAL: `performInputAction` is used in TWO ways:
 *   (a) Imported and unit-tested directly in jsdom.
 *   (b) Injected into the page world via `chrome.scripting.executeScript`
 *       (func/args), where it runs with no access to this module.
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
export function performInputAction(
  doc: Document,
  args:
    | { action: "click"; uid: string; doubleClick?: boolean }
    | { action: "hover"; uid: string }
    | { action: "fill"; uid: string; value: string }
    | { action: "fill-form"; fields: { uid: string; value: string }[] }
    | { action: "type"; text: string; submit?: boolean }
    | { action: "press-key"; key: string; modifiers?: string[] }
    | { action: "drag"; fromUid: string; toUid: string }
): { ok: boolean; error?: string } {
  const UID_ATTR = "data-bcmcp-uid";

  try {
    const win = doc.defaultView as (Window & typeof globalThis) | null;

    // --- inner helpers (must stay inside this function body) ---

    function resolve(uid: string): Element | null {
      return doc.querySelector("[" + UID_ATTR + '="' + uid + '"]');
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

    function mouseEvt(type: string): Event {
      return new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: win as Window,
      });
    }

    function dispatchClickSequence(el: Element, doubleClick?: boolean): void {
      // Realistic press sequence. None of these activate the element, so they
      // are safe to dispatch alongside the single real activation below.
      el.dispatchEvent(mouseEvt("pointerdown"));
      el.dispatchEvent(mouseEvt("mousedown"));
      el.dispatchEvent(mouseEvt("mouseup"));
      // Real clicks move focus to the clicked element so a following type-text
      // targets it. Synthetic el.click() does NOT move focus, so do it
      // explicitly (no-op for non-focusable elements).
      try {
        (el as { focus?: () => void }).focus?.();
      } catch (e) {
        /* not focusable — ignore */
      }
      // Exactly ONE activation: el.click() fires the element's `click` event
      // AND performs the default action (follows links, toggles checkboxes,
      // submits forms). We deliberately do NOT also dispatch a synthetic
      // `click` MouseEvent — doing so would double-activate the element.
      try {
        (el as { click?: () => void }).click?.();
      } catch (e) {
        /* ignore activation errors */
      }
      if (doubleClick) {
        // A real double-click fires `dblclick` after the click above.
        el.dispatchEvent(mouseEvt("dblclick"));
      }
    }

    function isCheckable(el: Element): boolean {
      if (el.tagName !== "INPUT") {
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

    function focusSafely(el: Element): void {
      try {
        (el as { focus?: () => void }).focus?.();
      } catch (e) {
        /* ignore focus errors */
      }
    }

    function fillElement(el: Element, value: string): void {
      scrollTo(el);

      if (el.tagName === "SELECT") {
        (el as { value?: string }).value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }

      if (isCheckable(el)) {
        // Set the desired state directly — do NOT dispatch a synthetic click.
        // A click would itself fire `change`, so combined with the explicit
        // `change` below it would fire change twice (and toggle relative to the
        // current state rather than landing on the requested value). Setting
        // `checked` and firing input + change once each is deterministic
        // regardless of the element's starting state.
        const target = truthyValue(value);
        (el as { checked?: boolean }).checked = target;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }

      // Text input / textarea.
      focusSafely(el);
      nativeSetValue(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function keyEvt(
      type: string,
      key: string,
      modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
    ): KeyboardEvent {
      const mods = modifiers || {};
      return new KeyboardEvent(type, {
        key: key,
        bubbles: true,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        altKey: !!mods.alt,
        metaKey: !!mods.meta,
      });
    }

    // --- dispatch on the requested action ---

    if (args.action === "click") {
      const el = resolve(args.uid);
      if (!el) {
        return notFound(args.uid);
      }
      scrollTo(el);
      dispatchClickSequence(el, args.doubleClick);
      return { ok: true };
    }

    if (args.action === "hover") {
      const el = resolve(args.uid);
      if (!el) {
        return notFound(args.uid);
      }
      scrollTo(el);
      el.dispatchEvent(mouseEvt("mouseover"));
      el.dispatchEvent(
        new MouseEvent("mouseenter", {
          bubbles: false,
          cancelable: true,
          view: win as Window,
        })
      );
      el.dispatchEvent(mouseEvt("mousemove"));
      return { ok: true };
    }

    if (args.action === "fill") {
      const el = resolve(args.uid);
      if (!el) {
        return notFound(args.uid);
      }
      fillElement(el, args.value);
      return { ok: true };
    }

    if (args.action === "fill-form") {
      for (let i = 0; i < args.fields.length; i++) {
        const field = args.fields[i];
        const el = resolve(field.uid);
        if (!el) {
          return notFound(field.uid);
        }
        fillElement(el, field.value);
      }
      return { ok: true };
    }

    if (args.action === "type") {
      const active = doc.activeElement;
      const tag = active ? active.tagName : "";
      const isField = tag === "INPUT" || tag === "TEXTAREA";
      if (!active || !isField) {
        return {
          ok: false,
          error: "No focused element to type into — click or fill an input first.",
        };
      }
      const el = active as Element;
      const text = args.text;
      const current = ((el as { value?: string }).value || "") as string;
      nativeSetValue(el, current + text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
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
            /* ignore submit errors */
          }
        }
      }
      return { ok: true };
    }

    if (args.action === "press-key") {
      const target: EventTarget = doc.activeElement || doc.body;
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
