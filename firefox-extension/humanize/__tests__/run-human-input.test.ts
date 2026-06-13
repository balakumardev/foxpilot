import { runHumanInput, HumanInputDeps } from "../run-human-input";
import { makeRng } from "../motion-model";

function makeDeps(over: Partial<HumanInputDeps> = {}): HumanInputDeps {
  return {
    rng: makeRng(99),
    sleep: jest.fn().mockResolvedValue(undefined),
    getCursor: jest.fn().mockReturnValue({ x: 0, y: 0 }),
    setCursor: jest.fn(),
    readTargetInfo: jest
      .fn()
      .mockResolvedValue({ x: 10, y: 10, width: 40, height: 20, dpr: 1 }),
    mouseMove: jest.fn().mockResolvedValue(undefined),
    typeChar: jest.fn().mockResolvedValue({ ok: true }),
    instant: jest.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
}

describe("runHumanInput", () => {
  it("click: moves the cursor first, then performs the instant click", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      mouseMove: jest.fn(async () => {
        calls.push("move");
      }),
      instant: jest.fn(async (a) => {
        calls.push("instant:" + a.action);
        return { ok: true };
      }),
    });

    const res = await runHumanInput({ action: "click", uid: "e1" }, deps);

    expect(res.ok).toBe(true);
    expect(calls[calls.length - 1]).toBe("instant:click");
    expect(calls.filter((c) => c === "move").length).toBeGreaterThan(0);
    expect(deps.instant).toHaveBeenCalledWith({ action: "click", uid: "e1" });
    expect(deps.setCursor).toHaveBeenCalled();
  });

  it("click: a missing uid skips movement and defers to instant for the error", async () => {
    const deps = makeDeps({
      readTargetInfo: jest.fn().mockResolvedValue(null),
      instant: jest.fn().mockResolvedValue({ ok: false, error: "fresh snapshot" }),
    });

    const res = await runHumanInput({ action: "click", uid: "gone" }, deps);

    expect(deps.mouseMove).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("fresh snapshot");
  });

  it("type: types each char with cadence and never calls instant on success", async () => {
    const typed: string[] = [];
    const deps = makeDeps({
      typeChar: jest.fn(async (c: string) => {
        typed.push(c);
        return { ok: true };
      }),
    });

    const res = await runHumanInput({ action: "type", text: "hi" }, deps);

    expect(res.ok).toBe(true);
    expect(typed).toEqual(["h", "i"]);
    expect(deps.instant).not.toHaveBeenCalled();
  });

  it("type: on a mid-way step failure, finishes the REMAINING text via instant (no duplication)", async () => {
    let n = 0;
    const deps = makeDeps({
      typeChar: jest.fn(async () => {
        n += 1;
        return n === 1 ? { ok: true } : { ok: false, error: "boom" };
      }),
    });

    const res = await runHumanInput({ action: "type", text: "hello" }, deps);

    expect(res.ok).toBe(true);
    expect(deps.instant).toHaveBeenCalledWith({
      action: "type",
      text: "ello",
      submit: undefined,
    });
  });

  it("fill: moves the cursor then performs the instant fill (value landed by instant)", async () => {
    const deps = makeDeps();
    const res = await runHumanInput(
      { action: "fill", uid: "e1", value: "x@y.com" },
      deps
    );
    expect(res.ok).toBe(true);
    expect(deps.instant).toHaveBeenCalledWith({
      action: "fill",
      uid: "e1",
      value: "x@y.com",
    });
  });

  it("press-key: waits then defers to instant", async () => {
    const deps = makeDeps();
    const res = await runHumanInput(
      { action: "press-key", key: "Enter" },
      deps
    );
    expect(res.ok).toBe(true);
    expect(deps.sleep).toHaveBeenCalled();
    expect(deps.instant).toHaveBeenCalledWith({
      action: "press-key",
      key: "Enter",
    });
  });
});
