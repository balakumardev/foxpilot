import { performInputAction, classifyHit } from "../injected/action-script";
import { buildSnapshot } from "../injected/snapshot-script";

/**
 * These tests run in jsdom (the default Jest test environment for this package).
 * They call `performInputAction` directly against a DOM built with
 * `document.body.innerHTML`. The same function is also stringified and injected
 * into the page at runtime, so it must remain fully self-contained.
 *
 * Elements are tagged with `data-bcmcp-uid` either manually or by running
 * `buildSnapshot(document, ...)` first (which stamps the same attribute that
 * `performInputAction` resolves against).
 */
describe("performInputAction", () => {
  const UID_ATTR = "data-bcmcp-uid";

  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  function stamp(el: Element, uid: string) {
    el.setAttribute(UID_ATTR, uid);
  }

  describe("click", () => {
    it("fires a click listener on the targeted element", () => {
      document.body.innerHTML = `<button>Go</button>`;
      const btn = document.querySelector("button")!;
      stamp(btn, "e1");
      const onClick = jest.fn();
      btn.addEventListener("click", onClick);

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(res.ok).toBe(true);
      expect(onClick).toHaveBeenCalled();
    });

    it("focuses the clicked element so a following type-text targets it", () => {
      document.body.innerHTML = `<input type="text" />`;
      const input = document.querySelector("input")!;
      stamp(input, "e1");

      performInputAction(document, { action: "click", uid: "e1" });

      expect(document.activeElement).toBe(input);
    });

    it("fires the click listener EXACTLY once (no double-activation)", () => {
      // Regression: the click path previously dispatched a synthetic `click`
      // MouseEvent AND called el.click(), activating the element twice. A
      // single click-element call must trigger the handler exactly once.
      document.body.innerHTML = `<button>Go</button>`;
      const btn = document.querySelector("button")!;
      stamp(btn, "e1");
      const onClick = jest.fn();
      btn.addEventListener("click", onClick);

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(res.ok).toBe(true);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("toggles a checkbox exactly once via click (ends in the toggled state)", () => {
      // Regression: double-activation toggled a checkbox twice, leaving it
      // unchanged. A single click must flip an unchecked box to checked.
      document.body.innerHTML = `<input type="checkbox" />`;
      const cb = document.querySelector("input")!;
      stamp(cb, "e1");
      expect(cb.checked).toBe(false);

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(res.ok).toBe(true);
      expect(cb.checked).toBe(true);
    });

    it("dispatches a realistic pointer/mouse sequence", () => {
      document.body.innerHTML = `<button>Go</button>`;
      const btn = document.querySelector("button")!;
      stamp(btn, "e1");
      const seen: string[] = [];
      ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) =>
        btn.addEventListener(t, () => seen.push(t))
      );

      performInputAction(document, { action: "click", uid: "e1" });

      expect(seen).toEqual(
        expect.arrayContaining(["pointerdown", "mousedown", "mouseup", "click"])
      );
    });

    it("dispatches dblclick when doubleClick is true", () => {
      document.body.innerHTML = `<button>Go</button>`;
      const btn = document.querySelector("button")!;
      stamp(btn, "e1");
      const onDbl = jest.fn();
      const onClick = jest.fn();
      btn.addEventListener("dblclick", onDbl);
      btn.addEventListener("click", onClick);

      const res = performInputAction(document, {
        action: "click",
        uid: "e1",
        doubleClick: true,
      });

      expect(res.ok).toBe(true);
      expect(onDbl).toHaveBeenCalledTimes(1);
      // doubleClick performs a single real click plus a dblclick — the click
      // handler must still fire exactly once, not twice.
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("returns ok:false mentioning a fresh snapshot when the uid is missing", () => {
      document.body.innerHTML = `<button>Go</button>`;
      const res = performInputAction(document, {
        action: "click",
        uid: "e999",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("e999");
      expect(res.error).toContain("fresh snapshot");
    });
  });

  describe("hover", () => {
    it("dispatches mouseover on the element", () => {
      document.body.innerHTML = `<a href="/x">Menu</a>`;
      const a = document.querySelector("a")!;
      stamp(a, "e1");
      const onOver = jest.fn();
      a.addEventListener("mouseover", onOver);

      const res = performInputAction(document, { action: "hover", uid: "e1" });

      expect(res.ok).toBe(true);
      expect(onOver).toHaveBeenCalled();
    });

    it("returns ok:false when the uid is missing", () => {
      document.body.innerHTML = `<a href="/x">Menu</a>`;
      const res = performInputAction(document, { action: "hover", uid: "nope" });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("fresh snapshot");
    });
  });

  describe("fill", () => {
    it("sets a text input's value and fires input + change", () => {
      document.body.innerHTML = `<input type="text" />`;
      const input = document.querySelector("input")!;
      stamp(input, "e1");
      const onInput = jest.fn();
      const onChange = jest.fn();
      input.addEventListener("input", onInput);
      input.addEventListener("change", onChange);

      const res = performInputAction(document, {
        action: "fill",
        uid: "e1",
        value: "hello world",
      });

      expect(res.ok).toBe(true);
      expect(input.value).toBe("hello world");
      expect(onInput).toHaveBeenCalled();
      expect(onChange).toHaveBeenCalled();
    });

    it("uses the React-safe native setter so the value actually changes", () => {
      document.body.innerHTML = `<input type="text" value="old" />`;
      const input = document.querySelector("input")!;
      stamp(input, "e1");

      performInputAction(document, {
        action: "fill",
        uid: "e1",
        value: "new value",
      });

      // The native value setter must have been invoked (jsdom reflects it).
      expect(input.value).toBe("new value");
    });

    it("fills a textarea via the React-safe setter", () => {
      document.body.innerHTML = `<textarea></textarea>`;
      const ta = document.querySelector("textarea")!;
      stamp(ta, "e1");
      const onInput = jest.fn();
      ta.addEventListener("input", onInput);

      const res = performInputAction(document, {
        action: "fill",
        uid: "e1",
        value: "multi\nline",
      });

      expect(res.ok).toBe(true);
      expect(ta.value).toBe("multi\nline");
      expect(onInput).toHaveBeenCalled();
    });

    it("changes a <select> value and fires change", () => {
      document.body.innerHTML = `
        <select>
          <option value="us">United States</option>
          <option value="ca">Canada</option>
        </select>
      `;
      const select = document.querySelector("select")!;
      stamp(select, "e1");
      const onChange = jest.fn();
      select.addEventListener("change", onChange);

      const res = performInputAction(document, {
        action: "fill",
        uid: "e1",
        value: "ca",
      });

      expect(res.ok).toBe(true);
      expect(select.value).toBe("ca");
      expect(onChange).toHaveBeenCalled();
    });

    it("toggles a checkbox checked state for true values and fires change", () => {
      document.body.innerHTML = `<input type="checkbox" />`;
      const cb = document.querySelector("input")!;
      stamp(cb, "e1");
      const onChange = jest.fn();
      cb.addEventListener("change", onChange);

      const res = performInputAction(document, {
        action: "fill",
        uid: "e1",
        value: "true",
      });

      expect(res.ok).toBe(true);
      expect(cb.checked).toBe(true);
      expect(onChange).toHaveBeenCalled();
    });

    it("fires change EXACTLY once when filling a checkbox (no synthetic click)", () => {
      // Regression: the checkbox fill path dispatched a synthetic click (which
      // itself fires change) and then an explicit change — two change events.
      // It must set checked directly and fire input + change once each.
      document.body.innerHTML = `<input type="checkbox" />`;
      const cb = document.querySelector("input")!;
      stamp(cb, "e1");
      const onChange = jest.fn();
      const onInput = jest.fn();
      const onClick = jest.fn();
      cb.addEventListener("change", onChange);
      cb.addEventListener("input", onInput);
      cb.addEventListener("click", onClick);

      const res = performInputAction(document, {
        action: "fill",
        uid: "e1",
        value: "true",
      });

      expect(res.ok).toBe(true);
      expect(cb.checked).toBe(true);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onInput).toHaveBeenCalledTimes(1);
      // No synthetic click should be dispatched for a checkbox fill.
      expect(onClick).not.toHaveBeenCalled();
    });

    it("unchecks a checkbox for non-true values (starting checked -> false)", () => {
      document.body.innerHTML = `<input type="checkbox" checked />`;
      const cb = document.querySelector("input")!;
      stamp(cb, "e1");
      expect(cb.checked).toBe(true);
      const onChange = jest.fn();
      cb.addEventListener("change", onChange);

      const res = performInputAction(document, {
        action: "fill",
        uid: "e1",
        value: "false",
      });

      expect(res.ok).toBe(true);
      expect(cb.checked).toBe(false);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("checks an unchecked checkbox (starting unchecked -> true) firing change once", () => {
      document.body.innerHTML = `<input type="checkbox" />`;
      const cb = document.querySelector("input")!;
      stamp(cb, "e1");
      expect(cb.checked).toBe(false);
      const onChange = jest.fn();
      cb.addEventListener("change", onChange);

      const res = performInputAction(document, {
        action: "fill",
        uid: "e1",
        value: "true",
      });

      expect(res.ok).toBe(true);
      expect(cb.checked).toBe(true);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("sets a radio checked and fires change exactly once", () => {
      document.body.innerHTML = `<input type="radio" name="g" />`;
      const radio = document.querySelector("input")!;
      stamp(radio, "e1");
      const onChange = jest.fn();
      const onClick = jest.fn();
      radio.addEventListener("change", onChange);
      radio.addEventListener("click", onClick);

      const res = performInputAction(document, {
        action: "fill",
        uid: "e1",
        value: "true",
      });

      expect(res.ok).toBe(true);
      expect(radio.checked).toBe(true);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });

    it("returns ok:false when the uid is missing", () => {
      document.body.innerHTML = `<input type="text" />`;
      const res = performInputAction(document, {
        action: "fill",
        uid: "missing",
        value: "x",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("fresh snapshot");
    });

    it("works against uids stamped by buildSnapshot", () => {
      document.body.innerHTML = `
        <label for="email">Email</label>
        <input id="email" type="text" />
      `;
      // buildSnapshot stamps data-bcmcp-uid on interactive elements.
      buildSnapshot(document, { verbose: false, maxLength: 25000 });
      const input = document.querySelector("#email") as HTMLInputElement;
      const uid = input.getAttribute(UID_ATTR)!;
      expect(uid).toMatch(/^e\d+$/);

      const res = performInputAction(document, {
        action: "fill",
        uid,
        value: "me@example.com",
      });

      expect(res.ok).toBe(true);
      expect(input.value).toBe("me@example.com");
    });
  });

  describe("fill-form", () => {
    it("fills multiple fields in one call", () => {
      document.body.innerHTML = `
        <input id="a" type="text" />
        <input id="b" type="text" />
      `;
      const a = document.querySelector("#a") as HTMLInputElement;
      const b = document.querySelector("#b") as HTMLInputElement;
      stamp(a, "e1");
      stamp(b, "e2");

      const res = performInputAction(document, {
        action: "fill-form",
        fields: [
          { uid: "e1", value: "alpha" },
          { uid: "e2", value: "beta" },
        ],
      });

      expect(res.ok).toBe(true);
      expect(a.value).toBe("alpha");
      expect(b.value).toBe("beta");
    });

    it("stops at the first missing uid and reports it", () => {
      document.body.innerHTML = `<input id="a" type="text" />`;
      const a = document.querySelector("#a") as HTMLInputElement;
      stamp(a, "e1");

      const res = performInputAction(document, {
        action: "fill-form",
        fields: [
          { uid: "e1", value: "alpha" },
          { uid: "eMissing", value: "beta" },
        ],
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("eMissing");
      // The first field was still filled before the failure.
      expect(a.value).toBe("alpha");
    });
  });

  describe("type", () => {
    it("appends text to the focused input and fires input", () => {
      document.body.innerHTML = `<input type="text" value="ab" />`;
      const input = document.querySelector("input")!;
      stamp(input, "e1");
      input.focus();
      const onInput = jest.fn();
      input.addEventListener("input", onInput);

      const res = performInputAction(document, { action: "type", text: "cd" });

      expect(res.ok).toBe(true);
      expect(input.value).toBe("abcd");
      expect(onInput).toHaveBeenCalled();
    });

    it("dispatches keydown/keyup for typed characters", () => {
      document.body.innerHTML = `<input type="text" />`;
      const input = document.querySelector("input")!;
      stamp(input, "e1");
      input.focus();
      const keys: string[] = [];
      input.addEventListener("keydown", (e) => keys.push((e as KeyboardEvent).key));

      performInputAction(document, { action: "type", text: "hi" });

      expect(keys).toEqual(["h", "i"]);
    });

    it("submits the enclosing form when submit is true", () => {
      document.body.innerHTML = `
        <form><input type="text" /></form>
      `;
      const input = document.querySelector("input")!;
      const form = document.querySelector("form")!;
      stamp(input, "e1");
      input.focus();
      // jsdom's requestSubmit may be missing; provide a spy either way.
      const submitSpy = jest.fn();
      (form as unknown as { requestSubmit?: () => void }).requestSubmit = submitSpy;

      const res = performInputAction(document, {
        action: "type",
        text: "x",
        submit: true,
      });

      expect(res.ok).toBe(true);
      expect(submitSpy).toHaveBeenCalled();
    });

    it("returns ok:false when there is no suitable focused element", () => {
      document.body.innerHTML = `<div>nothing focusable</div>`;
      if (
        document.activeElement &&
        (document.activeElement as HTMLElement).blur
      ) {
        (document.activeElement as HTMLElement).blur();
      }

      const res = performInputAction(document, { action: "type", text: "x" });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("No focused element");
    });
  });

  describe("press-key", () => {
    it("dispatches a keydown with the requested key", () => {
      document.body.innerHTML = `<input type="text" />`;
      const input = document.querySelector("input")!;
      stamp(input, "e1");
      input.focus();
      const onKeyDown = jest.fn();
      input.addEventListener("keydown", onKeyDown);

      const res = performInputAction(document, {
        action: "press-key",
        key: "Enter",
      });

      expect(res.ok).toBe(true);
      expect(onKeyDown).toHaveBeenCalled();
      const ev = onKeyDown.mock.calls[0][0] as KeyboardEvent;
      expect(ev.key).toBe("Enter");
    });

    it("sets modifier flags from the modifiers list", () => {
      document.body.innerHTML = `<input type="text" />`;
      const input = document.querySelector("input")!;
      stamp(input, "e1");
      input.focus();
      let captured: KeyboardEvent | null = null;
      input.addEventListener("keydown", (e) => {
        captured = e as KeyboardEvent;
      });

      performInputAction(document, {
        action: "press-key",
        key: "a",
        modifiers: ["ctrl", "shift"],
      });

      expect(captured).not.toBeNull();
      expect(captured!.ctrlKey).toBe(true);
      expect(captured!.shiftKey).toBe(true);
      expect(captured!.altKey).toBe(false);
      expect(captured!.metaKey).toBe(false);
    });

    it("falls back to document.body when there is no active element", () => {
      document.body.innerHTML = `<div>no focus</div>`;
      if (
        document.activeElement &&
        (document.activeElement as HTMLElement).blur
      ) {
        (document.activeElement as HTMLElement).blur();
      }
      const onKeyDown = jest.fn();
      document.body.addEventListener("keydown", onKeyDown);

      const res = performInputAction(document, {
        action: "press-key",
        key: "Escape",
      });

      expect(res.ok).toBe(true);
      expect(onKeyDown).toHaveBeenCalled();
    });
  });

  describe("drag", () => {
    it("dispatches dragstart on the source and drop/dragover on the target", () => {
      document.body.innerHTML = `
        <div id="from">Drag me</div>
        <div id="to">Drop here</div>
      `;
      const from = document.querySelector("#from") as HTMLElement;
      const to = document.querySelector("#to") as HTMLElement;
      stamp(from, "e1");
      stamp(to, "e2");

      const onDragStart = jest.fn();
      const onDragOver = jest.fn();
      const onDrop = jest.fn();
      from.addEventListener("dragstart", onDragStart);
      to.addEventListener("dragover", onDragOver);
      to.addEventListener("drop", onDrop);

      const res = performInputAction(document, {
        action: "drag",
        fromUid: "e1",
        toUid: "e2",
      });

      expect(res.ok).toBe(true);
      expect(onDragStart).toHaveBeenCalled();
      expect(onDragOver).toHaveBeenCalled();
      expect(onDrop).toHaveBeenCalled();
    });

    it("dispatches the full drag sequence in order (dragstart→dragenter→dragover→drop→dragend)", () => {
      document.body.innerHTML = `
        <div id="from">Drag me</div>
        <div id="to">Drop here</div>
      `;
      const from = document.querySelector("#from") as HTMLElement;
      const to = document.querySelector("#to") as HTMLElement;
      stamp(from, "e1");
      stamp(to, "e2");

      const seen: string[] = [];
      ["dragstart", "dragend"].forEach((t) =>
        from.addEventListener(t, () => seen.push(t))
      );
      ["dragenter", "dragover", "drop"].forEach((t) =>
        to.addEventListener(t, () => seen.push(t))
      );

      performInputAction(document, {
        action: "drag",
        fromUid: "e1",
        toUid: "e2",
      });

      // dragstart fires on the source before the target events, drop precedes
      // dragend.
      expect(seen).toEqual(
        expect.arrayContaining([
          "dragstart",
          "dragenter",
          "dragover",
          "drop",
          "dragend",
        ])
      );
      expect(seen.indexOf("dragstart")).toBeLessThan(seen.indexOf("dragover"));
      expect(seen.indexOf("drop")).toBeLessThan(seen.indexOf("dragend"));
    });

    it("dispatches a pointer/mouse fallback (mousedown on source, mouseup on target)", () => {
      // Pointer-based DnD libraries listen for pointer/mouse events rather than
      // HTML5 drag events. The drag action dispatches both.
      document.body.innerHTML = `
        <div id="from">Drag me</div>
        <div id="to">Drop here</div>
      `;
      const from = document.querySelector("#from") as HTMLElement;
      const to = document.querySelector("#to") as HTMLElement;
      stamp(from, "e1");
      stamp(to, "e2");

      const onMouseDown = jest.fn();
      const onMouseUp = jest.fn();
      from.addEventListener("mousedown", onMouseDown);
      to.addEventListener("mouseup", onMouseUp);

      const res = performInputAction(document, {
        action: "drag",
        fromUid: "e1",
        toUid: "e2",
      });

      expect(res.ok).toBe(true);
      expect(onMouseDown).toHaveBeenCalled();
      expect(onMouseUp).toHaveBeenCalled();
    });

    it("works against uids stamped by buildSnapshot", () => {
      document.body.innerHTML = `
        <button id="a">Source</button>
        <button id="b">Target</button>
      `;
      buildSnapshot(document, { verbose: false, maxLength: 25000 });
      const from = document.querySelector("#a") as HTMLElement;
      const to = document.querySelector("#b") as HTMLElement;
      const fromUid = from.getAttribute(UID_ATTR)!;
      const toUid = to.getAttribute(UID_ATTR)!;
      expect(fromUid).toMatch(/^e\d+$/);
      expect(toUid).toMatch(/^e\d+$/);

      const onDrop = jest.fn();
      to.addEventListener("drop", onDrop);

      const res = performInputAction(document, {
        action: "drag",
        fromUid,
        toUid,
      });

      expect(res.ok).toBe(true);
      expect(onDrop).toHaveBeenCalled();
    });

    it("returns ok:false naming the source uid when it is missing", () => {
      document.body.innerHTML = `<div id="to">Drop here</div>`;
      const to = document.querySelector("#to") as HTMLElement;
      stamp(to, "e2");

      const res = performInputAction(document, {
        action: "drag",
        fromUid: "eMissing",
        toUid: "e2",
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("eMissing");
      expect(res.error).toContain("fresh snapshot");
    });

    it("returns ok:false naming the target uid when it is missing", () => {
      document.body.innerHTML = `<div id="from">Drag me</div>`;
      const from = document.querySelector("#from") as HTMLElement;
      stamp(from, "e1");

      const res = performInputAction(document, {
        action: "drag",
        fromUid: "e1",
        toUid: "eGone",
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("eGone");
      expect(res.error).toContain("fresh snapshot");
    });
  });

  describe("click interception (integration through performInputAction)", () => {
    // jsdom has no layout: stub elementFromPoint + a non-zero rect so the click
    // arm's hit-test path runs. The pure decision logic is unit-tested separately.
    function withHitTest(topmost: Element | null) {
      (document as unknown as {
        elementFromPoint: (x: number, y: number) => Element | null;
      }).elementFromPoint = () => topmost;
      jest.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
        left: 0, top: 0, width: 20, height: 20,
        right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}),
      } as DOMRect);
    }
    afterEach(() => {
      jest.restoreAllMocks();
      delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    });

    it("flags intercepted (ok:true, still clicks) when a foreign overlay is topmost", () => {
      document.body.innerHTML =
        `<button>Go</button><div id="onetrust-banner-sdk" class="ot-sdk-row">cookies</div>`;
      const btn = document.querySelector("button")!;
      const overlay = document.querySelector("#onetrust-banner-sdk")!;
      btn.setAttribute(UID_ATTR, "e1");
      const onClick = jest.fn();
      btn.addEventListener("click", onClick);
      withHitTest(overlay);

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(res.ok).toBe(true);
      expect(onClick).toHaveBeenCalled();               // default: clicks through
      expect(res.intercepted).toMatchObject({ tag: "div", id: "onetrust-banner-sdk" });
    });

    it("does NOT flag when the target itself is topmost", () => {
      document.body.innerHTML = `<button>Go</button>`;
      const btn = document.querySelector("button")!;
      btn.setAttribute(UID_ATTR, "e1");
      withHitTest(btn);
      const res = performInputAction(document, { action: "click", uid: "e1" });
      expect(res.ok).toBe(true);
      expect(res.intercepted).toBeUndefined();
    });

    it("does NOT flag when topmost is an inner descendant of the target", () => {
      document.body.innerHTML = `<button><span>Go</span></button>`;
      const btn = document.querySelector("button")!;
      const span = document.querySelector("span")!;
      btn.setAttribute(UID_ATTR, "e1");
      withHitTest(span);
      const res = performInputAction(document, { action: "click", uid: "e1" });
      expect(res.intercepted).toBeUndefined();
    });

    it("returns ok:false and does NOT click when failIfIntercepted is set and covered", () => {
      document.body.innerHTML =
        `<button>Go</button><div id="onetrust-banner-sdk">cookies</div>`;
      const btn = document.querySelector("button")!;
      const overlay = document.querySelector("#onetrust-banner-sdk")!;
      btn.setAttribute(UID_ATTR, "e1");
      const onClick = jest.fn();
      btn.addEventListener("click", onClick);
      withHitTest(overlay);

      const res = performInputAction(document, {
        action: "click",
        uid: "e1",
        failIfIntercepted: true,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("click intercepted by #onetrust-banner-sdk");
      expect(res.intercepted).toMatchObject({ id: "onetrust-banner-sdk" });
      expect(onClick).not.toHaveBeenCalled();           // hard-fail dispatches nothing
    });
  });

  it("never throws — unexpected errors become ok:false", () => {
    // Passing a bogus args shape should be caught by the outer try/catch.
    const res = performInputAction(
      document,
      { action: "click" } as unknown as { action: "click"; uid: string }
    );
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
  });
});

describe("classifyHit (pure interception classifier)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns 'self' when topmost IS the target", () => {
    document.body.innerHTML = `<button>Go</button>`;
    const btn = document.querySelector("button")!;
    expect(classifyHit(btn, btn)).toBe("self");
  });

  it("returns 'descendant' when topmost is inside the target (inner label)", () => {
    document.body.innerHTML = `<button><span>Go</span></button>`;
    const btn = document.querySelector("button")!;
    const span = document.querySelector("span")!;
    expect(classifyHit(btn, span)).toBe("descendant");
  });

  it("returns 'ancestor' when the target is inside topmost (own wrapper/shadow host)", () => {
    document.body.innerHTML = `<div class="wrap"><button>Go</button></div>`;
    const wrap = document.querySelector(".wrap")!;
    const btn = document.querySelector("button")!;
    expect(classifyHit(btn, wrap)).toBe("ancestor");
  });

  it("returns 'unrelated' when topmost is a foreign overlay in a different subtree", () => {
    document.body.innerHTML =
      `<button>Go</button><div id="onetrust-banner-sdk">cookies</div>`;
    const btn = document.querySelector("button")!;
    const overlay = document.querySelector("#onetrust-banner-sdk")!;
    expect(classifyHit(btn, overlay)).toBe("unrelated");
  });

  it("returns 'self' (no false positive) when a node is null/indeterminate", () => {
    document.body.innerHTML = `<button>Go</button>`;
    const btn = document.querySelector("button")!;
    expect(classifyHit(btn, null)).toBe("self");
    expect(classifyHit(null, btn)).toBe("self");
  });
});
