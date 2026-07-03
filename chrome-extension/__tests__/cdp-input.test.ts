import { cdpInputClick } from "../cdp-input";
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
