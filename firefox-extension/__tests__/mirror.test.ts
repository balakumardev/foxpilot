/**
 * Mirror-parity invariant for files duplicated across the two extensions.
 *
 * `nav-race.ts` exists twice — once here and once in `chrome-extension/` — and
 * the two copies are meant to be the SAME code, differing only in the
 * WebExtension global (`browser` vs `chrome`) and in the per-store wording of
 * the leading doc comment. Nothing enforced that: CLAUDE.md's byte-identical
 * mirror rule is scoped to `injected/*`, and `self-containment.test.ts` (the
 * canonical guard for those) does not look at `nav-race.ts` at all. So the two
 * files could silently drift — a fix landed on one browser and not the other,
 * or one copy reaching for `self.setTimeout` while the other uses
 * `window.setTimeout` (the two `client.ts` files already diverge on exactly
 * that global, which is why nav-race must use the bare timer functions).
 *
 * Drift here is expensive and invisible: the extension halves are built and
 * shipped separately, both jest suites stay green, and the symptom only shows
 * up as "this works in Firefox but not Chrome" against a live page.
 *
 * This test is the cheap guard. It lives in a single canonical location — the
 * Firefox suite, matching how `self-containment.test.ts` guards the originals —
 * and reads the Chrome copy straight off disk rather than importing it (the
 * Chrome file references the `chrome` global and belongs to the other
 * project's tsconfig).
 *
 * If this fails, do NOT relax the assertion or special-case the diverging line.
 * Port the change to the other extension so both browsers get the same fix.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const FIREFOX_NAV_RACE = join(__dirname, "..", "nav-race.ts");
const CHROME_NAV_RACE = join(
  __dirname,
  "..",
  "..",
  "chrome-extension",
  "nav-race.ts"
);

/**
 * Strip the leading block doc comment — the one region the two copies are
 * ALLOWED to diverge, since each names its own store (CWS/AMO) and runtime
 * (service worker / background page) — and collapse the WebExtension global so
 * `(chrome as any)` and `(browser as any)` compare equal. The non-greedy match
 * stops at the first comment terminator, so any later doc comment stays in the
 * compared body.
 */
function normalize(src: string): string {
  return src
    .replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, "")
    .replace(/\((?:chrome|browser) as any\)/g, "(WEBEXT_GLOBAL as any)");
}

/**
 * Drop block comments and whole-line `//` comments so a token check reads the
 * CODE only. Needed because nav-race.ts names the forbidden timer globals in
 * prose (the comment explaining why it does not use them), which a naive
 * substring assertion would otherwise flag. Whole-line comments are the only
 * form these two files use.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("nav-race.ts is mirrored across the two extensions", () => {
  const firefoxSrc = readFileSync(FIREFOX_NAV_RACE, "utf8");
  const chromeSrc = readFileSync(CHROME_NAV_RACE, "utf8");

  it("each copy uses only its own WebExtension global", () => {
    expect(firefoxSrc).toContain("(browser as any).tabs.onUpdated");
    expect(firefoxSrc).not.toContain("(chrome as any)");
    expect(chromeSrc).toContain("(chrome as any).tabs.onUpdated");
    expect(chromeSrc).not.toContain("(browser as any)");
  });

  it("bodies are byte-identical once the doc comment and the global are normalized", () => {
    expect(normalize(chromeSrc)).toBe(normalize(firefoxSrc));
  });

  it("neither copy reaches for a context-specific timer global", () => {
    // `self.` (Chrome client.ts style) and `window.` (Firefox client.ts style)
    // are both correct in their own extension and would therefore pass their
    // own suite while breaking parity here — and `window` does not exist in an
    // MV3 service worker at all. Bare setTimeout/clearTimeout is the only form
    // valid in both contexts.
    for (const src of [firefoxSrc, chromeSrc]) {
      const code = stripComments(src);
      expect(code).toContain("setTimeout(");
      expect(code).not.toContain("self.setTimeout");
      expect(code).not.toContain("self.clearTimeout");
      expect(code).not.toContain("window.setTimeout");
      expect(code).not.toContain("window.clearTimeout");
    }
  });
});

/**
 * The same guard for `injected/*`, which CLAUDE.md declares must be
 * byte-identical between the two extensions past the leading doc comment.
 *
 * That rule was previously enforced by nothing: `self-containment.test.ts` — the
 * "canonical guard" — only imports the FIREFOX copies and checks each is
 * stringify-safe. It never compares the two extensions, so editing one
 * `injected/*` file and forgetting its twin broke no test and shipped a fix to
 * one browser only. These functions are injected into the page and are the most
 * behaviour-critical code in the repo, which makes silent drift here the
 * expensive kind: both suites stay green and the symptom is "works in Firefox,
 * not Chrome" against a live page.
 *
 * `page-world.ts` is deliberately excluded. Its two copies differ by ~125 lines and
 * the divergence is real, not cosmetic — Chrome's isolated-world eval honestly
 * degrades where Firefox compiles the source string (see CLAUDE.md on
 * `evaluate-script world:"isolated"`). Bringing it under this guard would mean
 * either reconciling genuinely different behaviour or weakening the assertion.
 * Its own header still claims byte-identity with Firefox; that claim is stale
 * and is a pre-existing inconsistency, not something this guard should paper
 * over.
 */
describe("injected/* is mirrored across the two extensions", () => {
  // Every injected module that is meant to be a true mirror. Adding a new
  // injected file means adding it here.
  const MIRRORED = [
    "action-script.ts",
    "dismiss-overlays-script.ts",
    "humanize-steps.ts",
    "point-action-script.ts",
    "screenshot-script.ts",
    "select-option-script.ts",
    "snapshot-script.ts",
    "upload-script.ts",
  ];

  it.each(MIRRORED)(
    "%s bodies are byte-identical once the doc comment is normalized",
    (name) => {
      const ff = readFileSync(join(__dirname, "..", "injected", name), "utf8");
      const cr = readFileSync(
        join(__dirname, "..", "..", "chrome-extension", "injected", name),
        "utf8"
      );
      expect(normalize(cr)).toBe(normalize(ff));
    }
  );

  it("covers every injected file except the documented exclusion", () => {
    // Catches a NEW injected module that nobody added to MIRRORED — otherwise
    // the guard silently stops covering the newest, least-reviewed code.
    const EXCLUDED = ["page-world.ts"];
    const present = readdirSync(join(__dirname, "..", "injected"))
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(present).toEqual([...MIRRORED, ...EXCLUDED].sort());
  });
});
