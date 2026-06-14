/**
 * Background-side network capture for Chrome MV3.
 *
 * Uses non-blocking webRequest listeners (blocking is not available in MV3
 * service workers). Response body capture is NOT supported in Chrome MV3.
 */

import type { NetworkRecord, NetworkHeader } from "@foxpilot/common";
import { isAutomationModeEnabled } from "./extension-config";

export type { NetworkRecord, NetworkHeader };

export const NETWORK_BUFFER_CAP = 200;
const INFLIGHT_CAP = 1000;

const buffers = new Map<number, NetworkRecord[]>();
const inFlight = new Map<string, NetworkRecord>();
const recordTabId = new Map<string, number>();

interface WebRequestDetails {
  requestId: string;
  url?: string;
  method?: string;
  type?: string;
  tabId?: number;
  timeStamp?: number;
  statusCode?: number;
  fromCache?: boolean;
  error?: string;
  responseSize?: number;
  requestHeaders?: NetworkHeader[];
  responseHeaders?: NetworkHeader[];
}

export function onBeforeRequestRecord(details: WebRequestDetails): void {
  if (typeof details.tabId !== "number" || details.tabId < 0) {
    return;
  }
  const record: NetworkRecord = {
    requestId: details.requestId,
    url: details.url ?? "",
    method: details.method ?? "GET",
    type: details.type ?? "other",
    timeStamp: typeof details.timeStamp === "number" ? details.timeStamp : Date.now(),
  };
  recordTabId.set(details.requestId, details.tabId);
  inFlight.set(details.requestId, record);
  evictInFlightIfNeeded();
}

export function onSendHeadersRecord(details: WebRequestDetails): void {
  const record = inFlight.get(details.requestId);
  if (!record) {
    return;
  }
  if (details.requestHeaders) {
    record.requestHeaders = details.requestHeaders;
  }
}

export function onHeadersReceivedRecord(details: WebRequestDetails): void {
  const record = inFlight.get(details.requestId);
  if (!record) {
    return;
  }
  if (typeof details.statusCode === "number") {
    record.statusCode = details.statusCode;
  }
  if (details.responseHeaders) {
    record.responseHeaders = details.responseHeaders;
  }
}

export function onCompletedRecord(details: WebRequestDetails): void {
  const record = takeOrSynthesize(details);
  if (!record) {
    return;
  }
  if (typeof details.statusCode === "number") {
    record.statusCode = details.statusCode;
  }
  if (typeof details.fromCache === "boolean") {
    record.fromCache = details.fromCache;
  }
  if (details.responseHeaders && !record.responseHeaders) {
    record.responseHeaders = details.responseHeaders;
  }
  const size = computeResponseSize(details, record);
  if (size !== undefined) {
    record.responseSize = size;
  }
  finalizeTiming(record, details);
  pushToTab(details, record);
}

export function onErrorOccurredRecord(details: WebRequestDetails): void {
  const record = takeOrSynthesize(details);
  if (!record) {
    return;
  }
  if (typeof details.error === "string") {
    record.error = details.error;
  }
  finalizeTiming(record, details);
  pushToTab(details, record);
}

function takeOrSynthesize(details: WebRequestDetails): NetworkRecord | null {
  const existing = inFlight.get(details.requestId);
  if (existing) {
    inFlight.delete(details.requestId);
    return existing;
  }
  const tabId = details.tabId;
  if (typeof tabId !== "number" || tabId < 0) {
    return null;
  }
  return {
    requestId: details.requestId,
    url: details.url ?? "",
    method: details.method ?? "GET",
    type: details.type ?? "other",
    timeStamp: typeof details.timeStamp === "number" ? details.timeStamp : Date.now(),
  };
}

function computeResponseSize(
  details: WebRequestDetails,
  record: NetworkRecord
): number | undefined {
  if (typeof details.responseSize === "number" && details.responseSize >= 0) {
    return details.responseSize;
  }
  const headers = details.responseHeaders ?? record.responseHeaders;
  if (headers) {
    for (const h of headers) {
      if (h.name && h.name.toLowerCase() === "content-length" && h.value) {
        const n = parseInt(h.value, 10);
        if (!Number.isNaN(n)) {
          return n;
        }
      }
    }
  }
  return undefined;
}

function finalizeTiming(record: NetworkRecord, details: WebRequestDetails): void {
  const completed = typeof details.timeStamp === "number" ? details.timeStamp : Date.now();
  record.completedTimeStamp = completed;
  record.durationMs = Math.max(0, completed - record.timeStamp);
}

function pushToTab(details: WebRequestDetails, record: NetworkRecord): void {
  const tabId = recordTabId.get(record.requestId) ?? details.tabId;
  recordTabId.delete(record.requestId);
  if (typeof tabId !== "number" || tabId < 0) {
    return;
  }
  let buf = buffers.get(tabId);
  if (!buf) {
    buf = [];
    buffers.set(tabId, buf);
  }
  buf.push(record);
  if (buf.length > NETWORK_BUFFER_CAP) {
    buf.splice(0, buf.length - NETWORK_BUFFER_CAP);
  }
}

function evictInFlightIfNeeded(): void {
  if (inFlight.size <= INFLIGHT_CAP) {
    return;
  }
  const overflow = inFlight.size - INFLIGHT_CAP;
  let removed = 0;
  for (const key of inFlight.keys()) {
    inFlight.delete(key);
    recordTabId.delete(key);
    if (++removed >= overflow) {
      break;
    }
  }
}

export function getNetworkRequests(
  tabId: number,
  opts?: { filter?: string; limit?: number }
): NetworkRecord[] {
  const buf = buffers.get(tabId);
  if (!buf || buf.length === 0) {
    return [];
  }
  let records = buf.slice();
  const filter = opts?.filter;
  if (filter) {
    const needle = filter.toLowerCase();
    records = records.filter(
      (r) => r.url.toLowerCase().includes(needle) || r.type === filter
    );
  }
  const limit = opts?.limit;
  if (limit !== undefined && limit >= 0 && limit < records.length) {
    records = records.slice(records.length - limit);
  }
  return records;
}

export function clearNetworkRequests(tabId: number): void {
  buffers.delete(tabId);
  for (const [requestId, owner] of recordTabId) {
    if (owner === tabId) {
      recordTabId.delete(requestId);
      inFlight.delete(requestId);
    }
  }
}

export function clearAllNetworkState(): void {
  buffers.clear();
  inFlight.clear();
  recordTabId.clear();
}

let listeners: {
  onBeforeRequest: (d: any) => any;
  onSendHeaders: (d: any) => void;
  onHeadersReceived: (d: any) => void;
  onCompleted: (d: any) => void;
  onErrorOccurred: (d: any) => void;
} | null = null;

export async function registerNetworkListeners(): Promise<void> {
  if (listeners) {
    return;
  }
  try {
    const allUrls = { urls: ["<all_urls>"] };
    const onBeforeRequest = (details: any): any => {
      onBeforeRequestRecord(details);
      return undefined;
    };
    const onSendHeaders = (details: any): void => onSendHeadersRecord(details);
    const onHeadersReceived = (details: any): void => onHeadersReceivedRecord(details);
    const onCompleted = (details: any): void => onCompletedRecord(details);
    const onErrorOccurred = (details: any): void => onErrorOccurredRecord(details);

    browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, allUrls);
    browser.webRequest.onSendHeaders.addListener(onSendHeaders, allUrls, [
      "requestHeaders",
    ]);
    browser.webRequest.onHeadersReceived.addListener(
      onHeadersReceived,
      allUrls,
      ["responseHeaders"]
    );
    browser.webRequest.onCompleted.addListener(onCompleted, allUrls, [
      "responseHeaders",
    ]);
    browser.webRequest.onErrorOccurred.addListener(onErrorOccurred, allUrls);

    listeners = {
      onBeforeRequest,
      onSendHeaders,
      onHeadersReceived,
      onCompleted,
      onErrorOccurred,
    };
  } catch (error) {
    console.error("network-capture: failed to register webRequest listeners:", error);
  }
}

export async function unregisterNetworkListeners(): Promise<void> {
  const l = listeners;
  listeners = null;
  if (!l) {
    return;
  }
  try {
    browser.webRequest.onBeforeRequest.removeListener(l.onBeforeRequest);
    browser.webRequest.onSendHeaders.removeListener(l.onSendHeaders);
    browser.webRequest.onHeadersReceived.removeListener(l.onHeadersReceived);
    browser.webRequest.onCompleted.removeListener(l.onCompleted);
    browser.webRequest.onErrorOccurred.removeListener(l.onErrorOccurred);
  } catch (error) {
    console.error("network-capture: failed to unregister webRequest listeners:", error);
  }
}

export function initNetworkCapture(): void {
  browser.tabs.onRemoved.addListener((tabId: number) => {
    clearNetworkRequests(tabId);
  });

  browser.storage.onChanged.addListener(
    (
      changes: { [key: string]: { oldValue?: unknown; newValue?: unknown } },
      areaName: string
    ) => {
      if (areaName !== "local" || !changes.config) {
        return;
      }
      const newConfig = changes.config.newValue as
        | { automationMode?: boolean }
        | undefined;
      const enabled = newConfig?.automationMode === true;
      if (enabled) {
        void registerNetworkListeners();
      } else {
        void unregisterNetworkListeners();
        clearAllNetworkState();
      }
    }
  );

  void isAutomationModeEnabled().then((enabled) => {
    if (enabled) {
      void registerNetworkListeners();
    }
  });
}
