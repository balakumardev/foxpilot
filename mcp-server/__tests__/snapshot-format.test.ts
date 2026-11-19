import { formatSnapshotResult } from "../snapshot-format";

// Pins the always-on element-count line prepended to take-snapshot output
// (Fix 3). Mirrors the formatPointResult unit block in coordinate-tools.test.ts:
// the wire tests (take-snapshot-args.test.ts) only drive api.takeSnapshot and
// assert the result FIELDS (total/hasMore); the composed MCP tool text is
// formatted here and can only be exercised via this pure function, since
// server.ts self-executes on import and cannot be imported into a test.
describe("formatSnapshotResult", () => {
  type Out = { content: { type: string; text: string }[]; isError?: boolean };

  it("always prepends a compact count line on a default snapshot (no query)", () => {
    const out = formatSnapshotResult({
      snapshot: 'button "Go" [uid=e1]',
      isTruncated: false,
      total: 3,
      hasMore: false,
    }) as Out;
    expect(out.isError).toBeUndefined();
    const text = out.content[0].text;
    expect(text.startsWith("[snapshot: 3 elements]\n")).toBe(true);
    expect(text).toContain('button "Go" [uid=e1]');
  });

  it("uses the singular 'element' for a single match", () => {
    const out = formatSnapshotResult({
      snapshot: "x",
      isTruncated: false,
      total: 1,
      hasMore: false,
    }) as Out;
    expect(out.content[0].text.startsWith("[snapshot: 1 element]\n")).toBe(true);
  });

  it("folds the truncation hint into the one count line (no double-print)", () => {
    const out = formatSnapshotResult({
      snapshot: "x",
      isTruncated: true,
      total: 120,
      hasMore: false,
    }) as Out;
    const text = out.content[0].text;
    expect(text).toContain(
      "[snapshot: 120 elements, output truncated — narrow with rootSelector/selector/textContains]"
    );
    // Exactly one count line, and NOT the legacy standalone truncation banner.
    expect(text.match(/\[snapshot:/g)!.length).toBe(1);
    expect(text).not.toContain("[snapshot truncated due to size]");
  });

  it("adds the more-available hint when hasMore is set", () => {
    const out = formatSnapshotResult({
      snapshot: "x",
      isTruncated: false,
      total: 50,
      hasMore: true,
    }) as Out;
    expect(out.content[0].text).toContain(
      "[snapshot: 50 elements, more via offset/limit]"
    );
  });

  it("falls back to no count line when total is undefined (older extension)", () => {
    const out = formatSnapshotResult({
      snapshot: 'link "Home" [uid=e1]',
      isTruncated: false,
    }) as Out;
    expect(out.content[0].text).toBe('link "Home" [uid=e1]');
    expect(out.content[0].text).not.toContain("[snapshot:");
  });

  it("preserves the legacy truncation banner in the undefined-total fallback", () => {
    const out = formatSnapshotResult({
      snapshot: "x",
      isTruncated: true,
    }) as Out;
    expect(out.content[0].text).toBe("[snapshot truncated due to size]\nx");
  });

  it("returns isError with the extension's query error", () => {
    const out = formatSnapshotResult({
      snapshot: "",
      isTruncated: false,
      error: "rootSelector matched no element: #missing",
    }) as Out;
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe(
      "Snapshot error: rootSelector matched no element: #missing"
    );
  });
});

/**
 * A bare `[snapshot: 0 elements]` is ambiguous three ways — mid-navigation, a
 * blank/torn-down document, and a real page with no controls all produce it.
 * These pin the docState-driven disambiguation, and pin that output is
 * unchanged when there is nothing extra to say.
 */
describe("formatSnapshotResult: empty-tree disambiguation via docState", () => {
  type Out = { content: { type: string; text: string }[]; isError?: boolean };

  const fmt = (
    total: number,
    docState?: { readyState: string; url: string; bodyChildren: number },
    snapshot = ""
  ) =>
    (
      formatSnapshotResult({
        snapshot,
        isTruncated: false,
        total,
        hasMore: false,
        docState,
      }) as Out
    ).content[0].text;

  it("flags a still-loading document as NAVIGATING, not empty", () => {
    const text = fmt(0, {
      readyState: "loading",
      url: "https://example.com/callback?code=abc",
      bodyChildren: 0,
    });
    expect(text).toContain("NAVIGATING");
    expect(text).toContain('readyState="loading"');
    // The URL is shown REDACTED: a mid-navigation tab is often on a login or
    // OAuth redirect, and its query or fragment can carry a token.
    expect(text).toContain("https://example.com/callback?[redacted]");
    expect(text).not.toContain("code=abc");
    expect(text).toContain("NOT necessarily an empty page");
    // Never an error — the snapshot itself succeeded.
    expect(
      (
        formatSnapshotResult({
          snapshot: "",
          isTruncated: false,
          total: 0,
          hasMore: false,
          docState: { readyState: "loading", url: "u", bodyChildren: 0 },
        }) as Out
      ).isError
    ).toBeUndefined();
  });

  it("distinguishes a blank document from a page with no controls", () => {
    const blank = fmt(0, {
      readyState: "complete",
      url: "about:blank",
      bodyChildren: 0,
    });
    expect(blank).toContain("NO DOCUMENT CONTENT");
    expect(blank).toContain("about:blank");
    expect(blank).not.toContain("NAVIGATING");

    const noControls = fmt(0, {
      readyState: "complete",
      url: "https://example.com/article",
      bodyChildren: 42,
    });
    expect(noControls).toContain("nothing interactive matched");
    expect(noControls).not.toContain("NO DOCUMENT CONTENT");
    expect(noControls).not.toContain("NAVIGATING");
    // Points at the real candidate causes: iframes are still not walked, but
    // open and closed shadow roots now are, so they are no longer blamed.
    expect(noControls).toContain("iframe");
    expect(noControls).toContain("not walked");
    expect(noControls).toContain("open and closed shadow roots are");
    expect(noControls).not.toContain("may live in a shadow root");
  });

  it("treats an unreadable readyState as navigating rather than settled", () => {
    const text = fmt(0, { readyState: "", url: "u", bodyChildren: 0 });
    expect(text).toContain("NAVIGATING");
    expect(text).toContain('readyState="unknown"');
  });

  it("caveats a non-empty tree read off a still-loading document", () => {
    const text = fmt(
      5,
      { readyState: "loading", url: "u", bodyChildren: 3 },
      "button x"
    );
    expect(text.startsWith("[snapshot: 5 elements, document still loading")).toBe(
      true
    );
    expect(text).toContain("tree may be incomplete");
    expect(text).toContain("button x");
  });

  it("leaves a settled, non-empty snapshot byte-identical to before", () => {
    const text = fmt(
      3,
      { readyState: "complete", url: "https://example.com", bodyChildren: 10 },
      'button "Go" [uid=e1]'
    );
    expect(text).toBe('[snapshot: 3 elements]\nbutton "Go" [uid=e1]');
  });

  it("falls back to the previous output when the extension sends no docState", () => {
    // Back-compat: an extension predating docState must not change output.
    expect(fmt(0, undefined)).toBe("[snapshot: 0 elements]\n");
    expect(fmt(2, undefined, "a\nb")).toBe("[snapshot: 2 elements]\na\nb");
  });

  it("keeps the truncation and hasMore hints alongside the docState suffix", () => {
    const out = formatSnapshotResult({
      snapshot: "x",
      isTruncated: true,
      total: 120,
      hasMore: true,
      docState: { readyState: "loading", url: "u", bodyChildren: 5 },
    }) as Out;
    const text = out.content[0].text;
    expect(text).toContain("output truncated");
    expect(text).toContain("more via offset/limit");
    expect(text).toContain("document still loading");
    // Still exactly one bracketed header.
    expect(text.match(/\[snapshot:/g)).toHaveLength(1);
  });
});

describe("formatSnapshotResult: URL redaction in the docState suffixes", () => {
  type Out = { content: { type: string; text: string }[] };
  const fmt = (docState: { readyState: string; url: string; bodyChildren: number }) =>
    (
      formatSnapshotResult({
        snapshot: "",
        isTruncated: false,
        total: 0,
        hasMore: false,
        docState,
      }) as Out
    ).content[0].text;

  it("NAVIGATING drops the query, the fragment and userinfo (fake token)", () => {
    const text = fmt({
      readyState: "loading",
      url: "https://user:fake-token-123@app.example.test/cb?token=fake-token-123#access_token=fake-token-123",
      bodyChildren: 0,
    });
    expect(text).toContain("url=https://app.example.test/cb?[redacted]#[redacted]");
    expect(text).not.toContain("fake-token-123");
  });

  it("NO DOCUMENT CONTENT is redacted the same way", () => {
    const text = fmt({
      readyState: "complete",
      url: "https://app.example.test/login?next=%2Fa&sid=fake-token-123",
      bodyChildren: 0,
    });
    expect(text).toContain("NO DOCUMENT CONTENT");
    expect(text).toContain("url=https://app.example.test/login?[redacted]");
    expect(text).not.toContain("fake-token-123");
  });

  it("an empty url still reads (unknown), and a redacted data: url never leaks its payload", () => {
    expect(fmt({ readyState: "loading", url: "", bodyChildren: 0 })).toContain("url=(unknown)");
    const data = fmt({ readyState: "loading", url: "data:text/html,fake-token-123", bodyChildren: 0 });
    expect(data).toContain("url=data:[redacted]");
    expect(data).not.toContain("fake-token-123");
  });

  it("a plain url without query or fragment is unchanged", () => {
    expect(fmt({ readyState: "loading", url: "https://app.example.test/a/b", bodyChildren: 0 })).toContain(
      "url=https://app.example.test/a/b)"
    );
  });
});

/**
 * The extension waited (a still-loading tab, or an unrendered app shell) before
 * answering. Without `waitedMs` the output must stay byte-for-byte what it was.
 */
describe("formatSnapshotResult: the wait is reported (waitedMs / tabStatus)", () => {
  type Out = { content: { type: string; text: string }[]; isError?: boolean };
  const loadingDoc = { readyState: "loading", url: "https://app.example.test/?sid=fake-token-123", bodyChildren: 1 };
  const completeShell = { readyState: "complete", url: "https://app.example.test/", bodyChildren: 1 };

  const fmt = (
    over: {
      total: number;
      docState?: { readyState: string; url: string; bodyChildren: number };
      waitedMs?: number;
      tabStatus?: string;
      isTruncated?: boolean;
      hasMore?: boolean;
    },
    snapshot = ""
  ) =>
    (
      formatSnapshotResult({
        snapshot,
        isTruncated: false,
        hasMore: false,
        ...over,
      }) as Out
    ).content[0].text;

  it("still empty and still loading: says how long it waited and the tab status", () => {
    const text = fmt({ total: 0, docState: loadingDoc, waitedMs: 5003, tabStatus: "loading" });
    expect(text.split("\n")[0]).toBe(
      "[snapshot: 0 elements — waited 5.0 s, page still loading (tab status: loading)]"
    );
    expect(text).toContain("NOT necessarily an empty page");
    // A filtered query that matched nothing must not be read as "page not ready".
    expect(text).toContain("If you passed selector/textContains/rootSelector, the page may also simply not contain a match");
    // No URL in this variant, so nothing that could carry a token.
    expect(text).not.toContain("fake-token-123");
    expect(text).not.toContain("NAVIGATING");
  });

  it("still empty on a complete but unrendered shell: loaded, nothing interactive yet", () => {
    const text = fmt({ total: 0, docState: completeShell, waitedMs: 1500, tabStatus: "complete" });
    expect(text.split("\n")[0]).toBe(
      "[snapshot: 0 elements — waited 1.5 s, page loaded but rendered nothing interactive yet]"
    );
    expect(text).toContain("Take a fresh snapshot in a moment");
  });

  it("empty on a complete shell with no docState and no tabStatus reads the same", () => {
    expect(fmt({ total: 0, waitedMs: 1500 }).split("\n")[0]).toBe(
      "[snapshot: 0 elements — waited 1.5 s, page loaded but rendered nothing interactive yet]"
    );
  });

  it("found elements after waiting: says it waited for the page to render", () => {
    const text = fmt(
      { total: 12, docState: { readyState: "complete", url: "u", bodyChildren: 9 }, waitedMs: 640, tabStatus: "complete" },
      'button "Go" [uid=e1]'
    );
    expect(text).toBe('[snapshot: 12 elements — waited 0.6 s for the page to render]\nbutton "Go" [uid=e1]');
  });

  it("found elements but the document is still loading keeps that caveat", () => {
    const text = fmt({ total: 2, docState: loadingDoc, waitedMs: 300, tabStatus: "loading" }, "x");
    expect(text.split("\n")[0]).toBe(
      "[snapshot: 2 elements — waited 0.3 s for the page to render, document still loading — tree may be incomplete]"
    );
  });

  it("names readyState when the tab says complete but the document is not", () => {
    const text = fmt({
      total: 0,
      docState: { readyState: "interactive", url: "u", bodyChildren: 1 },
      waitedMs: 5000,
      tabStatus: "complete",
    });
    expect(text.split("\n")[0]).toBe(
      "[snapshot: 0 elements — waited 5.0 s, page still loading (tab status: complete, readyState: interactive)]"
    );
  });

  it("formats the duration with one decimal", () => {
    expect(fmt({ total: 0, waitedMs: 0 }).split("\n")[0]).toContain("waited 0.0 s");
    expect(fmt({ total: 0, waitedMs: 1234 }).split("\n")[0]).toContain("waited 1.2 s");
    expect(fmt({ total: 0, waitedMs: 12960 }).split("\n")[0]).toContain("waited 13.0 s");
  });

  it("keeps the truncation and hasMore hints beside the wait", () => {
    const text = fmt({
      total: 120,
      isTruncated: true,
      hasMore: true,
      docState: { readyState: "complete", url: "u", bodyChildren: 9 },
      waitedMs: 900,
      tabStatus: "complete",
    }, "x");
    expect(text.split("\n")[0]).toBe(
      "[snapshot: 120 elements, output truncated — narrow with rootSelector/selector/textContains, more via offset/limit — waited 0.9 s for the page to render]"
    );
  });

  it("a query error stays an error, never reported as a wait", () => {
    const out = formatSnapshotResult({
      snapshot: "",
      isTruncated: false,
      total: 0,
      error: "rootSelector matched no element: #missing",
      waitedMs: 5000,
      tabStatus: "loading",
    }) as Out;
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("Snapshot error: rootSelector matched no element: #missing");
  });

  it("without waitedMs the output is exactly what it was before this field existed", () => {
    expect(fmt({ total: 0, docState: loadingDoc, tabStatus: "loading" }).split("\n")[0]).toBe(
      "[snapshot: 0 elements — NAVIGATING (readyState=\"loading\", url=https://app.example.test/?[redacted])]"
    );
    expect(fmt({ total: 3, docState: completeShell }, "a")).toBe("[snapshot: 3 elements]\na");
    expect(fmt({ total: 0 })).toBe("[snapshot: 0 elements]\n");
  });
});
