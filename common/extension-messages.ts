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
}

// Shared reply for all input-automation tools (click, hover, fill, fill-form,
// type-text, press-key). `ok` is false when the injected action failed (e.g. a
// uid could not be resolved), with a human-readable `error`.
export interface ActionResultExtensionMessage extends ExtensionMessageBase {
  resource: "action-result";
  ok: boolean;
  error?: string;
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
  body?: string;
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
  | NetworkRequestsExtensionMessage;

export interface ExtensionError {
  correlationId: string;
  errorMessage: string;
}