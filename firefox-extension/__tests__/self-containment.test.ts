/**
 * Self-containment invariant for the injected functions.
 *
 * `buildSnapshot` (injected/snapshot-script.ts) and `performInputAction`
 * (injected/action-script.ts) are NOT bundled and shipped as modules. The
 * message handler injects them into a target page by stringifying the function
 * with `.toString()` and wrapping it in an IIFE:
 *
 *     browser.tabs.executeScript(tabId, {
 *       code: `(${buildSnapshot.toString()})(document, ${JSON.stringify(opts)})`,
 *     });
 *
 * Whatever `.toString()` emits is the EXACT source that runs in the page. The
 * page has no module loader, no `require`, no CommonJS/ESM runtime and no
 * reference to the rest of this extension's bundle. So the emitted text must be
 * fully self-contained: every helper has to be an inner function and there must
 * be no module-system reference of any kind.
 *
 * This test is the cheap guard for that invariant. It catches two distinct
 * regression classes that a human reviewer would otherwise have to remember:
 *
 *   1. Source-level leaks — someone refactors a shared helper to the top of the
 *      module and calls it from inside the injected function, or adds an
 *      `import`/`require` that ends up referenced in the body. The stringified
 *      output would then reference a symbol that doesn't exist in the page,
 *      and injection would throw a ReferenceError at runtime in Firefox (never
 *      in jsdom, so the existing unit tests would NOT catch it).
 *
 *   2. Bundler-injected wrappers — if esbuild's `keepNames` were ever turned on
 *      (e.g. for nicer stack traces), it wraps every function in a
 *      `__name(fn, "fn")` helper and that `__name` reference appears INSIDE the
 *      stringified body, again undefined in the page. Likewise CommonJS interop
 *      helpers (`__commonJS`, `__toESM`, `__require`) or an `exports.` /
 *      `module.exports` reference would all break injection.
 *
 * If this test fails, do NOT relax the assertion — the injected function is no
 * longer safe to stringify-and-inject. Make the helper inner again, drop the
 * offending import, or disable the bundler transform that introduced the wrapper.
 */

import { buildSnapshot } from "../injected/snapshot-script";
import { performInputAction } from "../injected/action-script";
import { performPointAction } from "../injected/point-action-script";
import {
  dispatchMouseMoveStep,
  typeCharStep,
  readElementScreenRect,
} from "../injected/humanize-steps";

// Tokens that must never appear in the stringified source of an injected
// function. Each one is either a module-system reference (undefined in a raw
// page world) or an esbuild-generated wrapper/interop helper.
const FORBIDDEN_TOKENS = [
  "require(",
  "import ",
  "exports.",
  "module.exports",
  "__name",
  "__commonJS",
  "__toESM",
  "__require",
];

const INJECTED_FUNCTIONS: ReadonlyArray<[string, (...args: any[]) => any]> = [
  ["buildSnapshot", buildSnapshot as unknown as (...args: any[]) => any],
  ["performInputAction", performInputAction as unknown as (...args: any[]) => any],
  ["performPointAction", performPointAction as unknown as (...args: any[]) => any],
  ["dispatchMouseMoveStep", dispatchMouseMoveStep as unknown as (...args: any[]) => any],
  ["typeCharStep", typeCharStep as unknown as (...args: any[]) => any],
  ["readElementScreenRect", readElementScreenRect as unknown as (...args: any[]) => any],
];

describe("injected functions are self-contained (safe to stringify-and-inject)", () => {
  for (const [name, fn] of INJECTED_FUNCTIONS) {
    describe(name, () => {
      it("stringifies to a real function body (.toString() is not a native stub)", () => {
        const src = fn.toString();
        expect(typeof src).toBe("string");
        // A genuine source body, not "function () { [native code] }".
        expect(src).not.toContain("[native code]");
        expect(src.length).toBeGreaterThan(50);
      });

      for (const token of FORBIDDEN_TOKENS) {
        it(`contains no module-system reference: ${JSON.stringify(token)}`, () => {
          const src = fn.toString();
          expect(src).not.toContain(token);
        });
      }
    });
  }
});
