import {
  FEEDBACK_PATH,
  IP_HASH_KEY_MIN_LENGTH,
  MAX_BODY_BYTES,
  parseLinearConfig,
  type LinearConfig,
} from "./config";
import type { Env } from "./env";
import { buildIssueInput } from "./format";
import { createLinearIssue, type FetchLike } from "./linear";
import {
  checkLimits,
  clientHash,
  contentHash,
  recordOutcome,
  recordSubmission,
  type LimitDecision,
} from "./limits";
import { validateFeedback } from "./validate";

export interface Deps {
  now?: () => Date;
  nonce?: () => string;
  fetchImpl?: FetchLike;
  linearTimeoutMs?: number;
}

const LIMIT_MESSAGES: Record<Extract<LimitDecision, { action: "limit" }>["reason"], string> = {
  burst: "too many submissions from your network",
  busy: "the service is receiving too many submissions",
  "ip-daily": "daily limit reached for your network; it resets at 00:00 UTC",
  "global-daily": "the service's daily limit is reached; it resets at 00:00 UTC",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

const bad = (error: string) => json(400, { ok: false, error });
const unavailable = () => json(503, { ok: false, error: "feedback temporarily unavailable" });

// Logs carry event names, ticket refs and reasons only: never an address, a secret or report text.
function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** Reads at most `max` bytes of the body; null if it is larger. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

type Settings =
  | { ok: true; apiKey: string; ipHashKey: string; linear: LinearConfig }
  | { ok: false; setting: string; reason: string };

// A bad setting is reported by name and a fixed reason; the values are never read into a log line.
function readSettings(env: Env): Settings {
  const apiKey = env.LINEAR_API_KEY?.trim();
  if (!apiKey) return { ok: false, setting: "LINEAR_API_KEY", reason: "missing" };
  // A key pasted with stray text or non-ASCII characters makes every request throw before it is sent,
  // which would look like a Linear outage. Catch it as a configuration error instead.
  if (!/^[\x21-\x7E]{8,512}$/.test(apiKey)) return { ok: false, setting: "LINEAR_API_KEY", reason: "malformed" };
  const ipHashKey = env.IP_HASH_KEY?.trim();
  if (!ipHashKey || ipHashKey.length < IP_HASH_KEY_MIN_LENGTH) {
    return { ok: false, setting: "IP_HASH_KEY", reason: "missing or too short" };
  }
  const linear = parseLinearConfig(env.LINEAR_CONFIG);
  if (!linear.ok) return { ok: false, setting: "LINEAR_CONFIG", reason: linear.reason };
  return { ok: true, apiKey, ipHashKey, linear: linear.value };
}

async function route(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (new URL(request.url).pathname !== FEEDBACK_PATH) {
    return json(404, { ok: false, error: "not found" });
  }
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "method not allowed; use POST" }, { Allow: "POST" });
  }
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return bad("Content-Type must be application/json");
  }

  const tooLarge = `body must be at most ${MAX_BODY_BYTES} bytes`;
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return bad(tooLarge);
  const bytes = await readCapped(request, MAX_BODY_BYTES);
  if (!bytes) return bad(tooLarge);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return bad("body must be valid UTF-8 JSON");
  }
  const validation = validateFeedback(parsed);
  if (!validation.ok) return bad(validation.error);
  const feedback = validation.value;

  const settings = readSettings(env);
  if (!settings.ok) {
    log("not_configured", { setting: settings.setting, reason: settings.reason });
    return json(503, { ok: false, error: "feedback not configured" });
  }

  const now = deps.now?.() ?? new Date();
  const client = await clientHash(request.headers.get("cf-connecting-ip"), settings.ipHashKey);
  const content = await contentHash(feedback);

  let decision: LimitDecision;
  try {
    decision = await checkLimits({
      kv: env.FEEDBACK_KV,
      clientLimiter: env.BURST_LIMITER,
      globalLimiter: env.GLOBAL_LIMITER,
      now,
      client,
      content,
    });
  } catch (err) {
    log("limits_unavailable", { error: errorName(err) });
    return unavailable();
  }
  if (decision.action === "limit") {
    log("rate_limited", { reason: decision.reason });
    return json(
      429,
      { ok: false, error: LIMIT_MESSAGES[decision.reason] },
      { "Retry-After": String(decision.retryAfter) }
    );
  }
  if (decision.action === "duplicate") {
    log("duplicate", { ref: decision.ref });
    return json(200, { ok: true, ref: decision.ref, duplicate: true });
  }

  try {
    await recordSubmission(env.FEEDBACK_KV, now, client, deps.nonce?.() ?? crypto.randomUUID().slice(0, 8));
  } catch (err) {
    log("record_failed", { error: errorName(err) });
    return unavailable();
  }

  const result = await createLinearIssue(
    settings.apiKey,
    buildIssueInput(feedback, settings.linear),
    deps.fetchImpl,
    deps.linearTimeoutMs
  );
  try {
    await recordOutcome(env.FEEDBACK_KV, content, result);
  } catch (err) {
    log("dedupe_write_failed", { outcome: result.kind, error: errorName(err) });
  }

  if (result.kind === "created") {
    log("created", { ref: result.ref, kind: feedback.kind });
    return json(201, { ok: true, ref: result.ref });
  }
  log("linear_error", { outcome: result.kind, status: result.status, code: result.code, message: result.message, error: result.errorName });
  if (result.kind === "unknown") {
    return json(504, { ok: false, error: "the ticket service did not answer; the report may have been filed" });
  }
  return json(502, { ok: false, error: "the ticket service rejected the report" });
}

export async function handleRequest(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  try {
    return await route(request, env, deps);
  } catch (err) {
    log("unhandled", { error: errorName(err) });
    return json(500, { ok: false, error: "internal error" });
  }
}
