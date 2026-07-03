import { performPointAction } from "../injected/point-action-script";

// jsdom has no layout: document.elementFromPoint returns null and rects are
// zero. Every test stubs elementFromPoint and never asserts rect values.
describe("performPointAction (chrome)", () => {
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
});
