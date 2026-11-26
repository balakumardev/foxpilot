import {
  filterTabsByText,
  redactTabUrl,
  selectTabs,
  singleLine,
} from "@foxpilot/common";

describe("redactTabUrl", () => {
  it("keeps scheme, host and path of a plain URL", () => {
    expect(redactTabUrl("https://app.example.test/docs/page")).toBe(
      "https://app.example.test/docs/page"
    );
  });

  it("removes the query string and leaves a marker", () => {
    expect(
      redactTabUrl("https://app.example.test/login?token=fake-token-123&x=1")
    ).toBe("https://app.example.test/login?[redacted]");
  });

  it("removes the fragment too (implicit-flow OAuth puts access_token there)", () => {
    expect(
      redactTabUrl("https://app.example.test/cb#access_token=fake-token-123")
    ).toBe("https://app.example.test/cb#[redacted]");
  });

  it("removes query and fragment together", () => {
    expect(
      redactTabUrl(
        "https://app.example.test/cb?code=fake-code-9&state=s#access_token=fake-token-123"
      )
    ).toBe("https://app.example.test/cb?[redacted]#[redacted]");
  });

  it("drops userinfo without a marker", () => {
    const out = redactTabUrl("https://fakeuser:fake-pass-1@app.example.test/p");
    expect(out).toBe("https://app.example.test/p");
    expect(out).not.toMatch(/fake-pass|fakeuser/);
  });

  it("keeps a non-default port and drops a default one", () => {
    expect(redactTabUrl("http://localhost:8080/a?b=1")).toBe(
      "http://localhost:8080/a?[redacted]"
    );
    expect(redactTabUrl("https://app.example.test:443/a")).toBe(
      "https://app.example.test/a"
    );
  });

  it("handles an IPv6 host with a port", () => {
    expect(redactTabUrl("http://[::1]:3000/x?y=fake-token-123#z")).toBe(
      "http://[::1]:3000/x?[redacted]#[redacted]"
    );
  });

  it("adds no marker for an empty query or fragment", () => {
    expect(redactTabUrl("https://app.example.test/p?#")).toBe(
      "https://app.example.test/p"
    );
  });

  it("keeps a hash-router path out of the output (the fragment is redacted)", () => {
    expect(redactTabUrl("https://app.example.test/#/inbox/fake-id-77")).toBe(
      "https://app.example.test/#[redacted]"
    );
  });

  it("reduces data:, javascript:, blob: and vbscript: URLs to their scheme", () => {
    expect(redactTabUrl("data:text/html;base64,ZmFrZS1zZWNyZXQ=")).toBe(
      "data:[redacted]"
    );
    expect(redactTabUrl("javascript:alert('fake-token-123')")).toBe(
      "javascript:[redacted]"
    );
    expect(
      redactTabUrl("blob:https://app.example.test/0b1c2d3e-fake-uuid")
    ).toBe("blob:[redacted]");
    expect(redactTabUrl("vbscript:msgbox(1)")).toBe("vbscript:[redacted]");
  });

  it("recognises a payload scheme through case and embedded control characters", () => {
    expect(redactTabUrl("  DATA:text/plain,fake-secret")).toBe("data:[redacted]");
    expect(redactTabUrl("java\nscript:alert(1)")).toBe("javascript:[redacted]");
  });

  it("handles a very long data: URL without leaking or exploding", () => {
    const huge = "data:text/html;base64," + "QUJD".repeat(2_000_000);
    const out = redactTabUrl(huge);
    expect(out).toBe("data:[redacted]");
  });

  it("keeps browser-internal pages and strips their query", () => {
    expect(redactTabUrl("about:blank")).toBe("about:blank");
    expect(redactTabUrl("about:reader?url=https%3A%2F%2Fapp.example.test%2F%3Ft%3Dfake")).toBe(
      "about:reader?[redacted]"
    );
    expect(redactTabUrl("chrome://settings/passwords")).toBe(
      "chrome://settings/passwords"
    );
    expect(redactTabUrl("chrome-extension://fakeextid/page.html?tab=1#x")).toBe(
      "chrome-extension://fakeextid/page.html?[redacted]#[redacted]"
    );
    expect(redactTabUrl("moz-extension://fake-uuid/options.html")).toBe(
      "moz-extension://fake-uuid/options.html"
    );
  });

  it("keeps a file: path but not its query, and truncates a very long path", () => {
    expect(redactTabUrl("file:///tmp/report.html?x=1")).toBe(
      "file:///tmp/report.html?[redacted]"
    );
    const long = redactTabUrl("file:///" + "a".repeat(500));
    expect(long.length).toBeLessThan(160);
    expect(long.endsWith("...")).toBe(true);
  });

  it("redacts through view-source: and never recurses without bound", () => {
    expect(
      redactTabUrl("view-source:https://u:fake-pass-1@app.example.test/p?t=fake-token-123")
    ).toBe("view-source:https://app.example.test/p?[redacted]");
    expect(redactTabUrl("view-source:".repeat(5000) + "https://a.test/")).toBe(
      "view-source:view-source:view-source:[redacted]"
    );
  });

  it("reduces an unknown opaque scheme to the scheme", () => {
    expect(redactTabUrl("mailto:someone@app.example.test?subject=fake")).toBe(
      "mailto:[redacted]"
    );
  });

  it("falls back to cutting at the first ? or # for an unparsable URL", () => {
    expect(redactTabUrl("http://[bad host/x?token=fake-token-123#frag")).toBe(
      "http://[bad host/x?[redacted]#[redacted]"
    );
    expect(redactTabUrl("not a url #only-fragment")).toBe(
      "not a url #[redacted]"
    );
    // a ? after the # belongs to the fragment, so only the fragment marker shows
    expect(redactTabUrl("not a url #frag?x")).toBe("not a url #[redacted]");
  });

  it("drops userinfo and truncates in the unparsable fallback", () => {
    const out = redactTabUrl("http://fakeuser:fake-pass-1@[bad/" + "p".repeat(500));
    expect(out).not.toMatch(/fake-pass|fakeuser/);
    expect(out.length).toBeLessThan(260);
  });

  it("returns an empty string for an empty URL", () => {
    expect(redactTabUrl("")).toBe("");
  });

  it("never contains a newline, whatever the input", () => {
    expect(redactTabUrl("not a url\nsecond line?x=1")).not.toMatch(/[\r\n]/);
  });

  it.each([
    "https://app.example.test/cb?code=fake-code-9#access_token=fake-token-123",
    "https://u:fake-pass-1@app.example.test:8443/a/b?x=1",
    "http://[::1]:3000/x?y#z",
    "data:text/html,fake-secret",
    "blob:https://app.example.test/fake-uuid",
    "about:reader?url=https%3A%2F%2Fapp.example.test%2F",
    "chrome://settings/",
    "file:///" + "a".repeat(500),
    "view-source:https://app.example.test/p?t=1",
    "http://[bad host/x?token=fake-token-123#frag",
    "http://fakeuser:fake-pass-1@[bad/" + "p".repeat(500),
    "not a url #frag",
    "",
  ])("is idempotent: %s", (input) => {
    const once = redactTabUrl(input);
    expect(redactTabUrl(once)).toBe(once);
  });
});

describe("singleLine", () => {
  it("turns newlines, tabs and other control characters into single spaces", () => {
    expect(singleLine("a\nb\r\nc\td\u0000e")).toBe("a b c d e");
    expect(singleLine("  edge  ")).toBe("edge");
  });
});

describe("selectTabs", () => {
  const tabs = [
    {
      id: 1,
      windowId: 7,
      url: "https://app.example.test/inbox?token=fake-token-123",
      title: "Inbox",
      lastAccessed: 5,
      favIconUrl: "data:image/png;base64,AAAA",
    },
    { id: 2, windowId: 7, url: "https://docs.example.test/guide", title: "Guide" },
    { id: 3, windowId: 8, title: "No url" },
  ];

  it("keeps only the slim fields", () => {
    const out = selectTabs(tabs, {});
    expect(Object.keys(out[0]).sort()).toEqual([
      "id",
      "lastAccessed",
      "title",
      "url",
      "windowId",
    ]);
    expect(out).toHaveLength(3);
  });

  it("keeps the cookie store of a Firefox container tab only", () => {
    const out = selectTabs(
      [
        { id: 4, url: "https://a.example.test/", cookieStoreId: "firefox-container-3" },
        { id: 5, url: "https://b.example.test/", cookieStoreId: "firefox-default" },
        { id: 6, url: "https://c.example.test/", cookieStoreId: "firefox-private" },
      ],
      {}
    );
    expect(out[0].cookieStoreId).toBe("firefox-container-3");
    expect("cookieStoreId" in out[1]).toBe(false);
    expect(out[2].cookieStoreId).toBe("firefox-private");
  });

  it("redacts URLs only when asked", () => {
    expect(selectTabs(tabs, { redactUrls: true })[0].url).toBe(
      "https://app.example.test/inbox?[redacted]"
    );
    expect(selectTabs(tabs, {})[0].url).toBe(tabs[0].url);
  });

  it("matches urlContains on the redacted URL, so token text finds nothing", () => {
    expect(
      selectTabs(tabs, { urlContains: "fake-token-123", redactUrls: true })
    ).toEqual([]);
    expect(
      selectTabs(tabs, { urlContains: "fake-token-123", redactUrls: false }).map(
        (t) => t.id
      )
    ).toEqual([1]);
  });

  it("matches case-insensitively and ANDs url and title", () => {
    expect(
      selectTabs(tabs, { urlContains: "EXAMPLE.TEST", redactUrls: true }).map(
        (t) => t.id
      )
    ).toEqual([1, 2]);
    expect(
      selectTabs(tabs, {
        urlContains: "example.test",
        titleContains: "gUiDe",
        redactUrls: true,
      }).map((t) => t.id)
    ).toEqual([2]);
  });

  it("does not match a tab without a url against a url filter, and treats empty needles as no filter", () => {
    // tab 3 has no url: it can never match a url filter
    expect(selectTabs(tabs, { urlContains: "." }).map((t) => t.id)).toEqual([1, 2]);
    expect(selectTabs(tabs, { urlContains: "", titleContains: "" })).toHaveLength(3);
  });
});

describe("filterTabsByText", () => {
  const tabs = [
    { id: 1, windowId: 7, url: "https://a.example.test/p?t=fake-token-123", title: "Alpha" },
    { id: 2, windowId: 8, url: "https://b.example.test/", title: "Beta" },
    { id: 3, url: "https://c.example.test/", title: "Gamma" },
  ];

  it("applies windowId, but keeps a tab whose window id the reply does not carry", () => {
    expect(filterTabsByText(tabs, { windowId: 7 }).map((t) => t.id)).toEqual([1, 3]);
  });

  it("returns the original tab objects, unredacted", () => {
    const out = filterTabsByText(tabs, { urlContains: "a.example", redactUrls: true });
    expect(out[0]).toBe(tabs[0]);
  });

  it("matches the raw URL only without redactUrls", () => {
    expect(filterTabsByText(tabs, { urlContains: "fake-token-123", redactUrls: true })).toEqual([]);
    expect(
      filterTabsByText(tabs, { urlContains: "fake-token-123" }).map((t) => t.id)
    ).toEqual([1]);
  });
});
