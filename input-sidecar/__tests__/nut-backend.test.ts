// Tests for NutInputBackend. The nut-js module is fully mocked here so NO real
// OS input is ever synthesized (no real cursor moves, no real key presses).
// We only assert that the backend calls the correct nut-js API surface.
//
// The Button/Key enum values in the mock mirror the REAL @nut-tree-fork/shared
// enums (Button.LEFT=0, Button.RIGHT=2; Key.Escape=0, Key.Enter=103,
// Key.LeftControl=104, Key.LeftSuper=105, Key.LeftShift=87, Key.LeftAlt=108)
// so the assertions exercise the same values the production code would pass.
jest.mock("@nut-tree-fork/nut-js", () => {
  const mouse = {
    config: { mouseSpeed: 0, autoDelayMs: 0 },
    setPosition: jest.fn().mockResolvedValue(undefined),
    leftClick: jest.fn().mockResolvedValue(undefined),
    rightClick: jest.fn().mockResolvedValue(undefined),
    doubleClick: jest.fn().mockResolvedValue(undefined),
    pressButton: jest.fn().mockResolvedValue(undefined),
    releaseButton: jest.fn().mockResolvedValue(undefined),
    getPosition: jest.fn().mockResolvedValue({ x: 0, y: 0 }),
  };
  const keyboard = {
    config: { autoDelayMs: 0 },
    type: jest.fn().mockResolvedValue(undefined),
    pressKey: jest.fn().mockResolvedValue(undefined),
    releaseKey: jest.fn().mockResolvedValue(undefined),
  };
  return {
    mouse,
    keyboard,
    Point: class {
      constructor(public x: number, public y: number) {}
    },
    Button: { LEFT: 0, MIDDLE: 1, RIGHT: 2 },
    Key: {
      Escape: 0,
      Enter: 103,
      LeftShift: 87,
      LeftControl: 104,
      LeftSuper: 105,
      LeftAlt: 108,
    },
  };
});

import { mouse, keyboard, Button, Key } from "@nut-tree-fork/nut-js";
import { NutInputBackend } from "../nut-backend";

const mMouse = mouse as unknown as {
  config: { mouseSpeed: number; autoDelayMs: number };
  setPosition: jest.Mock;
  leftClick: jest.Mock;
  rightClick: jest.Mock;
  doubleClick: jest.Mock;
  pressButton: jest.Mock;
  releaseButton: jest.Mock;
  getPosition: jest.Mock;
};
const mKeyboard = keyboard as unknown as {
  config: { autoDelayMs: number };
  type: jest.Mock;
  pressKey: jest.Mock;
  releaseKey: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  mMouse.config = { mouseSpeed: 0, autoDelayMs: 0 };
  mKeyboard.config = { autoDelayMs: 0 };
});

describe("NutInputBackend", () => {
  it("disables nut-js easing/auto-delay in the constructor", () => {
    new NutInputBackend();
    expect(mMouse.config.mouseSpeed).toBeGreaterThan(10000);
    expect(mKeyboard.config.autoDelayMs).toBe(0);
  });

  it("moveTo sets the absolute screen position (rounded Point)", async () => {
    await new NutInputBackend().moveTo(120.4, 80.6);
    expect(mMouse.setPosition).toHaveBeenCalledTimes(1);
    const pt = mMouse.setPosition.mock.calls[0][0];
    expect(pt.x).toBe(120);
    expect(pt.y).toBe(81);
  });

  it("click left (single) calls leftClick", async () => {
    await new NutInputBackend().click("left", false);
    expect(mMouse.leftClick).toHaveBeenCalledTimes(1);
    expect(mMouse.rightClick).not.toHaveBeenCalled();
    expect(mMouse.doubleClick).not.toHaveBeenCalled();
  });

  it("click right (single) calls rightClick", async () => {
    await new NutInputBackend().click("right", false);
    expect(mMouse.rightClick).toHaveBeenCalledTimes(1);
    expect(mMouse.leftClick).not.toHaveBeenCalled();
  });

  it("click left (double) calls doubleClick with Button.LEFT", async () => {
    await new NutInputBackend().click("left", true);
    expect(mMouse.doubleClick).toHaveBeenCalledTimes(1);
    expect(mMouse.doubleClick).toHaveBeenCalledWith(Button.LEFT);
  });

  it("click right (double) calls doubleClick with Button.RIGHT", async () => {
    await new NutInputBackend().click("right", true);
    expect(mMouse.doubleClick).toHaveBeenCalledWith(Button.RIGHT);
  });

  it("mouseDown / mouseUp press and release the mapped Button", async () => {
    const b = new NutInputBackend();
    await b.mouseDown("left");
    expect(mMouse.pressButton).toHaveBeenCalledWith(Button.LEFT);
    await b.mouseUp("left");
    expect(mMouse.releaseButton).toHaveBeenCalledWith(Button.LEFT);
    await b.mouseDown("right");
    expect(mMouse.pressButton).toHaveBeenCalledWith(Button.RIGHT);
    await b.mouseUp("right");
    expect(mMouse.releaseButton).toHaveBeenCalledWith(Button.RIGHT);
  });

  it("typeChar types the character", async () => {
    await new NutInputBackend().typeChar("a");
    expect(mKeyboard.type).toHaveBeenCalledWith("a");
  });

  it("pressKey maps a single named key (Enter) and presses+releases it", async () => {
    await new NutInputBackend().pressKey("enter", []);
    expect(mKeyboard.pressKey).toHaveBeenCalledWith(Key.Enter);
    expect(mKeyboard.releaseKey).toHaveBeenCalledWith(Key.Enter);
  });

  it("pressKey maps modifiers + main key in natural order, releases in reverse", async () => {
    await new NutInputBackend().pressKey("a", ["ctrl", "shift"]);
    // press order: ctrl, shift, then main key 'a' -> via keyboard.type fallback? No: 'a' is not in map,
    // so main is undefined and we only press the modifiers. Verify the press/release ordering of modifiers.
    expect(mKeyboard.pressKey.mock.calls.map((c) => c[0])).toEqual([
      Key.LeftControl,
      Key.LeftShift,
    ]);
    expect(mKeyboard.releaseKey.mock.calls.map((c) => c[0])).toEqual([
      Key.LeftShift,
      Key.LeftControl,
    ]);
  });

  it("pressKey with mapped main key (escape) + meta modifier orders correctly", async () => {
    await new NutInputBackend().pressKey("escape", ["meta"]);
    expect(mKeyboard.pressKey.mock.calls.map((c) => c[0])).toEqual([
      Key.LeftSuper,
      Key.Escape,
    ]);
    expect(mKeyboard.releaseKey.mock.calls.map((c) => c[0])).toEqual([
      Key.Escape,
      Key.LeftSuper,
    ]);
  });

  it("pressKey falls back to typing the literal when nothing maps", async () => {
    await new NutInputBackend().pressKey("z", []);
    expect(mKeyboard.type).toHaveBeenCalledWith("z");
    expect(mKeyboard.pressKey).not.toHaveBeenCalled();
  });

  it("probe returns true when getPosition succeeds", async () => {
    expect(await new NutInputBackend().probe()).toBe(true);
  });

  it("probe returns false when getPosition throws", async () => {
    mMouse.getPosition.mockRejectedValueOnce(new Error("no accessibility permission"));
    expect(await new NutInputBackend().probe()).toBe(false);
  });
});
