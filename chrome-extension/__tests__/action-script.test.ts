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
