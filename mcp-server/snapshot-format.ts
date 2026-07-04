// Formats a take-snapshot result for the MCP tool: an always-on one-line count
// header (element total, plus folded truncation / more-available hints) followed
// by the snapshot text, or isError:true when the extension reported a query
// error. Extracted from server.ts — which self-executes on import (it constructs
// the BrowserAPI, connects stdio, and wires process exit, so it cannot be
// imported into a test) — for the same reason formatPointResult lives in
// point-format.ts and formatNetworkHeaders in network-format.ts.
export function formatSnapshotResult(result: {
  snapshot: string;
  isTruncated: boolean;
  total?: number;
  hasMore?: boolean;
  error?: string;
}) {
  if (result.error) {
    return {
      content: [
        { type: "text" as const, text: `Snapshot error: ${result.error}` },
      ],
      isError: true,
    };
  }
  // Always surface the page size so a cold agent immediately knows how big the
  // page is and when to scope. The truncation and more-available hints fold
  // into this single line (never double-printed). Guard for total being
  // undefined (an older extension that predates the count field) — fall back to
  // the prior output (no count line) so it cannot crash.
  if (typeof result.total === "number") {
    const countLine =
      `[snapshot: ${result.total} element${result.total === 1 ? "" : "s"}` +
      (result.isTruncated
        ? ", output truncated — narrow with rootSelector/selector/textContains"
        : "") +
      (result.hasMore ? ", more via offset/limit" : "") +
      "]";
    return {
      content: [
        { type: "text" as const, text: `${countLine}\n${result.snapshot}` },
      ],
    };
  }
  const truncHint = result.isTruncated
    ? "[snapshot truncated due to size]\n"
    : "";
  return {
    content: [{ type: "text" as const, text: truncHint + result.snapshot }],
  };
}
