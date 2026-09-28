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

describe("label-wrapped checkbox activation (antd .ant-checkbox-wrapper shape)", () => {
  // A trusted click anywhere in a <label> toggles the labeled control. Firefox
  // does not run that forwarding for an untrusted click, so clicking antd's
  // wrapper label — or the painted span over its visually-hidden input — did
  // nothing while still reporting ok:true. The browser-divergent half is proven
  // in e2e/antd-checkbox-click.spec.ts, which runs on Firefox AND Chromium.
  //
  // What these jsdom tests pin is the invariant that holds on every engine, and
  // the one a naive fix breaks: EXACTLY ONE toggle. Forwarding unconditionally
  // would double-activate wherever the browser already forwards, flipping the
  // box straight back off. Counting `change` events catches that in either
  // direction.
  function mountAntdCheckbox(): HTMLInputElement {
    document.body.innerHTML = `
      <label class="ant-checkbox-wrapper">
        <span class="ant-checkbox">
          <input type="checkbox" class="ant-checkbox-input" />
          <span class="ant-checkbox-inner"></span>
        </span>
        <span class="label-text">I accept the terms</span>
      </label>`;
    return document.querySelector("input[type=checkbox]") as HTMLInputElement;
  }

  function clickUid(el: Element): void {
    el.setAttribute("data-bcmcp-uid", "e1");
    performInputAction(document, { action: "click", uid: "e1" });
  }

  it("clicking the wrapper label toggles the checkbox exactly once", () => {
    const input = mountAntdCheckbox();
    let changes = 0;
    input.addEventListener("change", () => {
      changes++;
    });

    clickUid(document.querySelector("label")!);

    expect(input.checked).toBe(true);
    expect(changes).toBe(1);
  });

  it("clicking the painted inner span toggles the checkbox exactly once", () => {
    const input = mountAntdCheckbox();
    let changes = 0;
    input.addEventListener("change", () => {
      changes++;
    });

    clickUid(document.querySelector(".ant-checkbox-inner")!);

    expect(input.checked).toBe(true);
    expect(changes).toBe(1);
  });

  it("clicking the input itself toggles exactly once (no forwarded second click)", () => {
    const input = mountAntdCheckbox();
    let changes = 0;
    input.addEventListener("change", () => {
      changes++;
    });

    clickUid(input);

    expect(input.checked).toBe(true);
    expect(changes).toBe(1);
  });

  it("a label click on a radio selects it exactly once", () => {
    document.body.innerHTML = `
      <label class="ant-radio-wrapper">
        <span class="ant-radio"><input type="radio" name="g" value="a" /></span>
        <span>Option A</span>
      </label>`;
    const radio = document.querySelector("input[type=radio]") as HTMLInputElement;
    let changes = 0;
    radio.addEventListener("change", () => {
      changes++;
    });

    clickUid(document.querySelector("label")!);

    expect(radio.checked).toBe(true);
    expect(changes).toBe(1);
  });

  it("a label wrapping a TEXT input gains no extra activation", () => {
    // Scope guard: only checkbox/radio are forwarded. The control still receives
    // one click here — that is the ENGINE's own label activation, not ours — so
    // the thing worth pinning is that nothing adds a second one on top.
    document.body.innerHTML = `
      <label>Name <input type="text" /></label>`;
    const text = document.querySelector("input[type=text]") as HTMLInputElement;
    let clicks = 0;
    text.addEventListener("click", () => {
      clicks++;
    });

    clickUid(document.querySelector("label")!);

    expect(clicks).toBeLessThanOrEqual(1);
  });
});

/**
 * Shadow DOM (open, nested, slotted, closed) + role-wrapper click retargeting.
 * jsdom has attachShadow + slots but no layout: elementFromPoint (on the
 * Document AND on each ShadowRoot) is stubbed by assignment and rects come from
 * a getBoundingClientRect spy. Closed roots are reached through BOTH
 * extension-only shapes the injected shadowRootOf helper supports — Firefox's
 * `openOrClosedShadowRoot` PROPERTY and Chrome's
 * `chrome.dom.openOrClosedShadowRoot(el)` function — because the helper is
 * byte-identical across the two extensions, so both code paths ship in both.
 * Identical block in the Firefox and Chrome suites.
 */
describe("shadow DOM + role-wrapper click retargeting", () => {
  const UID_ATTR = "data-bcmcp-uid";
  const closedRoots = new Map<Element, ShadowRoot>();
  let restoreClosed: (() => void) | null = null;

  beforeEach(() => {
    // Earlier suites leave stamped nodes behind; a stray light-DOM "e1" would
    // (correctly) win over the shadow uid under test.
    document.body.innerHTML = "";
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    if (restoreClosed) {
      restoreClosed();
      restoreClosed = null;
    }
    closedRoots.clear();
    document.body.innerHTML = "";
  });

  function openHost(tag: string, html: string, parent: Element = document.body): ShadowRoot {
    const host = document.createElement(tag);
    parent.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = html;
    return root;
  }
  function closedHost(tag: string, html: string, parent: Element = document.body): ShadowRoot {
    const host = document.createElement(tag);
    parent.appendChild(host);
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = html;
    closedRoots.set(host, root);
    return root;
  }
  // Firefox shape: a read-only PROPERTY on every element (open roots too).
  function exposeClosedViaProperty(): void {
    Object.defineProperty(Element.prototype, "openOrClosedShadowRoot", {
      configurable: true,
      get(this: Element) {
        return closedRoots.get(this) || this.shadowRoot || null;
      },
    });
    restoreClosed = () => {
      delete (Element.prototype as unknown as { openOrClosedShadowRoot?: unknown })
        .openOrClosedShadowRoot;
    };
  }
  // Chrome shape: chrome.dom.openOrClosedShadowRoot(el).
  function exposeClosedViaChromeDom(): void {
    const g = globalThis as unknown as { chrome?: { dom?: unknown } };
    const hadChrome = typeof g.chrome !== "undefined";
    if (!hadChrome) {
      g.chrome = {};
    }
    g.chrome!.dom = {
      openOrClosedShadowRoot: (el: Element) => closedRoots.get(el) || el.shadowRoot || null,
    };
    restoreClosed = () => {
      delete g.chrome!.dom;
      if (!hadChrome) {
        delete g.chrome;
      }
    };
  }
  function stubRect(): void {
    jest.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 20, height: 20,
      right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
  }
  function stubDocHit(el: Element | null): void {
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
      .elementFromPoint = () => el;
  }
  function stubRootHit(root: ShadowRoot, el: Element | null): void {
    (root as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
      .elementFromPoint = () => el;
  }
  function hostOf(root: ShadowRoot): Element {
    return root.host;
  }

  describe("uid resolution pierces shadow roots", () => {
    it("clicks a uid stamped inside an OPEN shadow root", () => {
      const root = openHost("amp-nav", `<button data-bcmcp-uid="e1">Users and Access</button>`);
      const btn = root.querySelector("button")!;
      const onClick = jest.fn();
      btn.addEventListener("click", onClick);

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(res.ok).toBe(true);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("clicks a uid inside NESTED open roots", () => {
      const outer = openHost("amp-nav", `<nav aria-label="Primary"><div class="acct"></div></nav>`);
      const inner = openHost(
        "amp-account-menu",
        `<button data-bcmcp-uid="e2">Sign Out</button>`,
        outer.querySelector(".acct")!
      );
      const onClick = jest.fn();
      inner.querySelector("button")!.addEventListener("click", onClick);

      const res = performInputAction(document, { action: "click", uid: "e2" });

      expect(res.ok).toBe(true);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("clicks a uid inside a CLOSED root via the Firefox openOrClosedShadowRoot property", () => {
      const root = closedHost("amp-secret", `<button data-bcmcp-uid="e3">Closed Button</button>`);
      exposeClosedViaProperty();
      const onClick = jest.fn();
      root.querySelector("button")!.addEventListener("click", onClick);

      const res = performInputAction(document, { action: "click", uid: "e3" });

      expect(res.ok).toBe(true);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("clicks a uid inside a CLOSED root via chrome.dom.openOrClosedShadowRoot", () => {
      const root = closedHost("amp-secret", `<button data-bcmcp-uid="e3">Closed Button</button>`);
      exposeClosedViaChromeDom();
      const onClick = jest.fn();
      root.querySelector("button")!.addEventListener("click", onClick);

      const res = performInputAction(document, { action: "click", uid: "e3" });

      expect(res.ok).toBe(true);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("a closed root stays unreachable when neither extension API exists (page world)", () => {
      closedHost("amp-secret", `<button data-bcmcp-uid="e3">Closed Button</button>`);
      const res = performInputAction(document, { action: "click", uid: "e3" });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("fresh snapshot");
    });

    it("fills, hovers and fill-forms shadow uids", () => {
      const root = openHost(
        "amp-search",
        `<input id="q" type="search" data-bcmcp-uid="e1" /><input id="r" data-bcmcp-uid="e2" /><a href="#x" data-bcmcp-uid="e3">Menu</a>`
      );
      const q = root.getElementById("q") as HTMLInputElement;
      const r = root.getElementById("r") as HTMLInputElement;
      const onOver = jest.fn();
      root.querySelector("a")!.addEventListener("mouseover", onOver);

      expect(performInputAction(document, { action: "fill", uid: "e1", value: "ios" }).ok).toBe(true);
      expect(q.value).toBe("ios");
      expect(
        performInputAction(document, {
          action: "fill-form",
          fields: [
            { uid: "e1", value: "tvos" },
            { uid: "e2", value: "mac" },
          ],
        }).ok
      ).toBe(true);
      expect(q.value).toBe("tvos");
      expect(r.value).toBe("mac");
      expect(performInputAction(document, { action: "hover", uid: "e3" }).ok).toBe(true);
      expect(onOver).toHaveBeenCalled();
    });

    it("drags between a light-DOM uid and a shadow uid", () => {
      document.body.innerHTML = `<div id="from" data-bcmcp-uid="e1">Drag me</div>`;
      const root = openHost("amp-drop", `<div id="to" data-bcmcp-uid="e2">Drop here</div>`);
      const onDrop = jest.fn();
      root.getElementById("to")!.addEventListener("drop", onDrop);

      const res = performInputAction(document, { action: "drag", fromUid: "e1", toUid: "e2" });

      expect(res.ok).toBe(true);
      expect(onDrop).toHaveBeenCalled();
    });

    it("B10: a recycled node inside a shadow root is still rejected as stale", () => {
      // Stamp uid + sig with the real snapshot, then move the node into a shadow root.
      document.body.innerHTML = `<button aria-label="Save">S</button>`;
      const btn = document.querySelector("button")!;
      buildSnapshot(document, { verbose: false, maxLength: 25000 });
      const uid = btn.getAttribute(UID_ATTR)!;
      expect(btn.getAttribute("data-bcmcp-sig")).toBeTruthy();
      const root = openHost("amp-nav", "");
      root.appendChild(btn);
      const onClick = jest.fn();
      btn.addEventListener("click", onClick);

      expect(performInputAction(document, { action: "click", uid }).ok).toBe(true);
      expect(onClick).toHaveBeenCalledTimes(1);

      btn.setAttribute("aria-label", "Delete");
      const stale = performInputAction(document, { action: "click", uid });
      expect(stale.ok).toBe(false);
      expect(stale.error).toContain("fresh snapshot");
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe("hit-testing pierces shadow roots (click arm + classify-intercept)", () => {
    it("a shadow button is NOT reported intercepted by its own host", () => {
      const root = openHost("amp-nav", `<button data-bcmcp-uid="e1">Users and Access</button>`);
      const btn = root.querySelector("button")!;
      const onClick = jest.fn();
      btn.addEventListener("click", onClick);
      stubRect();
      stubDocHit(hostOf(root)); // document.elementFromPoint retargets to the host
      stubRootHit(root, btn);

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(res.ok).toBe(true);
      expect(res.intercepted).toBeUndefined();
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("classify-intercept (the CDP probe) pierces the same way — no false positive, real cover still named", () => {
      const root = openHost("amp-nav", `<button data-bcmcp-uid="e1">Users and Access</button>`);
      const cover = document.createElement("div");
      cover.id = "cover";
      document.body.appendChild(cover);
      stubRect();
      stubDocHit(hostOf(root));
      stubRootHit(root, root.querySelector("button"));

      const clear = performInputAction(document, { action: "classify-intercept", uid: "e1" });
      stubDocHit(cover);
      const covered = performInputAction(document, { action: "classify-intercept", uid: "e1" });

      expect(clear.ok).toBe(true);
      expect(clear.intercepted).toBeUndefined();
      expect(covered.intercepted).toMatchObject({ id: "cover" });
    });

    it("still no false interception when the root cannot be pierced (host = ancestor)", () => {
      const root = openHost("amp-nav", `<button data-bcmcp-uid="e1">Users and Access</button>`);
      stubRect();
      stubDocHit(hostOf(root)); // no ShadowRoot.elementFromPoint available

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(res.ok).toBe(true);
      expect(res.intercepted).toBeUndefined();
    });

    it("pierces a CLOSED root for the hit-test via the Firefox property", () => {
      const root = closedHost("amp-secret", `<button data-bcmcp-uid="e1">Closed Button</button>`);
      exposeClosedViaProperty();
      const onClick = jest.fn();
      root.querySelector("button")!.addEventListener("click", onClick);
      stubRect();
      stubDocHit(hostOf(root));
      stubRootHit(root, root.querySelector("button"));

      const res = performInputAction(document, { action: "click", uid: "e1", failIfIntercepted: true });

      expect(res.ok).toBe(true);
      expect(res.intercepted).toBeUndefined();
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("pierces a CLOSED root for the hit-test via chrome.dom", () => {
      const root = closedHost("amp-secret", `<button data-bcmcp-uid="e1">Closed Button</button>`);
      exposeClosedViaChromeDom();
      const onClick = jest.fn();
      root.querySelector("button")!.addEventListener("click", onClick);
      stubRect();
      stubDocHit(hostOf(root));
      stubRootHit(root, root.querySelector("button"));

      const res = performInputAction(document, { action: "click", uid: "e1", failIfIntercepted: true });

      expect(res.ok).toBe(true);
      expect(res.intercepted).toBeUndefined();
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("a light-DOM overlay covering a shadow target is still intercepted (and failIfIntercepted hard-stops)", () => {
      const root = openHost("amp-nav", `<button data-bcmcp-uid="e1">Users and Access</button>`);
      const cover = document.createElement("div");
      cover.id = "onetrust-banner-sdk";
      cover.textContent = "cookies";
      document.body.appendChild(cover);
      const onClick = jest.fn();
      root.querySelector("button")!.addEventListener("click", onClick);
      stubRect();
      stubDocHit(cover);

      const soft = performInputAction(document, { action: "click", uid: "e1" });
      expect(soft.ok).toBe(true);
      expect(soft.intercepted).toMatchObject({ tag: "div", id: "onetrust-banner-sdk" });

      onClick.mockClear();
      const hard = performInputAction(document, { action: "click", uid: "e1", failIfIntercepted: true });
      expect(hard.ok).toBe(false);
      expect(hard.error).toContain("click intercepted by #onetrust-banner-sdk");
      expect(onClick).not.toHaveBeenCalled();
    });

    it("an overlay inside ANOTHER component's shadow root is reported by that component's host", () => {
      document.body.innerHTML = `<button data-bcmcp-uid="e1">Buy</button>`;
      const banner = openHost("cookie-banner", `<div class="scrim">We use cookies</div>`);
      banner.host.id = "cb";
      stubRect();
      stubDocHit(banner.host);
      stubRootHit(banner, banner.querySelector(".scrim"));

      const res = performInputAction(document, { action: "classify-intercept", uid: "e1" });

      expect(res.intercepted).toMatchObject({ tag: "cookie-banner", id: "cb" });
    });

    it("a scrim inside the SAME shadow root as the target is reported as itself", () => {
      const root = openHost(
        "app-shell",
        `<button data-bcmcp-uid="e1">Save</button><div class="scrim">Loading</div>`
      );
      stubRect();
      stubDocHit(hostOf(root));
      stubRootHit(root, root.querySelector(".scrim"));

      const res = performInputAction(document, { action: "classify-intercept", uid: "e1" });

      expect(res.intercepted).toMatchObject({ tag: "div", classes: "scrim" });
    });

    it("ignores a ShadowRoot.elementFromPoint hit that lies OUTSIDE that root (Chrome off-root quirk)", () => {
      document.body.innerHTML = `<p id="elsewhere">Elsewhere</p>`;
      const root = openHost("x-card", `<span>chrome</span>`);
      hostOf(root).setAttribute(UID_ATTR, "e1");
      stubRect();
      stubDocHit(hostOf(root));
      stubRootHit(root, document.getElementById("elsewhere"));

      const res = performInputAction(document, { action: "classify-intercept", uid: "e1" });

      expect(res.intercepted).toBeUndefined();
    });
  });

  describe("composed classifyHit", () => {
    it("shadow target vs its host → 'ancestor' (was 'unrelated')", () => {
      const root = openHost("amp-nav", `<button>Users and Access</button>`);
      expect(classifyHit(root.querySelector("button"), hostOf(root))).toBe("ancestor");
    });

    it("host target vs an element inside its shadow root → 'descendant'", () => {
      const root = openHost("amp-nav", `<button>Users and Access</button>`);
      expect(classifyHit(hostOf(root), root.querySelector("button"))).toBe("descendant");
    });

    it("nested: a target two roots deep vs the outer host → 'ancestor'", () => {
      const outer = openHost("amp-nav", `<div class="acct"></div>`);
      const inner = openHost("amp-account-menu", `<button>Sign Out</button>`, outer.querySelector(".acct")!);
      expect(classifyHit(inner.querySelector("button"), hostOf(outer))).toBe("ancestor");
      expect(classifyHit(hostOf(outer), inner.querySelector("button"))).toBe("descendant");
    });

    it("slotted (open): light content projected through a <slot> is a 'descendant' of the slot's wrapper", () => {
      const root = openHost("amp-card", `<div class="frame"><slot></slot></div>`);
      const span = document.createElement("span");
      span.textContent = "Slotted";
      hostOf(root).appendChild(span);
      expect(classifyHit(root.querySelector(".frame"), span)).toBe("descendant");
    });

    it("slotted (closed, Firefox property): assignedSlot is null, the root-side slot lookup still finds it", () => {
      const root = closedHost("amp-card", `<div class="frame"><slot></slot></div>`);
      const span = document.createElement("span");
      hostOf(root).appendChild(span);
      expect(span.assignedSlot).toBeNull();
      exposeClosedViaProperty();
      expect(classifyHit(root.querySelector(".frame"), span)).toBe("descendant");
    });

    it("slotted (closed, chrome.dom): same via the Chrome API shape", () => {
      const root = closedHost("amp-card", `<div class="frame"><slot name="t"></slot></div>`);
      const span = document.createElement("span");
      span.setAttribute("slot", "t");
      hostOf(root).appendChild(span);
      exposeClosedViaChromeDom();
      expect(classifyHit(root.querySelector(".frame"), span)).toBe("descendant");
    });

    it("an element in a DIFFERENT component's shadow root is still 'unrelated'", () => {
      const a = openHost("amp-nav", `<button>Users and Access</button>`);
      const b = openHost("cookie-banner", `<div class="scrim">cookies</div>`);
      expect(classifyHit(a.querySelector("button"), b.querySelector(".scrim"))).toBe("unrelated");
    });
  });

  describe("role-wrapper click retargeting", () => {
    function mountMenu(): { li: HTMLElement; btn: HTMLElement; p: HTMLElement } {
      document.body.innerHTML = `
        <ul role="menu">
          <li role="menuitem" data-bcmcp-uid="e2"><button tabindex="0">Draft macOS Submission (1)<p>Started by Jane Today at 11:21 AM</p></button></li>
        </ul>`;
      return {
        li: document.querySelector("li") as HTMLElement,
        btn: document.querySelector("button") as HTMLElement,
        p: document.querySelector("p") as HTMLElement,
      };
    }

    it("li[role=menuitem] > button > p: dispatches on the button and reports dispatchedTo", () => {
      const { li, btn, p } = mountMenu();
      const onBtn = jest.fn();
      const onLi = jest.fn();
      btn.addEventListener("click", onBtn);
      li.addEventListener("click", onLi);
      stubRect();
      stubDocHit(p);

      const res = performInputAction(document, { action: "click", uid: "e2" });

      expect(res.ok).toBe(true);
      expect(onBtn).toHaveBeenCalledTimes(1);
      expect(onLi).toHaveBeenCalledTimes(1); // bubbled from the button, like a real click
      expect(onLi.mock.calls[0][0].target).toBe(btn);
      expect(res.intercepted).toBeUndefined();
      expect((res as { dispatchedTo?: unknown }).dispatchedTo).toEqual({
        tag: "button",
        name: "Draft macOS Submission (1)Started by Jane Today at 11:21 AM",
      });
      expect(document.activeElement).toBe(btn); // focus follows the real activation target
    });

    it("the whole pointer/mouse sequence goes to the retarget, carrying the hit point", () => {
      const { li, btn, p } = mountMenu();
      jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        const r = this === li ? { left: 0, top: 0, width: 200, height: 40 } : { left: 10, top: 5, width: 60, height: 10 };
        return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect;
      });
      stubDocHit(p);
      const seen: string[] = [];
      let down: MouseEvent | null = null;
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) =>
        btn.addEventListener(t, (e) => {
          if (e.target === btn) {
            seen.push(t);
          }
          if (t === "mousedown") {
            down = e as MouseEvent;
          }
        })
      );

      performInputAction(document, { action: "click", uid: "e2" });

      expect(seen).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
      expect(down!.clientX).toBe(100); // the li's centre = where the hit-test landed
      expect(down!.clientY).toBe(20);
    });

    it("dblclick is retargeted too (one click + one dblclick on the button)", () => {
      const { li, btn, p } = mountMenu();
      const onClick = jest.fn();
      const onDbl = jest.fn();
      const onLiDbl = jest.fn();
      btn.addEventListener("click", onClick);
      btn.addEventListener("dblclick", onDbl);
      li.addEventListener("dblclick", onLiDbl);
      stubRect();
      stubDocHit(p);

      const res = performInputAction(document, { action: "click", uid: "e2", doubleClick: true });

      expect(res.ok).toBe(true);
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onDbl).toHaveBeenCalledTimes(1);
      expect(onLiDbl).toHaveBeenCalledTimes(1);
    });

    it("button > span: stays on the button (no dispatchedTo)", () => {
      document.body.innerHTML = `<button data-bcmcp-uid="e1"><span>Save</span></button>`;
      const btn = document.querySelector("button")!;
      const onClick = jest.fn();
      btn.addEventListener("click", onClick);
      stubRect();
      stubDocHit(document.querySelector("span"));

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(res.ok).toBe(true);
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onClick.mock.calls[0][0].target).toBe(btn);
      expect((res as { dispatchedTo?: unknown }).dispatchedTo).toBeUndefined();
    });

    it("a[href] > span: stays on the link (no dispatchedTo)", () => {
      document.body.innerHTML = `<a href="#anchored" data-bcmcp-uid="e1"><span>Anchor</span></a>`;
      const a = document.querySelector("a")!;
      const onClick = jest.fn();
      a.addEventListener("click", onClick);
      stubRect();
      stubDocHit(document.querySelector("span"));

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onClick.mock.calls[0][0].target).toBe(a);
      expect((res as { dispatchedTo?: unknown }).dispatchedTo).toBeUndefined();
    });

    it("li with its own handler > span: stays on the li", () => {
      document.body.innerHTML = `<ul role="menu"><li role="menuitem" data-bcmcp-uid="e1"><span>Delete draft</span></li></ul>`;
      const li = document.querySelector("li")!;
      const onLi = jest.fn();
      li.addEventListener("click", onLi);
      stubRect();
      stubDocHit(document.querySelector("span"));

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(onLi).toHaveBeenCalledTimes(1);
      expect(onLi.mock.calls[0][0].target).toBe(li);
      expect((res as { dispatchedTo?: unknown }).dispatchedTo).toBeUndefined();
    });

    it("label uid with the hit on its painted span: stays on the label, checkbox toggles exactly once", () => {
      document.body.innerHTML = `
        <label class="ant-checkbox-wrapper" data-bcmcp-uid="e1">
          <span class="ant-checkbox"><input type="checkbox" /><span class="ant-checkbox-inner"></span></span>
          <span>I accept the terms</span>
        </label>`;
      const input = document.querySelector("input") as HTMLInputElement;
      let changes = 0;
      input.addEventListener("change", () => changes++);
      stubRect();
      stubDocHit(document.querySelector(".ant-checkbox-inner"));

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(input.checked).toBe(true);
      expect(changes).toBe(1);
      expect((res as { dispatchedTo?: unknown }).dispatchedTo).toBeUndefined();
    });

    it("an option wrapper around a label: retargets to the label, checkbox toggles exactly once", () => {
      document.body.innerHTML = `
        <div role="option" data-bcmcp-uid="e1">
          <label><input type="checkbox" /><span class="txt">Pick me</span></label>
        </div>`;
      const input = document.querySelector("input") as HTMLInputElement;
      let changes = 0;
      input.addEventListener("change", () => changes++);
      stubRect();
      stubDocHit(document.querySelector(".txt"));

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(input.checked).toBe(true);
      expect(changes).toBe(1);
      expect((res as { dispatchedTo?: { tag: string } }).dispatchedTo).toMatchObject({ tag: "label" });
    });

    it("skips a control with no click() (svg role=button) and a hidden one, falling back to the uid element", () => {
      document.body.innerHTML = `
        <ul role="menu">
          <li role="menuitem" data-bcmcp-uid="e1"><svg role="button" tabindex="0"><rect></rect></svg></li>
          <li role="menuitem" data-bcmcp-uid="e2"><button aria-hidden="true"><span id="h">x</span></button></li>
        </ul>`;
      const lis = document.querySelectorAll("li");
      const onLi1 = jest.fn();
      const onLi2 = jest.fn();
      lis[0].addEventListener("click", onLi1);
      lis[1].addEventListener("click", onLi2);
      stubRect();

      stubDocHit(document.querySelector("rect"));
      const r1 = performInputAction(document, { action: "click", uid: "e1" });
      stubDocHit(document.getElementById("h"));
      const r2 = performInputAction(document, { action: "click", uid: "e2" });

      expect(onLi1).toHaveBeenCalledTimes(1);
      expect(onLi1.mock.calls[0][0].target).toBe(lis[0]);
      expect(onLi2).toHaveBeenCalledTimes(1);
      expect(onLi2.mock.calls[0][0].target).toBe(lis[1]);
      expect((r1 as { dispatchedTo?: unknown }).dispatchedTo).toBeUndefined();
      expect((r2 as { dispatchedTo?: unknown }).dispatchedTo).toBeUndefined();
    });

    it("a shadow-DOM menuitem host: the hit inside its shadow button retargets to that button", () => {
      const root = openHost("amp-menu-item", `<button><span>Sign Out</span></button>`);
      const host = hostOf(root);
      host.setAttribute("role", "menuitem");
      host.setAttribute(UID_ATTR, "e1");
      const btn = root.querySelector("button")!;
      const onBtn = jest.fn();
      const onHost = jest.fn();
      btn.addEventListener("click", onBtn);
      host.addEventListener("click", onHost);
      stubRect();
      stubDocHit(host);
      stubRootHit(root, root.querySelector("span"));

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(onBtn).toHaveBeenCalledTimes(1);
      expect(onHost).toHaveBeenCalledTimes(1);
      expect((res as { dispatchedTo?: unknown }).dispatchedTo).toEqual({ tag: "button", name: "Sign Out" });
    });

    it("an overlay hit never retargets (interception rules unchanged)", () => {
      const { btn } = mountMenu();
      const cover = document.createElement("div");
      cover.id = "cover";
      document.body.appendChild(cover);
      const onBtn = jest.fn();
      btn.addEventListener("click", onBtn);
      stubRect();
      stubDocHit(cover);

      const res = performInputAction(document, { action: "click", uid: "e2" });

      expect(res.intercepted).toMatchObject({ id: "cover" });
      expect(onBtn).not.toHaveBeenCalled(); // dispatched on the li, as before
      expect((res as { dispatchedTo?: unknown }).dispatchedTo).toBeUndefined();
    });
  });

  describe("focused-element paths pierce shadow roots", () => {
    it("type appends into an input focused inside an OPEN shadow root", () => {
      const root = openHost("amp-search", `<input id="q" type="search" value="i" />`);
      const q = root.getElementById("q") as HTMLInputElement;
      q.focus();
      expect(document.activeElement).toBe(hostOf(root)); // what the old code read

      const res = performInputAction(document, { action: "type", text: "os" });

      expect(res.ok).toBe(true);
      expect(q.value).toBe("ios");
    });

    it("press-key dispatches on the input inside the shadow root, not on its host", () => {
      const root = openHost("amp-search", `<input id="q" type="search" />`);
      const q = root.getElementById("q") as HTMLInputElement;
      q.focus();
      // Read target DURING dispatch: the DOM clears/retargets a shadow target
      // once dispatch finishes.
      const targets: EventTarget[] = [];
      q.addEventListener("keydown", (e) => targets.push(e.target as EventTarget));

      performInputAction(document, { action: "press-key", key: "Enter" });

      expect(targets).toEqual([q]);
    });

    it("type reaches an input focused inside a CLOSED root (Firefox property)", () => {
      const root = closedHost("amp-search", `<input id="q" />`);
      const q = root.getElementById("q") as HTMLInputElement;
      q.focus();
      exposeClosedViaProperty();

      expect(performInputAction(document, { action: "type", text: "tv" }).ok).toBe(true);
      expect(q.value).toBe("tv");
    });

    it("type reaches an input focused inside a CLOSED root (chrome.dom)", () => {
      const root = closedHost("amp-search", `<input id="q" />`);
      const q = root.getElementById("q") as HTMLInputElement;
      q.focus();
      exposeClosedViaChromeDom();

      expect(performInputAction(document, { action: "type", text: "tv" }).ok).toBe(true);
      expect(q.value).toBe("tv");
    });
  });

  describe("fill on a non-fillable element", () => {
    it("returns a clear ok:false instead of a TypeError from the native value setter", () => {
      const root = openHost("amp-nav", `<button>Users and Access</button>`);
      hostOf(root).setAttribute(UID_ATTR, "e1");

      const res = performInputAction(document, { action: "fill", uid: "e1", value: "x" });

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not a fillable field/);
      expect(res.error).toContain("<amp-nav>");
      expect(res.error).not.toMatch(/TypeError|Illegal invocation|set value/);
    });

    it("fill-form stops at the non-fillable field with the same message", () => {
      document.body.innerHTML = `<input id="a" data-bcmcp-uid="e1" /><div data-bcmcp-uid="e2">Not a field</div>`;
      const res = performInputAction(document, {
        action: "fill-form",
        fields: [
          { uid: "e1", value: "alpha" },
          { uid: "e2", value: "beta" },
        ],
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not a fillable field/);
      expect((document.getElementById("a") as HTMLInputElement).value).toBe("alpha");
    });
  });
});
