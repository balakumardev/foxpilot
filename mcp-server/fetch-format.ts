// Formats the browser-fetch reply text. Extracted from server.ts (which
// self-executes on import) so it is a pure function that can be imported and
// unit-tested directly — the same reason network-format.ts and
// snapshot-format.ts live in their own modules.
//
// Three things live here besides the plain "<status> <url> / headers / body"
// layout:
//   1. The tab-context banner. A fetch that ran INSIDE a tab (tabId) says so,
//      with the page origin it ran as, so the agent never mistakes it for a
//      background (extension-origin) response.
//   2. The old-extension guard. An extension that predates `tabId` ignores it
//      and runs the background fetch, replying WITHOUT context:"tab". That
//      response must never be presented as a tab response, so it becomes an
//      error.
//   3. The empty-body 401/403 hint. A bare 401/403 with no body gives the agent
//      nothing to go on; the cause differs by context, so the hint does too.

export interface BrowserFetchRequestInfo {
  url: string;
  tabId?: number;
  method?: string;
}

// The subset of BrowserFetchResultExtensionMessage this module reads.
export interface BrowserFetchReply {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  finalUrl?: string;
  bodyText?: string;
  bodyBase64?: string;
  truncated?: boolean;
  error?: string;
  context?: "tab" | "background";
  tabOrigin?: string;
}

export interface FormattedBrowserFetch {
  text: string;
  isError: boolean;
}

// A response with nothing in it: no text, and no bytes either. An empty body of
// a type the extension does not treat as text arrives as bodyBase64 === "", and
// an extension that sent neither field means the same thing.
function isEmptyBody(reply: BrowserFetchReply): boolean {
  const noText = reply.bodyText === undefined || reply.bodyText.trim() === "";
  const noBytes = reply.bodyBase64 === undefined || reply.bodyBase64.length === 0;
  return noText && noBytes;
}

const BACKGROUND_HINT =
  "Hint: this request ran in the extension background, so it carried the extension's Origin " +
  "(not the app's) and no page Referer. A site that checks Origin, Referer or a CSRF token often " +
  "answers that with an empty 401/403. Retry with tabId set to a tab on the same site to send it as the page.";

const TAB_HINT =
  "Hint: this request already carried the page's Origin, Referer and cookies, so the session may have " +
  "expired, or the app adds a header itself (CSRF or auth token). Compare with the page's own request " +
  "using get-network-requests with includeHeaders.";

export function formatBrowserFetchReply(
  request: BrowserFetchRequestInfo,
  reply: BrowserFetchReply
): FormattedBrowserFetch {
  const tabRequested = request.tabId !== undefined;

  if (tabRequested && reply.context !== "tab") {
    // An extension that predates tabId ran the request anyway, from its
    // background. It was SENT (or at least attempted), so the advice must not be
    // "call it again without tabId": for a POST/PUT/PATCH/DELETE that sends it a
    // second time. The fix is to update the extension; until then, check first.
    const verb = (request.method ?? "GET").toUpperCase();
    const changesState = !["GET", "HEAD", "OPTIONS"].includes(verb);
    let sent: string;
    if (reply.ok) {
      sent =
        ` The extension ran the request from its background instead` +
        `${reply.status !== undefined ? ` (HTTP ${reply.status})` : ""}, so it WAS sent once` +
        ` and that response is not shown because it is not what the page would have received.`;
    } else {
      sent =
        ` The extension ran the request from its background instead and reported a failure` +
        `${reply.error ? ` (${reply.error})` : ""}; it may or may not have reached the server.`;
    }
    const next = changesState
      ? ` This ${verb} may already have taken effect: check before sending it again, and update the FoxPilot extension before using tabId.`
      : ` Update the FoxPilot extension, then retry with tabId.`;
    return {
      text:
        `Fetch NOT run inside tab ${request.tabId}: the connected FoxPilot extension is too old for tabId mode ` +
        `(it ignores tabId and runs every browser-fetch from its background, with the extension's Origin), ` +
        `so nothing was sent in the page context.${sent}${next}`,
      isError: true,
    };
  }

  if (!reply.ok) {
    // Only a transport-level failure (network/timeout/permission/abort) is an
    // error; a non-2xx HTTP status is handled as success below.
    return {
      text: `Fetch failed: ${reply.error ?? "unknown error"}`,
      isError: true,
    };
  }

  const inTab = reply.context === "tab";
  const banner = inTab
    ? `[ran inside tab ${request.tabId} as the page${
        reply.tabOrigin ? `: origin ${reply.tabOrigin}` : ""
      }]\n`
    : "";
  const statusLine = `${reply.status ?? "?"} ${reply.statusText ?? ""}  ${
    reply.finalUrl ?? request.url
  }`;
  const headersBlock = JSON.stringify(reply.headers ?? {}, null, 2);
  const bodyBlock =
    reply.bodyText !== undefined
      ? reply.bodyText
      : `[binary body: base64 length ${reply.bodyBase64?.length ?? 0}]`;
  const truncatedNote = reply.truncated ? "\n(truncated)" : "";
  const hint =
    (reply.status === 401 || reply.status === 403) && isEmptyBody(reply)
      ? `\n\n${inTab ? TAB_HINT : BACKGROUND_HINT}`
      : "";

  return {
    text: `${banner}${statusLine}\n\n${headersBlock}\n\n${bodyBlock}${truncatedNote}${hint}`,
    isError: false,
  };
}
