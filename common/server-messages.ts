export interface ServerMessageBase {
  cmd: string;
}

export interface OpenTabServerMessage extends ServerMessageBase {
  cmd: "open-tab";
  url: string;
}

export interface CloseTabsServerMessage extends ServerMessageBase {
  cmd: "close-tabs";
  tabIds: number[];
}

export interface GetTabListServerMessage extends ServerMessageBase {
  cmd: "get-tab-list";
}

export interface GetBrowserRecentHistoryServerMessage extends ServerMessageBase {
  cmd: "get-browser-recent-history";
  searchQuery?: string;
}

export interface GetTabContentServerMessage extends ServerMessageBase {
  cmd: "get-tab-content";
  tabId: number;
  offset?: number;
}

export interface ReorderTabsServerMessage extends ServerMessageBase {
  cmd: "reorder-tabs";
  tabOrder: number[];
}

export interface FindHighlightServerMessage extends ServerMessageBase {
  cmd: "find-highlight";
  tabId: number;
  queryPhrase: string;
}

export interface GroupTabsServerMessage extends ServerMessageBase {
  cmd: "group-tabs";
  tabIds: number[];
  isCollapsed: boolean;
  groupColor: string;
  groupTitle: string;
}

export interface TakeSnapshotServerMessage extends ServerMessageBase {
  cmd: "take-snapshot";
  tabId: number;
  verbose?: boolean;
}

export interface NavigateTabServerMessage extends ServerMessageBase {
  cmd: "navigate-tab";
  tabId: number;
  url: string;
}

export interface NavigatePageHistoryServerMessage extends ServerMessageBase {
  cmd: "navigate-page-history";
  tabId: number;
  direction: "back" | "forward" | "reload";
  bypassCache?: boolean;
}

export interface SelectTabServerMessage extends ServerMessageBase {
  cmd: "select-tab";
  tabId: number;
}

export interface GetActiveTabServerMessage extends ServerMessageBase {
  cmd: "get-active-tab";
}

export interface WaitForTextServerMessage extends ServerMessageBase {
  cmd: "wait-for-text";
  tabId: number;
  text: string;
  timeoutMs?: number;
}

export interface ClickElementServerMessage extends ServerMessageBase {
  cmd: "click-element";
  tabId: number;
  uid: string;
  doubleClick?: boolean;
}

export interface HoverElementServerMessage extends ServerMessageBase {
  cmd: "hover-element";
  tabId: number;
  uid: string;
}

export interface FillElementServerMessage extends ServerMessageBase {
  cmd: "fill-element";
  tabId: number;
  uid: string;
  value: string;
}

export interface FillFormServerMessage extends ServerMessageBase {
  cmd: "fill-form";
  tabId: number;
  fields: { uid: string; value: string }[];
}

export interface TypeTextServerMessage extends ServerMessageBase {
  cmd: "type-text";
  tabId: number;
  text: string;
  submit?: boolean;
}

export interface PressKeyServerMessage extends ServerMessageBase {
  cmd: "press-key";
  tabId: number;
  key: string;
  modifiers?: string[];
}

// Drag the element identified by `fromUid` onto the element identified by
// `toUid` (both snapshot uids). Implemented in the page world via synthetic
// HTML5 drag events plus a pointer/mouse fallback — see action-script.ts.
export interface DragElementServerMessage extends ServerMessageBase {
  cmd: "drag-element";
  tabId: number;
  fromUid: string;
  toUid: string;
}

// Resize the BROWSER WINDOW that hosts the given tab (not the page viewport).
// A plain window operation — no page injection.
export interface ResizeWindowServerMessage extends ServerMessageBase {
  cmd: "resize-window";
  tabId: number;
  width: number;
  height: number;
}

export interface EvaluateScriptServerMessage extends ServerMessageBase {
  cmd: "evaluate-script";
  tabId: number;
  function: string;
  args?: unknown[];
}

// Upload a local file into a file <input> identified by a snapshot uid. The MCP
// server (a Node process with filesystem access) reads the file itself and ships
// the bytes here as base64 — the extension never sees a filesystem path. The
// page-world script reconstructs a `File` via `DataTransfer` and assigns it to
// the input, which is the only way to programmatically populate a file input
// (browsers forbid setting `input.value` for security).
export interface UploadFileServerMessage extends ServerMessageBase {
  cmd: "upload-file";
  tabId: number;
  uid: string;
  filename: string;
  mimeType: string;
  base64: string;
}

// Capture a screenshot of a tab. `fullPage` stitches the whole scrollable page;
// `uid` (a snapshot uid) crops to just that element; otherwise the visible
// viewport is captured. `format` defaults to png. The server-side `filePath`
// option is intentionally NOT part of this message — the extension only returns
// the image bytes, and the MCP server writes the file itself.
export interface TakeScreenshotServerMessage extends ServerMessageBase {
  cmd: "take-screenshot";
  tabId: number;
  fullPage?: boolean;
  uid?: string;
  format?: "png" | "jpeg";
}

// Read the console output captured for a tab. Page console output and uncaught
// errors are invisible to a WebExtension, so the extension captures them via an
// injected page-world wrapper (registered only while Automation Mode is on) and
// keeps a per-tab ring buffer. This is a pure buffer read — no page scripting.
// `limit` caps the number of most-recent entries returned (default: all).
export interface GetConsoleMessagesServerMessage extends ServerMessageBase {
  cmd: "get-console-messages";
  tabId: number;
  limit?: number;
}

// Arm a tab so FUTURE native JS dialogs (alert/confirm/prompt) are
// auto-handled. `action` "accept" makes confirm return true and prompt return
// `promptText` (or ""); "dismiss" makes confirm return false and prompt return
// null; alert is suppressed either way. Implemented in the page world by
// overriding window.alert/confirm/prompt. Caveat: cannot intercept an
// already-open native dialog (it blocks the page's JS thread), and the override
// is reset on navigation.
export interface HandleDialogServerMessage extends ServerMessageBase {
  cmd: "handle-dialog";
  tabId: number;
  action: "accept" | "dismiss";
  promptText?: string;
}

// Emulate device conditions for a tab. `geolocation` shims
// navigator.geolocation in the page world to report the given coordinates;
// `userAgent` shims navigator.userAgent in the page AND rewrites the User-Agent
// request header on outgoing requests (via a background webRequest listener) so
// the server-visible UA changes too. Only geolocation and userAgent are
// supported — CPU throttling, network conditions, and colorScheme are not
// feasible from a WebExtension and are intentionally omitted.
export interface EmulateServerMessage extends ServerMessageBase {
  cmd: "emulate";
  tabId: number;
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  userAgent?: string;
}

// Read the network activity captured for a tab. While Automation Mode is on the
// extension observes requests via the webRequest API into a per-tab ring
// buffer; this is a pure buffer read. `filter` is a case-insensitive substring
// match on the URL or an exact resourceType match. `limit` caps the number of
// most-recent records returned. `includeBody` opts into best-effort response
// body capture (Firefox-specific); because bodies are captured at request time,
// it only affects requests made AFTER it is enabled.
export interface GetNetworkRequestsServerMessage extends ServerMessageBase {
  cmd: "get-network-requests";
  tabId: number;
  filter?: string;
  limit?: number;
  includeBody?: boolean;
}

export type ServerMessage =
  | OpenTabServerMessage
  | CloseTabsServerMessage
  | GetTabListServerMessage
  | GetBrowserRecentHistoryServerMessage
  | GetTabContentServerMessage
  | ReorderTabsServerMessage
  | FindHighlightServerMessage
  | GroupTabsServerMessage
  | TakeSnapshotServerMessage
  | NavigateTabServerMessage
  | NavigatePageHistoryServerMessage
  | SelectTabServerMessage
  | GetActiveTabServerMessage
  | WaitForTextServerMessage
  | ClickElementServerMessage
  | HoverElementServerMessage
  | FillElementServerMessage
  | FillFormServerMessage
  | TypeTextServerMessage
  | PressKeyServerMessage
  | DragElementServerMessage
  | ResizeWindowServerMessage
  | EvaluateScriptServerMessage
  | UploadFileServerMessage
  | TakeScreenshotServerMessage
  | HandleDialogServerMessage
  | EmulateServerMessage
  | GetConsoleMessagesServerMessage
  | GetNetworkRequestsServerMessage;

export type ServerMessageRequest = ServerMessage & { correlationId: string };
