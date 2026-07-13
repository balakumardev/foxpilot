import {
  cdpInputClick,
  cdpInputType,
  cdpInputHover,
  cdpInputScroll,
  cdpInputFill,
  cdpInputKey,
} from "../cdp-input";
import {
  attachDebugger,
  detachDebugger,
  isDebuggerAttached,
} from "../network-capture";

// Uses the chrome.debugger mock from __tests__/setup.ts. Asserts the trusted
// Input.* sendCommand sequence AND that the refcounted "input" purpose attaches
// and releases around each call (coexisting with a simulated "network" hold).
describe("cdpInputClick (Phase 3)", () => {
  let dbg: any;

  beforeEach(() => {
    dbg = (chrome as any).debugger;
    dbg.attach.mockReset().mockResolvedValue(undefined);
    dbg.detach.mockReset().mockResolvedValue(undefined);
    dbg.sendCommand.mockReset().mockResolvedValue({});
  });

  afterEach(async () => {
    const { forceDetachDebugger } = require("../network-capture");
    await forceDetachDebugger(3);
    await forceDetachDebugger(4);
  });

  it("moves to the point (C17), dispatches a trusted press/release pair with the buttons bitmask, and detaches", async () => {
    await cdpInputClick(3, 100, 200, "left", false);
    expect(dbg.attach).toHaveBeenCalledWith({ tabId: 3 }, "1.3");
    const mouse = (dbg.sendCommand as jest.Mock).mock.calls.filter(
      (c: any[]) => c[1] === "Input.dispatchMouseEvent"
    );
    // C17: a mouseMoved precedes the press/release pair (sets hover/hit-target).
    expect(mouse).toHaveLength(3);
    expect(mouse[0][2]).toMatchObject({ type: "mouseMoved", x: 100, y: 200 });
    expect(mouse[1][2]).toMatchObject({
      type: "mousePressed",
      x: 100,
      y: 200,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    expect(mouse[2][2]).toMatchObject({
      type: "mouseReleased",
      x: 100,
      y: 200,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    // input-only attach never enables the Network domain.
    expect(dbg.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 3 },
      "Network.enable"
    );
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 3 });
  });

  it("emits a second clickCount:2 pair for a double-click (after one leading mouseMoved)", async () => {
    await cdpInputClick(3, 5, 6, "left", true);
    const mouse = (dbg.sendCommand as jest.Mock).mock.calls.filter(
      (c: any[]) => c[1] === "Input.dispatchMouseEvent"
    );
    // mouseMoved + (press,release)×1 + (press,release for the dblclick) = 5.
    expect(mouse).toHaveLength(5);
    expect(mouse[0][2]).toMatchObject({ type: "mouseMoved" });
    expect(mouse[4][2]).toMatchObject({
      type: "mouseReleased",
      buttons: 0,
      clickCount: 2,
    });
  });

  it("does NOT detach when a network capture is already holding the tab", async () => {
    await attachDebugger(4, "network"); // simulate capture-response-bodies
    dbg.detach.mockClear();
    await cdpInputClick(4, 1, 2, "left", false);
    expect(dbg.detach).not.toHaveBeenCalled(); // network purpose still holds it
    expect(isDebuggerAttached(4)).toBe(true);
  });
});

describe("cdpInputType (Phase 3)", () => {
  let dbg: any;
  beforeEach(() => {
    dbg = (chrome as any).debugger;
    dbg.attach.mockReset().mockResolvedValue(undefined);
    dbg.detach.mockReset().mockResolvedValue(undefined);
    dbg.sendCommand.mockReset().mockResolvedValue({});
  });
  afterEach(async () => {
    const { forceDetachDebugger } = require("../network-capture");
    await forceDetachDebugger(3);
  });

  it("focus-clicks at {x,y}, then inserts text (no Enter without submit)", async () => {
    await cdpInputType(3, 40, 50, "hello", false);
    const calls = (dbg.sendCommand as jest.Mock).mock.calls;
    const mouse = calls.filter((c: any[]) => c[1] === "Input.dispatchMouseEvent");
    // C17: mouseMoved + a trusted press/release pair establishes focus + caret.
    expect(mouse).toHaveLength(3);
    expect(mouse[0][2]).toMatchObject({ type: "mouseMoved", x: 40, y: 50 });
    expect(mouse[1][2]).toMatchObject({ type: "mousePressed", x: 40, y: 50, button: "left", buttons: 1, clickCount: 1 });
    expect(mouse[2][2]).toMatchObject({ type: "mouseReleased", x: 40, y: 50, button: "left", buttons: 0, clickCount: 1 });
    const insert = calls.filter((c: any[]) => c[1] === "Input.insertText");
    expect(insert).toHaveLength(1);
    expect(insert[0][2]).toEqual({ text: "hello" });
    expect(calls.some((c: any[]) => c[1] === "Input.dispatchKeyEvent")).toBe(false);
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 3 });
  });

  it("appends a trusted Enter key pair when submit is true", async () => {
    await cdpInputType(3, 1, 2, "hi", true);
    const keys = (dbg.sendCommand as jest.Mock).mock.calls.filter(
      (c: any[]) => c[1] === "Input.dispatchKeyEvent"
    );
    expect(keys).toHaveLength(2);
    expect(keys[0][2]).toMatchObject({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    expect(keys[1][2]).toMatchObject({ type: "keyUp", key: "Enter" });
  });

  it("skips insertText for empty text but still focus-clicks", async () => {
    await cdpInputType(3, 5, 6, "", false);
    const calls = (dbg.sendCommand as jest.Mock).mock.calls;
    // C17: mouseMoved + press + release = 3 mouse events; still no insertText.
    expect(calls.filter((c: any[]) => c[1] === "Input.dispatchMouseEvent")).toHaveLength(3);
    expect(calls.some((c: any[]) => c[1] === "Input.insertText")).toBe(false);
  });
});

describe("cdpInputHover + cdpInputScroll (Phase 3)", () => {
  let dbg: any;
  beforeEach(() => {
    dbg = (chrome as any).debugger;
    dbg.attach.mockReset().mockResolvedValue(undefined);
    dbg.detach.mockReset().mockResolvedValue(undefined);
    dbg.sendCommand.mockReset().mockResolvedValue({});
  });
  afterEach(async () => {
    const { forceDetachDebugger } = require("../network-capture");
    await forceDetachDebugger(3);
  });

  it("cdpInputHover dispatches a single trusted mouseMoved at {x,y}", async () => {
    await cdpInputHover(3, 12, 34);
    const moves = (dbg.sendCommand as jest.Mock).mock.calls.filter(
      (c: any[]) => c[1] === "Input.dispatchMouseEvent"
    );
    expect(moves).toHaveLength(1);
    expect(moves[0][2]).toMatchObject({ type: "mouseMoved", x: 12, y: 34 });
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 3 });
  });

  it("cdpInputScroll dispatches a trusted mouseWheel with the given deltas", async () => {
    await cdpInputScroll(3, 10, 20, 5, 250);
    const wheel = (dbg.sendCommand as jest.Mock).mock.calls.filter(
      (c: any[]) => c[1] === "Input.dispatchMouseEvent"
    );
    expect(wheel[0][2]).toMatchObject({ type: "mouseWheel", x: 10, y: 20, deltaX: 5, deltaY: 250 });
  });

  it("cdpInputScroll defaults an omitted deltaY to a one-page step (600) and deltaX to 0", async () => {
    await cdpInputScroll(3, 10, 20);
    const wheel = (dbg.sendCommand as jest.Mock).mock.calls.find(
      (c: any[]) => c[1] === "Input.dispatchMouseEvent"
    );
    expect(wheel[2]).toMatchObject({ type: "mouseWheel", deltaX: 0, deltaY: 600 });
  });
});

describe("cdpInputFill (Wave 2 C15)", () => {
  let dbg: any;
  beforeEach(() => {
    dbg = (chrome as any).debugger;
    dbg.attach.mockReset().mockResolvedValue(undefined);
    dbg.detach.mockReset().mockResolvedValue(undefined);
    dbg.sendCommand.mockReset().mockResolvedValue({});
  });
  afterEach(async () => {
    const { forceDetachDebugger } = require("../network-capture");
    await forceDetachDebugger(3);
  });

  it("focus-clicks, select-alls (KeyA), then insertText REPLACES the value — in that order", async () => {
    await cdpInputFill(3, 40, 50, "new value");
    const calls = (dbg.sendCommand as jest.Mock).mock.calls;
    // Ordered sequence: mouseMoved, mousePressed, mouseReleased, keyDown(A),
    // keyUp(A), insertText.
    const seq = calls.map((c: any[]) => ({ method: c[1], ...c[2] }));
    const idxMoved = seq.findIndex((s: any) => s.method === "Input.dispatchMouseEvent" && s.type === "mouseMoved");
    const idxPressed = seq.findIndex((s: any) => s.method === "Input.dispatchMouseEvent" && s.type === "mousePressed");
    const idxReleased = seq.findIndex((s: any) => s.method === "Input.dispatchMouseEvent" && s.type === "mouseReleased");
    const idxSelDown = seq.findIndex((s: any) => s.method === "Input.dispatchKeyEvent" && s.type === "keyDown" && s.code === "KeyA");
    const idxSelUp = seq.findIndex((s: any) => s.method === "Input.dispatchKeyEvent" && s.type === "keyUp" && s.code === "KeyA");
    const idxInsert = seq.findIndex((s: any) => s.method === "Input.insertText");
    expect(idxMoved).toBeGreaterThanOrEqual(0);
    expect(idxMoved).toBeLessThan(idxPressed);
    expect(idxPressed).toBeLessThan(idxReleased);
    expect(idxReleased).toBeLessThan(idxSelDown);
    expect(idxSelDown).toBeLessThan(idxSelUp);
    expect(idxSelUp).toBeLessThan(idxInsert);
    // The select-all key event carries the KeyA virtual keycode and a
    // command modifier (Ctrl=2 on non-mac, Meta=4 on mac).
    expect(seq[idxSelDown]).toMatchObject({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    expect([2, 4]).toContain(seq[idxSelDown].modifiers);
    expect(seq[idxInsert]).toMatchObject({ text: "new value" });
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 3 });
  });

  it("still select-alls + insertText('') for an empty value (clears the field)", async () => {
    await cdpInputFill(3, 5, 6, "");
    const calls = (dbg.sendCommand as jest.Mock).mock.calls;
    const selectAll = calls.find(
      (c: any[]) => c[1] === "Input.dispatchKeyEvent" && c[2].code === "KeyA" && c[2].type === "keyDown"
    );
    expect(selectAll).toBeDefined();
    const insert = calls.find((c: any[]) => c[1] === "Input.insertText");
    expect(insert[2]).toEqual({ text: "" });
  });
});

describe("cdpInputKey (Wave 2 C15)", () => {
  let dbg: any;
  beforeEach(() => {
    dbg = (chrome as any).debugger;
    dbg.attach.mockReset().mockResolvedValue(undefined);
    dbg.detach.mockReset().mockResolvedValue(undefined);
    dbg.sendCommand.mockReset().mockResolvedValue({});
  });
  afterEach(async () => {
    const { forceDetachDebugger } = require("../network-capture");
    await forceDetachDebugger(3);
  });

  const keyEvents = () =>
    (dbg.sendCommand as jest.Mock).mock.calls.filter(
      (c: any[]) => c[1] === "Input.dispatchKeyEvent"
    );

  it("maps a named key (Enter) to code/windowsVirtualKeyCode 13 with text, as a keyDown/keyUp pair", async () => {
    await cdpInputKey(3, "Enter");
    const keys = keyEvents();
    expect(keys).toHaveLength(2);
    expect(keys[0][2]).toMatchObject({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    expect(keys[1][2]).toMatchObject({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    // keyUp does not carry text.
    expect(keys[1][2].text).toBeUndefined();
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 3 });
  });

  it("maps arrow/navigation keys to their windows virtual-key codes with NO text", async () => {
    const cases: Array<[string, string, number]> = [
      ["ArrowLeft", "ArrowLeft", 37],
      ["ArrowUp", "ArrowUp", 38],
      ["ArrowRight", "ArrowRight", 39],
      ["ArrowDown", "ArrowDown", 40],
      ["Home", "Home", 36],
      ["End", "End", 35],
      ["PageUp", "PageUp", 33],
      ["PageDown", "PageDown", 34],
      ["Escape", "Escape", 27],
      ["Backspace", "Backspace", 8],
      ["Delete", "Delete", 46],
      ["Tab", "Tab", 9],
    ];
    for (const [key, code, keyCode] of cases) {
      dbg.sendCommand.mockClear();
      await cdpInputKey(3, key);
      const down = keyEvents().find((c: any[]) => c[2].type === "keyDown");
      expect(down[2]).toMatchObject({ key, code, windowsVirtualKeyCode: keyCode });
      // Non-character keys carry no text (Tab is the exception — it inserts \t).
      if (key !== "Tab") {
        expect(down[2].text).toBeUndefined();
      } else {
        expect(down[2].text).toBe("\t");
      }
    }
  });

  it("maps a printable letter to Key<X> + uppercased char code and carries text", async () => {
    await cdpInputKey(3, "a");
    const down = keyEvents().find((c: any[]) => c[2].type === "keyDown");
    expect(down[2]).toMatchObject({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" });
  });

  it("maps a printable digit to Digit<N>", async () => {
    await cdpInputKey(3, "7");
    const down = keyEvents().find((c: any[]) => c[2].type === "keyDown");
    expect(down[2]).toMatchObject({ key: "7", code: "Digit7", windowsVirtualKeyCode: 55, text: "7" });
  });

  it("builds the CDP modifier bitmask (Ctrl=2) and SUPPRESSES text for a shortcut (Ctrl+A)", async () => {
    await cdpInputKey(3, "a", ["ctrl"]);
    const down = keyEvents().find((c: any[]) => c[2].type === "keyDown");
    expect(down[2].modifiers).toBe(2);
    // A command modifier means a shortcut — text must not be inserted.
    expect(down[2].text).toBeUndefined();
  });

  it("combines modifiers into the bitmask (ctrl+shift = 2|8 = 10)", async () => {
    await cdpInputKey(3, "ArrowRight", ["ctrl", "shift"]);
    const down = keyEvents().find((c: any[]) => c[2].type === "keyDown");
    expect(down[2].modifiers).toBe(10);
  });
});
