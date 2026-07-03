import { performPointAction } from "../injected/point-action-script";

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
});
