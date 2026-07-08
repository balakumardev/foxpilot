import { performInputAction, classifyHit } from "../injected/action-script";

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
