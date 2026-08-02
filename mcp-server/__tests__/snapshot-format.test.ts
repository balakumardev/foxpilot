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
    expect(text).toContain("https://example.com/callback?code=abc");
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
    // Points at the real candidate causes.
    expect(noControls).toContain("shadow root");
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
