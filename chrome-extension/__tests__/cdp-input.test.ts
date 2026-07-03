import { cdpInputClick, cdpInputType } from "../cdp-input";
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

  it("attaches 'input', dispatches a trusted press/release pair, and detaches", async () => {
    await cdpInputClick(3, 100, 200, "left", false);
    expect(dbg.attach).toHaveBeenCalledWith({ tabId: 3 }, "1.3");
    const mouse = (dbg.sendCommand as jest.Mock).mock.calls.filter(
      (c: any[]) => c[1] === "Input.dispatchMouseEvent"
    );
    expect(mouse).toHaveLength(2);
    expect(mouse[0][2]).toMatchObject({
      type: "mousePressed",
      x: 100,
      y: 200,
      button: "left",
      clickCount: 1,
    });
    expect(mouse[1][2]).toMatchObject({
      type: "mouseReleased",
      x: 100,
      y: 200,
      button: "left",
      clickCount: 1,
    });
    // input-only attach never enables the Network domain.
    expect(dbg.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 3 },
      "Network.enable"
    );
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 3 });
  });

  it("emits a second clickCount:2 pair for a double-click", async () => {
    await cdpInputClick(3, 5, 6, "left", true);
    const mouse = (dbg.sendCommand as jest.Mock).mock.calls.filter(
      (c: any[]) => c[1] === "Input.dispatchMouseEvent"
    );
    expect(mouse).toHaveLength(4);
    expect(mouse[3][2]).toMatchObject({ type: "mouseReleased", clickCount: 2 });
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
    // A single trusted press/release pair establishes focus + caret.
    expect(mouse).toHaveLength(2);
    expect(mouse[0][2]).toMatchObject({ type: "mousePressed", x: 40, y: 50, button: "left", clickCount: 1 });
    expect(mouse[1][2]).toMatchObject({ type: "mouseReleased", x: 40, y: 50, button: "left", clickCount: 1 });
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
    expect(calls.filter((c: any[]) => c[1] === "Input.dispatchMouseEvent")).toHaveLength(2);
    expect(calls.some((c: any[]) => c[1] === "Input.insertText")).toBe(false);
  });
});
