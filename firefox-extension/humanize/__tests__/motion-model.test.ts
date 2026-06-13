import { makeRng, mousePath, typingPlan, Point } from "../motion-model";

describe("motion-model", () => {
  describe("makeRng", () => {
    it("is deterministic for a given seed and in [0,1)", () => {
      const a = makeRng(42);
      const b = makeRng(42);
      const seqA = [a(), a(), a()];
      const seqB = [b(), b(), b()];
      expect(seqA).toEqual(seqB);
      seqA.forEach((n) => {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThan(1);
      });
    });
  });

  describe("mousePath", () => {
    const from: Point = { x: 0, y: 0 };
    const to: Point = { x: 300, y: 120 };

    it("starts moving toward and ends exactly on the target", () => {
      const steps = mousePath(from, to, makeRng(1));
      expect(steps.length).toBeGreaterThanOrEqual(8);
      const last = steps[steps.length - 1];
      expect(last.x).toBe(300);
      expect(last.y).toBe(120);
    });

    it("emits positive delays and more steps for longer distances", () => {
      const near = mousePath(from, { x: 20, y: 10 }, makeRng(2));
      const far = mousePath(from, { x: 900, y: 400 }, makeRng(2));
      expect(far.length).toBeGreaterThan(near.length);
      [...near, ...far].forEach((s) => expect(s.delayMs).toBeGreaterThan(0));
    });

    it("is deterministic for a given seed", () => {
      expect(mousePath(from, to, makeRng(7))).toEqual(
        mousePath(from, to, makeRng(7))
      );
    });
  });

  describe("typingPlan", () => {
    it("produces one step per character with positive delays", () => {
      const plan = typingPlan("abc", makeRng(3));
      expect(plan.map((k) => k.char)).toEqual(["a", "b", "c"]);
      plan.forEach((k) => expect(k.delayMs).toBeGreaterThan(0));
    });

    it("pauses longer after a space than after a normal letter", () => {
      const space = typingPlan(" ", makeRng(5))[0].delayMs;
      const letter = typingPlan("x", makeRng(5))[0].delayMs;
      expect(space).toBeGreaterThan(letter);
    });
  });
});
