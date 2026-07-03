/**
 * Privileged background-context HTTP + cookie helpers for the FoxPilot Firefox
 * extension.
 *
 * These run in the extension's PERSISTENT BACKGROUND PAGE (MV2), NOT the page
 * world, so they are:
 *   - immune to the visited page's Content-Security-Policy, and
 *   - able to use the browser's real cookie jar (incl. httpOnly cookies) and its
 *     cross-origin host privileges.
 *
 * Four capabilities:
 *   1. get-cookies      -> getCookies()          (browser.cookies.getAll)
 *   2. browser-fetch    -> browserFetch()        (one-shot fetch, body buffered)
 *   3. streaming        -> startStream() / pollStream() / closeStream()
 *                          (SSE/chunked body decoded into frames, polled out)
 *
 * The `Cookie` request header is a FORBIDDEN header for fetch() and would be
 * silently dropped, so `useSessionCookies` injects it via a BLOCKING
 * `webRequest.onBeforeSendHeaders` listener (mirrors emulate.ts). This is the
 * only supported way to force the exact cookie set onto the wire.
 *
 * Privacy: this module MUST NOT console.log cookie values or response bodies.
 * Logging host + method + status is fine; the token/body payloads are not.
 */

import type { CookieRecord } from "@foxpilot/common";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Whether a response body of the given Content-Type should be returned as UTF-8
 * text (vs. base64 binary). Matches text/*, application/json, application/*+json,
 * application/xml, application/*+xml, application/javascript, and
 * x-www-form-urlencoded. Tolerates a charset/parameter suffix and casing.
 */
export function isTextualContentType(ct: string | null | undefined): boolean {
  if (!ct) {
    return false;
  }
  const type = ct.split(";")[0].trim().toLowerCase();
  if (type.length === 0) {
    return false;
  }
  if (type.startsWith("text/")) {
    return true;
  }
  if (
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/javascript" ||
    type === "application/x-www-form-urlencoded"
  ) {
    return true;
  }
  if (/^application\/[a-z0-9.+-]*\+json$/.test(type)) {
    return true;
  }
  if (/^application\/[a-z0-9.+-]*\+xml$/.test(type)) {
    return true;
  }
  return false;
}

/**
 * Append `chunk` to any carried-over `remainder`, split the combined text into
 * complete SSE frames on the blank-line delimiter, and return the complete
 * frames plus the trailing incomplete leftover (to carry into the next call).
 *
 * Splits on "\n\n" and tolerates "\r\n\r\n" (CRLF pairs are normalized to LF
 * before splitting). PURE — no I/O — so it is directly unit-testable.
 */
export function splitSseFrames(
  remainder: string,
  chunk: string
): { frames: string[]; remainder: string } {
  const combined = (remainder + chunk).replace(/\r\n/g, "\n");
  const parts = combined.split("\n\n");
  const leftover = parts.pop() ?? "";
  return { frames: parts, remainder: leftover };
}

/**
 * Map a Firefox `cookies.Cookie` onto the frozen `CookieRecord` contract. A
 * cookie with no `expirationDate` is a session cookie. `sameSite` is passed
 * through as the engine's string.
 */
export function mapFirefoxCookie(c: any): CookieRecord {
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

// ---------------------------------------------------------------------------
// Small internal byte/error utilities
// ---------------------------------------------------------------------------

function errMsg(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Decode a base64 string to bytes (for a binary request body). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return arr;
}

/** Encode bytes to base64 (for a binary response body), chunked to avoid stack blowups. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK))
    );
  }
  return btoa(bin);
}

/** Flatten a Headers object into a plain record (defensive about the shape). */
function headersToRecord(headers: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers && typeof headers.forEach === "function") {
    headers.forEach((value: string, key: string) => {
      out[key] = value;
    });
  }
  return out;
}

/** Build the fetch body from either a text `body` or base64 `bodyBase64`. */
function buildBody(params: {
  body?: string;
  bodyBase64?: string;
}): string | Uint8Array | undefined {
  if (params.body !== undefined) {
    return params.body;
  }
  if (params.bodyBase64 !== undefined) {
    return base64ToBytes(params.bodyBase64);
  }
  return undefined;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * Read cookies from the browser's cookie jar via `browser.cookies.getAll`,
 * narrowing by url/domain/name (undefined keys are dropped). Returns httpOnly
 * cookies too (unlike document.cookie).
 */
export async function getCookies(opts: {
  url?: string;
  domain?: string;
  name?: string;
  names?: string[];
}): Promise<CookieRecord[]> {
  const details: Record<string, string> = {};
  if (opts.url !== undefined) {
    details.url = opts.url;
  }
  if (opts.domain !== undefined) {
    details.domain = opts.domain;
  }
  const multiName = !!(opts.names && opts.names.length > 0);
  if (opts.name !== undefined && !multiName) {
    details.name = opts.name;
  }
  const cookies = await (browser.cookies as any).getAll(details);
  let mapped: CookieRecord[] = ((cookies as any[]) ?? []).map(mapFirefoxCookie);
  if (multiName) {
    const wanted = new Set(opts.names);
    if (opts.name !== undefined) {
      wanted.add(opts.name);
    }
    mapped = mapped.filter((c) => wanted.has(c.name));
  }
  return mapped;
}

/** Assemble a `name=value; name=value` Cookie header from the jar for a URL. */
async function assembleCookieHeader(url: string): Promise<string> {
  try {
    const cookies = await getCookies({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Cookie-header injection via blocking webRequest (mirrors emulate.ts)
// ---------------------------------------------------------------------------

// Keyed by the exact target URL -> the assembled Cookie header to force onto
// that request. A URL present here has its outgoing `Cookie` header set/replaced.
const cookieInjections = new Map<string, string>();

interface BeforeSendHeadersDetails {
  url?: string;
  requestHeaders?: Array<{ name: string; value?: string }>;
}

/**
 * PURE rewriter for the blocking `onBeforeSendHeaders` listener: if the request
 * URL is in `map`, return `{ requestHeaders }` with the `Cookie` header replaced
 * (or appended). Returns `undefined` (no change) otherwise. Does not mutate the
 * input.
 */
export function rewriteCookieHeader(
  details: BeforeSendHeadersDetails,
  map: Map<string, string>
): { requestHeaders: Array<{ name: string; value?: string }> } | undefined {
  const url = details.url;
  if (typeof url !== "string") {
    return undefined;
  }
  const cookieHeader = map.get(url);
  if (cookieHeader === undefined) {
    return undefined;
  }
  const original = details.requestHeaders ?? [];
  const headers: Array<{ name: string; value?: string }> = [];
  let replaced = false;
  for (const h of original) {
    if (h.name && h.name.toLowerCase() === "cookie") {
      headers.push({ name: h.name, value: cookieHeader });
      replaced = true;
    } else {
      headers.push(h);
    }
  }
  if (!replaced) {
    headers.push({ name: "Cookie", value: cookieHeader });
  }
  return { requestHeaders: headers };
}

// The listener reference; `null` means not registered. Registration is idempotent.
let cookieListener: ((d: any) => any) | null = null;

/**
 * Idempotently register the blocking onBeforeSendHeaders listener. Wrapped in
 * try/catch (needs webRequest/webRequestBlocking); on failure we log and ignore.
 */
function registerCookieListener(): void {
  if (cookieListener) {
    return;
  }
  try {
    const listener = (details: any): any =>
      rewriteCookieHeader(details, cookieInjections);
    browser.webRequest.onBeforeSendHeaders.addListener(
      listener,
      { urls: ["<all_urls>"] },
      ["blocking", "requestHeaders"]
    );
    cookieListener = listener;
  } catch (error) {
    console.error(
      "browser-http: failed to register cookie onBeforeSendHeaders listener:",
      error
    );
  }
}

/** Register (or replace) the forced Cookie header for a URL, arming the listener. */
export function registerCookieInjection(url: string, cookieHeader: string): void {
  cookieInjections.set(url, cookieHeader);
  registerCookieListener();
}

/** Drop the forced Cookie header for a URL. Idempotent. */
export function unregisterCookieInjection(url: string): void {
  cookieInjections.delete(url);
}

// Test-only accessor for the live injection map.
export function __getCookieInjectionMap(): Map<string, string> {
  return cookieInjections;
}

// ---------------------------------------------------------------------------
// browser-fetch (one-shot)
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

const DEFAULT_FETCH_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 5_000_000;

/**
 * Privileged one-shot fetch from the background context. Buffers the whole body
 * (capped at maxBytes), returning it as text or base64 by Content-Type. Never
 * throws — failures come back as `{ ok:false, error }`.
 */
export async function browserFetch(
  params: BrowserFetchParams
): Promise<BrowserFetchResult> {
  const url = params.url;
  const timeoutMs = params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let injected = false;
  try {
    if (params.useSessionCookies) {
      const cookieHeader = await assembleCookieHeader(url);
      if (cookieHeader) {
        registerCookieInjection(url, cookieHeader);
        injected = true;
      }
    }

    const init: RequestInit = {
      method: params.method || "GET",
      headers: { ...(params.headers || {}) },
      credentials: params.credentials || "include",
      redirect: params.redirect || "follow",
      signal: controller.signal,
    };
    const body = buildBody(params);
    if (body !== undefined) {
      init.body = body as BodyInit;
    }

    const resp = await fetch(url, init);
    const buf = await resp.arrayBuffer();
    let bytes = new Uint8Array(buf);
    let truncated = false;
    if (bytes.byteLength > maxBytes) {
      bytes = bytes.slice(0, maxBytes);
      truncated = true;
    }

    const result: BrowserFetchResult = {
      ok: true,
      status: resp.status,
      statusText: resp.statusText,
      headers: headersToRecord(resp.headers),
      finalUrl: resp.url,
      truncated,
    };
    const ct = resp.headers.get("content-type");
    if (isTextualContentType(ct)) {
      result.bodyText = new TextDecoder("utf-8").decode(bytes);
    } else {
      result.bodyBase64 = bytesToBase64(bytes);
    }
    return result;
  } catch (error) {
    return { ok: false, error: errMsg(error) };
  } finally {
    clearTimeout(timer);
    if (injected) {
      unregisterCookieInjection(url);
    }
  }
}

// ---------------------------------------------------------------------------
// Streaming (start / poll / close)
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
  frames: string[];
  nextIndex: number;
  done: boolean;
  status?: number;
  error?: string;
}

export interface StreamCloseResult {
  ok: boolean;
}

interface StreamSession {
  buffer: string[];
  remainder: string;
  done: boolean;
  error?: string;
  controller: AbortController;
  injectedUrl?: string;
  totalBytes: number;
  lastActivity: number;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  finalUrl?: string;
  maxFrames?: number;
  maxBytes?: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  totalTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60000;
const DEFAULT_TOTAL_TIMEOUT_MS = 300000;
// How long a single poll may wait for the first new frame before returning. Kept
// well under the broker's 20s per-command timeout.
const POLL_BUDGET_MS = 8000;
const POLL_SLEEP_MS = 100;

const streams = new Map<string, StreamSession>();
let streamCounter = 0;

function newStreamId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof (crypto as any).randomUUID === "function"
    ) {
      return (crypto as any).randomUUID();
    }
  } catch {
    /* fall through to counter */
  }
  streamCounter += 1;
  return `stream-${Date.now()}-${streamCounter}`;
}

/**
 * Mark a session finished: set done (+ optional error), clear timers, drop any
 * cookie injection, and abort the underlying fetch. Idempotent.
 */
function finishSession(session: StreamSession, error?: string): void {
  if (session.done) {
    return;
  }
  session.done = true;
  if (error && !session.error) {
    session.error = error;
  }
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }
  if (session.totalTimer) {
    clearTimeout(session.totalTimer);
    session.totalTimer = undefined;
  }
  if (session.injectedUrl) {
    unregisterCookieInjection(session.injectedUrl);
    session.injectedUrl = undefined;
  }
  try {
    session.controller.abort();
  } catch {
    /* already settled */
  }
}

/**
 * Background pump: read the response body, decode UTF-8, split into SSE frames,
 * and push them into the session buffer. Honors maxFrames/maxBytes and stops on
 * a `[DONE]` sentinel frame, stream end, or error. Never awaited by the caller.
 */
async function pump(
  session: StreamSession,
  body: ReadableStream<Uint8Array>,
  armIdle: () => void
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder("utf-8");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (session.done) {
        break;
      }
      session.lastActivity = Date.now();
      armIdle();

      if (value) {
        session.totalBytes += value.byteLength;
      }
      const text = value ? dec.decode(value, { stream: true }) : "";
      const split = splitSseFrames(session.remainder, text);
      session.remainder = split.remainder;

      for (const frame of split.frames) {
        session.buffer.push(frame);
        if (frame.includes("[DONE]")) {
          finishSession(session);
          return;
        }
        if (
          session.maxFrames !== undefined &&
          session.buffer.length >= session.maxFrames
        ) {
          finishSession(session, "max frames exceeded");
          return;
        }
      }

      if (session.maxBytes !== undefined && session.totalBytes > session.maxBytes) {
        finishSession(session, "max bytes exceeded");
        return;
      }
    }
    // Normal end: flush any trailing (delimiter-less) leftover as a final frame.
    if (session.remainder.length > 0) {
      session.buffer.push(session.remainder);
      session.remainder = "";
    }
    finishSession(session);
  } catch (error) {
    if (!session.done) {
      finishSession(session, errMsg(error));
    }
  }
}

/**
 * Open a streaming request. Resolves once response HEADERS arrive (the body is
 * NOT awaited — an SSE body never completes). Returns the streamId to poll.
 * Never throws — failures come back as `{ ok:false, error }`.
 */
export async function startStream(
  params: StreamStartParams
): Promise<StreamStartResult> {
  const url = params.url;
  const idleTimeoutMs = params.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = params.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const controller = new AbortController();
  let injectedUrl: string | undefined;
  try {
    if (params.useSessionCookies) {
      const cookieHeader = await assembleCookieHeader(url);
      if (cookieHeader) {
        registerCookieInjection(url, cookieHeader);
        injectedUrl = url;
      }
    }

    const init: RequestInit = {
      method: params.method || "GET",
      headers: { ...(params.headers || {}) },
      credentials: params.credentials || "include",
      redirect: params.redirect || "follow",
      signal: controller.signal,
    };
    const body = buildBody(params);
    if (body !== undefined) {
      init.body = body as BodyInit;
    }

    const resp = await fetch(url, init);
    if (!resp.body) {
      if (injectedUrl) {
        unregisterCookieInjection(injectedUrl);
      }
      return { ok: false, error: "response has no readable body stream" };
    }

    const streamId = newStreamId();
    const session: StreamSession = {
      buffer: [],
      remainder: "",
      done: false,
      controller,
      injectedUrl,
      totalBytes: 0,
      lastActivity: Date.now(),
      status: resp.status,
      statusText: resp.statusText,
      headers: headersToRecord(resp.headers),
      finalUrl: resp.url,
      maxFrames: params.maxFrames,
      maxBytes: params.maxBytes,
    };

    const armIdle = (): void => {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
      }
      session.idleTimer = setTimeout(() => {
        finishSession(session, "idle timeout");
      }, idleTimeoutMs);
    };
    session.totalTimer = setTimeout(() => {
      finishSession(session, "total timeout");
    }, totalTimeoutMs);
    armIdle();

    streams.set(streamId, session);
    // Fire-and-forget the pump; poll drains the buffer it fills.
    void pump(session, resp.body, armIdle);

    return {
      ok: true,
      streamId,
      status: resp.status,
      statusText: resp.statusText,
      headers: session.headers,
      finalUrl: resp.url,
    };
  } catch (error) {
    if (injectedUrl) {
      unregisterCookieInjection(injectedUrl);
    }
    return { ok: false, error: errMsg(error) };
  }
}

/**
 * Drain frames buffered since `sinceIndex`. Briefly poll-waits for the first new
 * frame (so an empty stream doesn't return instantly on every call) but always
 * returns under the broker timeout. An unknown/expired streamId yields
 * `{ ok:false, done:true }`.
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
    Date.now() - start < POLL_BUDGET_MS
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
 * Abort a stream, free its buffer, and drop any cookie injection. Idempotent —
 * an unknown streamId still returns `{ ok:true }`.
 */
export function closeStream(streamId: string): StreamCloseResult {
  const session = streams.get(streamId);
  if (session) {
    try {
      session.controller.abort();
    } catch {
      /* already settled */
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    if (session.totalTimer) {
      clearTimeout(session.totalTimer);
    }
    if (session.injectedUrl) {
      unregisterCookieInjection(session.injectedUrl);
    }
    streams.delete(streamId);
  }
  return { ok: true };
}
