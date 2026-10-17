import {
  BURST_RETRY_AFTER_SECONDS,
  DEDUPE_TTL_SECONDS,
  GLOBAL_DAILY_CAP,
  IP_DAILY_CAP,
  SUBMISSION_TTL_SECONDS,
  isTicketRef,
} from "./config";
import type { KvStore, RateLimiter } from "./env";
import type { Feedback } from "./validate";
import type { LinearOutcome } from "./linear";

// Values stored under a content hash when there is no ticket ref to remember.
const FILED = "filed";
const PENDING = "pending";
const GLOBAL_LIMIT_KEY = "global";

export type LimitReason = "burst" | "busy" | "ip-daily" | "global-daily";

export type LimitDecision =
  | { action: "allow" }
  | { action: "duplicate"; ref: string | null }
  | { action: "limit"; reason: LimitReason; retryAfter: number };

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function secondsUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Maps an address to the unit that is rate-limited: IPv4 per address, IPv6 per /48 (a
 * typical site allocation, so rotating through a /64 gains nothing).
 */
export function clientBucket(ip: string | null | undefined): string {
  if (!ip) return "unknown";
  const v = ip.trim().toLowerCase();
  if (!v.includes(":")) return v;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) return mapped[1];
  const groups = expandIPv6(v);
  return groups ? `${groups.slice(0, 3).join(":")}::/48` : v;
}

function expandIPv6(v: string): string[] | null {
  const halves = v.split("%")[0].split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 2 && fill < 1)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ""));
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** The only form in which a client address is stored or logged. */
export async function clientHash(ip: string | null | undefined, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`client:${clientBucket(ip)}`));
  return toHex(mac).slice(0, 32);
}

export async function contentHash(fb: Feedback): Promise<string> {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return sha256Hex([fb.kind, norm(fb.title), norm(fb.description)].join("\0"));
}

export const kvKeys = {
  dedupe: (content: string) => `dup:${content}`,
  capped: (day: string) => `cap:${day}`,
  clientCapped: (day: string, client: string) => `cap:${day}:${client}`,
  day: (day: string) => `sub:${day}:`,
  client: (day: string, client: string) => `sub:${day}:${client}:`,
  submission: (day: string, client: string, now: Date, nonce: string) =>
    `sub:${day}:${client}:${now.getTime().toString(36)}-${nonce}`,
};

async function listToday(kv: KvStore, prefix: string, cap: number): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await kv.list({ prefix, limit: cap, cursor });
    for (const k of res.keys) names.push(k.name);
    if (res.list_complete || !res.cursor || names.length >= cap) break;
    cursor = res.cursor;
  }
  return names;
}

// Remembers that a cap was hit so later requests skip the listing. Best effort.
async function setFlag(kv: KvStore, key: string): Promise<void> {
  try {
    await kv.put(key, "1", { expirationTtl: SUBMISSION_TTL_SECONDS });
  } catch {
    // The next request just lists again.
  }
}

export interface LimitInput {
  kv: KvStore;
  clientLimiter: RateLimiter;
  globalLimiter: RateLimiter;
  now: Date;
  client: string;
  content: string;
}

export async function checkLimits(input: LimitInput): Promise<LimitDecision> {
  const burst = await input.clientLimiter.limit({ key: input.client });
  if (!burst.success) return { action: "limit", reason: "burst", retryAfter: BURST_RETRY_AFTER_SECONDS };
  const global = await input.globalLimiter.limit({ key: GLOBAL_LIMIT_KEY });
  if (!global.success) return { action: "limit", reason: "busy", retryAfter: BURST_RETRY_AFTER_SECONDS };

  const day = utcDay(input.now);
  const untilMidnight = secondsUntilUtcMidnight(input.now);
  const [existing, globalCapped, clientCapped] = await Promise.all([
    input.kv.get(kvKeys.dedupe(input.content)),
    input.kv.get(kvKeys.capped(day)),
    input.kv.get(kvKeys.clientCapped(day, input.client)),
  ]);
  if (existing) return { action: "duplicate", ref: isTicketRef(existing) ? existing : null };
  if (globalCapped) return { action: "limit", reason: "global-daily", retryAfter: untilMidnight };
  if (clientCapped) return { action: "limit", reason: "ip-daily", retryAfter: untilMidnight };

  const today = await listToday(input.kv, kvKeys.day(day), GLOBAL_DAILY_CAP);
  if (today.length >= GLOBAL_DAILY_CAP) {
    await setFlag(input.kv, kvKeys.capped(day));
    return { action: "limit", reason: "global-daily", retryAfter: untilMidnight };
  }
  const mine = kvKeys.client(day, input.client);
  if (today.filter((name) => name.startsWith(mine)).length >= IP_DAILY_CAP) {
    await setFlag(input.kv, kvKeys.clientCapped(day, input.client));
    return { action: "limit", reason: "ip-daily", retryAfter: untilMidnight };
  }
  return { action: "allow" };
}

/** Counted before the Linear call, so a request that fails still uses up quota. */
export async function recordSubmission(
  kv: KvStore,
  now: Date,
  client: string,
  nonce: string
): Promise<void> {
  await kv.put(kvKeys.submission(utcDay(now), client, now, nonce), "1", {
    expirationTtl: SUBMISSION_TTL_SECONDS,
  });
}

/**
 * Remembers a report so a repeat gets the same answer instead of a second ticket. A rejected
 * report is not remembered (nothing was filed); an unknown outcome is, because the ticket
 * may exist.
 */
export async function recordOutcome(
  kv: KvStore,
  content: string,
  outcome: LinearOutcome
): Promise<void> {
  if (outcome.kind === "rejected") return;
  const value = outcome.kind === "unknown" ? PENDING : outcome.ref ?? FILED;
  await kv.put(kvKeys.dedupe(content), value, { expirationTtl: DEDUPE_TTL_SECONDS });
}
