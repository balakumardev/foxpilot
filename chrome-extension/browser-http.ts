/**
 * Privileged background-context HTTP + cookie support for Chrome MV3.
 *
 * These helpers run DIRECTLY in the service worker (NOT the page world), so they
 * are immune to the visited page's Content-Security-Policy and can use the
 * browser's real cookie jar (including httpOnly cookies) plus its cross-origin
 * host privileges. The message handler wires each to a `req.cmd` case and, after
 * gating (deny-list + host permission), forwards the returned plain result to
 * the server via `sendResourceToServer`.
 *
 * `Cookie` is a forbidden request header for fetch(), so `useSessionCookies`
 * installs a declarativeNetRequest session rule that sets it on the wire (see
 * buildCookieHeaderRule). Streaming is buffered here and drained by stream-poll,
 * because a single MCP round-trip cannot stream through the broker.
 *
 * Privacy: never console.log cookie values or response bodies.
 */

import type { CookieRecord } from "@foxpilot/common";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Defaults chosen to stay well under the broker's per-command timeout while
// still giving slow origins room to respond.
const DEFAULT_FETCH_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60000;
const DEFAULT_TOTAL_TIMEOUT_MS = 300000;
// The server's per-command wait is 20000ms; keep the poll wait safely under it.
const POLL_WAIT_MS = 8000;
const POLL_SLEEP_MS = 100;

// Base id for the modifyHeaders "Cookie" DNR session rules. Ids are allocated
// from [COOKIE_RULE_ID_BASE, COOKIE_RULE_ID_MAX) and nowhere else.
// Exported (with COOKIE_RULE_ID_MAX below) so emulate.ts's User-Agent band and
// this one can be asserted DISJOINT by construction rather than by comment.
export const COOKIE_RULE_ID_BASE = 210000;

// Ids currently backing an installed rule. Tracked so the allocator can wrap
// inside the band without ever handing out an id another in-flight request is
// still using.
const inUseCookieRuleIds = new Set<number>();
let cookieRuleCursor = 0;

/**
 * Take the next free id in the reserved Cookie band.
 *
 * This deliberately does NOT use a bare ever-incrementing counter: past a full
 * band width that escapes COOKIE_RULE_ID_MAX, i.e. lands outside the window
 * clearStaleCookieRules() sweeps — so a service-worker eviction mid-stream would
 * strand a stale Cookie-injecting rule that nothing can ever reap. Nor a bare
 * modulo, which would wrap onto an id another live request still holds and
 * silently replace its rule. Scans forward from a rotating cursor instead,
 * skipping in-use ids, and throws rather than escaping the band (Chrome caps
 * session rules far below the band width, so exhaustion is unreachable).
 */
function nextCookieRuleId(): number {
  const span = COOKIE_RULE_ID_MAX - COOKIE_RULE_ID_BASE;
  for (let i = 0; i < span; i++) {
    const candidate = COOKIE_RULE_ID_BASE + ((cookieRuleCursor + i) % span);
    if (!inUseCookieRuleIds.has(candidate)) {
      cookieRuleCursor = (candidate - COOKIE_RULE_ID_BASE + 1) % span;
      inUseCookieRuleIds.add(candidate);
      return candidate;
    }
  }
  throw new Error(
    `browser-http: no free Cookie rule id in [${COOKIE_RULE_ID_BASE}, ${COOKIE_RULE_ID_MAX}) — ${inUseCookieRuleIds.size} rules are installed`
  );
}

/** Return an id to the band once its rule is off the wire. Idempotent. */
function releaseCookieRuleId(id: number): void {
  inUseCookieRuleIds.delete(id);
}

/** TEST-ONLY handle on the allocator. @internal */
export function __nextCookieRuleId(): number {
  return nextCookieRuleId();
}
/** TEST-ONLY handle on the allocator. @internal */
export function __releaseCookieRuleId(id: number): void {
  releaseCookieRuleId(id);
}

// ---------------------------------------------------------------------------
// Pure, unit-testable helpers
// ---------------------------------------------------------------------------

/**
 * Whether a Content-Type should be returned as decoded text (vs. base64). Covers
 * text/*, JSON (incl. +json), XML (incl. +xml), JavaScript, and form-urlencoded.
 */
export function isTextualContentType(ct: string | null | undefined): boolean {
  if (!ct) {
    return false;
  }
  const type = ct.split(";")[0].trim().toLowerCase();
  if (type.startsWith("text/")) {
    return true;
  }
  if (type === "application/json" || type === "application/xml") {
    return true;
  }
  if (type === "application/javascript") {
    return true;
  }
  if (type === "application/x-www-form-urlencoded") {
    return true;
  }
  if (/^application\/.+\+json$/.test(type)) {
    return true;
  }
  if (/^application\/.+\+xml$/.test(type)) {
    return true;
  }
  return false;
}

/**
 * Append a decoded chunk to any leftover and split into complete SSE frames on
 * the blank-line delimiter. Tolerates "\r\n\r\n" by normalizing CRLF to LF.
 * Returns the complete frames plus the (possibly partial) trailing remainder to
 * carry into the next call.
 */
export function splitSseFrames(
  remainder: string,
  chunk: string
): { frames: string[]; remainder: string } {
  // Normalize CRLF across the concatenation so a "\r\n" split across chunk
  // boundaries still collapses correctly.
  let buf = (remainder + chunk).replace(/\r\n/g, "\n");
  const frames: string[] = [];
  let idx: number;
  while ((idx = buf.indexOf("\n\n")) !== -1) {
    frames.push(buf.slice(0, idx));
    buf = buf.slice(idx + 2);
  }
  return { frames, remainder: buf };
}

/**
 * Map a chrome.cookies.Cookie into the frozen CookieRecord shape. A cookie with
 * no expirationDate is a session cookie.
 */
export function mapChromeCookie(c: any): CookieRecord {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite,
    session: !c.expirationDate,
    expirationDate: c.expirationDate,
    storeId: c.storeId,
  };
}

/**
 * Pure builder for a declarativeNetRequest session rule that SETS the outgoing
 * `Cookie` request header, scoped to the target URL. No chrome.* access —
 * unit-testable.
 */
export function buildCookieHeaderRule(
  url: string,
  cookieHeader: string,
  ruleId: number
): {
  id: number;
  priority: number;
  action: {
    type: "modifyHeaders";
    requestHeaders: { header: string; operation: "set"; value: string }[];
  };
  condition: { urlFilter: string; resourceTypes: string[] };
} {
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "cookie", operation: "set", value: cookieHeader },
      ],
    },
    condition: {
      urlFilter: url,
      resourceTypes: ["xmlhttprequest", "other"],
    },
  };
}

// ---------------------------------------------------------------------------
// Small byte/header utilities
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function headersToRecord(headers: any): Record<string, string> {
  const rec: Record<string, string> = {};
  if (headers && typeof headers.forEach === "function") {
    headers.forEach((value: string, key: string) => {
      rec[key] = value;
    });
  }
  return rec;
}

async function installCookieRule(
  url: string,
  cookieHeader: string,
  ruleId: number
): Promise<void> {
  await (browser as any).declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [buildCookieHeaderRule(url, cookieHeader, ruleId)],
  });
}

/**
 * Take the rule off the wire and return its id to the band. The id is released
 * in a `finally` so a rejected update still frees it: every caller treats a
 * failed removal as best-effort (`.catch(() => {})`) and drops the id, so
 * holding it would leak the slot for the life of the service worker. A rule that
 * survives a failed removal is collected by clearStaleCookieRules() at startup.
 */
async function removeCookieRule(ruleId: number): Promise<void> {
  try {
    await (browser as any).declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
    });
  } finally {
    releaseCookieRuleId(ruleId);
  }
}

// Upper bound (exclusive) of the reserved Cookie-rule id band. The startup sweep
// only touches ids in [COOKIE_RULE_ID_BASE, COOKIE_RULE_ID_MAX), and emulate.ts
// allocates User-Agent rule ids from a band that ends at or below
// COOKIE_RULE_ID_BASE, so the two sweeps are strictly disjoint and neither can
// delete the other's live rules. Exported so that invariant is unit-testable.
export const COOKIE_RULE_ID_MAX = COOKIE_RULE_ID_BASE + 100000;

/**
 * Remove leftover "Cookie" DNR session rules in our reserved id band. A
 * useSessionCookies STREAM installs a rule for the stream's lifetime and removes
 * it on teardown; but if the MV3 service worker is recycled mid-stream the
 * session Map is lost and that rule would be orphaned — still injecting the
 * (stale) session cookie onto same-URL requests until the browser restarts. Run
 * once at service-worker startup, this sweep clears any such orphan. One-shot
 * browserFetch removes its rule synchronously in a finally, so it can't orphan.
 *
 * `keep` is a PROVIDER, evaluated AFTER the getSessionRules() await — the same
 * shape emulate.ts's User-Agent sweep uses, and for the same reason. This sweep
 * is void-ed by initBrowserHttp() while background.ts goes on to connect the
 * broker clients, so a browser-fetch can install a rule while the read-back is
 * still in flight. That rule IS in the read-back, so a set frozen before the
 * await would not contain it and the sweep would delete a live rule out from
 * under an in-flight request, while the allocator still holds its id reserved.
 */
async function removeCookieRulesInBand(
  keep: () => ReadonlySet<number>
): Promise<void> {
  try {
    const dnr = (browser as any).declarativeNetRequest;
    const existing: Array<{ id?: number }> = (await dnr.getSessionRules()) ?? [];
    const live = keep();
    const stale = existing
      .map((r) => r.id)
      .filter(
        (id): id is number =>
          typeof id === "number" &&
          id >= COOKIE_RULE_ID_BASE &&
          id < COOKIE_RULE_ID_MAX &&
          !live.has(id)
      );
    if (stale.length > 0) {
      await dnr.updateSessionRules({ removeRuleIds: stale });
    }
  } catch (e) {
    console.error(
      "browser-http: failed to clear stale cookie rules:",
      errMessage(e)
    );
  }
}

export async function clearStaleCookieRules(): Promise<void> {
  await removeCookieRulesInBand(() => inUseCookieRuleIds);
}

/**
 * One-time background init: sweep orphaned cookie rules left by a prior service
 * worker generation. Called from background.ts alongside the other init hooks.
 */
export function initBrowserHttp(): void {
  void clearStaleCookieRules();
}

function errMessage(e: unknown): string {
  return String((e as any)?.message ?? e);
}

// ---------------------------------------------------------------------------
// cookies
// ---------------------------------------------------------------------------

/**
 * Read cookies from the browser jar (incl. httpOnly). Undefined query keys are
 * dropped so `getAll` sees only the narrowing the caller supplied.
 */
export async function getCookies(opts: {
  url?: string;
  domain?: string;
  name?: string;
  names?: string[];
}): Promise<CookieRecord[]> {
  const query: Record<string, string> = {};
  if (opts.url !== undefined) {
    query.url = opts.url;
  }
  if (opts.domain !== undefined) {
    query.domain = opts.domain;
  }
  // When a multi-name filter is present, do NOT constrain getAll by a single
  // name — fetch all cookies in the url/domain scope and filter in-memory.
  // A lone singular `name` still narrows the query for the back-compat path.
  const multiName = !!(opts.names && opts.names.length > 0);
  if (opts.name !== undefined && !multiName) {
    query.name = opts.name;
  }
  const raw = await (browser as any).cookies.getAll(query);
  let mapped: CookieRecord[] = (raw ?? []).map(mapChromeCookie);
  if (multiName) {
    const wanted = new Set(opts.names);
    if (opts.name !== undefined) {
      wanted.add(opts.name); // union singular + plural
    }
    mapped = mapped.filter((c) => wanted.has(c.name));
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// browser-fetch
// ---------------------------------------------------------------------------

export interface BrowserFetchParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  credentials?: "include" | "omit" | "same-origin";
  useSessionCookies?: boolean;
  redirect?: "follow" | "manual" | "error";
  timeoutMs?: number;
  maxBytes?: number;
}

export interface BrowserFetchResult {
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

async function buildCookieHeader(url: string): Promise<string> {
  const cookies = await getCookies({ url });
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * One-shot privileged fetch. Reads the whole body (up to maxBytes), returning it
 * as text or base64 by Content-Type. Never throws — failures become
 * `{ ok:false, error }`.
 */
export async function browserFetch(
  params: BrowserFetchParams
): Promise<BrowserFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  );
  let ruleId: number | undefined;
  try {
    const init: RequestInit = {
      method: params.method ?? "GET",
      redirect: params.redirect ?? "follow",
      credentials: params.credentials ?? "include",
      signal: controller.signal,
    };
    if (params.headers) {
      init.headers = params.headers;
    }
    if (params.body !== undefined) {
      init.body = params.body;
    } else if (params.bodyBase64 !== undefined) {
      // A Uint8Array is a valid fetch body at runtime; the lib's BodyInit type
      // rejects the generic Uint8Array, so cast at this boundary.
      init.body = base64ToBytes(params.bodyBase64) as unknown as BodyInit;
    }

    if (params.useSessionCookies) {
      const cookieHeader = await buildCookieHeader(params.url);
      if (cookieHeader) {
        ruleId = nextCookieRuleId();
        await installCookieRule(params.url, cookieHeader, ruleId);
      }
    }

    const resp = await fetch(params.url, init);
    const headers = headersToRecord(resp.headers);
    const contentType = resp.headers?.get?.("content-type");

    const full = new Uint8Array(await resp.arrayBuffer());
    const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
    let bytes = full;
    let truncated = false;
    if (full.byteLength > maxBytes) {
      bytes = full.slice(0, maxBytes);
      truncated = true;
    }

    const result: BrowserFetchResult = {
      ok: true,
      status: resp.status,
      statusText: resp.statusText,
      headers,
      finalUrl: resp.url,
      truncated,
    };
    if (isTextualContentType(contentType)) {
      result.bodyText = new TextDecoder("utf-8").decode(bytes);
    } else {
      result.bodyBase64 = bytesToBase64(bytes);
    }
    return result;
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  } finally {
    clearTimeout(timer);
    if (ruleId !== undefined) {
      await removeCookieRule(ruleId).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// streaming (stream-start / stream-poll / stream-close)
// ---------------------------------------------------------------------------

export interface StreamStartParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  credentials?: "include" | "omit" | "same-origin";
  useSessionCookies?: boolean;
  redirect?: "follow" | "manual" | "error";
  maxFrames?: number;
  maxBytes?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface StreamStartResult {
  ok: boolean;
  streamId?: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  finalUrl?: string;
  error?: string;
}

export interface StreamPollResult {
  ok: boolean;
  streamId: string;
  frames?: string[];
  nextIndex?: number;
  done: boolean;
  status?: number;
  error?: string;
}

interface StreamSession {
  buffer: string[];
  remainder: string;
  done: boolean;
  error?: string;
  controller: AbortController;
  ruleId?: number;
  totalBytes: number;
  lastActivity: number;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  finalUrl?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
  totalTimer?: ReturnType<typeof setTimeout>;
  idleTimeoutMs: number;
  maxFrames?: number;
  maxBytes?: number;
}

const streams = new Map<string, StreamSession>();

function clearSessionTimers(session: StreamSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }
  if (session.totalTimer) {
    clearTimeout(session.totalTimer);
    session.totalTimer = undefined;
  }
}

function armIdleTimer(session: StreamSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
  }
  session.idleTimer = setTimeout(() => {
    session.error = session.error ?? "idle timeout";
    session.done = true;
    try {
      session.controller.abort();
    } catch {
      /* already aborted */
    }
  }, session.idleTimeoutMs);
}

/**
 * Open a streaming request. Resolves once RESPONSE HEADERS arrive (the SSE body
 * never completes), returning a `streamId` the caller drains via pollStream. A
 * detached pump reads the body into the session buffer as frames arrive.
 */
export async function startStream(
  params: StreamStartParams
): Promise<StreamStartResult> {
  const controller = new AbortController();
  let ruleId: number | undefined;
  try {
    const init: RequestInit = {
      method: params.method ?? "GET",
      redirect: params.redirect ?? "follow",
      credentials: params.credentials ?? "include",
      signal: controller.signal,
    };
    if (params.headers) {
      init.headers = params.headers;
    }
    if (params.body !== undefined) {
      init.body = params.body;
    } else if (params.bodyBase64 !== undefined) {
      // A Uint8Array is a valid fetch body at runtime; the lib's BodyInit type
      // rejects the generic Uint8Array, so cast at this boundary.
      init.body = base64ToBytes(params.bodyBase64) as unknown as BodyInit;
    }

    if (params.useSessionCookies) {
      const cookieHeader = await buildCookieHeader(params.url);
      if (cookieHeader) {
        ruleId = nextCookieRuleId();
        await installCookieRule(params.url, cookieHeader, ruleId);
      }
    }

    // Resolves on HEADERS — do NOT await the body here.
    const resp = await fetch(params.url, init);
    const status = resp.status;
    const statusText = resp.statusText;
    const headers = headersToRecord(resp.headers);
    const finalUrl = resp.url;

    if (!resp.body) {
      if (ruleId !== undefined) {
        await removeCookieRule(ruleId).catch(() => {});
      }
      return {
        ok: false,
        status,
        statusText,
        headers,
        finalUrl,
        error: "Response has no readable body to stream",
      };
    }

    const streamId = crypto.randomUUID();
    const session: StreamSession = {
      buffer: [],
      remainder: "",
      done: false,
      error: undefined,
      controller,
      ruleId,
      totalBytes: 0,
      lastActivity: Date.now(),
      status,
      statusText,
      headers,
      finalUrl,
      idleTimeoutMs: params.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      maxFrames: params.maxFrames,
      maxBytes: params.maxBytes,
    };
    streams.set(streamId, session);

    session.totalTimer = setTimeout(() => {
      session.error = session.error ?? "total timeout";
      session.done = true;
      try {
        controller.abort();
      } catch {
        /* already aborted */
      }
    }, params.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
    armIdleTimer(session);

    // Detached pump — intentionally NOT awaited.
    void pumpStream(session, resp.body as ReadableStream<Uint8Array>);

    return { ok: true, streamId, status, statusText, headers, finalUrl };
  } catch (e) {
    try {
      controller.abort();
    } catch {
      /* already aborted */
    }
    if (ruleId !== undefined) {
      await removeCookieRule(ruleId).catch(() => {});
    }
    return { ok: false, error: errMessage(e) };
  }
}

async function pumpStream(
  session: StreamSession,
  body: ReadableStream<Uint8Array>
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      session.lastActivity = Date.now();
      session.totalBytes += value.byteLength;
      armIdleTimer(session);

      const decoded = decoder.decode(value, { stream: true });
      const split = splitSseFrames(session.remainder, decoded);
      session.remainder = split.remainder;
      for (const frame of split.frames) {
        session.buffer.push(frame);
        if (frame.includes("[DONE]")) {
          session.done = true;
        }
      }

      if (
        session.maxFrames !== undefined &&
        session.buffer.length >= session.maxFrames
      ) {
        session.error = session.error ?? "maxFrames exceeded";
        session.done = true;
      }
      if (
        session.maxBytes !== undefined &&
        session.totalBytes >= session.maxBytes
      ) {
        session.error = session.error ?? "maxBytes exceeded";
        session.done = true;
      }

      if (session.done) {
        try {
          session.controller.abort();
        } catch {
          /* already aborted */
        }
        break;
      }
    }
    // Reader ended (or we broke out): surface any trailing delimiter-less frame
    // so a final chunk that wasn't newline-terminated isn't dropped (parity with
    // the Firefox pump).
    if (session.remainder.length > 0) {
      session.buffer.push(session.remainder);
      session.remainder = "";
    }
  } catch (e) {
    session.error = session.error ?? errMessage(e);
  } finally {
    session.done = true;
    clearSessionTimers(session);
    if (session.ruleId !== undefined) {
      const id = session.ruleId;
      session.ruleId = undefined;
      await removeCookieRule(id).catch(() => {});
    }
  }
}

/**
 * Drain frames buffered past `sinceIndex`. Waits briefly for the first new frame
 * (staying under the broker timeout) when the stream is still live, then returns.
 */
export async function pollStream(
  streamId: string,
  sinceIndex = 0
): Promise<StreamPollResult> {
  const session = streams.get(streamId);
  if (!session) {
    return {
      ok: false,
      streamId,
      frames: [],
      nextIndex: sinceIndex,
      done: true,
      error: "stream expired or unknown",
    };
  }

  const start = Date.now();
  while (
    session.buffer.length <= sinceIndex &&
    !session.done &&
    Date.now() - start < POLL_WAIT_MS
  ) {
    await sleep(POLL_SLEEP_MS);
  }

  return {
    ok: true,
    streamId,
    frames: session.buffer.slice(sinceIndex),
    nextIndex: session.buffer.length,
    done: session.done,
    status: session.status,
    error: session.error,
  };
}

/**
 * Abort the stream, remove its cookie rule, clear timers, and forget it.
 * Idempotent — closing an unknown/already-closed stream still acks ok.
 */
export async function closeStream(streamId: string): Promise<{ ok: true }> {
  const session = streams.get(streamId);
  if (session) {
    try {
      session.controller.abort();
    } catch {
      /* already aborted */
    }
    clearSessionTimers(session);
    if (session.ruleId !== undefined) {
      const id = session.ruleId;
      session.ruleId = undefined;
      await removeCookieRule(id).catch(() => {});
    }
    streams.delete(streamId);
  }
  return { ok: true };
}
