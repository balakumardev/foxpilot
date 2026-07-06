/**
 * Background-side network capture for Chrome MV3.
 *
 * Uses non-blocking webRequest listeners (blocking is not available in MV3
 * service workers). Response BODIES are NOT supported in Chrome MV3 (that needs
 * chrome.debugger). REQUEST bodies, however, ride along covertly on the
 * `onBeforeRequest` `requestBody` extraInfoSpec — no debugger required — and are
 * captured (best-effort, capped) when body capture is enabled via the tool's
 * `includeBody` param.
 */

import type { NetworkRecord, NetworkHeader } from "@foxpilot/common";
import { isAutomationModeEnabled } from "./extension-config";

export type { NetworkRecord, NetworkHeader };

export const NETWORK_BUFFER_CAP = 200;
const INFLIGHT_CAP = 1000;

// Maximum number of request-body bytes we decode/retain (best-effort). Mirrors
// the Firefox response-body cap so a large upload can't bloat a record.
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

// Maximum number of RESPONSE-body characters we retain from the chrome.debugger
// (CDP) deep-capture path. Mirrors the request-body cap so a large response
// can't bloat a record. Best-effort snippets are already char-clamped.
const MAX_BODY_BYTES = 64 * 1024;

const buffers = new Map<number, NetworkRecord[]>();
const inFlight = new Map<string, NetworkRecord>();
const recordTabId = new Map<string, number>();

// --- Opt-in chrome.debugger (CDP) deep-capture path (Chrome/Edge only) ---
//
// Attaching the debugger is the ONLY way MV3 can read RESPONSE bodies, but it
// shows a "started debugging this browser" banner and is detectable by the page.
// It populates the SAME per-tab buffers as the covert webRequest path; while a
// tab is attached for the NETWORK purpose the debugger OWNS it and the
// webRequest path is skipped for that tab (see the hasNetworkPurpose guards in
// onBeforeRequestRecord / onCompletedRecord / onErrorOccurredRecord) so a
// request is never recorded twice. CDP request ids are strings in a SEPARATE namespace from webRequest
// ids, so they get their own in-flight map to avoid any collision.
//
// Purpose-refcounted chrome.debugger attach. A tab's debugger can be held by
// more than one PURPOSE at once: "network" (response-body deep-capture, which
// runs Network.enable) and "input" (the engine:"cdp" trusted coordinate tools,
// which dispatch Input.* and never enable the Network domain). We attach once,
// run Network.enable only for the network purpose, and only really detach when
// the LAST purpose releases — so a CDP click on a tab that is already capturing
// response bodies does not tear the capture down, and vice-versa.
type DebuggerPurpose = "network" | "input" | "eval";
// Per-tab purpose tracker: a Set (membership), NOT a counter. A Set is correct
// here — not an undercount waiting to happen — because the broker serializes
// tool calls per tab (see getMessageTabId / "Serialize per tab" in
// mcp-server/broker-core.ts), so two engine:"cdp" input dispatches never
// attach/detach the same tab concurrently (no two "input" holders at once). The
// only genuine multi-holder case is one "network" purpose (response-body
// deep-capture) coexisting with one "input" purpose (a CDP coordinate dispatch)
// on the same tab — and those are two DISTINCT Set members, so membership
// tracking releases the debugger exactly when the LAST purpose leaves.
const attachedPurposes = new Map<number, Set<DebuggerPurpose>>();
const cdpInFlight = new Map<string, NetworkRecord>();
const cdpRequestTab = new Map<string, number>();
let cdpListenersRegistered = false;

// True when the NETWORK purpose holds the debugger for this tab — i.e. response
// bodies are being deep-captured. The covert webRequest path is suppressed only
// for such tabs (an input-only CDP attach must NOT suppress covert capture,
// since it never enables the Network domain).
function hasNetworkPurpose(tabId: number): boolean {
  const s = attachedPurposes.get(tabId);
  return !!s && s.has("network");
}

/**
 * Whether the chrome.debugger deep-capture path is currently attached to a tab
 * (i.e. response bodies are being captured for it). Used by the tool to report
 * `bodyCaptureSupported` honestly.
 */
export function isDebuggerAttached(tabId: number): boolean {
  return hasNetworkPurpose(tabId);
}

// Whether best-effort request-body capture is enabled. Toggled by the tool (via
// the `includeBody` param). Because bodies are captured at request time
// (onBeforeRequest), flipping this only affects requests made afterwards.
let bodyCaptureEnabled = false;

/**
 * Enable/disable best-effort request-body capture for FUTURE requests.
 */
export function setBodyCaptureEnabled(enabled: boolean): void {
  bodyCaptureEnabled = enabled;
}

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
  // Present on onBeforeRequest when the `requestBody` extraInfoSpec is set:
  // either urlencoded/multipart form fields (`formData`) or raw byte parts
  // (`raw`); `error` is set by the engine when the body couldn't be parsed.
  requestBody?: {
    formData?: Record<string, string[]>;
    raw?: Array<{ bytes?: ArrayBuffer; file?: string }>;
    error?: string;
  };
}

export function onBeforeRequestRecord(details: WebRequestDetails): void {
  if (typeof details.tabId !== "number" || details.tabId < 0) {
    return;
  }
  // The debugger owns tabs it is attached to: skip the covert webRequest path
  // for them so a request is not recorded twice (the CDP path records it).
  if (hasNetworkPurpose(details.tabId)) {
    return;
  }
  const record: NetworkRecord = {
    requestId: details.requestId,
    url: details.url ?? "",
    method: details.method ?? "GET",
    type: details.type ?? "other",
    timeStamp: typeof details.timeStamp === "number" ? details.timeStamp : Date.now(),
  };
  // Opt-in, best-effort request-body capture. The body is only present on the
  // onBeforeRequest event, so it must be decoded here (not on a later event).
  if (bodyCaptureEnabled) {
    const rb = decodeRequestBody(details.requestBody);
    if (rb) {
      record.requestBody = rb;
    }
  }
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
  // Debugger-owned tabs are captured via the CDP path; skip the covert path so
  // the completed event can't synthesize a duplicate webRequest record.
  if (typeof details.tabId === "number" && hasNetworkPurpose(details.tabId)) {
    return;
  }
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
  // See onCompletedRecord: don't synthesize a duplicate for a debugger-owned tab.
  if (typeof details.tabId === "number" && hasNetworkPurpose(details.tabId)) {
    return;
  }
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

// Decode a webRequest `requestBody` into a best-effort string snippet. Prefers
// the parsed `formData` (serialized as JSON); otherwise concatenates the `raw`
// byte parts up to MAX_REQUEST_BODY_BYTES and decodes them as UTF-8. Parts with
// no `bytes` (file uploads, surfaced as `{ file }`) are skipped. Best-effort:
// wrapped in try/catch, returns undefined on failure or when nothing is
// decodable, and never throws.
function decodeRequestBody(
  rb: WebRequestDetails["requestBody"]
): string | undefined {
  if (!rb) {
    return undefined;
  }
  try {
    if (rb.formData) {
      return JSON.stringify(rb.formData);
    }
    if (rb.raw && rb.raw.length > 0) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (const part of rb.raw) {
        if (!part || !part.bytes) {
          continue; // skip file uploads / partless entries
        }
        if (total >= MAX_REQUEST_BODY_BYTES) {
          break;
        }
        const bytes = new Uint8Array(part.bytes);
        const remaining = MAX_REQUEST_BODY_BYTES - total;
        chunks.push(remaining >= bytes.length ? bytes : bytes.subarray(0, remaining));
        total += bytes.length;
      }
      if (chunks.length === 0) {
        return undefined;
      }
      const merged = new Uint8Array(Math.min(total, MAX_REQUEST_BODY_BYTES));
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      return new TextDecoder("utf-8", { fatal: false }).decode(merged);
    }
  } catch (e) {
    /* best-effort: request-body capture must never break capture */
  }
  return undefined;
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
  // The CDP in-flight maps are cleared too; detaching (which clears the tab's
  // attachedPurposes entry) is handled by the caller before this runs.
  cdpInFlight.clear();
  cdpRequestTab.clear();
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

    // "requestBody" makes the parsed/raw request body available on
    // onBeforeRequest (still non-blocking in MV3). "extraHeaders" is required on
    // Chrome for the header events to see Cookie/Set-Cookie/Authorization, which
    // Chrome omits from the default header lists.
    browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, allUrls, [
      "requestBody",
    ]);
    browser.webRequest.onSendHeaders.addListener(onSendHeaders, allUrls, [
      "requestHeaders",
      "extraHeaders",
    ]);
    browser.webRequest.onHeadersReceived.addListener(
      onHeadersReceived,
      allUrls,
      ["responseHeaders", "extraHeaders"]
    );
    browser.webRequest.onCompleted.addListener(onCompleted, allUrls, [
      "responseHeaders",
      "extraHeaders",
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

// Convert a CDP headers object ({ name: value }) to the NetworkHeader[] shape
// used everywhere else. Header values arrive as strings but are coerced
// defensively. Returns undefined when there are no headers to convert.
function headersObjectToArray(
  headers: Record<string, unknown> | undefined | null
): NetworkHeader[] | undefined {
  if (!headers) {
    return undefined;
  }
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: String(value),
  }));
}

// Best-effort char-clamp for body snippets (already best-effort, so clamping by
// character length rather than exact UTF-8 byte count is sufficient).
function truncateBody(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

// Drop any CDP in-flight records belonging to a tab (on detach / tab close).
function dropCdpTab(tabId: number): void {
  for (const [requestId, owner] of cdpRequestTab) {
    if (owner === tabId) {
      cdpRequestTab.delete(requestId);
      cdpInFlight.delete(requestId);
    }
  }
}

// Register the module-level CDP event/detach listeners exactly once.
function registerDebuggerListeners(): void {
  if (cdpListenersRegistered) {
    return;
  }
  const dbg = (chrome as any).debugger;
  if (!dbg || !dbg.onEvent || !dbg.onDetach) {
    return;
  }
  dbg.onEvent.addListener(onDebuggerEvent);
  dbg.onDetach.addListener(onDebuggerDetach);
  cdpListenersRegistered = true;
}

/**
 * Attach the chrome.debugger (CDP) path to a tab under a PURPOSE and, for the
 * network purpose, enable the Network domain. Shows the "started debugging this
 * browser" banner on the first purpose. `purpose` defaults to "network" so
 * existing one-arg callers (capture-response-bodies) are unchanged. A rejection
 * (DevTools already open / another debugger attached) propagates so the caller
 * can surface ok:false.
 */
export async function attachDebugger(
  tabId: number,
  purpose: DebuggerPurpose = "network"
): Promise<void> {
  const dbg = (chrome as any).debugger;
  registerDebuggerListeners();
  let set = attachedPurposes.get(tabId);
  if (!set || set.size === 0) {
    // First purpose on this tab — actually attach (this shows the banner).
    await dbg.attach({ tabId }, "1.3");
    set = new Set<DebuggerPurpose>();
    attachedPurposes.set(tabId, set);
  }
  // Enable the Network domain only for the network purpose, and only the first
  // time it is added (avoids a redundant Network.enable round-trip).
  if (purpose === "network" && !set.has("network")) {
    await dbg.sendCommand({ tabId }, "Network.enable");
  }
  set.add(purpose);
}

/**
 * Release a PURPOSE's hold on the debugger. Really detaches (and drops the
 * tab's in-flight CDP records) only when the LAST purpose releases. `purpose`
 * defaults to "network" for back-compat. Idempotent.
 */
export async function detachDebugger(
  tabId: number,
  purpose: DebuggerPurpose = "network"
): Promise<void> {
  const set = attachedPurposes.get(tabId);
  if (set && set.has(purpose)) {
    set.delete(purpose);
    if (set.size === 0) {
      // Last purpose released — really detach (the banner goes away).
      attachedPurposes.delete(tabId);
      const dbg = (chrome as any).debugger;
      await dbg.detach({ tabId }).catch(() => {});
    }
  }
  // Drop stray CDP in-flight records once the tab is no longer attached for ANY
  // purpose (idempotent — matches the old always-cleanup for the fully-detached
  // case; a still-attached tab keeps its in-flight records).
  if (!attachedPurposes.has(tabId)) {
    dropCdpTab(tabId);
  }
}

/**
 * Fully tear down the debugger for a tab regardless of how many purposes hold
 * it — used by the auto-detach triggers (tab closed, Automation Mode turned
 * off) where every purpose must be released at once. Detaches (if attached),
 * clears all purposes, and drops the tab's in-flight CDP records.
 */
export async function forceDetachDebugger(tabId: number): Promise<void> {
  const set = attachedPurposes.get(tabId);
  attachedPurposes.delete(tabId);
  if (set && set.size > 0) {
    const dbg = (chrome as any).debugger;
    await dbg.detach({ tabId }).catch(() => {});
  }
  dropCdpTab(tabId);
}

// CDP event dispatch. Routes by source.tabId and skips tabs we are not (or no
// longer) attached to. Errors are swallowed so a single event can never break
// capture.
async function onDebuggerEvent(
  source: { tabId?: number },
  method: string,
  params: any
): Promise<void> {
  const tabId = source?.tabId;
  if (typeof tabId !== "number" || !hasNetworkPurpose(tabId)) {
    return;
  }
  const dbg = (chrome as any).debugger;
  try {
    switch (method) {
      case "Network.requestWillBeSent": {
        const req = params?.request ?? {};
        const record: NetworkRecord = {
          requestId: params.requestId,
          url: req.url ?? "",
          method: req.method ?? "GET",
          type: params.type ?? "other",
          timeStamp:
            typeof params.timestamp === "number"
              ? params.timestamp * 1000
              : Date.now(),
        };
        const requestHeaders = headersObjectToArray(req.headers);
        if (requestHeaders) {
          record.requestHeaders = requestHeaders;
        }
        if (typeof req.postData === "string" && req.postData.length > 0) {
          record.requestBody = truncateBody(req.postData, MAX_REQUEST_BODY_BYTES);
        }
        cdpInFlight.set(params.requestId, record);
        cdpRequestTab.set(params.requestId, tabId);
        break;
      }
      case "Network.responseReceived": {
        const record = cdpInFlight.get(params.requestId);
        if (!record) {
          break;
        }
        const res = params?.response ?? {};
        if (typeof res.status === "number") {
          record.statusCode = res.status;
        }
        // CDP header maps include Set-Cookie (unlike Chrome's default webRequest
        // header lists), so this is strictly richer than the covert path.
        const responseHeaders = headersObjectToArray(res.headers);
        if (responseHeaders) {
          record.responseHeaders = responseHeaders;
        }
        if (
          typeof res.encodedDataLength === "number" &&
          res.encodedDataLength >= 0
        ) {
          record.responseSize = res.encodedDataLength;
        }
        break;
      }
      case "Network.loadingFinished": {
        const record = cdpInFlight.get(params.requestId);
        if (!record) {
          break;
        }
        try {
          const result = await dbg.sendCommand(
            { tabId },
            "Network.getResponseBody",
            { requestId: params.requestId }
          );
          if (result && typeof result.body === "string") {
            record.body = result.base64Encoded
              ? "[base64] " + truncateBody(result.body, MAX_BODY_BYTES)
              : truncateBody(result.body, MAX_BODY_BYTES);
          }
        } catch (e) {
          // getResponseBody throws for some requests (redirects / no body).
          // Still record the request, just without a body.
        }
        cdpInFlight.delete(params.requestId);
        cdpRequestTab.delete(params.requestId);
        pushToTab({ requestId: params.requestId, tabId }, record);
        break;
      }
      case "Network.loadingFailed": {
        const record = cdpInFlight.get(params.requestId);
        if (!record) {
          break;
        }
        if (typeof params.errorText === "string") {
          record.error = params.errorText;
        }
        cdpInFlight.delete(params.requestId);
        cdpRequestTab.delete(params.requestId);
        pushToTab({ requestId: params.requestId, tabId }, record);
        break;
      }
      default:
        break;
    }
  } catch (e) {
    console.error("network-capture: CDP event handling failed:", e);
  }
}

// Fired when the debugger detaches for a reason outside our control (user closed
// DevTools, dismissed the banner, or the target crashed). Just forget the tab.
function onDebuggerDetach(source: { tabId?: number }, _reason: string): void {
  const tabId = source?.tabId;
  if (typeof tabId !== "number") {
    return;
  }
  // External detach (banner dismissed / DevTools closed / target crashed)
  // tears down every purpose at once.
  attachedPurposes.delete(tabId);
  dropCdpTab(tabId);
}

export function initNetworkCapture(): void {
  browser.tabs.onRemoved.addListener((tabId: number) => {
    clearNetworkRequests(tabId);
    // Detach the debugger if this tab was attached (idempotent otherwise).
    // Force-detach so an input-held tab is not leaked on close.
    void forceDetachDebugger(tabId);
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
        // Detach every debugger-owned tab before wiping state so the banner goes
        // away and no tab is left attached when automation is turned off. Force-
        // detach so tabs held only by the input purpose are released too.
        for (const attachedTabId of Array.from(attachedPurposes.keys())) {
          void forceDetachDebugger(attachedTabId);
        }
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
