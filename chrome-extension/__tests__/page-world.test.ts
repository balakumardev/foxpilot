import { evalInIsolatedWorld } from "../injected/page-world";

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
