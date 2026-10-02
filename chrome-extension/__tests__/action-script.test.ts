import { performInputAction, classifyHit } from "../injected/action-script";
import * as vm from "vm";
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
    it("routes a contenteditable through beforeinput/input (insertText+data) instead of rejecting", async () => {
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
      const res = await performInputAction(document, { action: "type", text: "hi" });
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

  it("fires NO input and leaves textContent unchanged when beforeinput is preventDefault-ed", async () => {
    // Lexical/ProseMirror cancel beforeinput to drive their own model — the extra
    // input would be a spurious signal, and no insertion should happen. This
    // editor then inserts nothing itself, so the text was not kept: ok:false.
    document.body.innerHTML = `<div contenteditable="true" data-bcmcp-uid="e1"></div>`;
    const ce = document.querySelector("[contenteditable]") as HTMLElement;
    ce.focus();
    ce.addEventListener("beforeinput", (e) => e.preventDefault());
    const onInput = jest.fn();
    ce.addEventListener("input", onInput);

    const res = await performInputAction(document, { action: "type", text: "hi" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^The editor did not keep the typed text: <div> /);
    expect(ce.textContent).toBe(""); // insertion skipped
    expect(onInput).not.toHaveBeenCalled(); // input suppressed
  });

  it("normal (uncanceled) path still inserts and fires input with inputType insertText + data", async () => {
    document.body.innerHTML = `<div contenteditable="true" data-bcmcp-uid="e1"></div>`;
    const ce = document.querySelector("[contenteditable]") as HTMLElement;
    ce.focus();
    const inputs: Array<{ inputType?: string; data?: string }> = [];
    ce.addEventListener("input", (e) =>
      inputs.push(e as unknown as { inputType?: string; data?: string })
    );

    const res = await performInputAction(document, { action: "type", text: "hi" });

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

    it("slotted (closed) past an <svg><slot>: the root-side lookup skips the SVG element (both API shapes)", () => {
      const root = closedHost("amp-card", `<svg><slot></slot></svg><div class="frame"><slot></slot></div>`);
      const span = document.createElement("span");
      hostOf(root).appendChild(span);
      exposeClosedViaProperty();
      expect(classifyHit(root.querySelector(".frame"), span)).toBe("descendant");
      restoreClosed!();
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

    // An <svg><slot> is an SVG element named "slot" with no assignedNodes; the
    // hit-test's root-side slot lookup must skip it, not throw (a throw there is
    // swallowed and silently drops the retarget back onto the wrapper).
    function mountClosedRow(): { btn: HTMLElement } {
      document.body.innerHTML = `<ul role="menu"><li role="menuitem" data-bcmcp-uid="e2"></li></ul>`;
      const root = closedHost("x-menu-row", `<svg><slot></slot></svg><div><slot></slot></div>`, document.querySelector("li")!);
      const btn = document.createElement("button");
      btn.textContent = "Draft macOS Submission (1)";
      hostOf(root).appendChild(btn);
      return { btn };
    }
    it("a wrapper around a CLOSED host with an <svg><slot>: the slotted button still gets the click (Firefox property)", () => {
      const { btn } = mountClosedRow();
      const onBtn = jest.fn();
      btn.addEventListener("click", onBtn);
      stubRect();
      stubDocHit(btn); // slotted content is in the document tree
      exposeClosedViaProperty();

      const res = performInputAction(document, { action: "click", uid: "e2" });

      expect(res.ok).toBe(true);
      expect(onBtn).toHaveBeenCalledTimes(1);
      expect((res as { dispatchedTo?: unknown }).dispatchedTo).toEqual({ tag: "button", name: "Draft macOS Submission (1)" });
    });

    it("a wrapper around a CLOSED host with an <svg><slot>: the slotted button still gets the click (chrome.dom)", () => {
      const { btn } = mountClosedRow();
      const onBtn = jest.fn();
      btn.addEventListener("click", onBtn);
      stubRect();
      stubDocHit(btn);
      exposeClosedViaChromeDom();

      const res = performInputAction(document, { action: "click", uid: "e2" });

      expect(onBtn).toHaveBeenCalledTimes(1);
      expect((res as { dispatchedTo?: unknown }).dispatchedTo).toEqual({ tag: "button", name: "Draft macOS Submission (1)" });
    });

    it("an <svg><slot> in an OPEN root next to the target leaves the click alone", () => {
      const root = openHost("amp-nav", `<svg><slot></slot></svg><button data-bcmcp-uid="e1">Users and Access</button>`);
      const btn = root.querySelector("button")!;
      const onBtn = jest.fn();
      btn.addEventListener("click", onBtn);
      stubRect();
      stubDocHit(hostOf(root));
      stubRootHit(root, btn);

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(res.ok).toBe(true);
      expect(res.intercepted).toBeUndefined();
      expect(onBtn).toHaveBeenCalledTimes(1);
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
    it("type appends into an input focused inside an OPEN shadow root", async () => {
      const root = openHost("amp-search", `<input id="q" type="search" value="i" />`);
      const q = root.getElementById("q") as HTMLInputElement;
      q.focus();
      expect(document.activeElement).toBe(hostOf(root)); // what the old code read

      const res = await performInputAction(document, { action: "type", text: "os" });

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

    it("type reaches an input focused inside a CLOSED root (Firefox property)", async () => {
      const root = closedHost("amp-search", `<input id="q" />`);
      const q = root.getElementById("q") as HTMLInputElement;
      q.focus();
      exposeClosedViaProperty();

      expect((await performInputAction(document, { action: "type", text: "tv" })).ok).toBe(true);
      expect(q.value).toBe("tv");
    });

    it("type reaches an input focused inside a CLOSED root (chrome.dom)", async () => {
      const root = closedHost("amp-search", `<input id="q" />`);
      const q = root.getElementById("q") as HTMLInputElement;
      q.focus();
      exposeClosedViaChromeDom();

      expect((await performInputAction(document, { action: "type", text: "tv" })).ok).toBe(true);
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

/**
 * Closed-root probe memoization. chrome.dom.openOrClosedShadowRoot costs
 * microseconds per call and every div/span is a host candidate, so a deep uid
 * lookup probes each element once PER INJECTED-FUNCTION CALL — never twice in
 * one call, and never from a cache left over by an earlier call. Identical
 * block in the Firefox and Chrome suites.
 */
describe("closed-root probe memoization (per call)", () => {
  const closedRoots = new Map<Element, ShadowRoot>();
  const probes = new Map<Element, number>();
  let hadChrome = false;

  beforeEach(() => {
    document.body.innerHTML = "";
    const g = globalThis as any;
    hadChrome = typeof g.chrome !== "undefined";
    if (!hadChrome) {
      g.chrome = {};
    }
    g.chrome.dom = {
      openOrClosedShadowRoot: (el: Element) => {
        probes.set(el, (probes.get(el) || 0) + 1);
        return closedRoots.get(el) || null;
      },
    };
  });
  afterEach(() => {
    const g = globalThis as any;
    delete g.chrome.dom;
    if (!hadChrome) {
      delete g.chrome;
    }
    closedRoots.clear();
    probes.clear();
    document.body.innerHTML = "";
  });

  function closedHost(tag: string, html: string): ShadowRoot {
    const host = document.createElement(tag);
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = html;
    closedRoots.set(host, root);
    return root;
  }

  it("fill-form resolving two closed-root uids probes each element at most once", () => {
    document.body.innerHTML = `<div><span>a</span><span>b</span></div><section><p>c</p></section>`;
    const root = closedHost("amp-form", `<div><input id="a" data-bcmcp-uid="e1" /><input id="b" data-bcmcp-uid="e2" /></div>`);

    const res = performInputAction(document, {
      action: "fill-form",
      fields: [
        { uid: "e1", value: "alpha" },
        { uid: "e2", value: "beta" },
      ],
    });

    expect(res.ok).toBe(true);
    expect((root.getElementById("a") as HTMLInputElement).value).toBe("alpha");
    expect((root.getElementById("b") as HTMLInputElement).value).toBe("beta");
    expect(probes.size).toBeGreaterThan(0);
    expect(Math.max(...Array.from(probes.values()))).toBe(1);
  });

  it("does not carry the cache into the next call (a root attached between calls is found)", () => {
    document.body.innerHTML = `<x-panel></x-panel>`;
    closedHost("amp-nav", `<button data-bcmcp-uid="e1">Users and Access</button>`);
    expect(performInputAction(document, { action: "click", uid: "e1" }).ok).toBe(true);
    expect(probes.get(document.querySelector("x-panel")!)).toBe(1); // probed: no root yet

    const panel = document.querySelector("x-panel")!;
    const late = panel.attachShadow({ mode: "closed" });
    late.innerHTML = `<button data-bcmcp-uid="e2">Late</button>`;
    closedRoots.set(panel, late);
    const onClick = jest.fn();
    late.querySelector("button")!.addEventListener("click", onClick);

    expect(performInputAction(document, { action: "click", uid: "e2" }).ok).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

/**
 * Review fixes: click retargeting is scoped to role wrappers, label forwarding
 * skips interactive content inside the label, input events are composed, a
 * cover inside an ancestor host's own shadow tree is named itself, and uid
 * lookups try open roots before paying for closed-root probes. Identical block
 * in the Firefox and Chrome suites.
 */
describe("review fixes: retarget scope, label content, composed input, cover naming, lookup cost", () => {
  const closedRoots = new Map<Element, ShadowRoot>();
  let restoreChrome: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    if (restoreChrome) {
      restoreChrome();
      restoreChrome = null;
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
  // chrome.dom stub that counts calls: the closed-root probe is the expensive one.
  function countClosedProbes(): { calls: number } {
    const g = globalThis as any;
    const hadChrome = typeof g.chrome !== "undefined";
    if (!hadChrome) {
      g.chrome = {};
    }
    const counter = { calls: 0 };
    g.chrome.dom = {
      openOrClosedShadowRoot: (el: Element) => {
        counter.calls++;
        return closedRoots.get(el) || null;
      },
    };
    restoreChrome = () => {
      delete g.chrome.dom;
      if (!hadChrome) {
        delete g.chrome;
      }
    };
    return counter;
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
  // Click uid with the centre hit-test landing on `hit`.
  function clickWithHit(uid: string, hit: Element, extra?: { doubleClick?: boolean }) {
    stubRect();
    stubDocHit(hit);
    return performInputAction(document, { action: "click", uid, ...(extra || {}) }) as {
      ok: boolean;
      error?: string;
      dispatchedTo?: { tag: string; name?: string };
    };
  }
  function byId(id: string): HTMLElement {
    return document.getElementById(id) as HTMLElement;
  }

  describe("click retargeting only unwraps role wrappers", () => {
    it("a dialog uid does not press the button at its centre", () => {
      document.body.innerHTML = `<div role="dialog" id="dlg" data-bcmcp-uid="e1"><p>Delete your account?</p><button id="del">Delete account</button></div>`;
      const onDelete = jest.fn();
      const onDialog = jest.fn();
      byId("del").addEventListener("click", onDelete);
      byId("dlg").addEventListener("click", onDialog);

      const res = clickWithHit("e1", byId("del"));

      expect(res.ok).toBe(true);
      expect(onDelete).not.toHaveBeenCalled();
      expect(onDialog).toHaveBeenCalledTimes(1);
      expect(onDialog.mock.calls[0][0].target).toBe(byId("dlg"));
      expect(res.dispatchedTo).toBeUndefined();
    });

    it("a radiogroup uid does not switch the radio at its centre", () => {
      document.body.innerHTML = `<div role="radiogroup" aria-label="Plan" data-bcmcp-uid="e1">
        <label><input type="radio" name="plan" id="free" value="free" checked="" /> Free</label>
        <label><input type="radio" name="plan" id="pro" value="pro" /> <span id="pro-text">Pro</span></label>
      </div>`;

      clickWithHit("e1", byId("pro-text"));

      expect((byId("pro") as HTMLInputElement).checked).toBe(false);
      expect((byId("free") as HTMLInputElement).checked).toBe(true);
    });

    it("a backdrop that closes on its own clicks still receives them", () => {
      document.body.innerHTML = `<div class="backdrop" id="backdrop" data-bcmcp-uid="e1"><div class="modal"><button id="ok">OK</button></div></div>`;
      let closed = 0;
      byId("backdrop").addEventListener("click", (e) => {
        if (e.target === e.currentTarget) {
          closed++;
        }
      });
      const onOk = jest.fn();
      byId("ok").addEventListener("click", onOk);

      clickWithHit("e1", byId("ok"));

      expect(closed).toBe(1);
      expect(onOk).not.toHaveBeenCalled();
    });

    it("a contenteditable uid keeps focus when a link sits at its centre, so type-text still works", async () => {
      document.body.innerHTML = `<div contenteditable="true" id="ed" data-bcmcp-uid="e1">Hello <a id="lnk" href="#x">link</a> world</div>`;
      const onLink = jest.fn();
      byId("lnk").addEventListener("click", onLink);

      clickWithHit("e1", byId("lnk"));
      const typed = await performInputAction(document, { action: "type", text: "!" });

      expect(onLink).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(byId("ed"));
      expect(typed.ok).toBe(true);
      expect(byId("ed").textContent).toContain("!");
    });

    it("a product link uid follows the link instead of opening the quick-view button at its centre", () => {
      document.body.innerHTML = `<a href="#product-42" id="card" data-bcmcp-uid="e1"><span>Wool coat</span><button type="button" id="qv">Quick view</button></a>`;
      const onQuickView = jest.fn();
      const onLink = jest.fn();
      byId("qv").addEventListener("click", onQuickView);
      byId("card").addEventListener("click", onLink);

      const res = clickWithHit("e1", byId("qv"));

      expect(onQuickView).not.toHaveBeenCalled();
      expect(onLink).toHaveBeenCalledTimes(1);
      expect(onLink.mock.calls[0][0].target).toBe(byId("card"));
      expect(res.dispatchedTo).toBeUndefined();
    });

    it("a row holding several controls keeps the click (the link at its centre is not followed)", () => {
      document.body.innerHTML = `<div role="row" id="row" data-bcmcp-uid="e1">
        <span role="gridcell"><input type="checkbox" aria-label="Select" id="sel" /></span>
        <span role="gridcell"><a id="item" href="#item-1">Item 1</a></span>
        <span role="gridcell"><button type="button" aria-label="More">...</button></span>
      </div>`;
      const onRow = jest.fn();
      const onItem = jest.fn();
      byId("row").addEventListener("click", onRow);
      byId("item").addEventListener("click", onItem);

      const res = clickWithHit("e1", byId("item"));

      expect(onItem).not.toHaveBeenCalled();
      expect(onRow).toHaveBeenCalledTimes(1);
      expect(onRow.mock.calls[0][0].target).toBe(byId("row"));
      expect((byId("sel") as HTMLInputElement).checked).toBe(false);
      expect(res.dispatchedTo).toBeUndefined();
    });

    it("a row whose only control is a link but which shows text of its own keeps the click", () => {
      document.body.innerHTML = `<div role="row" id="row" data-bcmcp-uid="e1"><span role="gridcell">Invoice 42</span><span role="gridcell"><a id="cust" href="#customer">Acme</a></span><span role="gridcell">Paid</span></div>`;
      const onRow = jest.fn();
      const onCustomer = jest.fn();
      byId("row").addEventListener("click", onRow);
      byId("cust").addEventListener("click", onCustomer);

      const res = clickWithHit("e1", byId("cust"));

      expect(onCustomer).not.toHaveBeenCalled();
      expect(onRow.mock.calls[0][0].target).toBe(byId("row"));
      expect(res.dispatchedTo).toBeUndefined();
    });

    it("a tablist uid does not press the tab at its centre", () => {
      document.body.innerHTML = `<div role="tablist" id="tl" data-bcmcp-uid="e1"><button role="tab" id="t1">General</button><button role="tab" id="t2">Billing</button><button role="tab" id="t3">Danger</button></div>`;
      const onBilling = jest.fn();
      byId("t2").addEventListener("click", onBilling);

      clickWithHit("e1", byId("t2"));

      expect(onBilling).not.toHaveBeenCalled();
    });

    it("a card with a disabled button at its centre keeps the click and reports no dispatchedTo", () => {
      document.body.innerHTML = `<div class="card" id="card" data-bcmcp-uid="e1" style="cursor:pointer"><button id="buy" disabled="">Buy</button></div>`;
      const onCard = jest.fn();
      byId("card").addEventListener("click", onCard);

      const res = clickWithHit("e1", byId("buy"));

      expect(res.ok).toBe(true);
      expect(onCard).toHaveBeenCalledTimes(1);
      expect(onCard.mock.calls[0][0].target).toBe(byId("card"));
      expect(res.dispatchedTo).toBeUndefined();
    });

    it("a menuitem whose only control is disabled or aria-disabled keeps the click", () => {
      document.body.innerHTML = `<ul role="menu">
        <li role="menuitem" id="m1" data-bcmcp-uid="e1"><button id="b1" disabled="">Archive</button></li>
        <li role="menuitem" id="m2" data-bcmcp-uid="e2"><button id="b2" aria-disabled="true">Export</button></li>
      </ul>`;
      const onM1 = jest.fn();
      const onM2 = jest.fn();
      const onB2 = jest.fn();
      byId("m1").addEventListener("click", onM1);
      byId("m2").addEventListener("click", onM2);
      byId("b2").addEventListener("click", onB2);

      const r1 = clickWithHit("e1", byId("b1"));
      const r2 = clickWithHit("e2", byId("b2"));

      expect(onM1).toHaveBeenCalledTimes(1);
      expect(onM1.mock.calls[0][0].target).toBe(byId("m1"));
      expect(onB2).not.toHaveBeenCalled();
      expect(onM2.mock.calls[0][0].target).toBe(byId("m2"));
      expect(r1.dispatchedTo).toBeUndefined();
      expect(r2.dispatchedTo).toBeUndefined();
    });

    it("an option wrapper holding two enabled controls keeps the click", () => {
      document.body.innerHTML = `<div role="option" id="opt" data-bcmcp-uid="e1"><input type="checkbox" id="cb" aria-label="Pick" /><a id="more" href="#more">Details</a></div>`;
      const onOpt = jest.fn();
      const onMore = jest.fn();
      byId("opt").addEventListener("click", onOpt);
      byId("more").addEventListener("click", onMore);

      clickWithHit("e1", byId("more"));

      expect(onMore).not.toHaveBeenCalled();
      expect(onOpt.mock.calls[0][0].target).toBe(byId("opt"));
      expect((byId("cb") as HTMLInputElement).checked).toBe(false);
    });

    it("a control hidden by a display:none ancestor does not count against the visible one", () => {
      document.body.innerHTML = `<ul role="menu"><li role="menuitem" data-bcmcp-uid="e1"><div style="display:none"><button id="hid">Hidden</button></div><button id="vis">Rename</button></li></ul>`;
      const onVisible = jest.fn();
      byId("vis").addEventListener("click", onVisible);

      const res = clickWithHit("e1", byId("vis"));

      expect(onVisible).toHaveBeenCalledTimes(1);
      expect(res.dispatchedTo).toEqual({ tag: "button", name: "Rename" });
    });
  });

  describe("label forwarding skips interactive content inside the label", () => {
    it("clicking a link inside a checkbox label follows the link and leaves the box alone", () => {
      document.body.innerHTML = `<label>I agree to the <a id="terms" href="#terms" data-bcmcp-uid="e1">Terms</a> <input type="checkbox" id="agree" /></label>`;
      let changes = 0;
      byId("agree").addEventListener("change", () => changes++);
      const onLink = jest.fn();
      byId("terms").addEventListener("click", onLink);

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(res.ok).toBe(true);
      expect(onLink).toHaveBeenCalledTimes(1);
      expect((byId("agree") as HTMLInputElement).checked).toBe(false);
      expect(changes).toBe(0);
    });

    it("clicking inside a button inside a checkbox label leaves the box alone", () => {
      document.body.innerHTML = `<label><input type="checkbox" id="sub" /> Subscribe <button type="button" id="info"><span id="info-text" data-bcmcp-uid="e1">What is this?</span></button></label>`;
      const onInfo = jest.fn();
      byId("info").addEventListener("click", onInfo);

      performInputAction(document, { action: "click", uid: "e1" });

      expect(onInfo).toHaveBeenCalledTimes(1);
      expect((byId("sub") as HTMLInputElement).checked).toBe(false);
    });

    it("clicking the label's own text still toggles the box exactly once", () => {
      document.body.innerHTML = `<label>I agree to the <a href="#terms">Terms</a> <span id="txt" data-bcmcp-uid="e1">and the policy</span> <input type="checkbox" id="agree" /></label>`;
      let changes = 0;
      byId("agree").addEventListener("change", () => changes++);

      performInputAction(document, { action: "click", uid: "e1" });

      expect((byId("agree") as HTMLInputElement).checked).toBe(true);
      expect(changes).toBe(1);
    });
  });

  describe("input events are composed (change is not)", () => {
    it("fill on an input inside a shadow root is seen by a listener on the host", () => {
      const root = openHost("x-field", `<input id="q" data-bcmcp-uid="e1" />`);
      const seen: string[] = [];
      root.host.addEventListener("input", () => seen.push("input"));
      root.host.addEventListener("change", () => seen.push("change"));

      const res = performInputAction(document, { action: "fill", uid: "e1", value: "ios" });

      expect(res.ok).toBe(true);
      expect((root.getElementById("q") as HTMLInputElement).value).toBe("ios");
      expect(seen).toEqual(["input"]);
    });

    it("fill on a <select> inside a shadow root is seen by a listener on the host", () => {
      const root = openHost(
        "x-field",
        `<select id="s" data-bcmcp-uid="e1"><option value="ios">iOS</option><option value="tvos">tvOS</option></select>`
      );
      const seen: string[] = [];
      root.host.addEventListener("input", () => seen.push("input"));
      root.host.addEventListener("change", () => seen.push("change"));

      performInputAction(document, { action: "fill", uid: "e1", value: "tvOS" });

      expect((root.getElementById("s") as HTMLSelectElement).value).toBe("tvos");
      expect(seen).toEqual(["input"]);
    });

    it("type into an input focused inside a shadow root is seen by a listener on the host", async () => {
      const root = openHost("x-field", `<input id="q" />`);
      (root.getElementById("q") as HTMLInputElement).focus();
      const seen: string[] = [];
      root.host.addEventListener("input", () => seen.push("input"));

      const res = await performInputAction(document, { action: "type", text: "ab" });

      expect(res.ok).toBe(true);
      expect(seen).toContain("input");
    });
  });

  describe("cover naming", () => {
    it("a scrim in an app shell's own shadow tree covering a button slotted into it is named itself", () => {
      const shell = openHost("app-shell", `<div class="scrim">Loading</div><main><slot></slot></main>`);
      shell.host.innerHTML = `<button data-bcmcp-uid="e1">Save</button>`;
      stubRect();
      stubDocHit(shell.host);
      (shell as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () =>
        shell.querySelector(".scrim");

      const res = performInputAction(document, { action: "classify-intercept", uid: "e1" });

      expect(res.intercepted).toMatchObject({ tag: "div", classes: "scrim", name: "Loading" });
    });
  });

  // Chrome exposes a form's named controls as properties of the form, so
  // `<form><input name="parentNode">` makes form.parentNode return that input
  // and a naive ancestor walk cycles form -> input -> form forever. jsdom does
  // not do this, so these tests install the same own property on the form.
  describe("walks stay bounded when a form control shadows a DOM built-in", () => {
    function shadowFormProperty(form: Element, prop: string, value: Element | null): void {
      Object.defineProperty(form, prop, { configurable: true, get: () => value });
    }

    it("a click on a wrapper holding a form whose control is named parentNode terminates", () => {
      document.body.innerHTML = `<ul role="menu"><li role="menuitem" id="mi" data-bcmcp-uid="e1"><span id="lbl">Rename</span><form id="f"><input name="parentNode" /><button type="button" id="go">Go</button></form></li></ul>`;
      shadowFormProperty(byId("f"), "parentNode", byId("f").querySelector('input[name="parentNode"]'));
      const onItem = jest.fn();
      byId("mi").addEventListener("click", onItem);

      const res = clickWithHit("e1", byId("lbl"));

      expect(res.ok).toBe(true);
      expect(onItem).toHaveBeenCalledTimes(1);
      expect(res.dispatchedTo).toBeUndefined();
    });

    it("label forwarding reaches the real label through a form whose control is named parentElement", () => {
      document.body.innerHTML = `<label><input type="checkbox" id="cb" /><form id="f"><input type="hidden" name="parentElement" /><span id="txt" data-bcmcp-uid="e1">Accept</span></form></label>`;
      shadowFormProperty(byId("f"), "parentElement", byId("f").querySelector('input[name="parentElement"]'));
      // A browser's closest() is native and ignores the shadowing; jsdom's
      // (nwsapi) walks .parentElement and would itself cycle, so stand in the
      // native behaviour for this test.
      const nativeParent = Object.getOwnPropertyDescriptor(Node.prototype, "parentElement")!.get!;
      jest.spyOn(Element.prototype, "closest").mockImplementation(function (this: Element, sel: string) {
        for (let n: Element | null = this; n; n = nativeParent.call(n) as Element | null) {
          if (n.matches(sel)) {
            return n;
          }
        }
        return null;
      });
      let changes = 0;
      byId("cb").addEventListener("change", () => changes++);

      const res = performInputAction(document, { action: "click", uid: "e1" });

      expect(res.ok).toBe(true);
      expect((byId("cb") as HTMLInputElement).checked).toBe(true);
      expect(changes).toBe(1);
    });
  });

  describe("uid lookup tries open shadow roots before probing closed ones", () => {
    it("resolves a light-DOM uid and an open-root uid without a single closed-root probe", () => {
      document.body.innerHTML = `<div><span>a</span><span>b</span></div><section><div><p>c</p></div></section><button data-bcmcp-uid="e1">Light</button>`;
      const root = openHost("x-panel", `<div><span><button data-bcmcp-uid="e2">Shadow</button></span></div>`);
      const onShadow = jest.fn();
      root.querySelector("button")!.addEventListener("click", onShadow);
      const probes = countClosedProbes();

      expect(performInputAction(document, { action: "click", uid: "e1" }).ok).toBe(true);
      expect(performInputAction(document, { action: "click", uid: "e2" }).ok).toBe(true);

      expect(onShadow).toHaveBeenCalledTimes(1);
      expect(probes.calls).toBe(0);
    });

    it("still resolves a closed-root uid once the open pass misses, and still reports a stale one", () => {
      document.body.innerHTML = `<div><span>a</span></div>`;
      const root = closedHost("x-secret", `<div><button data-bcmcp-uid="e3">Closed</button></div>`);
      const onClosed = jest.fn();
      root.querySelector("button")!.addEventListener("click", onClosed);
      const probes = countClosedProbes();

      expect(performInputAction(document, { action: "click", uid: "e3" }).ok).toBe(true);
      const stale = performInputAction(document, { action: "click", uid: "e404" });

      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(probes.calls).toBeGreaterThan(0);
      expect(stale.ok).toBe(false);
      expect(stale.error).toContain("fresh snapshot");
    });
  });
});

/**
 * composedParent reads the prototype getters and composedContains is capped: a
 * form's named controls shadow its built-ins, so `<form><input
 * name="parentNode">` makes `form.parentNode` return that input and turns every
 * walk up through the form into a cycle (a content script shares the page's main
 * thread, so an unbounded walk freezes the tab). jsdom implements no form named
 * properties; each test shadows the property on the form with a getter that
 * throws once it is clearly read in a loop, so a regression fails instead of
 * hanging the suite.
 */
describe("a form's named controls cannot trap composedContains in a cycle", () => {
  function trapFormProperty(form: Element, name: string, inner: Element): void {
    let reads = 0;
    Object.defineProperty(form, name, {
      configurable: true,
      get() {
        reads += 1;
        if (reads > 5000) {
          throw new Error("cycle: form." + name + " read " + reads + " times");
        }
        return inner;
      },
    });
  }
  const PAGE = `<form id="f"><input id="trap"><button id="pay">Pay</button></form><div id="overlay">cookies</div>`;

  afterEach(() => {
    jest.restoreAllMocks();
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    document.body.innerHTML = "";
  });

  it.each(["parentNode", "assignedSlot"])("classifyHit walks through form.%s and terminates", (prop) => {
    document.body.innerHTML = PAGE;
    const form = document.getElementById("f")!;
    const pay = document.getElementById("pay")!;
    const overlay = document.getElementById("overlay")!;
    trapFormProperty(form, prop, document.getElementById("trap")!);
    expect(classifyHit(pay, overlay)).toBe("unrelated");
    expect(classifyHit(overlay, pay)).toBe("unrelated");
    expect(classifyHit(form, pay)).toBe("descendant");
    expect(classifyHit(pay, form)).toBe("ancestor");
  });

  it.each(["parentNode", "assignedSlot"])("a click whose hit-test walks through form.%s completes", (prop) => {
    document.body.innerHTML = PAGE;
    const pay = document.getElementById("pay")!;
    const overlay = document.getElementById("overlay")!;
    pay.setAttribute("data-bcmcp-uid", "e1");
    const onClick = jest.fn();
    pay.addEventListener("click", onClick);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => overlay;
    jest.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 20, height: 20,
      right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    trapFormProperty(document.getElementById("f")!, prop, document.getElementById("trap")!);

    const res = performInputAction(document, { action: "click", uid: "e1" });

    expect(res.ok).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(res.intercepted).toMatchObject({ tag: "div", id: "overlay" });
  });
});

/**
 * The whole path, across modules: take-snapshot hands out the menu item's uid,
 * and click-element unwraps a click on that role wrapper onto the button its
 * centre lands on. Both the snapshot and the unwrap walk up from the button,
 * through a form whose control shadows parentNode / assignedSlot, to the menu
 * item. composedParent reads the prototype getters, so the walk reaches the
 * item instead of cycling form → control → form. jsdom implements no form named
 * properties; the shadowing getter throws once it is clearly read in a loop, and
 * the snapshot (which memoizes parents, so a cycle can spin without re-reading
 * the property) runs stringified in a vm with a time limit — a regression fails
 * instead of hanging the suite.
 */
describe("snapshot → click through a form whose control shadows a traversal property", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    document.body.innerHTML = "";
  });

  it.each(["parentNode", "assignedSlot"])(
    "the menu item's uid unwraps onto the button inside the form (form.%s shadowed)",
    (prop) => {
      // One control in the item (the hidden input is not one), and a name of its
      // own, so the snapshot gives the item its own uid and the click unwraps.
      document.body.innerHTML = `<ul role="menu"><li role="menuitem" id="mi" aria-label="Rename file"><form id="f"><input type="hidden" name="${prop}"><button type="button" id="go">Rename</button></form></li></ul>`;
      const form = document.getElementById("f")!;
      const control = form.querySelector("input")!;
      let reads = 0;
      Object.defineProperty(form, prop, {
        configurable: true,
        get() {
          reads += 1;
          if (reads > 5000) {
            throw new Error("cycle: form." + prop + " read " + reads + " times");
          }
          return control;
        },
      });
      const go = document.getElementById("go")!;
      const onGo = jest.fn();
      go.addEventListener("click", onGo);

      const snap = vm.runInContext(
        "(" + buildSnapshot.toString() + ")(document, { verbose: false, maxLength: 25000 })",
        vm.createContext({ document, Element, Node }),
        { timeout: 4000 }
      ) as ReturnType<typeof buildSnapshot>;
      const item = document.getElementById("mi")!;
      const uid = item.getAttribute("data-bcmcp-uid")!;
      expect(snap.tree).toContain('menuitem "Rename file" |  |  [uid=' + uid + "]");

      jest.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
        left: 0, top: 0, width: 20, height: 20,
        right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}),
      } as DOMRect);
      (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => go;
      const res = performInputAction(document, { action: "click", uid }) as {
        ok: boolean;
        dispatchedTo?: { tag: string; name?: string };
      };

      expect(res.ok).toBe(true);
      expect(onGo).toHaveBeenCalledTimes(1);
      expect(res.dispatchedTo).toMatchObject({ tag: "button", name: "Rename" });
    }
  );
});

/**
 * type-text into a contenteditable: typed through the editing host at its
 * caret, and ok only when the editor kept the text, checked before any Enter.
 * jsdom has no execCommand, so the Text-node fallback runs unless a test stubs
 * it. Identical block in the Firefox and Chrome suites.
 */
describe("type-text into a contenteditable: caret and kept-text check", () => {
  const NOT_KEPT =
    /^The editor did not keep the typed text: <div role="textbox"> ignores or undoes synthetic input, so nothing was entered\. /;

  afterEach(() => {
    delete (document as any).execCommand;
    document.body.innerHTML = "";
  });

  function byId(id: string): HTMLElement {
    return document.getElementById(id) as HTMLElement;
  }

  it("leaves a caret that is already inside the host where it is", async () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true">helloworld</div>`;
    const ed = byId("ed");
    ed.focus();
    window.getSelection()!.collapse(ed.firstChild!, 5);

    const res = await performInputAction(document, { action: "type", text: " " });

    expect(res).toEqual({ ok: true });
    expect(ed.textContent).toBe("hello world");
  });

  it("moves a caret that is outside the host to the end of the host, inside an empty editor's <p>", async () => {
    document.body.innerHTML = `<p id="out">outside</p><div id="ed" contenteditable="true" role="textbox"><p id="para"><br></p></div>`;
    const ed = byId("ed");
    ed.focus();
    window.getSelection()!.collapse(byId("out").firstChild!, 3);

    const res = await performInputAction(document, { action: "type", text: "hi" });

    expect(res).toEqual({ ok: true });
    expect(byId("para").textContent).toBe("hi");
    expect(byId("out").textContent).toBe("outside");
  });

  it("reports ok:false and does not submit when the editor cancels beforeinput and inserts nothing", async () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true" role="textbox"></div>`;
    const ed = byId("ed");
    ed.focus();
    ed.addEventListener("beforeinput", (e) => e.preventDefault());
    const keys: string[] = [];
    ed.addEventListener("keydown", (e) => keys.push((e as KeyboardEvent).key));

    const res = await performInputAction(document, { action: "type", text: "hi", submit: true });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(NOT_KEPT);
    expect(ed.textContent).toBe("");
    expect(keys).toEqual(["h", "i"]); // the typed keys, and no Enter
  });

  it("reports ok:false when the editor undoes the inserted text (a MutationObserver restoring its DOM)", async () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true" role="textbox">kept</div>`;
    const ed = byId("ed");
    ed.focus();
    const undo = new MutationObserver(() => {
      if (ed.textContent !== "kept") {
        ed.textContent = "kept";
      }
    });
    undo.observe(ed, { childList: true, characterData: true, subtree: true });
    try {
      const res = await performInputAction(document, { action: "type", text: "x" });

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(NOT_KEPT);
      expect(ed.textContent).toBe("kept");
    } finally {
      undo.disconnect();
    }
  });

  it("reports ok when the editor cancels beforeinput and inserts through its own model", async () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true" role="textbox"><p><br></p></div>`;
    const ed = byId("ed");
    ed.focus();
    ed.addEventListener("beforeinput", (e) => {
      e.preventDefault();
      const data = (e as InputEvent).data || "";
      // Like Lexical: the model update reaches the DOM in a microtask.
      queueMicrotask(() => {
        ed.innerHTML = "<p><span>" + data + "</span></p>";
      });
    });
    const inputs = jest.fn();
    ed.addEventListener("input", inputs);

    const res = await performInputAction(document, { action: "type", text: "hello" });

    expect(res).toEqual({ ok: true });
    expect(ed.textContent).toBe("hello");
    expect(inputs).not.toHaveBeenCalled();
  });

  it("fires no input event of its own when execCommand inserted the text", async () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true"></div>`;
    const ed = byId("ed");
    ed.focus();
    // Stands in for the browser's insertText (which also fires the real input
    // event itself; this stub leaves that out so any input seen is ours).
    (document as any).execCommand = jest.fn((_cmd: string, _ui: boolean, value: string) => {
      ed.appendChild(document.createTextNode(value));
      return true;
    });
    const inputs = jest.fn();
    ed.addEventListener("input", inputs);

    const res = await performInputAction(document, { action: "type", text: "hey" });

    expect((document as any).execCommand).toHaveBeenCalledWith("insertText", false, "hey");
    expect(res).toEqual({ ok: true });
    expect(ed.textContent).toBe("hey");
    expect(inputs).not.toHaveBeenCalled();
  });

  it("with empty text and submit (the humanized path's last step), presses Enter without inserting or checking", async () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true">done</div>`;
    const ed = byId("ed");
    ed.focus();
    const beforeinput = jest.fn();
    ed.addEventListener("beforeinput", beforeinput);
    const keys: string[] = [];
    ed.addEventListener("keydown", (e) => keys.push((e as KeyboardEvent).key));

    const res = await performInputAction(document, { action: "type", text: "", submit: true });

    expect(res).toEqual({ ok: true }); // nothing changed, and nothing was checked
    expect(beforeinput).not.toHaveBeenCalled();
    expect(keys).toEqual(["Enter"]);
    expect(ed.textContent).toBe("done");
  });
});
