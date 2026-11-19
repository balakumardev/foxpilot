/**
 * evaluate-script in the page's REAL (main) world, Chrome/Edge.
 *
 * `chrome.scripting.executeScript({ world: "MAIN", func, args })` runs `func`
 * directly in the page's JS world, so it sees the page's globals and frameworks
 * and a returned Promise is awaited. The function compiles the caller's source
 * with indirect eval, which is governed by the PAGE's Content-Security-Policy:
 * it works on a page with no CSP and on one whose `script-src` allows
 * 'unsafe-eval', and it throws an EvalError on a page whose `script-src` does not
 * (e.g. `script-src 'self'`). Measured on Chromium 140 (see
 * test-fixtures/browser-probe/OBSERVED.json, cases 3 and 5).
 *
 * This replaces the old route (the content script appended an inline <script> to
 * the page). A <script> element created from the extension's isolated world is
 * governed by the EXTENSION's own CSP in Chromium 140, so that route was refused
 * on every page, even one with no CSP at all, and its message blamed the wrong
 * party.
 *
 * Two parts:
 *   - `mainWorldEval` is stringified by Chrome and runs in the page. It MUST be
 *     fully self-contained: no module-level references, no helpers, no
 *     transpiler wrappers. It returns a plain, structured-cloneable object (the
 *     value is JSON-serialized inside it, so what the server receives is what
 *     the old inline-script path produced).
 *   - `runMainWorldEval` runs in the service worker: it injects, races the
 *     injection against a timeout paced from the worker (a Promise that never
 *     settles would otherwise hang `executeScript` for good), and turns
 *     `cspBlocked` into the agent-facing message.
 */

/** What `mainWorldEval` returns to the service worker. */
export interface MainWorldEvalResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  /** The page's CSP refused eval (set only when compiling the source failed that way). */
  cspBlocked?: boolean;
}

/**
 * Runs in the page's main world. Semantics are those of the old page script:
 * the source is a function EXPRESSION (compiled as `(<source>)`) called with
 * `args`; a returned thenable is awaited; `undefined` becomes `null`; the value is
 * JSON round-tripped, falling back to `String(value)` when it is not JSON-safe; a
 * throw becomes `{ ok:false, error:String(err && err.message || err) }`.
 *
 * Two separate try blocks on purpose: only a failure to COMPILE the source can be
 * the CSP gate. An error thrown by the caller's own function is a plain failure.
 *
 * No async/await and no spread: it must stringify to the same plain source under
 * ts-jest and esbuild.
 */
export function mainWorldEval(
  source: string,
  args: unknown[]
): Promise<MainWorldEvalResult> {
  function messageOf(err: any): string {
    try {
      return String((err && err.message) || err);
    } catch (e) {
      return "unknown error";
    }
  }
  function failure(err: any): MainWorldEvalResult {
    return { ok: false, error: messageOf(err) };
  }
  function success(result: any): MainWorldEvalResult {
    try {
      if (result === undefined) return { ok: true, value: null };
      let out: unknown;
      try {
        out = JSON.parse(JSON.stringify(result));
      } catch (e) {
        out = String(result);
      }
      return { ok: true, value: out };
    } catch (e) {
      return failure(e);
    }
  }

  let callable: any;
  try {
    callable = (0, eval)("(" + source + ")");
  } catch (err: any) {
    const message = messageOf(err);
    if (
      (typeof EvalError !== "undefined" && err instanceof EvalError) ||
      /unsafe-eval/i.test(message)
    ) {
      return Promise.resolve({ ok: false, error: message, cspBlocked: true });
    }
    return Promise.resolve({ ok: false, error: message });
  }

  try {
    const result = callable.apply(null, args);
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).then(success, failure);
    }
    return Promise.resolve(success(result));
  } catch (err: any) {
    return Promise.resolve(failure(err));
  }
}

/** Reported when the function does not settle inside the budget (same text the old path used). */
export const MAIN_WORLD_EVAL_TIMEOUT_MESSAGE =
  "Timed out waiting for the script result (the function may be hanging or awaiting a promise that never resolves).";

/** Reported when the injection answers with nothing usable. */
export const MAIN_WORLD_EVAL_NO_RESULT_MESSAGE = "evaluation produced no result.";

/**
 * What the agent reads when the page's CSP refused eval. It names the real cause
 * (the PAGE's script-src), says what still works, and offers the debugger only as
 * the last resort. `browserMessage` is the browser's own refusal text, kept so the
 * agent can see which directive said no.
 */
export function cspBlockedEvalMessage(browserMessage?: string): string {
  const said = (browserMessage || "").trim().slice(0, 300);
  return (
    "The page's Content-Security-Policy forbids eval (its script-src has no 'unsafe-eval'), " +
    "so page-world script cannot run through the normal route on this page" +
    (said ? ` (the browser said: ${said})` : "") +
    ". Reading state still works: use take-snapshot, get-tab-web-content, get-network-requests, " +
    "get-cookies or the coordinate tools. Only as a last resort, engine:\"cdp\" runs it through " +
    "the debugger (Chrome/Edge): that shows the \"FoxPilot started debugging this browser\" bar " +
    "and the page can detect it."
  );
}

/**
 * Service-worker side: inject `mainWorldEval` into the tab's main world and wait
 * for it, at most `timeoutMs`. Errors from `executeScript` itself (no host access,
 * a discarded or closed tab, a navigation that tears the frame down) propagate to
 * the caller untouched; only the function's own outcome becomes an `ok:false`.
 *
 * The timer is cleared in `finally` and the abandoned injection gets a no-op
 * catch, so neither a late rejection nor a pending timer outlives the call.
 */
export async function runMainWorldEval(
  tabId: number,
  functionSource: string,
  args: unknown[],
  timeoutMs: number
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const injection = (chrome as any).scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: mainWorldEval,
    args: [functionSource, args],
  }) as Promise<Array<{ result?: unknown }> | undefined>;
  injection.catch(() => {});
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const raced = await Promise.race([injection, timeout]);
    if (raced === "timeout") {
      return { ok: false, error: MAIN_WORLD_EVAL_TIMEOUT_MESSAGE };
    }
    const outcome = raced && raced[0] ? (raced[0].result as MainWorldEvalResult | undefined) : undefined;
    if (!outcome || typeof outcome !== "object") {
      return { ok: false, error: MAIN_WORLD_EVAL_NO_RESULT_MESSAGE };
    }
    if (outcome.cspBlocked) {
      return { ok: false, error: cspBlockedEvalMessage(outcome.error) };
    }
    return { ok: !!outcome.ok, value: outcome.value, error: outcome.error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
