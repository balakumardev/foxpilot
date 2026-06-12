import { performInputAction } from "../injected/action-script";
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
      btn.addEventListener("dblclick", onDbl);

      const res = performInputAction(document, {
        action: "click",
        uid: "e1",
        doubleClick: true,
      });

      expect(res.ok).toBe(true);
      expect(onDbl).toHaveBeenCalled();
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

    it("unchecks a checkbox for non-true values", () => {
      document.body.innerHTML = `<input type="checkbox" checked />`;
      const cb = document.querySelector("input")!;
      stamp(cb, "e1");

      const res = performInputAction(document, {
        action: "fill",
        uid: "e1",
        value: "false",
      });

      expect(res.ok).toBe(true);
      expect(cb.checked).toBe(false);
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
