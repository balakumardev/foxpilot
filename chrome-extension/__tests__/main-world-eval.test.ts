/**
 * mainWorldEval / runMainWorldEval (main-world-eval.ts).
 *
 * What this does NOT prove: that Chrome really hands `func` to the page's main
 * world, or what a real page's CSP does. jsdom has no CSP, so the page gate is
 * simulated by replacing the global `eval` with one that throws an EvalError, the
 * shape Chromium 140 produced for a page with `script-src 'self'`
 * (test-fixtures/browser-probe/OBSERVED.json, case 3). The live-browser proof is
 * that probe, not this file.
 */
import { serialize, deserialize } from "v8";
import {
  mainWorldEval,
  runMainWorldEval,
  cspBlockedEvalMessage,
  MAIN_WORLD_EVAL_TIMEOUT_MESSAGE,
  MAIN_WORLD_EVAL_NO_RESULT_MESSAGE,
} from "../main-world-eval";

// The exact refusal text Chromium 140 gave (case 3, "self"): ends with a period
// and a newline.
const CSP_REFUSAL =
  "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\".\n";

describe("mainWorldEval is safe to stringify-and-inject", () => {
  const src = mainWorldEval.toString();

  it("references no module system, bundler helper or transpiler async/spread helper", () => {
    for (const token of [
      "require(",
      "import ",
      "exports.",
      "module.exports",
      "__name",
      "__commonJS",
      "__toESM",
      "__require",
      "__awaiter",
      "__generator",
      "__async",
      "__spreadArray",
      "regeneratorRuntime",
    ]) {
      expect(src).not.toContain(token);
    }
  });

  it("stringifies to a real function body and still works when rebuilt from that text alone", async () => {
    expect(src).toMatch(/^function\s+mainWorldEval\s*\(/);
    // Rebuild it the way Chrome does: from the source text only, with no access
    // to this module's scope. A leaked free variable would throw here.
    const rebuilt = new Function("return (" + src + ")")() as typeof mainWorldEval;
    await expect(rebuilt("(a, b) => a * b", [6, 7])).resolves.toEqual({
      ok: true,
      value: 42,
    });
  });
});

describe("mainWorldEval semantics (the old page script's, unchanged)", () => {
  it("calls an arrow function with the args", async () => {
    await expect(mainWorldEval("(sel) => sel + '!'", ["x"])).resolves.toEqual({
      ok: true,
      value: "x!",
    });
  });

  it("accepts a function expression string", async () => {
    await expect(
      mainWorldEval("function (n) { return n + 1; }", [1])
    ).resolves.toEqual({ ok: true, value: 2 });
  });

  it("awaits an async function", async () => {
    await expect(
      mainWorldEval("async () => { await null; return { n: 3 }; }", [])
    ).resolves.toEqual({ ok: true, value: { n: 3 } });
  });

  it("awaits a returned promise", async () => {
    await expect(
      mainWorldEval("() => Promise.resolve([1, 2])", [])
    ).resolves.toEqual({ ok: true, value: [1, 2] });
  });

  it("maps undefined to null (not the string 'undefined')", async () => {
    await expect(mainWorldEval("() => undefined", [])).resolves.toEqual({
      ok: true,
      value: null,
    });
  });

  it("keeps an explicit null and falsy values", async () => {
    await expect(mainWorldEval("() => null", [])).resolves.toEqual({ ok: true, value: null });
    await expect(mainWorldEval("() => 0", [])).resolves.toEqual({ ok: true, value: 0 });
    await expect(mainWorldEval("() => ''", [])).resolves.toEqual({ ok: true, value: "" });
  });

  it("JSON round-trips the value (a Date becomes its ISO string, a function-valued key drops out)", async () => {
    const r = await mainWorldEval(
      "() => ({ d: new Date(0), f() {}, k: 1 })",
      []
    );
    expect(r).toEqual({ ok: true, value: { d: "1970-01-01T00:00:00.000Z", k: 1 } });
  });

  it("falls back to String(value) when the value is not JSON-safe", async () => {
    const fn = await mainWorldEval("() => function fake() { return 1; }", []);
    expect(fn.ok).toBe(true);
    expect(String(fn.value)).toContain("function fake");
    const cyc = await mainWorldEval("() => { const o = {}; o.self = o; return o; }", []);
    expect(cyc).toEqual({ ok: true, value: "[object Object]" });
    const big = await mainWorldEval("() => 10n", []);
    expect(big).toEqual({ ok: true, value: "10" });
  });

  it("returns a structured-cloneable plain object (what executeScript requires)", async () => {
    const r = await mainWorldEval("() => ({ a: [1, { b: 2 }] })", []);
    // v8 serialization is the structured-clone algorithm; jsdom has no structuredClone.
    expect(deserialize(serialize(r))).toEqual(r);
  });

  it("reports a synchronous throw as ok:false with the error message", async () => {
    await expect(
      mainWorldEval("() => { throw new Error('fake boom'); }", [])
    ).resolves.toEqual({ ok: false, error: "fake boom" });
  });

  it("reports a rejected promise as ok:false", async () => {
    await expect(
      mainWorldEval("() => Promise.reject(new Error('fake async boom'))", [])
    ).resolves.toEqual({ ok: false, error: "fake async boom" });
  });

  it("stringifies a thrown non-Error and survives one that cannot be stringified", async () => {
    await expect(mainWorldEval("() => { throw 'plain text'; }", [])).resolves.toEqual({
      ok: false,
      error: "plain text",
    });
    const r = await mainWorldEval("() => { throw Object.create(null); }", []);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  it("a source that is not a function is an ok:false (callable.apply is not a function), not a crash", async () => {
    const r = await mainWorldEval("42", []);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/apply/);
  });

  it("a syntax error in the source is a plain failure, never the CSP verdict", async () => {
    const r = await mainWorldEval("() => {", []);
    expect(r.ok).toBe(false);
    expect(r.cspBlocked).toBeUndefined();
  });
});

describe("mainWorldEval when the page's CSP forbids eval", () => {
  const realEval = (globalThis as any).eval;
  afterEach(() => {
    (globalThis as any).eval = realEval;
  });

  const blockEval = (make: () => Error) => {
    (globalThis as any).eval = () => {
      throw make();
    };
  };

  it("an EvalError while compiling is cspBlocked, carrying the browser's own text", async () => {
    blockEval(() => new EvalError(CSP_REFUSAL));
    const r = await mainWorldEval("() => 1", []);
    expect(r).toEqual({ ok: false, error: CSP_REFUSAL, cspBlocked: true });
  });

  it("detects an EvalError that is not an instance of this realm's EvalError by the 'unsafe-eval' text", async () => {
    blockEval(() => new Error(CSP_REFUSAL));
    const r = await mainWorldEval("() => 1", []);
    expect(r.cspBlocked).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("an unrelated compile error does not trigger the CSP verdict", async () => {
    blockEval(() => new SyntaxError("Unexpected token ')'"));
    const r = await mainWorldEval("() => 1", []);
    expect(r).toEqual({ ok: false, error: "Unexpected token ')'" });
  });

  it("an EvalError thrown by the caller's own function (compile succeeded) is a plain failure", async () => {
    (globalThis as any).eval = realEval;
    const r = await mainWorldEval("() => { throw new EvalError('fake user eval error'); }", []);
    expect(r).toEqual({ ok: false, error: "fake user eval error" });
  });
});

describe("cspBlockedEvalMessage", () => {
  it("names the page's CSP, what still works and the debugger as the last resort", () => {
    const text = cspBlockedEvalMessage(CSP_REFUSAL);
    expect(text).toBe(
      "The page's Content-Security-Policy forbids eval (its script-src has no 'unsafe-eval'), " +
        "so page-world script cannot run through the normal route on this page " +
        `(the browser said: ${CSP_REFUSAL.trim()}). ` +
        "Reading state still works: use take-snapshot, get-tab-web-content, get-network-requests, " +
        "get-cookies or the coordinate tools. Only as a last resort, engine:\"cdp\" runs it through " +
        "the debugger (Chrome/Edge): that shows the \"FoxPilot started debugging this browser\" bar " +
        "and the page can detect it."
    );
  });

  it("omits the quote when the browser gave no text and caps a very long one", () => {
    expect(cspBlockedEvalMessage()).not.toContain("the browser said");
    expect(cspBlockedEvalMessage("")).not.toContain("the browser said");
    const long = cspBlockedEvalMessage("x".repeat(5000));
    expect(long).toContain("x".repeat(300));
    expect(long).not.toContain("x".repeat(301));
  });
});

describe("runMainWorldEval (service-worker side)", () => {
  const exec = () => (browser as any).scripting.executeScript as jest.Mock;
  const realEval = (globalThis as any).eval;

  beforeEach(() => {
    (browser as any).scripting.executeScript = jest.fn();
  });
  afterEach(() => {
    jest.useRealTimers();
    (globalThis as any).eval = realEval;
    (browser as any).scripting.executeScript = jest.fn().mockResolvedValue([]);
  });

  it("injects into the MAIN world of the tab with [source, args]", async () => {
    exec().mockResolvedValue([{ frameId: 0, result: { ok: true, value: 1 } }]);
    await expect(runMainWorldEval(9, "() => 1", ["a"], 10000)).resolves.toEqual({
      ok: true,
      value: 1,
      error: undefined,
    });
    expect(exec()).toHaveBeenCalledWith({
      target: { tabId: 9 },
      world: "MAIN",
      func: mainWorldEval,
      args: ["() => 1", ["a"]],
    });
  });

  it("runs end to end against a stand-in executeScript that really invokes the function", async () => {
    exec().mockImplementation(async (inj: any) => [
      { frameId: 0, result: await inj.func(...inj.args) },
    ]);
    await expect(
      runMainWorldEval(1, "async (a, b) => a + b", [2, 3], 10000)
    ).resolves.toMatchObject({ ok: true, value: 5 });

    // And with the page's CSP refusing eval.
    (globalThis as any).eval = () => {
      throw new EvalError(CSP_REFUSAL);
    };
    const blocked = await runMainWorldEval(1, "() => 1", [], 10000);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe(cspBlockedEvalMessage(CSP_REFUSAL));
  });

  it("maps a cspBlocked outcome to the agent-facing message", async () => {
    exec().mockResolvedValue([
      { frameId: 0, result: { ok: false, error: CSP_REFUSAL, cspBlocked: true } },
    ]);
    await expect(runMainWorldEval(1, "() => 1", [], 10000)).resolves.toEqual({
      ok: false,
      error: cspBlockedEvalMessage(CSP_REFUSAL),
    });
  });

  it("reports an empty or non-object reply as 'no result', never a TypeError", async () => {
    for (const reply of [[], undefined, [{ frameId: 0 }], [{ frameId: 0, result: "x" }]]) {
      exec().mockResolvedValueOnce(reply);
      await expect(runMainWorldEval(1, "() => 1", [], 10000)).resolves.toEqual({
        ok: false,
        error: MAIN_WORLD_EVAL_NO_RESULT_MESSAGE,
      });
    }
  });

  it("times out from the worker with the old timeout text and leaves no timer behind", async () => {
    jest.useFakeTimers();
    const never = new Promise(() => {});
    const catchSpy = jest.spyOn(never, "catch");
    exec().mockReturnValue(never);

    const done = runMainWorldEval(1, "() => new Promise(() => {})", [], 10000);
    await jest.advanceTimersByTimeAsync(9999);
    let settled = false;
    void done.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await expect(done).resolves.toEqual({ ok: false, error: MAIN_WORLD_EVAL_TIMEOUT_MESSAGE });
    expect(jest.getTimerCount()).toBe(0);
    // The abandoned injection is guarded against a late rejection.
    expect(catchSpy).toHaveBeenCalled();
  });

  it("clears the timer when the injection answers first", async () => {
    jest.useFakeTimers();
    exec().mockResolvedValue([{ frameId: 0, result: { ok: true, value: 0 } }]);
    await runMainWorldEval(1, "() => 0", [], 10000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("lets an executeScript rejection propagate (and still clears the timer)", async () => {
    jest.useFakeTimers();
    exec().mockRejectedValue(new Error("Frame with ID 0 was removed."));
    await expect(runMainWorldEval(1, "() => 1", [], 10000)).rejects.toThrow(
      "Frame with ID 0 was removed."
    );
    expect(jest.getTimerCount()).toBe(0);
  });
});
