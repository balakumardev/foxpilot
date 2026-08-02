export interface ExtensionMessageBase {
  resource: string;
  correlationId: string;
}

export interface TabContentExtensionMessage extends ExtensionMessageBase {
  resource: "tab-content";
  tabId: number;
  fullText: string;
  isTruncated: boolean;
  totalLength: number;
  links: { url: string; text: string }[];
}

export interface BrowserTab {
  id?: number;
  url?: string;
  title?: string;
  lastAccessed?: number;
}

export interface TabsExtensionMessage extends ExtensionMessageBase {
  resource: "tabs";
  tabs: BrowserTab[];
}

export interface OpenedTabIdExtensionMessage extends ExtensionMessageBase {
  resource: "opened-tab-id";
  tabId: number | undefined;
}

export interface BrowserHistoryItem {
  url?: string;
  title?: string;
  lastVisitTime?: number;
}

export interface BrowserHistoryExtensionMessage extends ExtensionMessageBase {
  resource: "history";

  historyItems: BrowserHistoryItem[];
}

export interface ReorderedTabsExtensionMessage extends ExtensionMessageBase {
  resource: "tabs-reordered";
  tabOrder: number[];
}

export interface FindHighlightExtensionMessage extends ExtensionMessageBase {
  resource: "find-highlight-result";
  noOfResults: number;
}

export interface TabsClosedExtensionMessage extends ExtensionMessageBase {
  resource: "tabs-closed";
}

export interface TabGroupCreatedExtensionMessage extends ExtensionMessageBase {
  resource: "new-tab-group";
  groupId: number;
}

export interface SnapshotExtensionMessage extends ExtensionMessageBase {
  resource: "snapshot";
  tabId: number;
  snapshot: string;
  isTruncated: boolean;
  // Phase-1 additions (append-only): total candidates collected, whether
  // more remain beyond the current page, and a query error (e.g. a
  // rootSelector/selector miss). All optional for back-compat.
  total?: number;
  hasMore?: boolean;
  error?: string;
  // Document state at snapshot time (append-only, optional for back-compat with
  // an extension that predates it). Lets the server tell a genuinely empty page
  // apart from one that was mid-navigation or had no document yet — a bare
  // `[snapshot: 0 elements]` is identical in all three cases.
  docState?: { readyState: string; url: string; bodyChildren: number };
}

export interface NavigatedExtensionMessage extends ExtensionMessageBase {
  resource: "navigated";
  tabId: number;
  url?: string;
}

export interface TabSelectedExtensionMessage extends ExtensionMessageBase {
  resource: "tab-selected";
  tabId: number;
}

export interface ActiveTabExtensionMessage extends ExtensionMessageBase {
  resource: "active-tab";
  tab: BrowserTab | null;
}

export interface WaitForTextResultExtensionMessage extends ExtensionMessageBase {
  resource: "wait-for-text-result";
  found: boolean;
  // Which needle matched (only set when the request supplied an array).
  matched?: string;
}

// Shared reply for all input-automation tools (click, hover, fill, fill-form,
// type-text, press-key). `ok` is false when the injected action failed (e.g. a
// uid could not be resolved), with a human-readable `error`.
export interface ActionResultExtensionMessage extends ExtensionMessageBase {
  resource: "action-result";
  ok: boolean;
  error?: string;
  // Set true when the input dispatched but the page began navigating before the
  // content-script ack could return (the click worked; the ack was lost to
  // page teardown). Append-only.
  navigated?: boolean;
  // Set (WITH ok:true — the click still dispatched) when a hit-test BEFORE the
  // click found a FOREIGN element covering the target's center: an overlay
  // (cookie banner, modal) is likely intercepting the click. `failIfIntercepted`
  // on the request turns this into ok:false instead. `classes` is the space-
  // joined class list; the server derives a selector for its warning. Append-
  // only. (Wave 3a. Wave 3b appends selected?/dismissed?/method? AFTER this.)
  intercepted?: {
    tag: string;
    id?: string;
    classes?: string;
    role?: string;
    name?: string;
  };
  // select-option: the control's resulting displayed value after the pick.
  // Append-only (Wave 3b, after Wave 3a's intercepted?).
  selected?: string;
  // dismiss-overlays: identifiers of what was dismissed, and how.
  dismissed?: string[];
  method?: "reject" | "remove";
}

// Reply for the evaluate-script tool. `ok` is false when the in-page evaluation
// threw or could not be retrieved (e.g. the page's CSP blocked the injected
// script and it timed out), with a human-readable `error`. On success, `value`
// holds the JSON-serializable result the page function returned.
export interface EvalResultExtensionMessage extends ExtensionMessageBase {
  resource: "eval-result";
  ok: boolean;
  value?: unknown;
  error?: string;
}

// Reply for the take-screenshot tool. `base64` is the raw (prefix-stripped)
// image payload and `mimeType` is "image/png" or "image/jpeg". The MCP server
// returns this to the model as image content and optionally writes it to disk.
export interface ScreenshotExtensionMessage extends ExtensionMessageBase {
  resource: "screenshot";
  mimeType: string;
  base64: string;
  // Set when a fallback path produced the image (e.g. full-page stitch failed
  // and a single viewport capture was returned instead). Append-only.
  warning?: string;
}

// A single captured console entry. `level` is the console method ("log",
// "info", "warn", "error", "debug") or "error" for uncaught errors/rejections.
// `text` is the args stringified and joined (truncated). `timestamp` is the
// epoch ms at which the entry was buffered in the background.
export interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: number;
}

// Reply for the get-console-messages tool: the buffered console entries for the
// requested tab (already limited to the most-recent N when a limit was given).
export interface ConsoleMessagesExtensionMessage extends ExtensionMessageBase {
  resource: "console-messages";
  entries: ConsoleEntry[];
}

// A single name/value header pair, as exposed by the webRequest API.
export interface NetworkHeader {
  name: string;
  value?: string;
}

// A single captured network request. Populated incrementally across the
// webRequest lifecycle: created on onBeforeRequest, enriched on
// onSendHeaders/onHeadersReceived, finalized on onCompleted/onErrorOccurred.
// `durationMs` is completedTimeStamp - timeStamp. `responseSize` is taken from
// the engine's reported size or the Content-Length header. `body` is a
// best-effort UTF-8 response-body snippet, only present when body capture was
// enabled (it is Firefox-specific and opt-in). Headers are optional because the
// header-extra-info specs may be unavailable on a given request.
export interface NetworkRecord {
  requestId: string;
  url: string;
  method: string;
  type: string;
  statusCode?: number;
  timeStamp: number;
  completedTimeStamp?: number;
  durationMs?: number;
  fromCache?: boolean;
  error?: string;
  responseSize?: number;
  requestHeaders?: NetworkHeader[];
  responseHeaders?: NetworkHeader[];
  // Best-effort response-body snippet (UTF-8), only when body capture is enabled:
  // Firefox via webRequest filterResponseData; Chrome/Edge only via the opt-in
  // chrome.debugger path (webRequest MV3 cannot read response bodies).
  body?: string;
  // Best-effort request-body snippet (UTF-8 text, or serialized form data),
  // captured covertly via webRequest onBeforeRequest `requestBody` when body
  // capture is enabled. Available on both browsers without the debugger.
  requestBody?: string;
}

// Reply for the get-network-requests tool: the captured network records for the
// requested tab (already filtered/limited when filter/limit were given).
export interface NetworkRequestsExtensionMessage extends ExtensionMessageBase {
  resource: "network-requests";
  requests: NetworkRecord[];
  // Chrome MV3 cannot capture response bodies (no chrome.debugger). When the
  // caller requested includeBody, the extension sets this to false so the tool
  // reports the limitation honestly instead of silently dropping bodies.
  bodyCaptureSupported?: boolean;
}

// A single cookie from the browser's cookie jar (chrome.cookies / browser.cookies).
// `value` is included so callers can read the token they asked for; the MCP tool
// layer is responsible for never LOGGING these values. `sameSite` is the engine's
// string ("no_restriction" | "lax" | "strict" | "unspecified" | ...). `session` is
// true for a session cookie (no expiry); `expirationDate` is epoch seconds.
export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  session: boolean;
  expirationDate?: number;
  storeId?: string;
}

// Reply for get-cookies. `ok` is false (with `error`) when the cookies API is
// unavailable or host permission for the domain has not been granted.
export interface CookiesExtensionMessage extends ExtensionMessageBase {
  resource: "cookies";
  ok: boolean;
  cookies?: CookieRecord[];
  error?: string;
}

// Reply for browser-fetch. `ok` is false (with `error`) on network failure,
// timeout, permission denial, or abort. On success `status`/`headers`/`finalUrl`
// describe the response; the body is returned as `bodyText` (UTF-8) or
// `bodyBase64` (binary / non-text). `truncated` is true when the body was cut off
// at `maxBytes`.
export interface BrowserFetchResultExtensionMessage extends ExtensionMessageBase {
  resource: "browser-fetch-result";
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  finalUrl?: string;
  bodyText?: string;
  bodyBase64?: string;
  truncated?: boolean;
  error?: string;
}

// Reply for stream-start. On success returns the `streamId` the caller polls,
// plus the response `status`/`headers`/`finalUrl` captured when headers arrived.
export interface StreamStartedExtensionMessage extends ExtensionMessageBase {
  resource: "stream-started";
  ok: boolean;
  streamId?: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  finalUrl?: string;
  error?: string;
}

// Reply for stream-poll. `frames` are decoded frames after the requested cursor;
// `nextIndex` is the cursor for the next poll. `done` is true once the stream has
// ended (no more frames after these). `ok` is false (with `error`) when the
// streamId is unknown/expired (e.g. the MV3 service worker was recycled) or the
// underlying read errored.
export interface StreamFramesExtensionMessage extends ExtensionMessageBase {
  resource: "stream-frames";
  ok: boolean;
  streamId: string;
  frames?: string[];
  nextIndex?: number;
  done: boolean;
  status?: number;
  error?: string;
}

// Reply for stream-close. Idempotent ack.
export interface StreamClosedExtensionMessage extends ExtensionMessageBase {
  resource: "stream-closed";
  ok: boolean;
}

// Reply for capture-response-bodies. `supported` is false on Firefox (no
// debugger; response bodies are already captured covertly there), true on
// Chrome/Edge. `enabled` echoes the resulting attach state.
export interface ResponseBodyCaptureExtensionMessage extends ExtensionMessageBase {
  resource: "response-body-capture";
  ok: boolean;
  enabled: boolean;
  supported: boolean;
  error?: string;
}

// Compact descriptor of the element under a coordinate point, returned by the
// coordinate tools (click-at/type-at/hover-at/scroll-at) for confirmation.
// `rect` is the viewport-relative bounding box in CSS px; `editable` is true
// for inputs/textareas/selects/contenteditable.
export interface PointElementDescriptor {
  tag: string;
  id?: string;
  classes: string[];
  role?: string;
  name?: string;
  rect: { x: number; y: number; w: number; h: number };
  editable?: boolean;
}

// Reply for the coordinate tools. `ok` is false (with `error`) when no element
// resolves at the point; on success `element` describes what was under it.
export interface PointActionResultExtensionMessage extends ExtensionMessageBase {
  resource: "point-action-result";
  ok: boolean;
  error?: string;
  element?: PointElementDescriptor;
  navigated?: boolean; // see ActionResultExtensionMessage.navigated
}

export type ExtensionMessage =
  | TabContentExtensionMessage
  | TabsExtensionMessage
  | OpenedTabIdExtensionMessage
  | BrowserHistoryExtensionMessage
  | ReorderedTabsExtensionMessage
  | FindHighlightExtensionMessage
  | TabsClosedExtensionMessage
  | TabGroupCreatedExtensionMessage
  | SnapshotExtensionMessage
  | NavigatedExtensionMessage
  | TabSelectedExtensionMessage
  | ActiveTabExtensionMessage
  | WaitForTextResultExtensionMessage
  | ActionResultExtensionMessage
  | EvalResultExtensionMessage
  | ScreenshotExtensionMessage
  | ConsoleMessagesExtensionMessage
  | NetworkRequestsExtensionMessage
  | CookiesExtensionMessage
  | BrowserFetchResultExtensionMessage
  | StreamStartedExtensionMessage
  | StreamFramesExtensionMessage
  | StreamClosedExtensionMessage
  | ResponseBodyCaptureExtensionMessage
  | PointActionResultExtensionMessage;

export interface ExtensionError {
  correlationId: string;
  errorMessage: string;
}