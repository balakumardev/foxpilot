import { buildEvalPageScript, evalInIsolatedWorld } from "../injected/page-world";

// jsdom has NO Content-Security-Policy, so `new Function` works here and these
// tests exercise the SUCCESS path. On real Chrome MV3 the isolated-world
// extension CSP blocks new Function; that failure is caught and reported as a
// clear ok:false (see the try/catch's CSP branch) — not reproducible in jsdom.
describe("evalInIsolatedWorld (chrome, Task 1)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("evaluates a function expression against the DOM and returns ok/value", () => {
    document.body.innerHTML = `<div id="x">hi</div>`;
    const r = evalInIsolatedWorld(
      "(sel) => document.querySelector(sel).textContent",
      ["#x"]
    );
    expect(r).toEqual({ ok: true, value: "hi" });
  });

  it("maps a top-level undefined to null", () => {
    const r = evalInIsolatedWorld("() => undefined", []);
    expect(r).toEqual({ ok: true, value: null });
  });

  it("reports a Promise return as an unsupported-async ok:false", () => {
    const r = evalInIsolatedWorld("() => Promise.resolve(1)", []);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/synchronous/i);
  });

  it("reports a thrown error as ok:false", () => {
    const r = evalInIsolatedWorld("() => { throw new Error('boom'); }", []);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("boom");
  });
});

// Task A2: buildEvalPageScript emits a synchronous "started" marker (only when a
// startedAttr is passed) at the very top of the IIFE, BEFORE the result attr is
// written, so a CSP-blocked injection leaves neither the marker nor the result.
describe("buildEvalPageScript started marker (Task A2)", () => {
  const attr = "data-r";
  const startedAttr = "data-started";

  it("emits the started marker before the result attribute in source order", () => {
    const src = buildEvalPageScript("() => 1", [], attr, startedAttr);
    // The started attribute marker is present...
    expect(src).toContain(startedAttr);
    // ...and it is set BEFORE the result attribute (so a CSP-blocked injection
    // leaves neither the marker nor the result set).
    expect(src.indexOf(startedAttr)).toBeLessThan(src.lastIndexOf(attr));
  });

  it("stays byte-identical to the 3-arg form when startedAttr is omitted", () => {
    const withMarker = buildEvalPageScript("() => 1", [], attr, startedAttr);
    const noMarker = buildEvalPageScript("() => 1", [], attr);
    // Omitting startedAttr emits no marker at all...
    expect(noMarker).not.toContain(startedAttr);
    // ...and deleting the marker statement from the 4-arg output reproduces the
    // 3-arg output exactly (byte-identical to the original function).
    expect(
      withMarker.replace(
        'document.documentElement.setAttribute("data-started", "1");',
        ""
      )
    ).toBe(noMarker);
  });
});
