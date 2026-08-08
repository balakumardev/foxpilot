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
// runs Network.enable) and "input" (the engine:"cdp" trusted coordinate/uid
// tools, which dispatch Input.* and never enable the Network domain). We attach
// once, run Network.enable only for the network purpose, and only really detach
// when the LAST purpose releases — so a CDP click on a tab that is already
// capturing response bodies does not tear the capture down, and vice-versa.
// "screenshot" is the CDP Page.captureScreenshot fallback's own purpose: kept
// DISTINCT from "input" so a concurrent CDP input action can't detach the
// debugger out from under an in-flight screenshot (and vice-versa). "eval" is
// the engine:"cdp" Runtime.evaluate path.
type DebuggerPurpose = "network" | "input" | "eval" | "screenshot";
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

// Tabs whose `dbg.attach` HAS SUCCEEDED and that we have not successfully
// detached — i.e. the ground truth of "the debugger is really attached (banner
// up) and it is ours". Deliberately SEPARATE from `attachedPurposes`, which only
// tracks who currently WANTS it: the two legitimately disagree for a moment
// (during a rollback, or after a detach that rejected), and collapsing them into
// one map is what let a tab end up attached-but-untracked, with every detach
// path short-circuiting on an empty/absent purpose Set. Every mutation of this
// set is mirrored into chrome.storage.session (see persistAttachedTabs) so a
// later service-worker generation can still find these attachments.
const attachedTabs = new Set<number>();

// In-flight `dbg.attach` per tab. Two purposes racing on the same tab await the
// SAME attach instead of the second one seeing "nothing attached yet" and
// issuing a duplicate `dbg.attach` on an already-attached tab.
const attachInFlight = new Map<number, Promise<void>>();

// Tabs a teardown (Automation Mode off / tab closed / force-detach) asked to
// release while their `dbg.attach` was STILL IN FLIGHT. In that window the tab
// is in neither `attachedTabs` nor `attachedPurposes`, so teardown cannot detach
// it and a detach call would be a silent no-op — the attach would then land and
// sit there with the debugging banner up until the next worker boot. Teardown
// leaves a marker here instead and the attach's own continuation honours it.
// Teardown deliberately does NOT await the attach: a `dbg.attach` that never
// settles must not be able to wedge teardown.
const teardownWhileAttaching = new Set<number>();

// Tabs with a `dbg.detach` currently outstanding. `attachedTabs` still holds the
// tab until that IPC resolves (deliberately — see reallyDetach), so without this
// a concurrent attachDebugger would take the already-attached fast path and
// register a purpose that outlives the detach. Same stale-purpose outcome as
// `teardownWhileAttaching` guards against, reached without any in-flight attach
// to hang a marker on.
const detachInFlight = new Set<number>();

// A teardown for this tab is underway and has not finished. Both sets are
// checked together everywhere a new hold could be registered.
function teardownPending(tabId: number): boolean {
  return teardownWhileAttaching.has(tabId) || detachInFlight.has(tabId);
}

/**
 * How long a caller will wait to JOIN an already-in-flight attach before giving
 * up. Sized to the broker's default per-command budget (5s, see
 * mcp-server/timeouts.ts) — a real `chrome.debugger.attach` is a local IPC that
 * settles in milliseconds, so anything near this is already a hang.
 *
 * On timeout the attach is deliberately left in flight and still cached in
 * `attachInFlight`, so a second `dbg.attach` is never issued on a tab whose
 * first attach might still land. That restraint is the point — retrying would
 * create exactly the untracked duplicate attachment this module exists to
 * prevent. If the attach does land later, `attachedTabs` records it and both the
 * Automation-Mode-off sweep and the boot reconcile can still release it.
 *
 * Be clear about the cost, because it is bigger than "this one caller gives up":
 * `attachInFlight` has NO expiry, so a `dbg.attach` that never settles leaves
 * its entry (and any teardown marker) in place for the LIFE OF THE SERVICE
 * WORKER. Every future attachDebugger on that tab fails too, permanently, until
 * the worker restarts — after this timeout when it joins the dead promise, or
 * immediately at the step-0 teardown guard if a teardown marked the tab in the
 * meantime (faster, same permanence). That is accepted: a bounded, honest
 * failure per call beats either hanging forever or issuing a duplicate attach
 * whose outcome nothing tracks.
 */
export const ATTACH_JOIN_TIMEOUT_MS = 5000;

function attachTornDownError(tabId: number): Error {
  return new Error(
    `Debugger attach for tab ${tabId} was torn down before it could be used ` +
      `(Automation Mode turned off, the tab closed, or a concurrent detach).`
  );
}

// Await an in-flight attach with a bound. See ATTACH_JOIN_TIMEOUT_MS for why the
// attach itself is deliberately left alone on timeout.
async function joinAttach(tabId: number, pending: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Debugger attach for tab ${tabId} did not complete within ` +
              `${ATTACH_JOIN_TIMEOUT_MS}ms; not issuing a second attach.`
          )
        ),
      ATTACH_JOIN_TIMEOUT_MS
    );
  });
  try {
    await Promise.race([pending, expiry]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

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

/**
 * chrome.storage.session key holding the tabIds this extension has attached the
 * debugger to. `storage.session` is the right lifetime for this record: it
 * survives service-worker restarts (unlike the in-memory maps) and is wiped when
 * the browser closes (exactly when a debugger attachment dies anyway), so it can
 * never resurrect a stale tabId across a browser restart.
 */
export const DEBUGGER_SESSION_KEY = "foxpilotDebuggerAttachedTabs";

function getSessionStore(): {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
} | null {
  const session = (browser as any)?.storage?.session;
  return session && typeof session.get === "function" ? session : null;
}

// Mirror `attachedTabs` into chrome.storage.session. Best-effort: a persistence
// failure must never break an attach/detach that otherwise succeeded.
async function persistAttachedTabs(): Promise<void> {
  const session = getSessionStore();
  if (!session) {
    return;
  }
  try {
    await session.set({ [DEBUGGER_SESSION_KEY]: Array.from(attachedTabs) });
  } catch (e) {
    console.error(
      "network-capture: failed to persist debugger attachments:",
      (e as { message?: unknown })?.message ?? e
    );
  }
}

/**
 * Release debugger attachments left behind by a PRIOR service-worker generation.
 *
 * `attachedPurposes` / `attachedTabs` are in-memory only, so when MV3 evicts the
 * service worker the bookkeeping dies while the attachment (and its "started
 * debugging this browser" banner) survives — after that nothing in the extension
 * could ever detach it. The tabIds are mirrored into chrome.storage.session
 * precisely so a fresh generation can find and release them.
 *
 * This deliberately does NOT enumerate `chrome.debugger.getTargets()`: that
 * reports `attached: true` without saying WHO attached, so blind-detaching
 * everything it lists would rip down the user's own DevTools sessions. Only tabs
 * WE recorded are touched. Tabs the current generation still holds are skipped —
 * those are live attachments, not orphans.
 *
 * Called once at startup from initNetworkCapture(), mirroring
 * initBrowserHttp()'s orphaned-DNR-rule sweep.
 */
export async function reconcileDebuggerAttachments(): Promise<void> {
  const session = getSessionStore();
  if (!session) {
    return;
  }
  try {
    const stored = await session.get(DEBUGGER_SESSION_KEY);
    const recorded = stored?.[DEBUGGER_SESSION_KEY];
    const orphans = (Array.isArray(recorded) ? recorded : []).filter(
      (id): id is number =>
        typeof id === "number" && Number.isInteger(id) && !attachedTabs.has(id)
    );
    const dbg = (chrome as any).debugger;
    if (dbg && typeof dbg.detach === "function") {
      for (const tabId of orphans) {
        // Re-test on EVERY iteration, not just when the list was built. This
        // loop awaits between tabs, and an attachDebugger completing in one of
        // those gaps would otherwise be torn down when the loop reaches its tab.
        // Chrome does NOT fire onDetach for the extension's own detach(), so the
        // bookkeeping would never self-heal: attachedTabs/attachedPurposes would
        // keep claiming the tab, hasNetworkPurpose would suppress the covert
        // webRequest path, and the tab would capture nothing while the tool had
        // already reported ok:true.
        if (attachedTabs.has(tabId) || attachInFlight.has(tabId)) {
          continue;
        }
        // Best-effort: an orphan whose tab has since closed rejects here, which
        // is the outcome we wanted anyway.
        await dbg.detach({ tabId }).catch(() => {});
      }
    }
    // Rewrite the record to just what this generation actually holds.
    await persistAttachedTabs();
  } catch (e) {
    console.error(
      "network-capture: failed to reconcile debugger attachments:",
      (e as { message?: unknown })?.message ?? e
    );
  }
}

// Tabs with best-effort request-body capture enabled. Toggled by the tool (via
// the `includeBody` param), which is TAB-SCOPED — so this must be per-tab too: a
// single module-wide flag meant one includeBody:true call silently started
// decoding and retaining request bodies (form fields, JSON payloads, tokens) for
// EVERY tab in the browser until something flipped it back. Because bodies are
// captured at request time (onBeforeRequest), flipping this only affects
// requests made afterwards.
const bodyCaptureTabs = new Set<number>();

/**
 * Enable/disable best-effort request-body capture for FUTURE requests on one tab.
 */
export function setBodyCaptureEnabled(tabId: number, enabled: boolean): void {
  if (enabled) {
    bodyCaptureTabs.add(tabId);
  } else {
    bodyCaptureTabs.delete(tabId);
  }
}

/**
 * Whether request-body capture is currently enabled for a tab. Non-tab requests
 * (tabId absent / negative) are never body-captured.
 */
export function isBodyCaptureEnabled(tabId: number | undefined): boolean {
  return typeof tabId === "number" && bodyCaptureTabs.has(tabId);
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
  // Opt-in, best-effort request-body capture, scoped to the tab that asked for
  // it. The body is only present on the onBeforeRequest event, so it must be
  // decoded here (not on a later event).
  if (isBodyCaptureEnabled(details.tabId)) {
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
  // The tab's opt-in body-capture flag goes with it (this runs on tab removal),
  // so a recycled tabId can't inherit a previous tab's capture setting.
  bodyCaptureTabs.delete(tabId);
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
  bodyCaptureTabs.clear();
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

  // 0) Refuse outright while a teardown for this tab is underway. This MUST come
  //    before the already-attached fast path below: that path skips the whole
  //    attach block (and its post-join re-check), so without this guard a caller
  //    arriving in the window where `attachedTabs` still holds a tab that is on
  //    its way out would register a purpose and return SUCCESS. The detach then
  //    lands and the purpose outlives it — and a stale "network" member makes
  //    hasNetworkPurpose suppress the covert webRequest path for that tab
  //    indefinitely, so it captures nothing while the tool reported ok:true.
  //    Failing loudly is the right trade: the caller can retry once the teardown
  //    finishes, whereas a silently dead capture is unrecoverable.
  if (teardownPending(tabId)) {
    throw attachTornDownError(tabId);
  }

  // 1) Make sure the tab is really attached, exactly once. `attachedTabs` is
  //    written the instant `dbg.attach` resolves and BEFORE any further await,
  //    so from that point on the tracked state can never claim "not attached"
  //    while the debugger is — which is what stranded tabs forever.
  if (!attachedTabs.has(tabId)) {
    let pending = attachInFlight.get(tabId);
    if (!pending) {
      pending = (async () => {
        await dbg.attach({ tabId }, "1.3");
        attachedTabs.add(tabId);
        // AWAITED, not fire-and-forget: this is the one moment the session
        // record actually matters. A worker eviction (or a write failure, which
        // is only logged) between the attach landing and the record being
        // written loses the tabId while the attachment survives — precisely the
        // orphan the record exists to prevent.
        await persistAttachedTabs();
        // Honour a teardown that ran while this attach was in flight. See
        // `teardownWhileAttaching`.
        if (teardownWhileAttaching.delete(tabId)) {
          await reallyDetach(tabId);
          dropCdpTab(tabId);
          throw attachTornDownError(tabId);
        }
      })();
      attachInFlight.set(tabId, pending);
      // Never leave a settled attach cached (a rejected one must not poison the
      // next call). The extra `.catch` keeps this bookkeeping chain from
      // surfacing as an unhandled rejection — the real error still reaches the
      // caller through the join below.
      void pending
        .catch(() => {})
        .finally(() => {
          if (attachInFlight.get(tabId) === pending) {
            attachInFlight.delete(tabId);
          }
          // A rejected attach attached nothing, so a marker left by a teardown
          // that raced it has nothing left to act on.
          teardownWhileAttaching.delete(tabId);
        });
    }
    await joinAttach(tabId, pending);
    // A teardown can also land in the window between the attach resolving and
    // this continuation running. Registering a purpose now would claim a hold on
    // a tab that is no longer attached, which silently suppresses the covert
    // webRequest path (hasNetworkPurpose) while nothing is capturing.
    if (!attachedTabs.has(tabId)) {
      throw attachTornDownError(tabId);
    }
  }

  // 2) Register the purpose BEFORE the Network.enable round-trip, so the tab is
  //    never held by a visibly-empty purpose set across an await.
  const set = attachedPurposes.get(tabId) ?? new Set<DebuggerPurpose>();
  // Enable the Network domain only for the network purpose, and only the first
  // time it is added (avoids a redundant Network.enable round-trip).
  const needsNetworkEnable = purpose === "network" && !set.has("network");
  set.add(purpose);
  attachedPurposes.set(tabId, set);

  if (needsNetworkEnable) {
    try {
      await dbg.sendCommand({ tabId }, "Network.enable");
    } catch (e) {
      // The attach itself succeeded, so failing here would otherwise leave the
      // tab attached (banner up) while the caller is told it is not. Roll this
      // purpose back, and if it was the only holder detach the tab, so the
      // thrown error matches reality.
      set.delete(purpose);
      if (set.size === 0) {
        attachedPurposes.delete(tabId);
        await reallyDetach(tabId);
        dropCdpTab(tabId);
      }
      throw e;
    }
  }
}

/**
 * Classify a `dbg.detach` rejection. A rejection does NOT always mean the tab is
 * still attached: when the target is already gone (tab closed, debugger already
 * detached, target crashed) there is nothing left to detach and FORGETTING the
 * tab is the correct bookkeeping. Any other rejection is a genuine failure — the
 * debugger is very likely still attached — so the tab must stay tracked and
 * remain reachable by a later detach attempt rather than becoming an untracked
 * (i.e. permanently leaked) attachment. Same shape as the existing
 * `activateTabWithRetry` drag-detection classifier in message-handler.ts.
 */
function detachErrorMeansTargetGone(e: unknown): boolean {
  const msg = String((e as { message?: unknown })?.message ?? e).toLowerCase();
  return (
    msg.includes("no target with given id") ||
    msg.includes("no tab with given id") ||
    msg.includes("no such tab") ||
    msg.includes("not attached to the tab") ||
    msg.includes("target closed") ||
    msg.includes("detached while handling command")
  );
}

/**
 * Actually detach the debugger from a tab and reconcile the bookkeeping with the
 * REAL outcome. Returns true when the tab is confirmed no longer attached
 * (detached cleanly, or the target was already gone), false when the detach
 * genuinely failed and the tab is therefore still tracked as attached.
 */
async function reallyDetach(tabId: number): Promise<boolean> {
  const dbg = (chrome as any).debugger;
  // Publish the in-progress detach so attachDebugger refuses to register a new
  // hold on a tab that is on its way out (see detachInFlight).
  detachInFlight.add(tabId);
  // The flag is cleared in the finally below. What is true once it lifts:
  //   - detach succeeded, or the target was already gone: `attachedTabs` no
  //     longer holds the tab. Every step between the awaited detach and the
  //     finally is synchronous, so there is no window in which the tab still
  //     looks attached while no detach is registered as pending.
  //   - detach genuinely FAILED (the `return false` path below): the tab
  //     deliberately STAYS in `attachedTabs` and the guard still lifts. That is
  //     the correct state, not a hole — the tab really is still attached, so a
  //     later attachDebugger SHOULD be allowed through the fast path rather than
  //     refused, and forceDetachDebugger / the boot sweep can still retry it.
  // So "guard lifted" does NOT imply "not in attachedTabs". It means only that
  // no detach is currently in flight for this tab.
  try {
    try {
      await dbg.detach({ tabId });
    } catch (e) {
      if (!detachErrorMeansTargetGone(e)) {
        // Still attached in reality — keep tracking it so forceDetachDebugger /
        // the boot sweep can retry. Dropping it here is what turned a transient
        // detach failure into a permanent attached-but-untracked leak.
        console.error(
          "network-capture: debugger detach failed for tab",
          tabId,
          e
        );
        return false;
      }
      // Target already gone: nothing to detach, so forgetting it is correct.
    }
    attachedTabs.delete(tabId);
    void persistAttachedTabs();
    return true;
  } finally {
    detachInFlight.delete(tabId);
  }
}

/**
 * Release a PURPOSE's hold on the debugger. Really detaches (and drops the
 * tab's in-flight CDP records) only when the LAST purpose releases. `purpose`
 * defaults to "network" for back-compat. Idempotent.
 *
 * CALL-SITE INVARIANT (not enforced by the compiler — read before adding a
 * caller): every caller must already OWN the purpose it releases, i.e. its
 * `attachDebugger` for that purpose has resolved before this runs. That is why
 * this function, unlike `forceDetachDebugger`, does not deal with an attach that
 * is still in flight — by the invariant there cannot be one. Today all callers
 * satisfy it by attaching OUTSIDE the try whose finally detaches (see
 * cdp-input.ts's withInputAttach and cdp-eval.ts). A caller that instead wraps
 * `attachDebugger` INSIDE that try would break the invariant and reintroduce the
 * in-flight case here: the release would find no registered purpose, no-op, and
 * the attach would land afterwards holding a tab nobody releases. Keep the
 * attach outside the try.
 */
export async function detachDebugger(
  tabId: number,
  purpose: DebuggerPurpose = "network"
): Promise<void> {
  const set = attachedPurposes.get(tabId);
  if (set && set.has(purpose)) {
    set.delete(purpose);
    if (set.size === 0) {
      // Last purpose released — really detach (the banner goes away). The
      // purpose bookkeeping is dropped either way (nobody wants the tab any
      // more); whether the tab is still ATTACHED is tracked separately by
      // reallyDetach, so a rejected detach cannot lose the attachment.
      attachedPurposes.delete(tabId);
      await reallyDetach(tabId);
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
  attachedPurposes.delete(tabId);
  // An attach that has not resolved yet is in NEITHER tracking set, so a detach
  // here would be a silent no-op and the attach would land afterwards with the
  // banner up. Leave a marker the attach's own continuation acts on. Not awaited
  // on purpose — teardown must not block on an attach that may never settle.
  if (attachInFlight.has(tabId)) {
    teardownWhileAttaching.add(tabId);
  }
  // Guard on the REAL attachment state, not on the purpose set. A tab whose
  // purposes were already dropped (rolled-back attach, or a detach that
  // rejected) is exactly the one that must still be reachable here.
  if (attachedTabs.has(tabId)) {
    await reallyDetach(tabId);
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
  // tears down every purpose at once. The tab is genuinely no longer attached,
  // so drop it from the real-attachment set and the session record too —
  // otherwise the next boot sweep would try to detach a tab we no longer hold.
  attachedPurposes.delete(tabId);
  attachedTabs.delete(tabId);
  void persistAttachedTabs();
  dropCdpTab(tabId);
}

export function initNetworkCapture(): void {
  // Release debugger attachments orphaned by a prior service-worker generation
  // (MV3 evicts the SW, losing the in-memory maps while the attachment lives on).
  // Mirrors initBrowserHttp()'s orphaned-DNR-rule sweep.
  void reconcileDebuggerAttachments();

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
        // detach so tabs held only by the input purpose are released too. The
        // union of all THREE sets is used: a tab that is really attached but
        // holds no purpose (rolled-back attach, or a detach that rejected), and
        // a tab whose attach is still in flight (in neither tracking set until
        // it resolves) must both be released, not just the purpose-holders.
        const ownedTabs = new Set<number>([
          ...attachedPurposes.keys(),
          ...attachedTabs,
          ...attachInFlight.keys(),
        ]);
        for (const attachedTabId of ownedTabs) {
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
