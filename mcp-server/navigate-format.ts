// Formats a navigate-tab result for the MCP tool. Extracted from server.ts —
// which self-executes on import (it constructs the BrowserAPI, connects stdio,
// and wires process exit, so it cannot be imported into a test) — for the same
// reason formatPointResult lives in point-format.ts and formatSnapshotResult in
// snapshot-format.ts.
//
// `committed: false` means the extension never saw the navigation commit, so
// `url` is the page the tab is STILL on ("" from an extension that sent a
// never-committed Chrome tab's url as-is). Printing that as "Navigated tab N to
// <url>" presents the old page as the destination — the exact bug this guards —
// so that case gets its own wording, with any unmet waitFor* condition kept
// apart from the url. It stays a success, not isError: the navigation was
// issued and may still land. Without the flag (a committed navigation, or an
// older extension that predates it) the established one-line wording is
// unchanged.
//
// The extension also folds that condition into `url` as "<url> — <mismatch>",
// the form every reply had before `mismatch` existed, so an older server that
// prints `url` verbatim still shows it. Here it is stripped back off, so it is
// printed once.

// Chrome reports urls normalized (e.g. a trailing "/" on a bare origin), so
// compare the way it would print them.
function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

export function formatNavigateResult(
  requestedUrl: string,
  result: {
    tabId: number;
    url?: string;
    committed?: boolean;
    pendingUrl?: string;
    mismatch?: string;
  }
): { content: { type: "text"; text: string }[]; isError?: boolean } {
  if (result.committed === false) {
    let current = result.url;
    const folded = result.mismatch ? ` — ${result.mismatch}` : "";
    if (folded && current && current.endsWith(folded)) {
      current = current.slice(0, current.length - folded.length);
    }
    const shows = current
      ? `the tab still shows ${current}`
      : "the tab has not loaded a page yet";
    const loading = !result.pendingUrl
      ? ""
      : sameUrl(result.pendingUrl, requestedUrl)
        ? " and is still loading it"
        : ` and is still loading ${result.pendingUrl}`;
    const unmet = result.mismatch
      ? ` The wait condition was not met either: ${result.mismatch}.`
      : "";
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Navigation of tab ${result.tabId} to ${requestedUrl} has not committed: ` +
            `${shows}${loading}.${unmet} ` +
            "The page may still be loading, or the URL returned no page (a download, " +
            "a 204, or a blocked navigation). Check get-list-of-open-tabs or " +
            "take-snapshot before acting on the page.",
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `Navigated tab ${result.tabId} to ${result.url ?? requestedUrl}`,
      },
    ],
  };
}
