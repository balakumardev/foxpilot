/**
 * Background-side network capture.
 *
 * While Automation Mode is ON we observe network activity for all URLs via the
 * `webRequest` API and keep a bounded per-tab ring buffer that the
 * `get-network-requests` tool reads. A request is built up incrementally across
 * the lifecycle events (onBeforeRequest -> onSendHeaders -> onHeadersReceived
 * -> onCompleted / onErrorOccurred); once it finalizes it moves from an
 * in-flight map into the tab's ring buffer.
 *
 * Known caveats (documented for callers):
 *   - Only requests that occur AFTER the listeners are registered are captured
 *     (registration happens when Automation Mode turns on). Reload the page to
 *     capture its initial requests.
 *   - Response BODIES are opt-in (the `includeBody` request param) and
 *     best-effort: we attach a Firefox-specific `filterResponseData` stream
 *     filter that tees the bytes, decodes a UTF-8 snippet up to a cap, and
 *     always re-emits the data so the page still works. This needs the
 *     `webRequestBlocking` permission and is a Firefox-only API.
 *   - The live event flow and body streaming are browser-only; the pure updater
 *     functions below are what the unit tests drive with synthetic details.
 */

import type {
  NetworkRecord,
  NetworkHeader,
} from "@browser-control-mcp/common";
import { isAutomationModeEnabled } from "./extension-config";

export type { NetworkRecord, NetworkHeader };

// Max finalized records retained per tab. Oldest are dropped once exceeded so a
// chatty page cannot grow a tab's buffer without bound.
export const NETWORK_BUFFER_CAP = 200;

// Max number of still-in-flight requests we track at once. A request that never
// completes (e.g. a long-lived stream, or one whose terminal event we miss)
// would otherwise leak an in-flight entry forever, so we evict the oldest once
// this ceiling is crossed.
const INFLIGHT_CAP = 1000;

// Maximum number of UTF-8 bytes of a response body we retain (best-effort).
const MAX_BODY_BYTES = 64 * 1024;

// Per-tab ring buffer of finalized records. Keyed by tabId.
const buffers = new Map<number, NetworkRecord[]>();

// Requests seen on onBeforeRequest but not yet finalized. Keyed by requestId.
const inFlight = new Map<string, NetworkRecord>();

// Whether best-effort response-body capture is enabled. Toggled by the tool
// (via the `includeBody` param). Because bodies are captured at request time,
// flipping this only affects requests made afterwards.
let bodyCaptureEnabled = false;

/**
 * Enable/disable best-effort response-body capture for FUTURE requests.
 */
export function setBodyCaptureEnabled(enabled: boolean): void {
  bodyCaptureEnabled = enabled;
}

// ---- pure updater functions (unit-tested with synthetic details) ----

// The subset of webRequest `details` fields we read. Kept permissive (extra
// fields are ignored) so synthetic test objects and real events both fit.
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

/**
 * onBeforeRequest: create the in-flight record for this request.
 */
export function onBeforeRequestRecord(details: WebRequestDetails): void {
  // Requests not associated with a tab (tabId < 0, e.g. extension/system
  // requests) are not useful to a per-tab tool, so skip them.
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
  // Stash the owning tab so finalize can route it without re-reading details.
  recordTabId.set(details.requestId, details.tabId);
  inFlight.set(details.requestId, record);
  evictInFlightIfNeeded();
}

/**
 * onSendHeaders: attach the request headers to the in-flight record.
 */
export function onSendHeadersRecord(details: WebRequestDetails): void {
  const record = inFlight.get(details.requestId);
  if (!record) {
    return;
  }
  if (details.requestHeaders) {
    record.requestHeaders = details.requestHeaders;
  }
}

/**
 * onHeadersReceived: attach the status code and response headers.
 */
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

/**
 * onCompleted: finalize the record (status, fromCache, size, timing) and push
 * it into the owning tab's ring buffer.
 */
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

/**
 * onErrorOccurred: finalize the record with the error string and push it into
 * the owning tab's ring buffer.
 */
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

// Remembers which tab each in-flight requestId belongs to, so the terminal
// events (which may also carry tabId, but we don't want to depend on it) can
// route the record. Cleared alongside the in-flight entry.
const recordTabId = new Map<string, number>();

// Pull the in-flight record for a terminal event. If we never saw the
// onBeforeRequest (e.g. it predates registration), synthesize a record from the
// terminal details so the activity is still reported rather than dropped.
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

// Compute the response size, preferring the engine-reported `responseSize`,
// falling back to a Content-Length response header.
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

// Set completedTimeStamp and durationMs from the terminal event's timeStamp.
function finalizeTiming(record: NetworkRecord, details: WebRequestDetails): void {
  const completed =
    typeof details.timeStamp === "number" ? details.timeStamp : Date.now();
  record.completedTimeStamp = completed;
  record.durationMs = Math.max(0, completed - record.timeStamp);
}

// Push a finalized record into its tab's ring buffer, dropping the oldest once
// the per-tab cap is exceeded. Also clears the requestId->tab mapping.
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

// Evict the oldest in-flight entries (Map preserves insertion order) when the
// in-flight map grows past its ceiling, so never-completing requests can't leak.
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

/**
 * Return a tab's captured network records, newest-last. With `filter`, keeps
 * records whose URL contains the filter (case-insensitive) OR whose resource
 * type exactly equals it. With `limit`, returns only the most-recent `limit`
 * records (after filtering). Always returns a fresh array.
 */
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

/**
 * Clear a tab's captured records (called on tab removal). Also drops any
 * in-flight requests belonging to that tab.
 */
export function clearNetworkRequests(tabId: number): void {
  buffers.delete(tabId);
  for (const [requestId, owner] of recordTabId) {
    if (owner === tabId) {
      recordTabId.delete(requestId);
      inFlight.delete(requestId);
    }
  }
}

// ---- webRequest listener registration ----

// The listener references, kept so they can be removed. `null` means not
// registered. Registration is idempotent.
let listeners: {
  onBeforeRequest: (d: any) => any;
  onSendHeaders: (d: any) => void;
  onHeadersReceived: (d: any) => void;
  onCompleted: (d: any) => void;
  onErrorOccurred: (d: any) => void;
} | null = null;

/**
 * Register the webRequest listeners for all URLs. Idempotent: a no-op if already
 * registered. Wrapped in try/catch because it needs the `webRequest` (and, for
 * body capture, `webRequestBlocking`) permissions; on failure we log and ignore
 * so the rest of the extension keeps working.
 */
export async function registerNetworkListeners(): Promise<void> {
  if (listeners) {
    return;
  }
  try {
    const allUrls = { urls: ["<all_urls>"] };

    const onBeforeRequest = (details: any): any => {
      onBeforeRequestRecord(details);
      // Opt-in, best-effort body capture (Firefox-specific). Only attach the
      // stream filter when body capture is enabled, so the default path stays
      // light. The filter MUST always re-emit the bytes so the page still works.
      if (bodyCaptureEnabled) {
        attachBodyFilter(details);
      }
      return undefined;
    };
    const onSendHeaders = (details: any): void => onSendHeadersRecord(details);
    const onHeadersReceived = (details: any): void =>
      onHeadersReceivedRecord(details);
    const onCompleted = (details: any): void => onCompletedRecord(details);
    const onErrorOccurred = (details: any): void =>
      onErrorOccurredRecord(details);

    browser.webRequest.onBeforeRequest.addListener(
      onBeforeRequest,
      allUrls,
      // "blocking" is required for filterResponseData to be usable in the
      // handler; harmless for the no-body path.
      ["blocking"]
    );
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
    console.error(
      "network-capture: failed to register webRequest listeners:",
      error
    );
  }
}

/**
 * Remove the webRequest listeners if registered. Idempotent.
 */
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
    console.error(
      "network-capture: failed to unregister webRequest listeners:",
      error
    );
  }
}

// Attach a Firefox-specific filterResponseData stream filter that accumulates
// response bytes (up to a cap), decodes them as UTF-8, and stores the snippet on
// the captured record. It ALWAYS writes each chunk back out and disconnects on
// stop, so the page receives its response unchanged. This is browser-only and
// best-effort: any failure is swallowed so the request still completes.
//
// We capture the record OBJECT REFERENCE here (it is guaranteed to be in-flight
// at onBeforeRequest time) rather than re-fetching it on stop. onCompleted moves
// the same object out of the in-flight map into the tab buffer WITHOUT cloning,
// so mutating the captured reference on stop lands the body on the right record
// regardless of whether the filter's onstop fires before or after onCompleted.
function attachBodyFilter(details: any): void {
  try {
    const frd = (browser.webRequest as any).filterResponseData;
    if (typeof frd !== "function") {
      return;
    }
    const record = inFlight.get(details.requestId);
    if (!record) {
      return;
    }
    const filter = frd(details.requestId);
    const chunks: Uint8Array[] = [];
    let total = 0;

    filter.ondata = (event: { data: ArrayBuffer }) => {
      if (total < MAX_BODY_BYTES) {
        const bytes = new Uint8Array(event.data);
        const remaining = MAX_BODY_BYTES - total;
        chunks.push(remaining >= bytes.length ? bytes : bytes.subarray(0, remaining));
        total += bytes.length;
      }
      // Always re-emit so the page still works.
      filter.write(event.data);
    };

    filter.onstop = () => {
      try {
        if (chunks.length > 0) {
          const merged = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
          }
          record.body = new TextDecoder("utf-8", { fatal: false }).decode(merged);
        }
      } catch (e) {
        /* best-effort: ignore decode failures */
      }
      filter.disconnect();
    };

    filter.onerror = () => {
      try {
        filter.disconnect();
      } catch (e) {
        /* ignore */
      }
    };
  } catch (e) {
    /* best-effort: body capture must never break the request */
  }
}

/**
 * Initialize background network capture. Call ONCE from background.ts after the
 * config is loaded. Importing this module must NOT trigger any browser API call
 * (so tests can import the buffer/updater helpers freely) — all listener
 * registration happens here.
 */
export function initNetworkCapture(): void {
  // 1) Drop a tab's records when the tab goes away.
  browser.tabs.onRemoved.addListener((tabId: number) => {
    clearNetworkRequests(tabId);
  });

  // 2) Register/unregister the webRequest listeners as Automation Mode flips.
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
      }
    }
  );

  // 3) If Automation Mode is already on at startup, register immediately.
  void isAutomationModeEnabled().then((enabled) => {
    if (enabled) {
      void registerNetworkListeners();
    }
  });
}
