import { z } from "zod";
import { allowedNavUrl, NAV_URL_MESSAGE } from "../url-policy";

// D22: open-browser-tab must accept the same URLs as navigate-tab — https to
// any host, http only for loopback — so a local dev/test server can be opened
// in a new tab. `allowedNavUrl` is the single source of truth both tool schemas
// refine against.
describe("allowedNavUrl", () => {
  it("accepts https to any host", () => {
    expect(allowedNavUrl("https://x.com")).toBe(true);
    expect(allowedNavUrl("https://app.factors.ai/dashboard")).toBe(true);
  });

  it("accepts http only for loopback hosts (localhost / 127.0.0.1 / [::1])", () => {
    expect(allowedNavUrl("http://localhost:8770/")).toBe(true);
    expect(allowedNavUrl("http://127.0.0.1:8770/")).toBe(true);
    expect(allowedNavUrl("http://[::1]:8770/")).toBe(true);
  });

  it("rejects http to a non-loopback host (no arbitrary plaintext http)", () => {
    expect(allowedNavUrl("http://evil.com/")).toBe(false);
    expect(allowedNavUrl("http://example.com")).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    expect(allowedNavUrl("ftp://files.example.com/a")).toBe(false);
    expect(allowedNavUrl("javascript:alert(1)")).toBe(false);
    expect(allowedNavUrl("file:///etc/passwd")).toBe(false);
    expect(allowedNavUrl("about:blank")).toBe(false);
  });

  it("rejects unparseable / non-URL strings", () => {
    expect(allowedNavUrl("not a url")).toBe(false);
    expect(allowedNavUrl("")).toBe(false);
  });
});

// Mirror the shared `navUrl` schema wired into open-browser-tab and navigate-tab
// (server.ts) to prove the refine + message reach the tool boundary.
describe("navUrl zod schema (as used by open-browser-tab / navigate-tab)", () => {
  const navUrl = z.string().refine(allowedNavUrl, { message: NAV_URL_MESSAGE });

  it("safeParse succeeds for allowed URLs", () => {
    expect(navUrl.safeParse("https://x.com").success).toBe(true);
    expect(navUrl.safeParse("http://localhost:8770/").success).toBe(true);
    expect(navUrl.safeParse("http://127.0.0.1:8770/").success).toBe(true);
  });

  it("safeParse fails with the policy message for disallowed URLs", () => {
    for (const bad of ["http://evil.com/", "ftp://x/", "javascript:1"]) {
      const res = navUrl.safeParse(bad);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].message).toBe(NAV_URL_MESSAGE);
      }
    }
  });
});
