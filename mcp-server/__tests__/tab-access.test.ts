/**
 * common/tab-access.ts: why a tab will not let FoxPilot in. Lives under
 * mcp-server/__tests__ (node environment, like tab-list-redaction.test.ts) because
 * `common` has no jest config of its own.
 *
 * The browser strings pinned here were observed in Chromium 140
 * (test-fixtures/browser-probe/OBSERVED.json cases 1 and 5); the host and token are fake.
 */
import {
  TAB_ACCESS_TAGS,
  NO_BROWSER_ERROR_TEXT,
  buildTabAccessMessage,
  classifyTabUrl,
  describeRestrictedPage,
  diagnoseTabAccess,
  gateTabUrl,
  isFirefoxRestrictedHost,
  isPageAccessError,
  isTabAccessMessage,
  originOfTabUrl,
  redactAccessMessage,
  type TabAccessProbe,
  type TabInfoForAccess,
} from "@foxpilot/common";

// Observed browser errors.
const S1 =
  'Cannot access contents of url "https://app.example.test/dash?token=fake-token-123#access_token=fake-token-123". Extension manifest must request permission to access this host.';
const S1_BLANK =
  'Cannot access contents of url "about:blank". Extension manifest must request permission to access this host.';
const S2 =
  "Cannot access contents of the page. Extension manifest must request permission to access the respective host.";
const CHROME_URL = "Cannot access a chrome:// URL";
const OTHER_EXT = "Cannot access a chrome-extension:// URL of different extension";
const ERROR_PAGE = "Frame with ID 0 is showing error page";
const RECEIVING_END = "Could not establish connection. Receiving end does not exist.";
const NO_ORIGIN = "Invalid value for origin pattern null/*: Missing scheme separator.";

const APP = "https://app.example.test";
const FULL_URL = `${APP}/dash?token=fake-token-123#access_token=fake-token-123`;

describe("classifyTabUrl", () => {
  it.each([
    ["https://app.example.test/dash?x=1", "web"],
    ["http://localhost:3000/", "web"],
    ["http://127.0.0.1:8080/a#b", "web"],
    ["ftp://files.example.test/a", "web"],
    ["blob:https://app.example.test/0b8d3c1e-0000-4000-8000-000000000000", "web"],
    ["https://chrome.google.com/other", "web"],
    ["https://chromewebstore.example.test/", "web"],
    ["about:blank", "blank"],
    ["about:blank#frag", "blank"],
    ["ABOUT:BLANK", "blank"],
    ["file:///tmp/page.html", "file"],
    ["blob:file:///tmp/x", "file"],
    ["", "none"],
    ["   ", "none"],
    ["not a url", "none"],
    ["http://", "none"],
  ] as const)("%s -> %s", (url, kind) => {
    expect(classifyTabUrl(url)).toBe(kind);
  });

  it("treats undefined and null as none", () => {
    expect(classifyTabUrl(undefined)).toBe("none");
    expect(classifyTabUrl(null)).toBe("none");
  });

  it.each([
    "chrome://version/",
    "chrome://settings/privacy",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html",
    "chrome-untrusted://terminal/",
    "chrome-search://local-ntp/",
    "chrome-error://chromewebdata/",
    "devtools://devtools/bundled/inspector.html",
    "edge://settings",
    "brave://settings",
    "about:config",
    "about:addons",
    "view-source:https://app.example.test/page?token=fake-token-123",
    "data:text/html,<p>x</p>",
    "filesystem:https://app.example.test/temporary/f.txt",
    "javascript:void(0)",
    "moz-extension://11111111-2222-3333-4444-555555555555/options.html",
    "blob:null/0b8d3c1e-0000-4000-8000-000000000000",
    "blob:data:text/html,x",
    "https://chromewebstore.google.com/detail/x/abc",
    "https://chrome.google.com/webstore/detail/x/abc",
    "https://chrome.google.com/webstore",
    "someapp://open?x=1",
  ])("%s is restricted", (url) => {
    expect(classifyTabUrl(url)).toBe("restricted");
  });

  it("the Chrome Web Store is an ordinary page in Firefox", () => {
    expect(classifyTabUrl("https://chromewebstore.google.com/", { browser: "firefox" })).toBe("web");
    expect(classifyTabUrl("https://chrome.google.com/webstore", { browser: "firefox" })).toBe("web");
  });

  it("another extension's moz-extension page is restricted; the extension's own is left to the caller", () => {
    const own = "moz-extension://11111111-2222-3333-4444-555555555555";
    expect(classifyTabUrl(`${own}/options.html`, { browser: "firefox", selfOrigin: own })).toBe("web");
    expect(classifyTabUrl(own, { browser: "firefox", selfOrigin: `${own}/` })).toBe("web");
    expect(
      classifyTabUrl("moz-extension://99999999-2222-3333-4444-555555555555/x.html", {
        browser: "firefox",
        selfOrigin: own,
      })
    ).toBe("restricted");
    // A longer id that merely starts with the own origin is another extension.
    expect(classifyTabUrl(`${own}9/x.html`, { browser: "firefox", selfOrigin: own })).toBe("restricted");
  });

  it("chrome-extension pages stay restricted whatever the own origin is", () => {
    expect(
      classifyTabUrl("chrome-extension://abc/perm.html", { selfOrigin: "chrome-extension://abc" })
    ).toBe("restricted");
  });
});

describe("originOfTabUrl", () => {
  it("returns scheme://host[:port] for web pages and the inner origin of a blob: page", () => {
    expect(originOfTabUrl("https://app.example.test:8443/a?b#c")).toBe("https://app.example.test:8443");
    expect(originOfTabUrl("blob:https://app.example.test/0b8d3c1e")).toBe("https://app.example.test");
    expect(originOfTabUrl("http://localhost:3000/")).toBe("http://localhost:3000");
  });

  it("has no origin for anything the browser reports as the opaque origin null", () => {
    for (const url of ["about:blank", "data:text/html,x", "view-source:https://a.example.test/", "", undefined, null, "nonsense"]) {
      expect(originOfTabUrl(url as string)).toBeUndefined();
    }
  });
});

describe("isPageAccessError", () => {
  it.each([
    ["S1 (host not granted / blank / data: / own page / file: off)", S1],
    ["S1 about:blank", S1_BLANK],
    ["S2 (a discarded tab)", S2],
    ["chrome:// page", CHROME_URL],
    ["another extension's page", OTHER_EXT],
    ["browser error page", ERROR_PAGE],
    ["older Chrome wording", "Missing host permission for the tab"],
    ["Firefox: missing host permission", "Missing host permission for the tab or frames"],
    ["Chrome Web Store", "The extensions gallery cannot be scripted."],
    ["Firefox: privileged page (defensive)", 'Cannot access "about:addons"'],
    ["a wrapper that kept the browser text", `captureVisibleTab was refused: ${S2}`],
  ])("matches %s", (_label, message) => {
    expect(isPageAccessError(message)).toBe(true);
  });

  it.each([
    ["a closed tab", "No tab with id: 7."],
    ["Firefox: closed tab", "Invalid tab ID: 7"],
    ["a detached receiver", RECEIVING_END],
    ["a deny-list error", "Domain in tab URL is in the deny list"],
    ["an origin pattern error", NO_ORIGIN],
    ["a timeout", "Timed out waiting for response from the browser extension"],
    ["FoxPilot's older own message", 'Missing host permission for "https://app.example.test" after navigation. Ask the user to grant access to this domain, then retry.'],
    ["empty", ""],
  ])("does not match %s", (_label, message) => {
    expect(isPageAccessError(message)).toBe(false);
  });

  it("never matches a message FoxPilot already diagnosed, even one that quotes the browser text", () => {
    for (const cause of Object.keys(TAB_ACCESS_TAGS) as (keyof typeof TAB_ACCESS_TAGS)[]) {
      const message = buildTabAccessMessage(cause, {
        browser: "chrome",
        tabId: 7,
        origin: APP,
        rawMessage: redactAccessMessage(S1),
      });
      expect(isPageAccessError(message)).toBe(false);
      expect(isTabAccessMessage(message)).toBe(true);
    }
  });

  it("is false for values that are not strings", () => {
    expect(isPageAccessError(undefined)).toBe(false);
    expect(isPageAccessError(null)).toBe(false);
    expect(isPageAccessError(42)).toBe(false);
  });
});

describe("redactAccessMessage", () => {
  it("removes the query and fragment from the URL S1 embeds", () => {
    const out = redactAccessMessage(S1);
    expect(out).toBe(
      'Cannot access contents of url "https://app.example.test/dash?[redacted]#[redacted]". Extension manifest must request permission to access this host.'
    );
    expect(out).not.toContain("fake-token-123");
  });

  it("removes a long data: payload even when it contains quotes", () => {
    const payload = "<p class=\"x\">" + "A".repeat(5000) + "fake-token-123</p>";
    const out = redactAccessMessage(
      `Cannot access contents of url "data:text/html,${payload}". Extension manifest must request permission to access this host.`
    );
    expect(out).toBe(
      'Cannot access contents of url "data:[redacted]". Extension manifest must request permission to access this host.'
    );
    expect(out.length).toBeLessThan(200);
  });

  it("redacts the bare URLs of an origin pattern error", () => {
    const out = redactAccessMessage(
      "Invalid value for origin pattern view-source:https://app.example.test/page?token=fake-token-123: Invalid scheme."
    );
    expect(out).toBe(
      "Invalid value for origin pattern view-source:https://app.example.test/page?[redacted]: Invalid scheme."
    );
    expect(
      redactAccessMessage(
        "Invalid value for origin pattern data:text/html,<p>fake-token-123</p>: Invalid scheme."
      )
    ).not.toContain("fake-token-123");
    expect(
      redactAccessMessage(
        "Invalid value for origin pattern chrome-extension://abcdefghijklmnopabcdefghijklmnop/perm.html?x=fake-token-123: Invalid scheme."
      )
    ).not.toContain("fake-token-123");
  });

  it("drops userinfo and leaves messages without URLs alone", () => {
    expect(redactAccessMessage('Cannot access contents of url "https://user:fake-token-123@app.example.test/a". Extension manifest must request permission to access this host.')).not.toContain("fake-token-123");
    expect(redactAccessMessage(S2)).toBe(S2);
    expect(redactAccessMessage(CHROME_URL)).toBe(CHROME_URL);
    expect(redactAccessMessage(RECEIVING_END)).toBe(RECEIVING_END);
  });

  it("is idempotent, one line, and capped", () => {
    const once = redactAccessMessage(S1);
    expect(redactAccessMessage(once)).toBe(once);
    const long = redactAccessMessage(`line one\nline two ${"x".repeat(1000)}`);
    expect(long).not.toContain("\n");
    expect(long.length).toBeLessThanOrEqual(403);
  });

  it("survives non-string input", () => {
    expect(redactAccessMessage(undefined as unknown as string)).toBe("");
  });
});

describe("buildTabAccessMessage", () => {
  const raw = redactAccessMessage(S1);
  const FULL_URL_PARTS = ["fake-token-123", "/dash", "access_token", "?token"];

  it.each(Object.keys(TAB_ACCESS_TAGS) as (keyof typeof TAB_ACCESS_TAGS)[])(
    "%s: starts with its own tag only, ends with the original error, shows no full URL",
    (cause) => {
      for (const browser of ["chrome", "firefox"] as const) {
        const msg = buildTabAccessMessage(cause, {
          browser,
          tabId: 7,
          // Even a careless caller passing a full URL as the origin is cut back to the origin.
          origin: FULL_URL,
          rawMessage: raw,
          pageKind: "a chrome: page",
        });
        expect(msg.startsWith(`${TAB_ACCESS_TAGS[cause]} `)).toBe(true);
        const others = Object.values(TAB_ACCESS_TAGS).filter((t) => t !== TAB_ACCESS_TAGS[cause]);
        for (const tag of others) {
          expect(msg).not.toContain(tag);
        }
        expect(msg.endsWith(`Original error: ${raw}`)).toBe(true);
        const beforeOriginal = msg.slice(0, msg.indexOf("Original error:"));
        for (const part of FULL_URL_PARTS) {
          expect(beforeOriginal).not.toContain(part);
        }
        expect(msg).not.toContain("fake-token-123");
        // Outside the (redacted) original error there is an origin at most, never a path.
        expect(beforeOriginal).not.toMatch(/https?:\/\/[^\s]*\//);
      }
    }
  );

  it("says what FoxPilot checked when the browser was never asked", () => {
    const msg = buildTabAccessMessage("restricted", { browser: "chrome", pageKind: "a chrome: page" });
    expect(msg.endsWith(`Original error: ${NO_BROWSER_ERROR_TEXT}`)).toBe(true);
  });

  it("restricted: names the page kind, says nothing can be granted, and points at open-browser-tab", () => {
    const msg = buildTabAccessMessage("restricted", { browser: "chrome", tabId: 7, pageKind: "a chrome: page" });
    expect(msg).toContain("Tab 7 shows a chrome: page");
    expect(msg).toContain("nothing can be granted");
    expect(msg).toContain("open-browser-tab");
  });

  it("restricted blank page: says there is no content and points at navigate-tab", () => {
    const msg = buildTabAccessMessage("restricted", {
      browser: "chrome",
      tabId: 7,
      pageKind: describeRestrictedPage("about:blank"),
    });
    expect(msg).toContain("a blank page (about:blank)");
    expect(msg).toContain("navigate-tab");
  });

  it("file: names the file URL switch on the extensions page of each Chromium browser", () => {
    const msg = buildTabAccessMessage("file", { browser: "chrome", tabId: 7 });
    expect(msg).toContain("chrome://extensions");
    expect(msg).toContain("brave://extensions");
    expect(msg).toContain("edge://extensions");
    expect(msg).toContain("FoxPilot → Details");
    expect(msg).toContain("Allow access to file URLs");
  });

  it("discarded: says reloading loses nothing and gives the three recoveries", () => {
    const msg = buildTabAccessMessage("discarded", { browser: "chrome", tabId: 7, origin: APP });
    expect(msg).toContain("Tab 7 (https://app.example.test)");
    expect(msg).toContain("Memory Saver");
    expect(msg).toContain("reloading loses nothing");
    expect(msg).toContain("activateTab:true");
    expect(msg).toContain('navigate-page-history with direction "reload"');
    expect(msg).toContain("open-browser-tab");
  });

  it("discarded after the call already activated the tab: does not recommend activateTab again", () => {
    const msg = buildTabAccessMessage("discarded", {
      browser: "chrome",
      tabId: 7,
      origin: APP,
      activateTabRequested: true,
    });
    expect(msg).toContain("already passed activateTab:true");
    expect(msg).not.toContain("Retry this call with activateTab:true");
    expect(msg).toContain('direction "reload"');
  });

  it("loading and error page: say it is not a permission problem", () => {
    expect(buildTabAccessMessage("loading", { browser: "chrome", tabId: 7, origin: APP })).toMatch(/not a permission problem/);
    const err = buildTabAccessMessage("errorPage", { browser: "chrome", tabId: 7 });
    expect(err).toMatch(/not a permission problem/);
    expect(err).toContain("navigate-tab");
  });

  it("notGranted (Chrome): names the exact place, with every Chromium browser's extensions page", () => {
    const msg = buildTabAccessMessage("notGranted", { browser: "chrome", origin: APP });
    expect(msg).toContain("FoxPilot has no access to https://app.example.test");
    expect(msg).toContain("chrome://extensions");
    expect(msg).toContain("brave://extensions");
    expect(msg).toContain("edge://extensions");
    expect(msg).toContain('FoxPilot → Details → Site access → "On all sites"');
    expect(msg).toContain('"On specific sites"');
    expect(msg).toContain("switching it off and on again in FoxPilot's options page");
  });

  it("notGranted with Automation Mode on and a dialog: names the all-sites grant", () => {
    const msg = buildTabAccessMessage("notGranted", {
      browser: "chrome",
      origin: APP,
      automationMode: true,
      dialog: "all-sites",
    });
    expect(msg).toContain("Automation Mode is on");
    expect(msg).toContain("access to all sites");
    expect(msg).toContain("click Grant");
  });

  it("notGranted (Firefox): points at about:addons → FoxPilot → Permissions", () => {
    const msg = buildTabAccessMessage("notGranted", { browser: "firefox", origin: APP });
    expect(msg).toContain("about:addons → FoxPilot → Permissions");
    expect(msg).not.toContain("chrome://extensions");
  });

  it("refused: claims no cause and recommends a fresh tab first, with reload only on the user's say-so", () => {
    const msg = buildTabAccessMessage("refused", { browser: "chrome", tabId: 7, origin: APP });
    expect(msg).toContain("the cause is not known");
    expect(msg).toContain("fresh tab on the same origin");
    expect(msg).toContain("only if the user agrees");
    for (const invented of ["Memory Saver", "discarded", "file URLs", "unloaded"]) {
      expect(msg).not.toContain(invented);
    }
  });

  it("leaves the tab id out when there is none", () => {
    expect(buildTabAccessMessage("loading", { browser: "chrome" })).toContain("This tab is still loading");
  });
});

// A probe over a canned tab; every call is recorded so tests can see what was asked.
function probeFor(opts: {
  tab?: TabInfoForAccess | "throw" | "hang";
  origin?: boolean | "throw" | "hang";
  file?: boolean | "throw" | "hang";
}): TabAccessProbe & { calls: string[] } {
  const calls: string[] = [];
  const answer = <T>(label: string, value: T | "throw" | "hang" | undefined): Promise<T> => {
    calls.push(label);
    if (value === "throw") return Promise.reject(new Error("browser said no"));
    if (value === "hang") return new Promise<T>(() => undefined);
    return Promise.resolve(value as T);
  };
  return {
    calls,
    getTab: () => answer("getTab", opts.tab),
    containsOrigin: (origin: string) => answer(`containsOrigin ${origin}`, opts.origin),
    containsFileAccess: () => answer("containsFileAccess", opts.file),
  };
}

const loaded = (url: string): TabInfoForAccess => ({ url, status: "complete", discarded: false });

describe("diagnoseTabAccess: the order of causes", () => {
  const diagnose = (
    rawMessage: string,
    probe: TabAccessProbe,
    extra: Partial<Parameters<typeof diagnoseTabAccess>[0]> = {}
  ) => diagnoseTabAccess({ browser: "chrome", tabId: 7, rawMessage, timeoutMs: 300, ...extra }, probe);

  it("1. a restricted page wins over everything, even a discarded tab with S2", async () => {
    const probe = probeFor({ tab: { url: "chrome://settings/", status: "unloaded", discarded: true }, origin: true });
    const msg = await diagnose(S2, probe);
    expect(msg).toMatch(/^TAB NOT SCRIPTABLE \(restricted page\):/);
    expect(msg).toContain("a chrome: page");
    expect(probe.calls).toEqual(["getTab"]);
  });

  it("1. about:blank, data:, view-source: and another extension's page are restricted", async () => {
    for (const url of [
      "about:blank",
      "data:text/html,<p>x</p>",
      `view-source:${FULL_URL}`,
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/public.html",
    ]) {
      const probe = probeFor({ tab: loaded(url), origin: true });
      const msg = await diagnose(S1_BLANK, probe);
      expect(msg).toMatch(/^TAB NOT SCRIPTABLE \(restricted page\):/);
      expect(msg).not.toContain("fake-token-123");
      expect(probe.calls).not.toContain("containsOrigin undefined");
      expect(probe.calls.some((c) => c.startsWith("containsOrigin"))).toBe(false);
    }
  });

  it("1. the Chrome Web Store is restricted by its URL, and Firefox's AMO host only after the browser refused", async () => {
    const chrome = await diagnose(S1, probeFor({ tab: loaded("https://chromewebstore.google.com/detail/x/abc"), origin: true }));
    expect(chrome).toMatch(/^TAB NOT SCRIPTABLE \(restricted page\):/);
    expect(chrome).toContain("the Chrome Web Store");

    const ff = await diagnose("Missing host permission for the tab", probeFor({ tab: loaded("https://addons.mozilla.org/en-US/firefox/"), origin: true }), { browser: "firefox" });
    expect(ff).toMatch(/^TAB NOT SCRIPTABLE \(restricted page\):/);
    expect(isFirefoxRestrictedHost("https://addons.mozilla.org/x")).toBe(true);
    expect(isFirefoxRestrictedHost("https://app.example.test/x")).toBe(false);
  });

  it("1. what the browser's message names holds even when the tab cannot be read", async () => {
    const chrome = await diagnose(CHROME_URL, probeFor({ tab: "throw" }));
    expect(chrome).toMatch(/^TAB NOT SCRIPTABLE \(restricted page\):.*a chrome: page/s);
    const ext = await diagnose(OTHER_EXT, probeFor({ tab: "throw" }));
    expect(ext).toMatch(/^TAB NOT SCRIPTABLE \(restricted page\):.*an extension's page/s);
    const store = await diagnose("The extensions gallery cannot be scripted.", probeFor({ tab: "throw" }));
    expect(store).toContain("the Chrome Web Store");
  });

  it("2. a file: tab with file access off is the file cause; with access on, the order goes on", async () => {
    const off = await diagnose(S1, probeFor({ tab: loaded("file:///tmp/page.html"), file: false }));
    expect(off).toMatch(/^TAB NOT SCRIPTABLE \(file: URL\):/);
    const on = probeFor({ tab: loaded("file:///tmp/page.html"), file: true });
    const msg = await diagnose(S1, on);
    expect(msg).toMatch(/^TAB REFUSED ACCESS DESPITE GRANT:/);
    expect(msg).toContain("Original error:");
    // ... and a discarded file: tab is still the discarded cause.
    const discarded = await diagnose(
      S2,
      probeFor({ tab: { url: "file:///tmp/page.html", status: "unloaded", discarded: true }, file: true })
    );
    expect(discarded).toMatch(/^TAB DISCARDED:/);
  });

  it("3. a browser error page, from the message alone or from the tab", async () => {
    const byMessage = await diagnose(ERROR_PAGE, probeFor({ tab: loaded("http://127.0.0.1:1/"), origin: true }));
    expect(byMessage).toMatch(/^TAB SHOWS A BROWSER ERROR PAGE:/);
    const unreadable = await diagnose(ERROR_PAGE, probeFor({ tab: "throw" }));
    expect(unreadable).toMatch(/^TAB SHOWS A BROWSER ERROR PAGE:/);
    const byUrl = await diagnose(S2, probeFor({ tab: loaded("chrome-error://chromewebdata/") }));
    expect(byUrl).toMatch(/^TAB SHOWS A BROWSER ERROR PAGE:/);
  });

  it("4. a discarded tab with S2 is TAB DISCARDED, whether or not the host is granted", async () => {
    for (const origin of [true, false]) {
      const probe = probeFor({
        tab: { url: FULL_URL, status: "unloaded", discarded: true },
        origin,
      });
      const msg = await diagnose(S2, probe);
      expect(msg).toMatch(/^TAB DISCARDED:/);
      expect(msg).toContain("https://app.example.test");
      expect(msg).not.toContain("fake-token-123");
      expect(probe.calls.some((c) => c.startsWith("containsOrigin"))).toBe(false);
    }
  });

  it("4. discarded:true with no status, and status unloaded alone, both count; discarded while loading does not", async () => {
    expect(await diagnose(S2, probeFor({ tab: { url: FULL_URL, discarded: true } }))).toMatch(/^TAB DISCARDED:/);
    expect(await diagnose(S2, probeFor({ tab: { url: FULL_URL, status: "unloaded" } }))).toMatch(/^TAB DISCARDED:/);
    expect(await diagnose(S2, probeFor({ tab: { url: FULL_URL, status: "loading", discarded: true } }))).toMatch(/^TAB STILL LOADING:/);
  });

  it("4. activateTab already requested: the discarded message does not suggest it again", async () => {
    const msg = await diagnose(S2, probeFor({ tab: { url: FULL_URL, status: "unloaded", discarded: true } }), {
      activateTabRequested: true,
    });
    expect(msg).toContain("already passed activateTab:true");
  });

  it("5. a tab that is still loading", async () => {
    const msg = await diagnose(S2, probeFor({ tab: { url: "", pendingUrl: FULL_URL, status: "loading", discarded: false } }));
    expect(msg).toMatch(/^TAB STILL LOADING:/);
    expect(msg).toContain("https://app.example.test");
    expect(msg).not.toContain("fake-token-123");
  });

  it("6. a loaded tab whose host is not granted", async () => {
    const probe = probeFor({ tab: loaded(FULL_URL), origin: false });
    const msg = await diagnose(S1, probe);
    expect(msg).toMatch(/^SITE ACCESS NOT GRANTED:/);
    expect(msg).toContain("https://app.example.test");
    expect(probe.calls).toContain("containsOrigin https://app.example.test");
    expect(msg).not.toContain("fake-token-123");
  });

  it("7. a loaded tab whose host IS granted: refused despite grant, and no other cause is claimed", async () => {
    const msg = await diagnose(S1, probeFor({ tab: loaded(FULL_URL), origin: true }));
    expect(msg).toMatch(/^TAB REFUSED ACCESS DESPITE GRANT:/);
    for (const invented of ["Memory Saver", "unloaded this tab", "Allow access to file URLs", "still loading"]) {
      expect(msg).not.toContain(invented);
    }
    expect(msg).toContain("Original error: Cannot access contents of url \"https://app.example.test/dash?[redacted]#[redacted]\"");
  });

  it("a blob: page is judged by its inner origin", async () => {
    const probe = probeFor({ tab: loaded("blob:https://app.example.test/0b8d3c1e-0000-4000-8000-000000000000"), origin: true });
    expect(await diagnose(S1, probe)).toMatch(/^TAB REFUSED ACCESS DESPITE GRANT:/);
    expect(probe.calls).toContain("containsOrigin https://app.example.test");
  });
});

describe("diagnoseTabAccess: browser calls that fail or hang", () => {
  const diagnose = (probe: TabAccessProbe, rawMessage = S1, timeoutMs = 80) =>
    diagnoseTabAccess({ browser: "chrome", tabId: 7, rawMessage, timeoutMs }, probe);

  it("tabs.get rejecting falls back to the redacted raw message plus a note, and never throws", async () => {
    const msg = await diagnose(probeFor({ tab: "throw" }));
    expect(msg).toContain('Cannot access contents of url "https://app.example.test/dash?[redacted]#[redacted]"');
    expect(msg).toContain("could not inspect the tab");
    expect(msg).not.toContain("fake-token-123");
    expect(isTabAccessMessage(msg)).toBe(false);
  });

  it("tabs.get hanging gives up at the budget", async () => {
    const started = Date.now();
    const msg = await diagnose(probeFor({ tab: "hang" }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(msg).toContain("could not inspect the tab");
    expect(msg).not.toContain("fake-token-123");
  });

  it("permissions.contains rejecting or hanging leaves the cause unclaimed", async () => {
    for (const origin of ["throw", "hang"] as const) {
      const msg = await diagnose(probeFor({ tab: loaded(FULL_URL), origin }));
      expect(isTabAccessMessage(msg)).toBe(false);
      expect(msg).toContain("could not inspect the tab");
      expect(msg).toContain("Cannot access contents of url");
    }
  });

  it("the budget is shared: two slow calls do not add up to twice the budget", async () => {
    const slowProbe: TabAccessProbe = {
      getTab: () => new Promise((resolve) => setTimeout(() => resolve(loaded(FULL_URL)), 50)),
      containsOrigin: () => new Promise(() => undefined),
      containsFileAccess: () => new Promise(() => undefined),
    };
    const started = Date.now();
    const msg = await diagnose(slowProbe, S1, 100);
    expect(Date.now() - started).toBeLessThan(250);
    expect(isTabAccessMessage(msg)).toBe(false);
  });

  it("a probe that throws synchronously is absorbed too", async () => {
    const msg = await diagnose({
      getTab: () => {
        throw new Error("sync");
      },
      containsOrigin: () => Promise.resolve(true),
      containsFileAccess: () => Promise.resolve(true),
    });
    expect(msg).toContain("could not inspect the tab");
  });

  it("an unreadable file-access state does not claim the file cause", async () => {
    const msg = await diagnose(probeFor({ tab: loaded("file:///tmp/page.html"), file: "throw" }));
    expect(msg).not.toMatch(/^TAB NOT SCRIPTABLE/);
  });
});

describe("gateTabUrl", () => {
  const gate = (url: string | undefined, probe: TabAccessProbe, browser: "chrome" | "firefox" = "chrome") =>
    gateTabUrl(url, browser, probe, { tabId: 7, timeoutMs: 80 });

  it("returns the restricted message for restricted and blank tabs without asking the browser anything", async () => {
    for (const url of [
      "about:blank",
      "chrome://version/",
      "data:text/html,<p>x</p>",
      `view-source:${FULL_URL}`,
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/public.html",
    ]) {
      const probe = probeFor({ origin: true, file: true });
      const msg = await gate(url, probe);
      expect(msg).toMatch(/^TAB NOT SCRIPTABLE \(restricted page\):/);
      expect(msg).toContain("Tab 7");
      expect(msg).not.toContain("fake-token-123");
      expect(probe.calls).toEqual([]);
    }
  });

  it("lets web pages and tabs without a URL through, untouched", async () => {
    const probe = probeFor({ origin: false, file: false });
    expect(await gate(FULL_URL, probe)).toBeNull();
    expect(await gate("", probe)).toBeNull();
    expect(await gate(undefined, probe)).toBeNull();
    expect(probe.calls).toEqual([]);
  });

  it("file: is blocked only while file access is off; an unreadable state proceeds", async () => {
    expect(await gate("file:///tmp/page.html", probeFor({ file: false }))).toMatch(/^TAB NOT SCRIPTABLE \(file: URL\):/);
    expect(await gate("file:///tmp/page.html", probeFor({ file: true }))).toBeNull();
    expect(await gate("file:///tmp/page.html", probeFor({ file: "throw" }))).toBeNull();
    expect(await gate("file:///tmp/page.html", probeFor({ file: "hang" }))).toBeNull();
  });
});

describe("describeRestrictedPage", () => {
  it("never returns more than a scheme or a fixed phrase", () => {
    expect(describeRestrictedPage("chrome://settings/privacy")).toBe("a chrome: page");
    expect(describeRestrictedPage("about:blank#x")).toBe("a blank page (about:blank)");
    expect(describeRestrictedPage("about:config")).toBe("an about: page");
    expect(describeRestrictedPage("data:text/html,<p>fake-token-123</p>")).toBe("a data: page");
    expect(describeRestrictedPage(`view-source:${FULL_URL}`)).not.toContain("fake-token-123");
    expect(describeRestrictedPage("chrome-extension://abc/p.html")).toBe("an extension's page");
    expect(describeRestrictedPage("https://chromewebstore.google.com/x")).toBe("the Chrome Web Store");
    expect(describeRestrictedPage(undefined)).toBe("a browser page");
  });
});
