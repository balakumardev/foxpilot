import { formatTabList, listOpenTabs } from "../tab-list-format";

const NOW = Date.parse("2026-10-17T10:00:00Z");
const minutesAgo = (n: number) => NOW - n * 60_000;

function texts(items: { type: "text"; text: string }[]): string[] {
  return items.map((i) => i.text);
}

const base = { offset: 0, limit: 100, now: NOW };

describe("formatTabList", () => {
  const tabs = [
    { id: 1, url: "https://a.example.test/", title: "A", lastAccessed: minutesAgo(3), windowId: 7 },
    { id: 2, url: "https://b.example.test/", title: "B", windowId: 8 },
    { id: 3, url: "https://c.example.test/", title: "C" },
  ];

  it("prints a pagination header followed by one line per tab", () => {
    const out = texts(formatTabList(tabs, base));
    expect(out[0]).toBe("Showing tabs 1-3 of 3 total tabs");
    expect(out).toHaveLength(4);
  });

  it("keeps the existing line shape and appends the window id when known", () => {
    const out = texts(formatTabList(tabs, base));
    expect(out[1]).toBe(
      "tab id=1, tab url=https://a.example.test/, tab title=A, last accessed=3 minutes ago, window id=7"
    );
    // no lastAccessed -> "unknown"; no windowId -> no suffix at all
    expect(out[2]).toBe(
      "tab id=2, tab url=https://b.example.test/, tab title=B, last accessed=unknown, window id=8"
    );
    expect(out[3]).toBe(
      "tab id=3, tab url=https://c.example.test/, tab title=C, last accessed=unknown"
    );
  });

  it("appends the Firefox container of a tab that is in one, and nothing for the default store", () => {
    const out = texts(
      formatTabList(
        [
          { id: 5, url: "https://a.example.test/", title: "A", windowId: 7, cookieStoreId: "firefox-container-2" },
          { id: 6, url: "https://b.example.test/", title: "B", windowId: 7, cookieStoreId: "firefox-default" },
        ],
        base
      )
    );
    expect(out[1]).toBe(
      "tab id=5, tab url=https://a.example.test/, tab title=A, last accessed=unknown, window id=7, cookieStoreId=firefox-container-2"
    );
    expect(out[2]).toBe(
      "tab id=6, tab url=https://b.example.test/, tab title=B, last accessed=unknown, window id=7"
    );
  });

  it("treats window id 0 as a real window", () => {
    const out = texts(
      formatTabList([{ id: 9, url: "https://a.example.test/", title: "t", windowId: 0 }], {
        ...base,
        limit: 10,
      })
    );
    expect(out[1]).toContain(", window id=0");
  });

  it("prints unknown for a tab whose url the browser did not report", () => {
    const out = texts(formatTabList([{ id: 4, title: "No url" }], base));
    expect(out[1]).toContain("tab url=unknown,");
  });

  it("paginates and points at the next offset", () => {
    const out = texts(formatTabList(tabs, { ...base, offset: 1, limit: 1 }));
    expect(out[0]).toBe(
      "Showing tabs 2-2 of 3 total tabs (use offset=2 to see more)"
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toContain("tab id=2");
  });

  it("clamps the limit to 1..500", () => {
    const many = Array.from({ length: 600 }, (_, i) => ({
      id: i,
      url: "https://a.example.test/",
      title: "t",
    }));
    expect(formatTabList(many, { ...base, limit: 9999 })).toHaveLength(1 + 500);
    expect(formatTabList(many, { ...base, limit: 0 })).toHaveLength(1 + 1);
  });

  it("says so plainly when there are no tabs", () => {
    expect(texts(formatTabList([], base))).toEqual(["No open tabs."]);
  });

  it("says the filters matched nothing when they did", () => {
    const out = texts(formatTabList([], { ...base, windowId: 7 }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/no open tabs match/i);
    expect(out[0]).toMatch(/windowId|activeOnly|visibleOnly|urlContains|titleContains/);
  });

  describe("offset past the end", () => {
    it("says there are no more tabs instead of printing a reversed range", () => {
      const out = texts(formatTabList(tabs, { ...base, offset: 5 }));
      expect(out).toHaveLength(1);
      expect(out[0]).toBe(
        "No more tabs at offset=5: there are 3 total tabs (use offset=0 to start from the first)."
      );
      expect(out[0]).not.toMatch(/Showing tabs/);
    });

    it("counts the matching tabs when filtered, and handles a single one", () => {
      const out = texts(
        formatTabList(tabs, { ...base, offset: 9, urlContains: "b.example" })
      );
      expect(out[0]).toBe(
        "No more tabs at offset=9: there is 1 matching tab (use offset=0 to start from the first)."
      );
    });

    it("treats offset equal to the count as past the end", () => {
      const out = texts(formatTabList(tabs, { ...base, offset: 3 }));
      expect(out[0]).toMatch(/^No more tabs at offset=3/);
    });
  });

  describe("URL redaction", () => {
    const secret = [
      {
        id: 5,
        windowId: 3,
        url: "https://fakeuser:fake-pass-1@app.example.test:8443/cb?code=fake-code-9#access_token=fake-token-123",
        title: "Sign in",
      },
    ];

    it("shows scheme, host, port and path only, with markers, by default", () => {
      const out = texts(formatTabList(secret, base));
      expect(out[1]).toBe(
        "tab id=5, tab url=https://app.example.test:8443/cb?[redacted]#[redacted], tab title=Sign in, last accessed=unknown, window id=3"
      );
      const all = out.join("\n");
      expect(all).not.toMatch(/fake-token-123|fake-code-9|fake-pass-1|fakeuser/);
    });

    it("redacts a URL the (older) extension sent raw, and leaves an already-redacted one alone", () => {
      const already = [
        { id: 6, url: "https://app.example.test/cb?[redacted]#[redacted]", title: "x" },
      ];
      expect(texts(formatTabList(already, base))[1]).toContain(
        "tab url=https://app.example.test/cb?[redacted]#[redacted],"
      );
    });

    it("prints the raw URL with fullUrls", () => {
      const out = texts(formatTabList(secret, { ...base, fullUrls: true }));
      expect(out[1]).toContain(
        "tab url=https://fakeuser:fake-pass-1@app.example.test:8443/cb?code=fake-code-9#access_token=fake-token-123,"
      );
    });

    it("does not let a data: URL through", () => {
      const out = texts(
        formatTabList(
          [{ id: 7, url: "data:text/html;base64,ZmFrZS1zZWNyZXQ=", title: "d" }],
          base
        )
      );
      expect(out[1]).toContain("tab url=data:[redacted],");
    });
  });

  describe("compact", () => {
    it("prints one short line per tab: id, window, host+path, title", () => {
      const out = texts(
        formatTabList(
          [
            { id: 12, windowId: 3, url: "https://app.example.test/path?x=fake-token-123", title: "Dashboard" },
            { id: 13, url: "http://plain.example.test/", title: "No window" },
          ],
          { ...base, compact: true }
        )
      );
      expect(out[0]).toBe("Showing tabs 1-2 of 2 total tabs");
      expect(out[1]).toBe("id=12 win=3 app.example.test/path?[redacted] | Dashboard");
      expect(out[2]).toBe("id=13 plain.example.test/ | No window");
    });

    it("shows the Firefox container after the window", () => {
      const out = texts(
        formatTabList(
          [{ id: 18, windowId: 3, url: "https://a.example.test/", title: "A", cookieStoreId: "firefox-container-4" }],
          { ...base, compact: true }
        )
      );
      expect(out[1]).toBe("id=18 win=3 cookieStoreId=firefox-container-4 a.example.test/ | A");
    });

    it("keeps the scheme of a non-http URL and leaves out last-accessed", () => {
      const out = texts(
        formatTabList(
          [{ id: 14, windowId: 1, url: "about:blank", title: "", lastAccessed: minutesAgo(1) }],
          { ...base, compact: true }
        )
      );
      expect(out[1]).toBe("id=14 win=1 about:blank");
      expect(out[1]).not.toMatch(/last accessed/);
    });

    it("cuts a long title to about 60 characters with an ellipsis", () => {
      const title = "T".repeat(200);
      const out = texts(
        formatTabList([{ id: 15, url: "https://a.example.test/", title }], {
          ...base,
          compact: true,
        })
      );
      const printed = out[1].split(" | ")[1];
      expect(printed).toHaveLength(60);
      expect(printed.endsWith("…")).toBe(true);
    });

    it("does not split a surrogate pair when cutting", () => {
      const title = "\u{1F600}".repeat(100);
      const out = texts(
        formatTabList([{ id: 16, url: "https://a.example.test/", title }], {
          ...base,
          compact: true,
        })
      );
      const printed = out[1].split(" | ")[1];
      expect(Array.from(printed)).toHaveLength(60);
    });

    it("shows raw URLs minus the scheme with fullUrls", () => {
      const out = texts(
        formatTabList(
          [{ id: 17, url: "https://app.example.test/p?x=fake-token-123", title: "t" }],
          { ...base, compact: true, fullUrls: true }
        )
      );
      expect(out[1]).toBe("id=17 app.example.test/p?x=fake-token-123 | t");
    });
  });

  describe("titles stay on one line", () => {
    it("collapses newlines and control characters in both modes", () => {
      const tab = [
        { id: 18, url: "https://a.example.test/", title: "line one\nline two\r\n\tline three\u0000" },
      ];
      for (const compact of [false, true]) {
        const out = texts(formatTabList(tab, { ...base, compact }));
        expect(out).toHaveLength(2);
        expect(out[1]).not.toMatch(/[\r\n\t\u0000]/);
        expect(out[1]).toContain("line one line two line three");
      }
    });
  });

  describe("filters", () => {
    const set = [
      { id: 1, windowId: 7, url: "https://app.example.test/inbox?token=fake-token-123", title: "Inbox - Mail" },
      { id: 2, windowId: 7, url: "https://docs.example.test/guide", title: "Guide" },
      { id: 3, windowId: 8, url: "https://app.example.test/settings", title: "Settings" },
    ];

    it("urlContains filters, case-insensitively, and the header says matching", () => {
      const out = texts(formatTabList(set, { ...base, urlContains: "APP.EXAMPLE" }));
      expect(out[0]).toBe("Showing tabs 1-2 of 2 matching tabs");
      expect(out).toHaveLength(3);
    });

    it("titleContains filters, and both filters are ANDed", () => {
      expect(
        texts(formatTabList(set, { ...base, titleContains: "mail" }))[0]
      ).toBe("Showing tabs 1-1 of 1 matching tabs");
      const both = texts(
        formatTabList(set, { ...base, urlContains: "app.example", titleContains: "settings" })
      );
      expect(both).toHaveLength(2);
      expect(both[1]).toContain("tab id=3");
    });

    it("urlContains cannot probe a token: it matches the redacted URL", () => {
      const out = texts(formatTabList(set, { ...base, urlContains: "fake-token-123" }));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatch(/no open tabs match/i);
    });

    it("urlContains matches the raw URL with fullUrls", () => {
      const out = texts(
        formatTabList(set, { ...base, urlContains: "fake-token-123", fullUrls: true })
      );
      expect(out[0]).toBe("Showing tabs 1-1 of 1 matching tabs");
      expect(out[1]).toContain("token=fake-token-123");
    });

    it("re-applies windowId on the server, combined with the text filters", () => {
      const out = texts(
        formatTabList(set, { ...base, windowId: 7, urlContains: "app.example" })
      );
      expect(out[0]).toBe("Showing tabs 1-1 of 1 matching tabs");
      expect(out[1]).toContain("tab id=1");
    });

    it("counts and paginates after filtering", () => {
      const out = texts(
        formatTabList(set, { ...base, urlContains: "example.test", limit: 2 })
      );
      expect(out[0]).toBe(
        "Showing tabs 1-2 of 3 matching tabs (use offset=2 to see more)"
      );
    });

    it("ignores empty filter strings", () => {
      const out = texts(formatTabList(set, { ...base, urlContains: "", titleContains: "" }));
      expect(out[0]).toBe("Showing tabs 1-3 of 3 total tabs");
    });
  });

  describe("older extension (no filtersApplied marker)", () => {
    const tabsWith = [{ id: 1, windowId: 7, url: "https://a.example.test/", title: "A" }];

    it("appends one NOTE naming activeOnly / visibleOnly it could not confirm", () => {
      const out = texts(
        formatTabList(tabsWith, { ...base, activeOnly: true, visibleOnly: true })
      );
      const note = out[out.length - 1];
      expect(note).toMatch(/^NOTE: activeOnly and visibleOnly could not be confirmed/);
      expect(note).not.toMatch(/\n/);
      expect(out.filter((l) => l.startsWith("NOTE:"))).toHaveLength(1);
    });

    it("names only the filter that was asked for, and also notes an empty result", () => {
      const out = texts(formatTabList([], { ...base, visibleOnly: true }));
      expect(out[0]).toMatch(/no open tabs match/i);
      expect(out[1]).toMatch(/^NOTE: visibleOnly could not be confirmed/);
      expect(out[1]).not.toMatch(/activeOnly/);
    });

    it("adds no note when the extension confirmed the filters", () => {
      const out = texts(
        formatTabList(tabsWith, {
          ...base,
          activeOnly: true,
          visibleOnly: true,
          filtersApplied: true,
        })
      );
      expect(out.some((l) => l.startsWith("NOTE:"))).toBe(false);
    });

    it("adds no note for filters the server verified itself", () => {
      const out = texts(
        formatTabList(tabsWith, { ...base, windowId: 7, urlContains: "a.example" })
      );
      expect(out.some((l) => l.startsWith("NOTE:"))).toBe(false);
    });
  });
});

describe("listOpenTabs", () => {
  it("asks the extension to redact by default and passes the filters through", async () => {
    const getTabListResult = jest
      .fn()
      .mockResolvedValue({ tabs: [], filtersApplied: true });
    await listOpenTabs(
      { getTabListResult },
      {
        offset: 0,
        limit: 10,
        windowId: 4,
        activeOnly: true,
        urlContains: "example",
        titleContains: "",
      }
    );
    expect(getTabListResult).toHaveBeenCalledWith({
      windowId: 4,
      activeOnly: true,
      visibleOnly: undefined,
      urlContains: "example",
      titleContains: undefined,
      redactUrls: true,
    });
  });

  it("turns redaction off in the request when fullUrls is set", async () => {
    const getTabListResult = jest
      .fn()
      .mockResolvedValue({ tabs: [], filtersApplied: true });
    await listOpenTabs({ getTabListResult }, { offset: 0, limit: 10, fullUrls: true });
    expect(getTabListResult.mock.calls[0][0].redactUrls).toBe(false);
  });

  it("formats the reply and notes an unconfirmed activeOnly", async () => {
    const getTabListResult = jest.fn().mockResolvedValue({
      tabs: [{ id: 1, windowId: 2, url: "https://a.example.test/p?x=1", title: "A" }],
      filtersApplied: false,
    });
    const out = texts(
      await listOpenTabs(
        { getTabListResult },
        { offset: 0, limit: 10, activeOnly: true, compact: true }
      )
    );
    expect(out[0]).toBe("Showing tabs 1-1 of 1 matching tabs");
    expect(out[1]).toBe("id=1 win=2 a.example.test/p?[redacted] | A");
    expect(out[2]).toMatch(/^NOTE: activeOnly could not be confirmed/);
  });
});
