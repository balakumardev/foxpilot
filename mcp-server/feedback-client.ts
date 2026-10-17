// Client for the send-feedback tool: lets an AI assistant report a bug or
// feature request about FoxPilot itself to the maintainers' ticket system.
//
// The endpoint is public and unauthenticated and this repo is open source, so
// everything here is conservative about what leaves the machine: free text is
// redacted before sending, nothing is retried (a retry could file a second
// ticket), redirects are refused, and the response is read with a hard cap.
//
// Pure and side-effect free on import (unlike server.ts), so every piece is
// unit-tested directly.

import { z } from "zod";
import { FOXPILOT_VERSION } from "./version";

export const DEFAULT_FEEDBACK_URL =
  "https://foxpilot-feedback.co-balakumar.workers.dev/v1/feedback";

// Where a user can file the same report by hand when sending is off or failing.
export const FEEDBACK_ISSUES_URL = "https://github.com/balakumardev/foxpilot/issues";

export const FEEDBACK_KINDS = ["bug", "feature", "improvement", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

// Mirrors the server's validation; the server rejects anything outside these.
export const FEEDBACK_LIMITS = {
  titleMin: 3,
  titleMax: 140,
  descriptionMin: 10,
  descriptionMax: 8000,
  fieldMax: 64,
} as const;

const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_CAP_BYTES = 16 * 1024;

export const SEND_FEEDBACK_DESCRIPTION =
  "Send a bug report, feature request or improvement idea about FoxPilot itself to the FoxPilot maintainers' ticket system. " +
  "Send only when the user asks you to report something or agrees to it after you offer: show the user the exact title and description first, and set userApproved to true only once they have agreed to send that exact report. " +
  "Describe the FoxPilot problem generically: which FoxPilot tool was involved, what you did, what you expected, and what happened (FoxPilot's own error text is fine). " +
  "NEVER include page content, URLs, tab titles, cookies, credentials, link tokens or personal data. " +
  "The report is sent over the internet to the FoxPilot maintainers' ticket system. Values that look like secrets or personal data are redacted automatically first, but do not rely on that. " +
  "This tool does not need a connected browser. The user can turn off its network call by setting FOXPILOT_FEEDBACK=off in the FoxPilot server's environment.";

export const sendFeedbackInputShape = {
  kind: z
    .enum(FEEDBACK_KINDS)
    .describe("bug = something broken; feature = a new capability; improvement = a change to existing behaviour; other = anything else."),
  title: z
    .string()
    .min(FEEDBACK_LIMITS.titleMin)
    .max(FEEDBACK_LIMITS.titleMax)
    .describe("One-line summary, 3-140 characters. Generic: no page content, URLs or personal data."),
  description: z
    .string()
    .min(FEEDBACK_LIMITS.descriptionMin)
    .max(FEEDBACK_LIMITS.descriptionMax)
    .describe(
      "What you did, what you expected and what happened, 10-8000 characters. Generic: no page content, URLs, tab titles, cookies, credentials, link tokens or personal data."
    ),
  tool: z
    .string()
    .max(FEEDBACK_LIMITS.fieldMax)
    .optional()
    .describe("The FoxPilot tool involved, for example click-element. Omit if none."),
  userApproved: z
    .literal(true)
    .describe("Set true only after the user has agreed to send this exact report"),
};

// The tool reads, writes nothing locally and files a new ticket on every
// distinct report; it talks to a server outside the user's machine.
export const SEND_FEEDBACK_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Endpoint resolution
// ---------------------------------------------------------------------------

export type FeedbackEndpoint =
  | { status: "ok"; url: string }
  | { status: "disabled" }
  | { status: "invalid"; error: string };

const OFF_VALUES = new Set(["off", "0", "false", "disabled"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * FOXPILOT_FEEDBACK=off (also 0, false, disabled; any case) turns sending off.
 * FOXPILOT_FEEDBACK_URL overrides the endpoint: https, or http for loopback
 * only. An override that fails those rules is an error, never a silent
 * fallback to the default, so a typo cannot send reports somewhere unintended.
 */
export function resolveFeedbackEndpoint(env: Env): FeedbackEndpoint {
  const sw = env.FOXPILOT_FEEDBACK;
  if (sw !== undefined && OFF_VALUES.has(sw.trim().toLowerCase())) {
    return { status: "disabled" };
  }
  const override = env.FOXPILOT_FEEDBACK_URL?.trim();
  if (!override) return { status: "ok", url: DEFAULT_FEEDBACK_URL };

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    return { status: "invalid", error: "FOXPILOT_FEEDBACK_URL is not a valid URL." };
  }
  // The value is never echoed back: it could carry a credential.
  if (parsed.username || parsed.password) {
    return { status: "invalid", error: "FOXPILOT_FEEDBACK_URL must not contain a username or password." };
  }
  const allowed =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname));
  if (!allowed) {
    return {
      status: "invalid",
      error: `FOXPILOT_FEEDBACK_URL must be https, or http only for localhost, 127.0.0.1 or [::1] (got ${parsed.protocol}//${parsed.hostname}).`,
    };
  }
  return { status: "ok", url: parsed.href };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACTED = "[redacted]";
const EMAIL = "[email]";

// Hard stop on the redact-until-stable loop. Two passes is the norm.
const MAX_REDACTION_PASSES = 4;

// Every pattern below is anchored on a literal or a bounded quantifier so a
// 64 KB hostile string cannot trigger quadratic backtracking. An unbounded
// class in front of a literal (the classic /[a-z]+@/) is the thing to avoid.

// A value assigned to a secret-looking name: long enough, and either has a
// digit or is long enough that prose is unlikely. Passwords are shorter and
// plainer, so they get lower bars.
function looksSecret(v: string, passwordLike = false): boolean {
  const [min, long] = passwordLike ? [6, 12] : [8, 24];
  return v.length >= min && (/\d/.test(v) || v.length >= long);
}

interface Rule {
  re: RegExp;
  // Receives String.replace arguments; returning the match unchanged means
  // "leave it", which is also how already-redacted text is skipped (that is
  // what makes redaction idempotent).
  fn: (m: string, ...rest: any[]) => string; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function count(s: string, ch: string): number {
  let n = 0;
  for (let i = s.indexOf(ch); i !== -1; i = s.indexOf(ch, i + 1)) n++;
  return n;
}

function redactUrl(m: string, scheme: string, body: string): string {
  // Trailing sentence punctuation belongs to the prose, not the URL.
  let end = body.length;
  while (end > 0 && ").},;:!".includes(body[end - 1])) end--;
  let core = body.slice(0, end);
  let trail = body.slice(end);

  const q = core.indexOf("?");
  const h = core.indexOf("#");
  const cut = q === -1 ? h : h === -1 ? q : Math.min(q, h);
  let head = cut === -1 ? core : core.slice(0, cut);
  let tail = cut === -1 ? "" : core.slice(cut);

  const slash = head.indexOf("/");
  const authority = slash === -1 ? head : head.slice(0, slash);
  const at = authority.lastIndexOf("@");
  if (at !== -1) head = authority.slice(at + 1) + head.slice(authority.length);

  // `[see https://x/a?b=c]`: a closing bracket the prose opened is not part of
  // the query. Brackets the marker itself brings (`?[redacted]`) are balanced.
  while (tail.endsWith("]") && count(tail, "]") > count(tail, "[")) {
    tail = tail.slice(0, -1);
    trail = "]" + trail;
  }
  if (tail.length > 1 && tail !== `?${REDACTED}` && tail !== `#${REDACTED}`) {
    tail = tail[0] + REDACTED;
  }
  core = head + tail;
  const out = `${scheme}://${core}${trail}`;
  return out === m ? m : out;
}

const RULES: Rule[] = [
  // FoxPilot link tokens: fpl1.<base64url secret>[.<base64url relay url>]
  {
    re: /\bfpl1\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)*=*/g,
    fn: () => REDACTED,
  },
  // Header values, as plain lines or as JSON/quoted strings.
  {
    re: /\b(authorization|proxy-authorization|cookie|set-cookie)(["']?[ \t]{0,8}:[ \t]{0,8})("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi,
    fn: (m: string, name: string, sep: string, value: string) => {
      const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0];
      const q = quoted ? value[0] : "";
      const inner = quoted ? value.slice(1, -1) : value;
      if (inner.trim() === REDACTED) return m;
      return `${name}${sep}${q}${REDACTED}${q}`;
    },
  },
  {
    re: /\bBearer[ \t]{1,8}([A-Za-z0-9._~+/-]{8,}=*)/gi,
    fn: (m: string, token: string) => (looksSecret(token) ? m.slice(0, m.length - token.length) + REDACTED : m),
  },
  // JWT: header and payload are base64url JSON, so the header starts "eyJ".
  // A generic "three dotted segments" rule would eat host and property names.
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    fn: () => REDACTED,
  },
  // Well-known API key shapes.
  {
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,})/g,
    // "sk-learn-pipeline" is a package name; real sk- keys carry digits.
    fn: (m: string) => (m.startsWith("sk-") && !/\d/.test(m) ? m : REDACTED),
  },
  // URLs: drop credentials, query string and fragment; keep scheme, host, path.
  {
    re: /\b([A-Za-z][A-Za-z0-9+.-]{1,15}):\/\/([^\s<>"'`]+)/g,
    fn: redactUrl,
  },
  // key=value / "key": "value" for secret-looking names.
  {
    re: /(api[-_]?key|(?:access|secret|private|signing|encryption)[-_]?key|secret|token|passwd|password|credentials?)([\w-]{0,12}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)([A-Za-z0-9+/_.~=-]{6,})/gi,
    fn: (m: string, key: string, sep: string, value: string, offset: number, str: string) => {
      // token = getToken(session): a call, not a literal.
      if (str[offset + m.length] === "(") return m;
      return looksSecret(value, /^passw/i.test(key)) ? key + sep + REDACTED : m;
    },
  },
  // Email addresses. Bounded quantifiers keep this linear on long inputs.
  {
    re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g,
    fn: () => EMAIL,
  },
  // Home directories. Windows first, so "C:/Users/x" is not half-matched by the
  // Unix rule. Unix paths must start a token (or follow file://) so a URL path
  // such as https://example.com/home/page is left alone.
  {
    re: /\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`)\]}<>|:]+(?: [^\\/\s"'`)\]}<>|:]+(?=[\\/]))?/gi,
    fn: () => "~",
  },
  {
    re: /(?:(?<=^|[\s"'`(\[{=:,<>|])|(?<=file:\/\/))\/(?:Users|home)\/[^/\s"'`)\]}<>|:\\]+/g,
    fn: () => "~",
  },
];

/**
 * Replaces secrets and personal data with visible markers. Runs until the text
 * stops changing, so redacting already-redacted text is a no-op that reports
 * zero replacements. Linear in the input length.
 */
export function redactSensitive(text: string): { text: string; count: number } {
  let current = text;
  let count = 0;
  for (let pass = 0; pass < MAX_REDACTION_PASSES; pass++) {
    let changed = 0;
    for (const rule of RULES) {
      current = current.replace(rule.re, (...args: any[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const out = rule.fn(...(args as [string, ...any[]]));
        if (out !== args[0]) changed++;
        return out;
      });
    }
    if (changed === 0) break;
    count += changed;
  }
  return { text: current, count };
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface FeedbackInput {
  kind: FeedbackKind;
  title: string;
  description: string;
  tool?: string;
}

export interface FeedbackMetadata {
  foxpilotVersion?: string;
  clientName?: string;
  clientVersion?: string;
  platform?: string;
  nodeVersion?: string;
}

/** Exactly the fields the API accepts; it rejects unknown ones. */
export interface FeedbackPayload extends FeedbackMetadata {
  kind: FeedbackKind;
  title: string;
  description: string;
  tool?: string;
}

export type FeedbackField = "title" | "description" | "tool";

export type BuildFeedbackResult =
  | { ok: true; payload: FeedbackPayload; redactions: number; truncated: FeedbackField[] }
  | { ok: false; error: string };

// Control characters other than tab and newline have no place in a report.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function clip(s: string, max: number, ellipsis: boolean): { text: string; clipped: boolean } {
  if (s.length <= max) return { text: s, clipped: false };
  let end = ellipsis ? max - 1 : max;
  // Do not leave half of a surrogate pair at the cut.
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: s.slice(0, end) + (ellipsis ? "…" : ""), clipped: true };
}

function cleanMeta(v: string | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = clip(v.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim(), FEEDBACK_LIMITS.fieldMax, false).text.trim();
  return s === "" ? undefined : s;
}

/**
 * Sanitises, redacts and length-limits a report. Limits are applied after
 * redaction because a marker can be longer than what it replaced. Only the API's
 * own fields are copied, so model-supplied extras (userApproved included) can
 * never reach the wire.
 */
export function buildFeedbackPayload(
  input: FeedbackInput,
  meta: FeedbackMetadata = {}
): BuildFeedbackResult {
  if (!(FEEDBACK_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, error: `kind must be one of ${FEEDBACK_KINDS.join(", ")}.` };
  }
  const truncated: FeedbackField[] = [];

  const titleRaw = String(input.title ?? "").replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  const descRaw = String(input.description ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .trim();
  const toolRaw = String(input.tool ?? "").replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();

  const t = redactSensitive(titleRaw);
  const d = redactSensitive(descRaw);
  const tl = redactSensitive(toolRaw);
  const redactions = t.count + d.count + tl.count;

  const title = clip(t.text, FEEDBACK_LIMITS.titleMax, true);
  const description = clip(d.text, FEEDBACK_LIMITS.descriptionMax, true);
  const tool = clip(tl.text, FEEDBACK_LIMITS.fieldMax, false);
  if (title.clipped) truncated.push("title");
  if (description.clipped) truncated.push("description");
  if (tool.clipped) truncated.push("tool");

  if (title.text.length < FEEDBACK_LIMITS.titleMin) {
    return { ok: false, error: `The title is shorter than ${FEEDBACK_LIMITS.titleMin} characters once sensitive values are removed. Nothing was sent.` };
  }
  if (description.text.length < FEEDBACK_LIMITS.descriptionMin) {
    return { ok: false, error: `The description is shorter than ${FEEDBACK_LIMITS.descriptionMin} characters once sensitive values are removed. Nothing was sent.` };
  }

  const payload: FeedbackPayload = {
    kind: input.kind,
    title: title.text,
    description: description.text,
  };
  if (tool.text.trim() !== "") payload.tool = tool.text.trim();
  const metaFields: (keyof FeedbackMetadata)[] = ["foxpilotVersion", "clientName", "clientVersion", "platform", "nodeVersion"];
  for (const key of metaFields) {
    const v = cleanMeta(meta[key]);
    if (v !== undefined) payload[key] = v;
  }
  return { ok: true, payload, redactions, truncated };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type UnknownOutcomeReason =
  | "timeout"
  | "cancelled"
  | "gateway-timeout"
  | "server-error"
  | "connection-lost"
  | "unreadable-response";

export type FeedbackResult =
  | { kind: "sent"; ref: string | null }
  | { kind: "duplicate"; ref: string | null }
  | { kind: "rate-limited"; retryAfterSeconds: number | null; error?: string }
  | { kind: "rejected"; status: number; error?: string }
  | { kind: "unknown-outcome"; reason: UnknownOutcomeReason; status?: number }
  | { kind: "network-error"; error: string }
  | { kind: "invalid-endpoint"; error: string }
  | { kind: "disabled" };

export interface SendFeedbackOptions {
  env?: Env;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Aborts the request, e.g. when the MCP client cancels the tool call. */
  signal?: AbortSignal;
}

// Errors that can only happen before the request reached the server.
const PRE_SEND_ERROR = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ERR_INVALID_URL|UND_ERR_CONNECT_TIMEOUT|CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH)/;
// Errors after the request was written: the server may have acted on it.
const POST_SEND_ERROR = /^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_ABORTED)$/;

function cleanText(s: string, max: number): string {
  return clip(s.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim(), max, true).text;
}

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : undefined;
}

function errorText(err: unknown): string {
  const e = err as { message?: unknown; cause?: { message?: unknown } } | null;
  const parts = [e?.message, e?.cause?.message].filter((p): p is string => typeof p === "string");
  return parts.join(" ");
}

class AbortedError extends Error {
  constructor(public readonly reason: "timeout" | "cancelled") {
    super(reason);
  }
}

async function readCappedBody(res: Response): Promise<string> {
  const stream = res.body;
  if (!stream) {
    try {
      return (await res.text()).slice(0, RESPONSE_BODY_CAP_BYTES);
    } catch {
      return "";
    }
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= RESPONSE_BODY_CAP_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
  } finally {
    // Not awaited: a stalled stream must not stall us.
    reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(Math.min(total, RESPONSE_BODY_CAP_BYTES));
  let offset = 0;
  for (const c of chunks) {
    if (offset >= all.length) break;
    const part = c.length > all.length - offset ? c.subarray(0, all.length - offset) : c;
    all.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder("utf-8").decode(all);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function cleanRef(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9#._-]{1,40}$/.test(v) ? v : null;
}

function classifyResponse(status: number, retryAfter: string | null, text: string): FeedbackResult {
  const body = parseJsonObject(text);
  const error = typeof body?.error === "string" ? cleanText(body.error, 200) : undefined;

  if (status >= 200 && status < 300) {
    if (body?.ok === true) {
      const ref = cleanRef(body.ref);
      return body.duplicate === true ? { kind: "duplicate", ref } : { kind: "sent", ref };
    }
    // A 2xx that is not our API's answer (a captive portal, a proxy page).
    return { kind: "unknown-outcome", reason: "unreadable-response", status };
  }
  if (status === 429) {
    const secs = retryAfter !== null && /^\d{1,9}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
    return { kind: "rate-limited", retryAfterSeconds: secs, error };
  }
  if (status === 504) return { kind: "unknown-outcome", reason: "gateway-timeout", status };
  if (status >= 500 && status !== 502 && status !== 503) {
    return { kind: "unknown-outcome", reason: "server-error", status };
  }
  return { kind: "rejected", status, error };
}

function classifyFetchError(err: unknown): FeedbackResult {
  const code = errorCode(err);
  const text = errorText(err);
  if (/redirect/i.test(text)) {
    return { kind: "network-error", error: "the endpoint tried to redirect the request, and redirects are not followed" };
  }
  if (code && POST_SEND_ERROR.test(code)) {
    return { kind: "unknown-outcome", reason: "connection-lost" };
  }
  const shown = code && PRE_SEND_ERROR.test(code) ? code : cleanText(text || (err instanceof Error ? err.name : "unknown error"), 120);
  return { kind: "network-error", error: shown };
}

/**
 * POSTs the report once. Never throws and never retries: the server dedupes
 * identical reports, but a blind retry after an unclear outcome is still the
 * caller's decision, not ours.
 */
export async function sendFeedback(
  payload: FeedbackPayload,
  opts: SendFeedbackOptions = {}
): Promise<FeedbackResult> {
  try {
    const endpoint = resolveFeedbackEndpoint(opts.env ?? process.env);
    if (endpoint.status === "disabled") return { kind: "disabled" };
    if (endpoint.status === "invalid") return { kind: "invalid-endpoint", error: endpoint.error };
    if (opts.signal?.aborted) {
      return { kind: "network-error", error: "the request was cancelled before it was sent" };
    }

    const fetchImpl = opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const state: { reason: "timeout" | "cancelled" | null } = { reason: null };
    const abort = (reason: "timeout" | "cancelled") => {
      if (state.reason === null) state.reason = reason;
      controller.abort();
    };
    const timer = setTimeout(() => abort("timeout"), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const onCallerAbort = () => abort("cancelled");
    if (opts.signal?.aborted) onCallerAbort();
    else opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

    // Rejects on abort even if an injected fetch ignores the signal, so the
    // call can never hang past its deadline.
    const aborted = new Promise<never>((_, reject) => {
      const fire = () => reject(new AbortedError(state.reason ?? "timeout"));
      if (controller.signal.aborted) fire();
      else controller.signal.addEventListener("abort", fire, { once: true });
    });
    aborted.catch(() => undefined);

    try {
      let res: Response;
      try {
        res = await Promise.race([
          fetchImpl(endpoint.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "User-Agent": `foxpilot-mcp/${FOXPILOT_VERSION}`,
            },
            body: JSON.stringify(payload),
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal: controller.signal,
          }),
          aborted,
        ]);
      } catch (err) {
        if (err instanceof AbortedError) return { kind: "unknown-outcome", reason: err.reason };
        if (state.reason !== null) return { kind: "unknown-outcome", reason: state.reason };
        return classifyFetchError(err);
      }

      // The status is known; a body that cannot be read in time only costs
      // the ref and error text.
      let text = "";
      try {
        text = await Promise.race([readCappedBody(res), aborted]);
      } catch {
        text = "";
      }
      return classifyResponse(res.status, res.headers?.get("retry-after") ?? null, text);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);
    }
  } catch (err) {
    return { kind: "network-error", error: cleanText(errorText(err) || "unexpected error", 120) };
  }
}

// ---------------------------------------------------------------------------
// Result text
// ---------------------------------------------------------------------------

export interface FeedbackNotes {
  redactions: number;
  truncated: FeedbackField[];
}

function formatWait(seconds: number | null): string {
  if (seconds === null) return "a while";
  if (seconds < 90) return `${Math.max(1, seconds)} seconds`;
  if (seconds < 5400) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
}

function noteLines(notes: FeedbackNotes): string[] {
  const lines: string[] = [];
  if (notes.redactions > 0) {
    lines.push(
      `${notes.redactions} value${notes.redactions === 1 ? "" : "s"} that looked sensitive (such as tokens, emails, URL query strings or home-directory paths) ${notes.redactions === 1 ? "was" : "were"} redacted from the report before sending.`
    );
  }
  if (notes.truncated.length > 0) {
    lines.push(`The ${notes.truncated.join(" and ")} had to be shortened to fit the length limit.`);
  }
  return lines;
}

/** The tool's reply text. Failures set isError so the caller notices. */
export function formatFeedbackResult(
  result: FeedbackResult,
  notes: FeedbackNotes = { redactions: 0, truncated: [] }
): { text: string; isError: boolean } {
  const manual = `The user can report it by hand at ${FEEDBACK_ISSUES_URL}.`;
  switch (result.kind) {
    case "sent":
      return {
        isError: false,
        text: [
          result.ref
            ? `Feedback sent to the FoxPilot maintainers. Reference: ${result.ref}.`
            : "Feedback sent to the FoxPilot maintainers (the ticket system returned no reference).",
          ...noteLines(notes),
        ].join("\n"),
      };
    case "duplicate":
      return {
        isError: false,
        text: [
          result.ref
            ? `This report was already filed (reference ${result.ref}). Nothing new was created.`
            : "This report was already filed. Nothing new was created.",
          ...noteLines(notes),
        ].join("\n"),
      };
    case "rate-limited":
      return {
        isError: true,
        text: `Not sent: the feedback service is rate limiting reports. Try again in about ${formatWait(result.retryAfterSeconds)}, and do not retry in a loop. ${manual}`,
      };
    case "rejected": {
      const why = result.error ? ` (${result.error})` : "";
      if (result.status === 400) {
        return {
          isError: true,
          text: `Not sent: the feedback service rejected the report${why}. Nothing was filed. Fix the report and send it again only if the user still wants that.`,
        };
      }
      return {
        isError: true,
        text: `Not sent: the feedback service could not file the report (HTTP ${result.status})${why}. Nothing was filed. ${manual}`,
      };
    }
    case "unknown-outcome": {
      const why: Record<UnknownOutcomeReason, string> = {
        timeout: "The feedback service did not answer within 10 seconds.",
        cancelled: "The request was cancelled before an answer arrived.",
        "gateway-timeout": "The feedback service timed out while filing the report (HTTP 504).",
        "server-error": `The feedback service failed with HTTP ${result.status ?? "5xx"}.`,
        "connection-lost": "The connection dropped after the report was sent.",
        "unreadable-response": `The feedback endpoint answered HTTP ${result.status ?? "2xx"} with a reply this client does not recognise.`,
      };
      return {
        isError: true,
        text: [
          `Outcome unknown: ${why[result.reason]} The report may already have been filed. Do not resend it blindly: tell the user, and resend only if they ask you to. ${manual}`,
          ...noteLines(notes),
        ].join("\n"),
      };
    }
    case "network-error":
      return {
        isError: true,
        text: `Not sent: could not reach the feedback service (${result.error}). ${manual}`,
      };
    case "invalid-endpoint":
      return {
        isError: true,
        text: `Not sent: ${result.error} Fix or unset FOXPILOT_FEEDBACK_URL in the FoxPilot server's environment.`,
      };
    case "disabled":
      return {
        isError: false,
        text: `Nothing was sent: feedback sending is turned off by the FOXPILOT_FEEDBACK setting. ${manual}`,
      };
  }
}

export interface SubmitFeedbackContext extends SendFeedbackOptions {
  metadata?: FeedbackMetadata;
}

/** The whole tool body: build, send, format. Never throws. */
export async function submitFeedback(
  input: FeedbackInput,
  ctx: SubmitFeedbackContext = {}
): Promise<{ text: string; isError: boolean; result?: FeedbackResult }> {
  const endpoint = resolveFeedbackEndpoint(ctx.env ?? process.env);
  if (endpoint.status === "disabled") {
    return { ...formatFeedbackResult({ kind: "disabled" }), result: { kind: "disabled" } };
  }
  if (endpoint.status === "invalid") {
    const result: FeedbackResult = { kind: "invalid-endpoint", error: endpoint.error };
    return { ...formatFeedbackResult(result), result };
  }
  const built = buildFeedbackPayload(input, ctx.metadata);
  if (!built.ok) return { text: built.error, isError: true };
  const result = await sendFeedback(built.payload, ctx);
  return {
    ...formatFeedbackResult(result, { redactions: built.redactions, truncated: built.truncated }),
    result,
  };
}
