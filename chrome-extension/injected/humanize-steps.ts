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

    // The cursor moves over what is really under it, inside shadow roots too
    // (the document-level hit stops at the outermost host).
    const target: EventTarget =
      (typeof doc.elementFromPoint === "function" ? deepElementFromPoint(doc, x, y) : null) ||
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

// A contenteditable step waits for the editor before it answers (see
// typeCharIntoEditor), so it returns a Promise; a field step answers
// synchronously.
export function typeCharStep(
  doc: Document,
  ch: string
): { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }> {
  try {
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

    // Focus inside a shadow tree leaves document.activeElement on the host.
    const active = deepActiveElement(doc);
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
      // In a Firefox content script `ev` is an Xray view of the page's event:
      // the two properties above stay on that view, and page code still read
      // keyCode 0 (so a menu that closes on keyCode 27 ignored Escape). The
      // page-side object (wrappedJSObject) takes them as its own. Chrome's
      // isolated world has no wrappedJSObject; there this does nothing.
      try {
        const pageEv = (ev as { wrappedJSObject?: object }).wrappedJSObject;
        if (pageEv) {
          Object.defineProperty(pageEv, "keyCode", { value: info.keyCode });
          Object.defineProperty(pageEv, "which", { value: info.keyCode });
        }
      } catch (e) {
        /* best effort */
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
      // Composed like the InputEvent branch (and the browser's own input), so
      // listeners outside a shadow root see it.
      const ev = new Event(type, { bubbles: true, cancelable: cancelable, composed: true });
      try {
        Object.defineProperty(ev, "inputType", { value: "insertText" });
        Object.defineProperty(ev, "data", { value: data });
      } catch (e) {
        /* best effort */
      }
      return ev;
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

    // Lets the queued microtasks run: an editor that commits in one (Lexical)
    // and a MutationObserver undoing a change have both run when this resolves.
    // Unlike timers, microtasks are not throttled in a background tab.
    async function afterMicrotasks(): Promise<void> {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
    }

    // One character into a contenteditable: the focus and caret of type-text,
    // then keydown, the insertion, keypress and keyup on the editing host, and
    // ok only when the editor kept the character. This runs once per character,
    // so it stays off timers while it can: a background tab throttles each
    // timer to about a second, which would cost seconds per character. A
    // change that is there once the editor's microtasks have run answers at
    // once; only a character that has not landed by then waits out the timed
    // check. Never rejects.
    async function typeCharIntoEditor(host: Element): Promise<{ ok: boolean; error?: string }> {
      try {
        try {
          (host as { focus?: () => void }).focus?.();
        } catch (e) {
          /* not focusable */
        }
        placeCaret(host, null);
        await afterMicrotasks();
        const before = renderedText(host);
        host.dispatchEvent(keyEvt("keydown"));
        insertIntoContentEditable(host, ch);
        if (isPrintableKey(ch)) {
          host.dispatchEvent(keyEvt("keypress"));
        }
        host.dispatchEvent(keyEvt("keyup"));
        await afterMicrotasks();
        if (renderedText(host) === before && !(await keptAfter(host, before, 0))) {
          return { ok: false, error: notKeptError(host) };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }

    if (!isField) {
      // contenteditable host: typed through its editing host at the caret, and
      // ok only when the editor kept the character (see typeCharIntoEditor).
      return typeCharIntoEditor(editingHost(el));
    }
    el.dispatchEvent(keyEvt("keydown"));
    const notPrevented = el.dispatchEvent(makeInputEvt("beforeinput", ch, true));
    if (notPrevented) {
      const current = ((el as { value?: string }).value || "") as string;
      nativeSetValue(el, current + ch);
    }
    el.dispatchEvent(makeInputEvt("input", ch, false));
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

    const el = deepQuery(doc, '[data-bcmcp-uid="' + uid + '"]');
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
