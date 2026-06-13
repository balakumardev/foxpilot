import { dispatchMouseMoveStep, typeCharStep } from "../injected/humanize-steps";

describe("humanize-steps (injected, jsdom)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("dispatchMouseMoveStep", () => {
    it("dispatches a mousemove carrying the coordinates", () => {
      let seen: MouseEvent | null = null;
      document.addEventListener("mousemove", (e) => (seen = e as MouseEvent), {
        once: true,
      });

      const res = dispatchMouseMoveStep(document, 40, 25);

      expect(res.ok).toBe(true);
      expect(seen).not.toBeNull();
      expect(seen!.clientX).toBe(40);
      expect(seen!.clientY).toBe(25);
    });
  });

  describe("typeCharStep", () => {
    it("appends one char to the focused field and fires keydown/input/keyup", () => {
      document.body.innerHTML = `<input type="text" value="ab" />`;
      const input = document.querySelector("input")!;
      input.focus();
      const events: string[] = [];
      ["keydown", "input", "keyup"].forEach((t) =>
        input.addEventListener(t, () => events.push(t))
      );

      const res = typeCharStep(document, "c");

      expect(res.ok).toBe(true);
      expect(input.value).toBe("abc");
      expect(events).toEqual(expect.arrayContaining(["keydown", "input", "keyup"]));
    });

    it("returns ok:false when no input/textarea is focused", () => {
      document.body.innerHTML = `<div>not a field</div>`;
      const res = typeCharStep(document, "x");
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe("string");
    });
  });
});
