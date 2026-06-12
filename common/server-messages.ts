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
  | EvaluateScriptServerMessage
  | UploadFileServerMessage
  | TakeScreenshotServerMessage;

export type ServerMessageRequest = ServerMessage & { correlationId: string };
