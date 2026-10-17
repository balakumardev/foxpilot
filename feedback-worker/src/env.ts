// Structural slices of the Cloudflare bindings, so tests can pass in-memory fakes.
// The compile-time check at the bottom proves the real bindings satisfy them.

export interface KvListResult {
  keys: { name: string }[];
  list_complete: boolean;
  cursor?: string;
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<KvListResult>;
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  FEEDBACK_KV: KvStore;
  BURST_LIMITER: RateLimiter;
  GLOBAL_LIMITER: RateLimiter;
  /** Secret: Linear API key restricted to creating issues. */
  LINEAR_API_KEY?: string;
  /** Secret: at least 32 characters; keys the HMAC that stands in for the client address. */
  IP_HASH_KEY?: string;
  /** Secret: JSON with the Linear team, assignee and labels (see config.ts). */
  LINEAR_CONFIG?: string;
}

type RealBindings = {
  FEEDBACK_KV: KVNamespace;
  BURST_LIMITER: RateLimit;
  GLOBAL_LIMITER: RateLimit;
};
export const _bindingsSatisfyEnv = (b: RealBindings): Pick<Env, keyof RealBindings> => b;
