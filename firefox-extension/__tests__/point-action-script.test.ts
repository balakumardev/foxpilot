import {
  performPointAction,
  scrollWindowTo,
  scrollElementIntoView,
} from "../injected/point-action-script";
import { buildSnapshot } from "../injected/snapshot-script";

// jsdom has no layout: document.elementFromPoint returns null and rects are
// zero. Every test stubs elementFromPoint and never asserts rect values.
describe("performPointAction (firefox)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    (document as any).elementFromPoint = undefined;
  });

  function stubPoint(el: Element | null) {
    (document as any).elementFromPoint = jest.fn(() => el);
  }

  describe("click-at (Task 2)", () => {
    it("clicks the element under the point and returns its descriptor", () => {
      document.body.innerHTML = `<div id="card" role="button" class="a b">Open</div>`;
      const el = document.getElementById("card")!;
      stubPoint(el);
      const onClick = jest.fn();
      el.addEventListener("click", onClick);

      const res = performPointAction(document, { action: "click-at", x: 10, y: 20 });

      expect((document as any).elementFromPoint).toHaveBeenCalledWith(10, 20);
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(true);
      expect(res.element).toMatchObject({
        tag: "div",
        id: "card",
        role: "button",
        classes: ["a", "b"],
        name: "Open",
      });
      expect(res.element!.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    });

    it("returns ok:false with a helpful error when no element is at the point", () => {
      stubPoint(null);
      const res = performPointAction(document, { action: "click-at", x: 1, y: 2 });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/No element at point \(1, 2\)/);
      expect(res.element).toBeUndefined();
    });

    it("fires dblclick when doubleClick is set", () => {
      document.body.innerHTML = `<button>Go</button>`;
      const el = document.querySelector("button")!;
      stubPoint(el);
      const onDbl = jest.fn();
      el.addEventListener("dblclick", onDbl);
      performPointAction(document, { action: "click-at", x: 5, y: 5, doubleClick: true });
      expect(onDbl).toHaveBeenCalledTimes(1);
    });

    it("fires contextmenu for button:'right' instead of activating", () => {
      document.body.innerHTML = `<button>Go</button>`;
      const el = document.querySelector("button")!;
      stubPoint(el);
      const onClick = jest.fn();
      const onCtx = jest.fn();
      el.addEventListener("click", onClick);
      el.addEventListener("contextmenu", onCtx);
      performPointAction(document, { action: "click-at", x: 5, y: 5, button: "right" });
      expect(onCtx).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe("type-at (Task 3)", () => {
    function stubPoint(el: Element | null) {
      (document as any).elementFromPoint = jest.fn(() => el);
    }

    it("types into an <input> via the native setter and fires input", () => {
      document.body.innerHTML = `<input type="text" />`;
      const el = document.querySelector("input")!;
      stubPoint(el);
      const onInput = jest.fn();
      el.addEventListener("input", onInput);

      const res = performPointAction(document, { action: "type-at", x: 3, y: 4, text: "hi" });

      expect(res.ok).toBe(true);
      expect(el.value).toBe("hi");
      expect(onInput).toHaveBeenCalled();
      expect(res.element!.editable).toBe(true);
    });

    it("types into a contenteditable div (textContent fallback when execCommand is absent)", () => {
      document.body.innerHTML = `<div contenteditable="true"></div>`;
      const el = document.querySelector("[contenteditable]")!;
      // jsdom has no execCommand — the fallback path runs.
      stubPoint(el);
      const res = performPointAction(document, { action: "type-at", x: 1, y: 1, text: "yo" });
      expect(res.ok).toBe(true);
      expect(el.textContent).toBe("yo");
    });

    it("submits with a trailing Enter when submit is set", () => {
      document.body.innerHTML = `<input type="text" />`;
      const el = document.querySelector("input")!;
      stubPoint(el);
      const onKeydown = jest.fn();
      el.addEventListener("keydown", onKeydown);
      performPointAction(document, { action: "type-at", x: 1, y: 1, text: "x", submit: true });
      const keys = onKeydown.mock.calls.map((c) => c[0].key);
      expect(keys).toContain("Enter");
    });

    it("returns ok:false for a non-typable element", () => {
      document.body.innerHTML = `<div>plain</div>`;
      const el = document.querySelector("div")!;
      stubPoint(el);
      const res = performPointAction(document, { action: "type-at", x: 1, y: 1, text: "z" });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not typable/);
      expect(res.element!.tag).toBe("div");
    });

    it("returns ok:false when no element is at the point", () => {
      stubPoint(null);
      const res = performPointAction(document, { action: "type-at", x: 9, y: 9, text: "q" });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/No element at point/);
      expect(res.element).toBeUndefined();
    });
  });

  describe("hover-at (Task 4)", () => {
    it("dispatches mouseover/mouseenter/mousemove on the element under the point", () => {
      document.body.innerHTML = `<div id="menu">Menu</div>`;
      const el = document.getElementById("menu")!;
      (document as any).elementFromPoint = jest.fn(() => el);
      const over = jest.fn();
      const enter = jest.fn();
      const move = jest.fn();
      el.addEventListener("mouseover", over);
      el.addEventListener("mouseenter", enter);
      el.addEventListener("mousemove", move);

      const res = performPointAction(document, { action: "hover-at", x: 7, y: 8 });

      expect(over).toHaveBeenCalled();
      expect(enter).toHaveBeenCalled();
      expect(move).toHaveBeenCalled();
      expect(res.ok).toBe(true);
      expect(res.element!.id).toBe("menu");
    });

    it("returns ok:false when the point hits nothing", () => {
      (document as any).elementFromPoint = jest.fn(() => null);
      const res = performPointAction(document, { action: "hover-at", x: 0, y: 0 });
      expect(res.ok).toBe(false);
    });
  });

  describe("scroll-at (Task 5)", () => {
    function stubPoint(el: Element | null) {
      (document as any).elementFromPoint = jest.fn(() => el);
    }

    it("scrolls the nearest scrollable ANCESTOR, not the window", () => {
      document.body.innerHTML = `
        <div id="panel" style="overflow-y: scroll">
          <div id="inner"><span id="leaf">row</span></div>
        </div>`;
      const panel = document.getElementById("panel")!;
      const leaf = document.getElementById("leaf")!;
      // jsdom reports 0 sizes; force a scrollable geometry on the panel.
      Object.defineProperty(panel, "scrollHeight", { value: 500, configurable: true });
      Object.defineProperty(panel, "clientHeight", { value: 200, configurable: true });
      (panel as any).scrollBy = jest.fn();
      (window as any).scrollBy = jest.fn();
      stubPoint(leaf);

      const res = performPointAction(document, { action: "scroll-at", x: 5, y: 5, dy: 120 });

      expect((panel as any).scrollBy).toHaveBeenCalledWith(0, 120);
      expect((window as any).scrollBy).not.toHaveBeenCalled();
      expect(res.ok).toBe(true);
      expect(res.element!.id).toBe("panel");
    });

    it("falls back to window.scrollBy when no ancestor is scrollable", () => {
      document.body.innerHTML = `<div id="plain">x</div>`;
      const el = document.getElementById("plain")!;
      (window as any).scrollBy = jest.fn();
      stubPoint(el);

      const res = performPointAction(document, { action: "scroll-at", x: 1, y: 1, dy: 300 });

      expect((window as any).scrollBy).toHaveBeenCalledWith(0, 300);
      expect(res.ok).toBe(true);
    });

    it("defaults dy to the container's clientHeight when dy is omitted", () => {
      document.body.innerHTML = `<div id="panel" style="overflow-y: scroll"><span id="leaf">row</span></div>`;
      const panel = document.getElementById("panel")!;
      const leaf = document.getElementById("leaf")!;
      Object.defineProperty(panel, "scrollHeight", { value: 900, configurable: true });
      Object.defineProperty(panel, "clientHeight", { value: 300, configurable: true });
      (panel as any).scrollBy = jest.fn();
      (window as any).scrollBy = jest.fn();
      stubPoint(leaf);

      const res = performPointAction(document, { action: "scroll-at", x: 2, y: 2 });

      // dx defaults to 0; dy defaults to the container's clientHeight (300).
      expect((panel as any).scrollBy).toHaveBeenCalledWith(0, 300);
      expect((window as any).scrollBy).not.toHaveBeenCalled();
      expect(res.ok).toBe(true);
      expect(res.element!.id).toBe("panel");
    });

    it("returns ok:false when the point hits nothing", () => {
      stubPoint(null);
      const res = performPointAction(document, { action: "scroll-at", x: 0, y: 0 });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/No element at point/);
      expect(res.element).toBeUndefined();
    });
  });

  describe("scrollWindowTo / scrollElementIntoView (Task 6)", () => {
    it("scrollWindowTo calls window.scrollTo(x,y)", () => {
      (window as any).scrollTo = jest.fn();
      const res = scrollWindowTo(document, 0, 400);
      expect((window as any).scrollTo).toHaveBeenCalledWith(0, 400);
      expect(res.ok).toBe(true);
    });

    it("scrollElementIntoView resolves the uid and centers it", () => {
      document.body.innerHTML = `<div data-bcmcp-uid="e5">target</div>`;
      const el = document.querySelector('[data-bcmcp-uid="e5"]')!;
      (el as any).scrollIntoView = jest.fn();
      const res = scrollElementIntoView(document, "e5");
      expect((el as any).scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "center" });
      expect(res.ok).toBe(true);
    });

    it("scrollElementIntoView returns ok:false for a stale uid", () => {
      document.body.innerHTML = `<div>nope</div>`;
      const res = scrollElementIntoView(document, "e404");
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not found/);
    });
  });

  describe("describe-at (Phase 3 — read-only descriptor for the CDP engine)", () => {
    afterEach(() => {
      document.body.innerHTML = "";
      (document as any).elementFromPoint = undefined;
    });

    it("returns the element descriptor WITHOUT dispatching any event", () => {
      document.body.innerHTML = `<div id="card" role="button" class="a b">Open</div>`;
      const el = document.getElementById("card")!;
      (document as any).elementFromPoint = jest.fn(() => el);
      const onClick = jest.fn();
      el.addEventListener("click", onClick);

      const res = performPointAction(document, { action: "describe-at", x: 3, y: 4 });

      expect((document as any).elementFromPoint).toHaveBeenCalledWith(3, 4);
      expect(onClick).not.toHaveBeenCalled(); // read-only
      expect(res.ok).toBe(true);
      expect(res.element).toMatchObject({
        tag: "div",
        id: "card",
        role: "button",
        name: "Open",
      });
    });

    it("returns ok:false off-point", () => {
      (document as any).elementFromPoint = jest.fn(() => null);
      const res = performPointAction(document, { action: "describe-at", x: 1, y: 2 });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/No element at point/);
    });
  });
});

/**
 * Covert synthetic parity for the coordinate tools (A1 key identity + keypress,
 * A3 click-at sequence completeness / coords / buttons, A5 contenteditable via
 * InputEvent, A7 hover-at pointer events, B10 identity guard on scroll-into-view).
 * Every dispatched event stays synthetic (isTrusted:false).
 */
describe("synthetic covert parity (point tools)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = "";
    (document as any).elementFromPoint = undefined;
  });
  function stubPoint(el: Element | null) {
    (document as any).elementFromPoint = jest.fn(() => el);
  }

  describe("A3: click-at sequence completeness + coordinates + buttons", () => {
    it("dispatches pointerup and carries click coordinates + the buttons bitmask", () => {
      document.body.innerHTML = `<button>Go</button>`;
      const el = document.querySelector("button")!;
      stubPoint(el);
      const seq: string[] = [];
      ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(
        (t) => el.addEventListener(t, () => seq.push(t))
      );
      let down: MouseEvent | null = null;
      let up: MouseEvent | null = null;
      el.addEventListener("mousedown", (e) => (down = e as MouseEvent));
      el.addEventListener("mouseup", (e) => (up = e as MouseEvent));

      performPointAction(document, { action: "click-at", x: 77, y: 88 });

      expect(seq).toContain("pointerup");
      expect(seq.indexOf("mouseup")).toBeLessThan(seq.indexOf("click"));
      expect(down!.clientX).toBe(77);
      expect(down!.clientY).toBe(88);
      expect(down!.composed).toBe(true);
      expect(down!.buttons).toBe(1);
      expect(up!.buttons).toBe(0);
    });
  });

  describe("A1: type-at key events carry identity + keypress", () => {
    it("emits keydown→keypress→keyup with keyCode/code for a printable char", () => {
      document.body.innerHTML = `<input type="text" />`;
      const el = document.querySelector("input")!;
      stubPoint(el);
      const seq: string[] = [];
      let kd: KeyboardEvent | null = null;
      el.addEventListener("keydown", (e) => {
        seq.push("keydown");
        kd = e as KeyboardEvent;
      });
      el.addEventListener("keypress", () => seq.push("keypress"));
      el.addEventListener("keyup", () => seq.push("keyup"));

      performPointAction(document, { action: "type-at", x: 1, y: 1, text: "z" });

      expect(seq).toEqual(["keydown", "keypress", "keyup"]);
      expect(kd!.keyCode).toBe(90); // 'z' -> 'Z'
      expect(kd!.code).toBe("KeyZ");
    });
  });

  describe("A5: type-at into contenteditable uses beforeinput/input (insertText)", () => {
    it("fires beforeinput+input carrying inputType insertText and data", () => {
      document.body.innerHTML = `<div contenteditable="true"></div>`;
      const el = document.querySelector("[contenteditable]") as HTMLElement;
      stubPoint(el);
      const bi: Array<{ inputType?: string; data?: string }> = [];
      const inp: Array<{ inputType?: string; data?: string }> = [];
      el.addEventListener("beforeinput", (e) =>
        bi.push(e as unknown as { inputType?: string; data?: string })
      );
      el.addEventListener("input", (e) =>
        inp.push(e as unknown as { inputType?: string; data?: string })
      );

      const res = performPointAction(document, { action: "type-at", x: 1, y: 1, text: "yo" });

      expect(res.ok).toBe(true);
      expect(el.textContent).toBe("yo");
      expect(bi.length).toBe(1);
      expect(bi[0].inputType).toBe("insertText");
      expect(bi[0].data).toBe("yo");
      expect(inp[0].inputType).toBe("insertText");
    });
  });

  describe("A7: hover-at emits pointer events alongside mouse events", () => {
    it("dispatches pointerover/pointerenter/pointermove + mouseover/mouseenter/mousemove", () => {
      document.body.innerHTML = `<div id="menu">Menu</div>`;
      const el = document.getElementById("menu")!;
      stubPoint(el);
      const seen: string[] = [];
      const types = [
        "pointerover",
        "pointerenter",
        "pointermove",
        "mouseover",
        "mouseenter",
        "mousemove",
      ];
      types.forEach((t) => el.addEventListener(t, () => seen.push(t)));

      const res = performPointAction(document, { action: "hover-at", x: 3, y: 4 });

      expect(res.ok).toBe(true);
      types.forEach((t) => expect(seen).toContain(t));
    });
  });

  describe("B10: scrollElementIntoView rejects a recycled uid", () => {
    it("resolves while identity matches, then notFound after the identity changes", () => {
      document.body.innerHTML = `<button aria-label="Save">S</button>`;
      const el = document.querySelector("button")!;
      (el as unknown as { scrollIntoView: () => void }).scrollIntoView = jest.fn();
      buildSnapshot(document, { verbose: false, maxLength: 25000 });
      const uid = el.getAttribute("data-bcmcp-uid")!;
      expect(scrollElementIntoView(document, uid).ok).toBe(true);

      el.setAttribute("aria-label", "Delete");
      const stale = scrollElementIntoView(document, uid);
      expect(stale.ok).toBe(false);
      expect(stale.error).toMatch(/fresh snapshot/);
    });
  });
});
