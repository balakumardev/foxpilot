import { performInputAction, classifyHit } from "../injected/action-script";
import { buildSnapshot } from "../injected/snapshot-script";

/**
 * Chrome mirror of the Firefox action-script suite. `performInputAction` and
 * `classifyHit` are byte-identical between the two extensions (see the
 * self-containment guard + the plan's diff check), so this suite is intentionally
 * minimal: it independently guards Chrome's copy of the interception logic
 * (`classifyHit` + the click-arm hit-test) while the full `performInputAction`
 * behavior stays covered by the Firefox suite. Matches the existing chrome
 * point-action-script / snapshot-script mirror pattern.
 */
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

describe("click interception (integration through performInputAction)", () => {
  const UID_ATTR = "data-bcmcp-uid";
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
    document.body.innerHTML = "";
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

describe("classify-intercept (read-only probe for the CDP engine, Fix A)", () => {
  // The CDP click fires trusted events from the background at a coordinate, so it
  // cannot run the isolated-world hit-test itself. This action returns the SAME
  // `intercepted` descriptor the click arm computes, WITHOUT dispatching — the
  // CDP dispatcher calls it before its (blind) trusted click to reach parity.
  const UID_ATTR = "data-bcmcp-uid";
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
    document.body.innerHTML = "";
  });

  it("returns the intercepted descriptor and does NOT click when a foreign overlay covers the target", () => {
    document.body.innerHTML =
      `<button>Go</button><div id="onetrust-banner-sdk" class="ot-sdk-row">cookies</div>`;
    const btn = document.querySelector("button")!;
    const overlay = document.querySelector("#onetrust-banner-sdk")!;
    btn.setAttribute(UID_ATTR, "e1");
    const onClick = jest.fn();
    btn.addEventListener("click", onClick);
    withHitTest(overlay);

    const res = performInputAction(document, {
      action: "classify-intercept",
      uid: "e1",
    });

    expect(res.ok).toBe(true);
    expect(res.intercepted).toMatchObject({ tag: "div", id: "onetrust-banner-sdk" });
    // Read-only: the trusted click is the CDP dispatcher's job AFTER this probe.
    expect(onClick).not.toHaveBeenCalled();
  });

  it("returns no interception (and no click) when the target itself is topmost", () => {
    document.body.innerHTML = `<button>Go</button>`;
    const btn = document.querySelector("button")!;
    btn.setAttribute(UID_ATTR, "e1");
    const onClick = jest.fn();
    btn.addEventListener("click", onClick);
    withHitTest(btn);

    const res = performInputAction(document, {
      action: "classify-intercept",
      uid: "e1",
    });

    expect(res.ok).toBe(true);
    expect(res.intercepted).toBeUndefined();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is best-effort for a stale uid — ok:true with no interception, never blocking the click", () => {
    document.body.innerHTML = `<button>Go</button>`;
    const res = performInputAction(document, {
      action: "classify-intercept",
      uid: "gone",
    });
    expect(res.ok).toBe(true);
    expect(res.intercepted).toBeUndefined();
  });
});

/**
 * Covert synthetic parity fixes (A1 key identity, A2 checkbox-via-click covered
 * in the fill suite above, A3 click-sequence completeness, A5 contenteditable,
 * A6 select-by-text, B10 resolve-time identity guard). These exercise the exact
 * behaviour a React SPA relies on while every dispatched event stays synthetic
 * (isTrusted:false). Byte-identical to the Chrome copy.
 */
describe("synthetic covert parity", () => {
  const UID_ATTR = "data-bcmcp-uid";
  afterEach(() => {
    jest.restoreAllMocks();
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });
  function stampUid(el: Element, uid: string) {
    el.setAttribute(UID_ATTR, uid);
  }

  describe("A1: key events carry code/keyCode/which + keypress for printables", () => {
    it("press-key Enter carries key/code='Enter' and keyCode/which=13", () => {
      document.body.innerHTML = `<input type="text" />`;
      const input = document.querySelector("input")!;
      stampUid(input, "e1");
      input.focus();
      let ev: KeyboardEvent | null = null;
      input.addEventListener("keydown", (e) => (ev = e as KeyboardEvent));
      performInputAction(document, { action: "press-key", key: "Enter" });
      expect(ev).not.toBeNull();
      expect(ev!.key).toBe("Enter");
      expect(ev!.code).toBe("Enter");
      expect(ev!.keyCode).toBe(13);
      expect(ev!.which).toBe(13);
    });

    it("a typed printable char carries keyCode/code and emits keydown→keypress→keyup", () => {
      document.body.innerHTML = `<input type="text" />`;
      const input = document.querySelector("input")!;
      stampUid(input, "e1");
      input.focus();
      const seq: string[] = [];
      let keydownEv: KeyboardEvent | null = null;
      input.addEventListener("keydown", (e) => {
        seq.push("keydown");
        keydownEv = e as KeyboardEvent;
      });
      input.addEventListener("keypress", () => seq.push("keypress"));
      input.addEventListener("keyup", () => seq.push("keyup"));
      performInputAction(document, { action: "type", text: "a" });
      expect(seq).toEqual(["keydown", "keypress", "keyup"]);
      expect(keydownEv!.code).toBe("KeyA");
      expect(keydownEv!.keyCode).toBe(65);
    });

    it("a printable char pressed as a Ctrl chord does NOT emit keypress", () => {
      document.body.innerHTML = `<input type="text" />`;
      const input = document.querySelector("input")!;
      stampUid(input, "e1");
      input.focus();
      const seq: string[] = [];
      input.addEventListener("keydown", () => seq.push("keydown"));
      input.addEventListener("keypress", () => seq.push("keypress"));
      input.addEventListener("keyup", () => seq.push("keyup"));
      performInputAction(document, {
        action: "press-key",
        key: "a",
        modifiers: ["ctrl"],
      });
      expect(seq).toEqual(["keydown", "keyup"]);
    });
  });

  describe("A3: click sequence completeness (pointerup + composed + coords + buttons)", () => {
    it("dispatches the full ordered pointer/mouse sequence including pointerup", () => {
      document.body.innerHTML = `<button>Go</button>`;
      const btn = document.querySelector("button")!;
      stampUid(btn, "e1");
      const seq: string[] = [];
      [
        "pointerover",
        "pointerenter",
        "pointermove",
        "pointerdown",
        "mousedown",
        "pointerup",
        "mouseup",
        "click",
      ].forEach((t) => btn.addEventListener(t, () => seq.push(t)));
      performInputAction(document, { action: "click", uid: "e1" });
      expect(seq).toContain("pointerup");
      expect(seq.indexOf("pointerdown")).toBeLessThan(seq.indexOf("pointerup"));
      expect(seq.indexOf("mouseup")).toBeLessThan(seq.indexOf("click"));
      expect(seq.indexOf("pointerover")).toBeLessThan(seq.indexOf("pointerdown"));
    });

    it("mouse events carry composed:true, element-center coords and the buttons bitmask", () => {
      document.body.innerHTML = `<button>Go</button>`;
      const btn = document.querySelector("button")!;
      stampUid(btn, "e1");
      jest.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
        left: 100, top: 40, width: 20, height: 10,
        right: 120, bottom: 50, x: 100, y: 40, toJSON: () => ({}),
      } as DOMRect);
      let down: MouseEvent | null = null;
      let up: MouseEvent | null = null;
      btn.addEventListener("mousedown", (e) => (down = e as MouseEvent));
      btn.addEventListener("mouseup", (e) => (up = e as MouseEvent));
      performInputAction(document, { action: "click", uid: "e1" });
      expect(down).not.toBeNull();
      expect(down!.composed).toBe(true);
      expect(down!.clientX).toBe(110); // 100 + 20/2
      expect(down!.clientY).toBe(45); // 40 + 10/2
      expect(down!.buttons).toBe(1); // held during press
      expect(up!.buttons).toBe(0); // released on up
    });
  });

  describe("A5: type into a focused contenteditable host", () => {
    it("routes a contenteditable through beforeinput/input (insertText+data) instead of rejecting", () => {
      document.body.innerHTML = `<div contenteditable="true" data-bcmcp-uid="e1"></div>`;
      const ce = document.querySelector("[contenteditable]") as HTMLElement;
      ce.focus();
      const beforeinput: Array<{ inputType?: string; data?: string }> = [];
      const input: Array<{ inputType?: string; data?: string }> = [];
      ce.addEventListener("beforeinput", (e) =>
        beforeinput.push(e as unknown as { inputType?: string; data?: string })
      );
      ce.addEventListener("input", (e) =>
        input.push(e as unknown as { inputType?: string; data?: string })
      );
      const res = performInputAction(document, { action: "type", text: "hi" });
      expect(res.ok).toBe(true);
      expect(ce.textContent).toBe("hi");
      expect(beforeinput.length).toBe(1);
      expect(beforeinput[0].inputType).toBe("insertText");
      expect(beforeinput[0].data).toBe("hi");
      expect(input[0].inputType).toBe("insertText");
      expect(input[0].data).toBe("hi");
    });
  });

  describe("A6: <select> fill resolves by option value OR visible text", () => {
    it("selects by visible option text and fires input + change", () => {
      document.body.innerHTML = `
        <select data-bcmcp-uid="e1">
          <option value="us">United States</option>
          <option value="ca">Canada</option>
        </select>`;
      const select = document.querySelector("select")!;
      const onInput = jest.fn();
      const onChange = jest.fn();
      select.addEventListener("input", onInput);
      select.addEventListener("change", onChange);
      const res = performInputAction(document, {
        action: "fill",
        uid: "e1",
        value: "Canada",
      });
      expect(res.ok).toBe(true);
      expect(select.value).toBe("ca");
      expect(onInput).toHaveBeenCalled();
      expect(onChange).toHaveBeenCalled();
    });

    it("returns ok:false with a clear error when no option matches", () => {
      document.body.innerHTML = `<select data-bcmcp-uid="e1"><option value="us">United States</option></select>`;
      const res = performInputAction(document, {
        action: "fill",
        uid: "e1",
        value: "Nowhere",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/No <option> matching/);
    });
  });

  describe("B10: resolve rejects a uid whose element identity changed", () => {
    it("resolves while identity matches, then notFound once the identity changes", () => {
      document.body.innerHTML = `<button aria-label="Save">S</button>`;
      const btn = document.querySelector("button")!;
      buildSnapshot(document, { verbose: false, maxLength: 25000 });
      const uid = btn.getAttribute(UID_ATTR)!;
      expect(uid).toMatch(/^e\d+$/);
      expect(btn.getAttribute("data-bcmcp-sig")).toBeTruthy();

      const onClick = jest.fn();
      btn.addEventListener("click", onClick);
      const ok = performInputAction(document, { action: "click", uid });
      expect(ok.ok).toBe(true);
      expect(onClick).toHaveBeenCalled();

      // The framework recycles the node under the same uid but a new identity.
      btn.setAttribute("aria-label", "Delete");
      const stale = performInputAction(document, { action: "click", uid });
      expect(stale.ok).toBe(false);
      expect(stale.error).toContain("fresh snapshot");
    });

    it("skips the identity check for an element with no sig (older snapshot, back-compat)", () => {
      document.body.innerHTML = `<button aria-label="Save">S</button>`;
      const btn = document.querySelector("button")!;
      btn.setAttribute(UID_ATTR, "e1"); // uid present, but NO data-bcmcp-sig
      const onClick = jest.fn();
      btn.addEventListener("click", onClick);
      const res = performInputAction(document, { action: "click", uid: "e1" });
      expect(res.ok).toBe(true);
      expect(onClick).toHaveBeenCalled();
    });
  });
});

describe("A5 refinement: contenteditable respects a canceled beforeinput", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fires NO input and leaves textContent unchanged when beforeinput is preventDefault-ed", () => {
    // Lexical/ProseMirror cancel beforeinput to drive their own model — the extra
    // input would be a spurious signal, and no insertion should happen.
    document.body.innerHTML = `<div contenteditable="true" data-bcmcp-uid="e1"></div>`;
    const ce = document.querySelector("[contenteditable]") as HTMLElement;
    ce.focus();
    ce.addEventListener("beforeinput", (e) => e.preventDefault());
    const onInput = jest.fn();
    ce.addEventListener("input", onInput);

    const res = performInputAction(document, { action: "type", text: "hi" });

    expect(res.ok).toBe(true);
    expect(ce.textContent).toBe(""); // insertion skipped
    expect(onInput).not.toHaveBeenCalled(); // input suppressed
  });

  it("normal (uncanceled) path still inserts and fires input with inputType insertText + data", () => {
    document.body.innerHTML = `<div contenteditable="true" data-bcmcp-uid="e1"></div>`;
    const ce = document.querySelector("[contenteditable]") as HTMLElement;
    ce.focus();
    const inputs: Array<{ inputType?: string; data?: string }> = [];
    ce.addEventListener("input", (e) =>
      inputs.push(e as unknown as { inputType?: string; data?: string })
    );

    const res = performInputAction(document, { action: "type", text: "hi" });

    expect(res.ok).toBe(true);
    expect(ce.textContent).toBe("hi");
    expect(inputs.length).toBe(1);
    expect(inputs[0].inputType).toBe("insertText");
    expect(inputs[0].data).toBe("hi");
  });
});
