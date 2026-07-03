/**
 * Chrome/Edge-only TRUSTED coordinate input via chrome.debugger (CDP). Backs the
 * engine:"cdp" tier of the -at tools: it dispatches Input.* events at viewport
 * CSS-pixel {x,y}, which the renderer delivers as isTrusted:true (so strict
 * rich-text editors that ignore synthetic events accept them). It does NOT move
 * the OS cursor and needs no sidecar — its only cost is the "started debugging
 * this browser" banner (documented, opt-in). The debugger attach is REFCOUNTED
 * under the "input" purpose (see network-capture.ts) so it coexists with
 * response-body capture on the same tab: each call attaches "input", dispatches,
 * and releases "input" in a finally.
 *
 * Coordinates are native viewport CSS px — no screen mapping, no DPR multiply.
 * Firefox has no CDP; the Firefox message handler rejects engine:"cdp" before
 * reaching this module (this file is imported ONLY by the Chrome extension).
 */
import { attachDebugger, detachDebugger } from "./network-capture";

type MouseButton = "left" | "middle" | "right";

// Attach the "input" purpose, run the dispatch, and ALWAYS release it. Attach is
// outside the try so a failed attach (DevTools already open) does not trigger a
// spurious detach — nothing was attached.
async function withInputAttach(
  tabId: number,
  fn: (dbg: any) => Promise<void>
): Promise<void> {
  const dbg = (chrome as any).debugger;
  await attachDebugger(tabId, "input");
  try {
    await fn(dbg);
  } finally {
    await detachDebugger(tabId, "input");
  }
}

export async function cdpInputClick(
  tabId: number,
  x: number,
  y: number,
  button: MouseButton,
  doubleClick: boolean
): Promise<void> {
  await withInputAttach(tabId, async (dbg) => {
    // First (and, for a single click, only) trusted press/release pair.
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount: 1,
    });
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount: 1,
    });
    if (doubleClick) {
      // A trusted dblclick is a second pair with clickCount:2 (Chrome then
      // synthesizes the dblclick event itself).
      await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        clickCount: 2,
      });
      await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        clickCount: 2,
      });
    }
  });
}
