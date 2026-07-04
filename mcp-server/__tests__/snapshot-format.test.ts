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
