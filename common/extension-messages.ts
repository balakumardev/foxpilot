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
  | WaitForTextResultExtensionMessage;

export interface ExtensionError {
  correlationId: string;
  errorMessage: string;
}