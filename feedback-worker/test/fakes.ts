import { vi } from "vitest";
import type { Env, KvListResult, KvStore, RateLimiter } from "../src/env";
import type { FetchLike } from "../src/linear";

type KvOp = "get" | "put" | "list";

export class FakeKv implements KvStore {
  readonly store = new Map<string, { value: string; ttl?: number }>();
  readonly calls: { op: KvOp; key: string }[] = [];
  /** Operations that throw, to simulate a KV outage. */
  readonly failing = new Set<KvOp>();
  /** Throw on put for keys matching this predicate. */
  failPutFor?: (key: string) => boolean;
  /** Keys returned per list page (the real limit is the `limit` option, up to 1000). */
  pageSize = Infinity;

  async get(key: string): Promise<string | null> {
    this.calls.push({ op: "get", key });
    if (this.failing.has("get")) throw new Error("kv get unavailable");
    return this.store.get(key)?.value ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.calls.push({ op: "put", key });
    if (this.failing.has("put") || this.failPutFor?.(key)) throw new Error("kv put unavailable");
    this.store.set(key, { value, ttl: options?.expirationTtl });
  }

  async list(options: { prefix: string; limit: number; cursor?: string }): Promise<KvListResult> {
    this.calls.push({ op: "list", key: options.prefix });
    if (this.failing.has("list")) throw new Error("kv list unavailable");
    const names = [...this.store.keys()].filter((k) => k.startsWith(options.prefix)).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const end = Math.min(start + Math.min(options.limit, this.pageSize), names.length);
    const keys = names.slice(start, end).map((name) => ({ name }));
    return end >= names.length
      ? { keys, list_complete: true }
      : { keys, list_complete: false, cursor: String(end) };
  }

  seed(key: string, value = "1"): void {
    this.store.set(key, { value });
  }

  count(op: KvOp): number {
    return this.calls.filter((c) => c.op === op).length;
  }
}

/** Allows `max` calls per key, then refuses, like a fixed window that never rolls over. */
export class FakeLimiter implements RateLimiter {
  readonly seen: string[] = [];
  throwOnLimit = false;
  private readonly counts = new Map<string, number>();

  constructor(private readonly max = Infinity) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    if (this.throwOnLimit) throw new Error("limiter unavailable");
    this.seen.push(key);
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return { success: n <= this.max };
  }
}

export const TEAM_ID = "11111111-1111-4111-8111-111111111111";
export const ASSIGNEE_ID = "22222222-2222-4222-8222-222222222222";
export const LABEL_BASE = "33333333-3333-4333-8333-333333333333";
export const LABEL_BUG = "44444444-4444-4444-8444-444444444444";
export const LABEL_FEATURE = "55555555-5555-4555-8555-555555555555";

export const SECRETS = {
  apiKey: "lin_api_TESTKEY_0123456789abcdef",
  ipHashKey: "test-ip-hash-key-0123456789-abcdefghij",
  config: JSON.stringify({
    teamId: TEAM_ID,
    assigneeId: ASSIGNEE_ID,
    labelIds: [LABEL_BASE],
    kindLabelIds: { bug: LABEL_BUG, feature: LABEL_FEATURE },
  }),
};

export interface TestEnv {
  env: Env;
  kv: FakeKv;
  burst: FakeLimiter;
  global: FakeLimiter;
}

export function makeEnv(overrides: Partial<Env> = {}, limiters?: { burst?: number; global?: number }): TestEnv {
  const kv = new FakeKv();
  const burst = new FakeLimiter(limiters?.burst);
  const global = new FakeLimiter(limiters?.global);
  const env: Env = {
    FEEDBACK_KV: kv,
    BURST_LIMITER: burst,
    GLOBAL_LIMITER: global,
    LINEAR_API_KEY: SECRETS.apiKey,
    IP_HASH_KEY: SECRETS.ipHashKey,
    LINEAR_CONFIG: SECRETS.config,
    ...overrides,
  };
  return { env, kv, burst, global };
}

export function linearOk(identifier = "FP-7"): Response {
  return Response.json({ data: { issueCreate: { success: true, issue: { identifier } } } });
}

export function fakeFetch(respond: () => Response | Promise<Response> = () => linearOk()) {
  return vi.fn<FetchLike>(async () => respond());
}
