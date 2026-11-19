/**
 * Pins the agent-facing wording of the evaluate-script and take-snapshot tool
 * descriptions in server.ts. server.ts self-executes on import (it builds the
 * BrowserAPI and connects stdio), so it is read as text, like the other guidance
 * tests (agent-nudges.test.ts, activate-tab-retry-only.test.ts).
 */
import * as fs from "fs";
import * as path from "path";

// The evaluate-script description is a single-quoted literal, so its apostrophes
// are escaped in the file; undo that to read it the way an agent does.
const src = fs
  .readFileSync(path.join(__dirname, "..", "server.ts"), "utf8")
  .replace(/\\'/g, "'");

function descriptionOf(tool: string): string {
  const at = src.indexOf(`"${tool}",`);
  expect(at).toBeGreaterThan(-1);
  const rest = src.slice(at);
  const end = rest.indexOf("\n  {\n");
  return rest.slice(0, end === -1 ? 6000 : end);
}

describe("evaluate-script description", () => {
  const d = descriptionOf("evaluate-script");

  it("says what each world does and that world defaults to auto", () => {
    expect(d).toContain('world defaults to "auto"');
    expect(d).toContain('(world:"main", "auto" or omitted)');
    expect(d).toContain("a returned Promise is awaited");
    expect(d).toContain('world:"isolated"');
    expect(d).toContain("CANNOT see the page's own JS globals");
  });

  it("says a page whose CSP forbids eval needs engine:cdp, per browser", () => {
    expect(d).toContain("On Chrome/Edge that works on any page unless the PAGE's Content-Security-Policy forbids eval");
    expect(d).toContain("script-src without 'unsafe-eval'");
    expect(d).toContain('only engine:"cdp" can still run it');
    expect(d).toContain("(Chrome/Edge only)");
    expect(d).toContain('world:"main" does NOT fall back');
  });

  it("names the reads that still work and the debugger's cost as the last resort", () => {
    for (const tool of ["take-snapshot", "get-tab-web-content", "get-network-requests", "get-cookies"]) {
      expect(d).toContain(tool);
    }
    expect(d).toContain("last resort");
    expect(d).toContain("FoxPilot started debugging this browser");
    expect(d).toContain("detectable by the page");
  });

  it("no longer teaches that main is blocked everywhere or that it is the default 'world:main' only", () => {
    expect(d).not.toContain('By default (world:"main")');
    expect(d).not.toContain("on Chrome use engine:\"cdp\" or world:\"main\"");
  });
});

describe("take-snapshot description", () => {
  const d = descriptionOf("take-snapshot");

  it("tells agents it waits on a still-loading tab, for how long, and what it says", () => {
    expect(d).toContain("STILL-LOADING TAB");
    expect(d).toContain("up to about 5 s for a loading page and 1.5 s for a loaded but unrendered shell");
    expect(d).toContain("waited 5.0 s, page still loading (tab status: loading)");
    expect(d).toContain("a settled page that simply has no controls is not waited on");
  });
});
