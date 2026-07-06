/**
 * Chrome/Edge-only CSP-immune eval via chrome.debugger (CDP). Backs
 * evaluate-script engine:"cdp": Runtime.evaluate runs arbitrary source in the
 * page's real world through the debugger protocol, which is NOT subject to the
 * page's script-src CSP (the same reason the DevTools console can eval on a
 * strict-CSP page). Its only cost is the "started debugging this browser"
 * banner (documented, opt-in) — same tradeoff as capture-response-bodies and the
 * -at tools' engine:"cdp". The attach is REFCOUNTED under the "eval" purpose so
 * it coexists with input/network debugger holders on the same tab; each call
 * attaches "eval", evaluates, and releases "eval" in a finally.
 *
 * Firefox has no chrome.debugger; the Firefox message handler rejects
 * engine:"cdp" before reaching here (this file is imported ONLY by the Chrome
 * extension).
 */
import { attachDebugger, detachDebugger } from "./network-capture";

export async function cdpEval(
  tabId: number,
  functionSource: string,
  args: unknown[]
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const dbg = (chrome as any).debugger;
  // Build "(<fn>)(<arg0>, <arg1>, ...)". args are JSON-encoded; functionSource
  // is a function-expression string by the tool's contract.
  const argList = (args || []).map((a) => JSON.stringify(a)).join(",");
  const expression = "(" + functionSource + ")(" + argList + ")";
  await attachDebugger(tabId, "eval");
  try {
    const res = await dbg.sendCommand({ tabId }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res && res.exceptionDetails) {
      const ex = res.exceptionDetails;
      const msg =
        (ex.exception && (ex.exception.description || ex.exception.value)) ||
        ex.text ||
        "Runtime.evaluate threw";
      return { ok: false, error: String(msg) };
    }
    const value = res && res.result ? res.result.value : undefined;
    return { ok: true, value: value === undefined ? null : value };
  } catch (err) {
    return { ok: false, error: String((err as { message?: unknown })?.message ?? err) };
  } finally {
    await detachDebugger(tabId, "eval");
  }
}
