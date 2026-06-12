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
  | WaitForTextServerMessage;

export type ServerMessageRequest = ServerMessage & { correlationId: string };
