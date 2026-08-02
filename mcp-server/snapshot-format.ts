// Formats a take-snapshot result for the MCP tool: an always-on one-line count
// header (element total, plus folded truncation / more-available hints) followed
// by the snapshot text, or isError:true when the extension reported a query
// error. Extracted from server.ts — which self-executes on import (it constructs
// the BrowserAPI, connects stdio, and wires process exit, so it cannot be
// imported into a test) — for the same reason formatPointResult lives in
// point-format.ts and formatNetworkHeaders in network-format.ts.
type DocState = { readyState: string; url: string; bodyChildren: number };

// A document is treated as mid-navigation when it is still parsing. "" covers
// an extension that could not read readyState at all (defensive path in
// buildSnapshot) — unknown is closer to "cannot vouch for this tree" than to
// "settled", and this only ever adds a caveat.
function isNavigating(readyState: string): boolean {
  return readyState === "loading" || readyState === "";
}

// Keep a pathological URL from dominating the line; the origin + start of the
// path is what identifies which document was snapshotted.
function shortUrl(url: string): string {
  if (!url) return "(unknown)";
  return url.length > 120 ? `${url.slice(0, 117)}...` : url;
}

/**
 * Explains a 0-element tree, which is otherwise ambiguous three ways: a page
 * mid-navigation, a blank/torn-down document, and a real page with no
 * interactive controls all render as the same bare `[snapshot: 0 elements]`.
 *
 * Returns `[suffix, note]` — `suffix` folds into the count line beside the
 * existing truncation/hasMore hints, `note` is a following prose line (empty
 * when there is nothing worth saying). Both are empty when the extension sent
 * no `docState`, so an older extension keeps the previous output byte for byte.
 */
function explainDocState(
  total: number,
  docState?: DocState
): [suffix: string, note: string] {
  if (!docState) return ["", ""];
  const navigating = isNavigating(docState.readyState);
  const rs = docState.readyState || "unknown";

  if (total > 0) {
    // A non-empty tree read off a still-parsing document may be missing nodes.
    return navigating
      ? [", document still loading — tree may be incomplete", ""]
      : ["", ""];
  }

  if (navigating) {
    return [
      ` — NAVIGATING (readyState="${rs}", url=${shortUrl(docState.url)})`,
      "The document was still loading, so this is NOT necessarily an empty page. " +
        "Retry once it settles — or gate on the new document first with wait-for-text, " +
        "or navigate-tab's waitForSelector/waitForText.",
    ];
  }
  if (docState.bodyChildren === 0) {
    return [
      ` — NO DOCUMENT CONTENT (readyState="${rs}", url=${shortUrl(docState.url)})`,
      "The tab has no body content at all — it is blank or the document was torn down. " +
        "This is not a page that merely lacks controls.",
    ];
  }
  return [
    ` — document loaded, nothing interactive matched (readyState="${rs}")`,
    "The page has content but no interactive elements were collected. If you passed " +
      "selector/textContains/rootSelector, it filtered everything out; otherwise the " +
      "controls may live in a shadow root or an iframe.",
  ];
}

export function formatSnapshotResult(result: {
  snapshot: string;
  isTruncated: boolean;
  total?: number;
  hasMore?: boolean;
  error?: string;
  docState?: DocState;
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
    const [docSuffix, docNote] = explainDocState(result.total, result.docState);
    const countLine =
      `[snapshot: ${result.total} element${result.total === 1 ? "" : "s"}` +
      (result.isTruncated
        ? ", output truncated — narrow with rootSelector/selector/textContains"
        : "") +
      (result.hasMore ? ", more via offset/limit" : "") +
      docSuffix +
      "]";
    const body = docNote ? `${docNote}\n${result.snapshot}` : result.snapshot;
    return {
      content: [
        { type: "text" as const, text: `${countLine}\n${body}` },
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
