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
export function performInputAction(
  doc: Document,
  args:
    | { action: "click"; uid: string; doubleClick?: boolean; failIfIntercepted?: boolean }
    | { action: "hover"; uid: string }
    | { action: "fill"; uid: string; value: string }
    | { action: "fill-form"; fields: { uid: string; value: string }[] }
    | { action: "type"; text: string; submit?: boolean }
    | { action: "press-key"; key: string; modifiers?: string[] }
    | { action: "drag"; fromUid: string; toUid: string }
    | { action: "classify-intercept"; uid: string }
): {
  ok: boolean;
  error?: string;
  intercepted?: {
    tag: string;
    id?: string;
    classes?: string;
    role?: string;
    name?: string;
  };
} {
  const UID_ATTR = "data-bcmcp-uid";

  try {
    const win = doc.defaultView as (Window & typeof globalThis) | null;

    // --- inner helpers (must stay inside this function body) ---

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
      const node = doc.querySelector("[" + UID_ATTR + '="' + uid + '"]');
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

    function dispatchClickSequence(el: Element, doubleClick?: boolean): void {
      const c = elementCenter(el);
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
      try {
        (el as { click?: () => void }).click?.();
      } catch (e) {
        /* ignore activation errors */
      }
      if (doubleClick) {
        // A real double-click fires `dblclick` after the click above.
        el.dispatchEvent(mouseEvt("dblclick", { x: c.x, y: c.y }));
      }
    }

    // --- interception hit-test helpers (inner; classifyHit is a byte-identical
    //     twin of the exported module-scope classifyHit the unit tests import) ---

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
      if (target.contains(topmost)) {
        return "descendant";
      }
      if (topmost.contains(target)) {
        return "ancestor";
      }
      return "unrelated";
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

    function fillElement(el: Element, value: string): { ok: boolean; error?: string } {
      scrollTo(el);

      if (el.tagName === "SELECT") {
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
        el.dispatchEvent(new Event("input", { bubbles: true }));
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

      // Text input / textarea.
      focusSafely(el);
      nativeSetValue(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
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
      // tests are unaffected; real geometry is Playwright-covered.
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
            const topmost = efp.call(doc, cx, cy);
            if (topmost && classifyHit(el, topmost) === "unrelated") {
              intercepted = describeIntercept(topmost);
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
      dispatchClickSequence(el, args.doubleClick);
      return intercepted ? { ok: true, intercepted: intercepted } : { ok: true };
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
            const topmost = efp.call(doc, cx, cy);
            if (topmost && classifyHit(el, topmost) === "unrelated") {
              intercepted = describeIntercept(topmost);
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
      return fillElement(el, args.value);
    }

    if (args.action === "fill-form") {
      for (let i = 0; i < args.fields.length; i++) {
        const field = args.fields[i];
        const el = resolve(field.uid);
        if (!el) {
          return notFound(field.uid);
        }
        const r = fillElement(el, field.value);
        if (!r.ok) {
          return r;
        }
      }
      return { ok: true };
    }

    if (args.action === "type") {
      const active = doc.activeElement;
      const tag = active ? active.tagName : "";
      const isField = tag === "INPUT" || tag === "TEXTAREA";
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
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        // contenteditable host — insert via a real beforeinput/input pair rather
        // than rejecting it (the SPA rich-text-editor case).
        insertIntoContentEditable(el, text);
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
 * click `target` and the `topmost` element document.elementFromPoint returned at
 * the target's center, classify their DOM relationship. elementFromPoint is
 * deliberately NOT called here — the CALLER passes `topmost` in — so this stays a
 * pure function that jsdom unit tests exercise with fabricated nodes (jsdom has
 * no layout / no elementFromPoint). Only "unrelated" (a foreign overlay covering
 * the target) counts as an interception.
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
 * this body (it is stringified-and-injected and may not reference module scope).
 * Keep the two in sync.
 */
export function classifyHit(
  target: Element | null,
  topmost: Element | null
): "self" | "ancestor" | "descendant" | "unrelated" {
  if (!target || !topmost) {
    return "self";
  }
  if (topmost === target) {
    return "self";
  }
  if (target.contains(topmost)) {
    return "descendant";
  }
  if (topmost.contains(target)) {
    return "ancestor";
  }
  return "unrelated";
}
