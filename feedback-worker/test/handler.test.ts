import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handleRequest, type Deps } from "../src/handler";
import type { Env } from "../src/env";
import { clientHash, contentHash, kvKeys } from "../src/limits";
import {
  ASSIGNEE_ID,
  fakeFetch,
  LABEL_BASE,
  LABEL_BUG,
  linearOk,
  makeEnv,
  SECRETS,
  TEAM_ID,
  type TestEnv,
} from "./fakes";

const ENDPOINT = "https://feedback.example/v1/feedback";
const NOON = new Date("2026-10-16T12:00:00.000Z");
const DAY = "2026-10-16";
const IP = "203.0.113.7";

const valid = { title: "Crash on startup", description: "It crashes when I open a tab.", kind: "bug" };

let logs: string[] = [];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": IP, ...headers },
    body: (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit,
  });
}

function streamed(chunks: number, size: number, onCancel: () => void): Request {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) return controller.close();
      sent++;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
    cancel: onCancel,
  });
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
}

function run(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  return handleRequest(request, env, { now: () => NOON, nonce: () => "abc12345", ...deps });
}

async function bodyOf(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

function logged(): Record<string, unknown>[] {
  return logs.map((line) => JSON.parse(line));
}

describe("routing", () => {
  it.each(["/", "/v1", "/v1/feedback/", "/v1/feedback/x", "/V1/feedback", "/feedback", "/health"])("404 for %s", async (path) => {
    const { env } = makeEnv();
    const other = await run(new Request(`https://feedback.example${path}`, { method: "POST", body: "{}" }), env);
    expect(other.status).toBe(404);
    expect(await bodyOf(other)).toEqual({ ok: false, error: "not found" });
  });

  it.each(["GET", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])("405 with an Allow header for %s", async (method) => {
    const { env } = makeEnv();
    const res = await run(new Request(ENDPOINT, { method }), env);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    if (method !== "HEAD") {
      expect(await bodyOf(res)).toEqual({ ok: false, error: "method not allowed; use POST" });
    }
  });

  it("checks the path before the method", async () => {
    const { env } = makeEnv();
    expect((await run(new Request("https://feedback.example/other", { method: "GET" }), env)).status).toBe(404);
  });

  it("ignores the query string", async () => {
    const { env } = makeEnv();
    const res = await run(new Request(`${ENDPOINT}?x=1`, { method: "GET" }), env);
    expect(res.status).toBe(405);
  });

  it("is served by the Worker's fetch entry point", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request("https://feedback.example/nope"), env);
    expect(res.status).toBe(404);
  });
});

describe("response headers", () => {
  it("are the same safe set on success and on errors", async () => {
    const { env } = makeEnv();
    const responses = [
      await run(post(valid), env, { fetchImpl: fakeFetch() }),
      await run(post({ nope: 1 }), env),
      await run(new Request(ENDPOINT, { method: "GET" }), env),
      await run(new Request("https://feedback.example/x"), env),
    ];
    for (const res of responses) {
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });
});

describe("request checks", () => {
  it.each(["application/json", "application/json; charset=utf-8", "APPLICATION/JSON", "application/json ;charset=utf-8", "application/json  "])(
    "accepts Content-Type %j",
    async (contentType) => {
      const { env } = makeEnv();
      const res = await run(post(valid, { "content-type": contentType }), env, { fetchImpl: fakeFetch() });
      expect(res.status).toBe(201);
    }
  );

  it.each(["text/plain", "application/jsonx", "application/x-www-form-urlencoded", "multipart/form-data", "text/json", "application/ld+json", ""])(
    "rejects Content-Type %j",
    async (contentType) => {
      const { env } = makeEnv();
      const res = await run(post(valid, { "content-type": contentType }), env);
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual({ ok: false, error: "Content-Type must be application/json" });
    }
  );

  it("rejects a request with no Content-Type", async () => {
    const { env } = makeEnv();
    const request = new Request(ENDPOINT, { method: "POST", body: new TextEncoder().encode(JSON.stringify(valid)) });
    expect(request.headers.get("content-type")).toBeNull();
    const res = await run(request, env);
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ ok: false, error: "Content-Type must be application/json" });
  });

  describe("body size", () => {
    const tooLarge = { ok: false, error: "body must be at most 65536 bytes" };

    it("rejects a Content-Length above the limit without reading the body", async () => {
      const { env, kv } = makeEnv();
      const res = await run(post(valid, { "content-length": "65537" }), env);
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual(tooLarge);
      expect(kv.calls).toEqual([]);
    });

    it("rejects a streamed body that grows past the limit, and stops reading it", async () => {
      const { env } = makeEnv();
      const onCancel = vi.fn();
      const res = await run(streamed(100, 1024, onCancel), env);
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual(tooLarge);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("rejects a body whose Content-Length understates it", async () => {
      const { env } = makeEnv();
      const request = post("x".repeat(65537), { "content-length": "10" });
      const res = await run(request, env);
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual(tooLarge);
    });

    it("accepts a body of exactly 64 KiB", async () => {
      const { env } = makeEnv();
      const json = JSON.stringify(valid);
      const exact = json + " ".repeat(65536 - json.length);
      expect(exact.length).toBe(65536);
      const res = await run(post(exact), env, { fetchImpl: fakeFetch() });
      expect(res.status).toBe(201);
    });

    it("rejects a body one byte over 64 KiB", async () => {
      const { env } = makeEnv();
      const json = JSON.stringify(valid);
      const res = await run(post(json + " ".repeat(65537 - json.length)), env);
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual(tooLarge);
    });

    it("counts bytes, not characters", async () => {
      const { env } = makeEnv();
      // 22000 characters of 3 bytes each: under the limit as text, over it as bytes
      const res = await run(post(JSON.stringify({ ...valid, tool: "€".repeat(22000) })), env);
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual(tooLarge);
    });
  });

  describe("body content", () => {
    const invalid = { ok: false, error: "body must be valid UTF-8 JSON" };

    it("rejects invalid UTF-8, even where the bytes sit inside a string", async () => {
      const { env } = makeEnv();
      const head = new TextEncoder().encode('{"title":"abc","description":"0123456789","kind":"bug","tool":"');
      const bytes = new Uint8Array([...head, 0xff, 0xfe, 0x22, 0x7d]);
      const res = await run(post(bytes), env);
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual(invalid);
    });

    it.each(["", "{", "not json", "{'title': 'x'}", '{"title": "abc",}', "undefined"])("rejects %j", async (text) => {
      const { env } = makeEnv();
      const res = await run(post(text), env);
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual(invalid);
    });

    it("passes the parsed body to validation", async () => {
      const { env } = makeEnv();
      const res = await run(post({ ...valid, kind: "question" }), env);
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual({ ok: false, error: "kind must be one of: bug, feature, improvement, other" });
    });

    it("validates before it checks the configuration or touches storage", async () => {
      const { env, kv, burst } = makeEnv({ LINEAR_API_KEY: undefined, LINEAR_CONFIG: undefined });
      const res = await run(post({ title: "x" }), env);
      expect(res.status).toBe(400);
      expect(kv.calls).toEqual([]);
      expect(burst.seen).toEqual([]);
      expect(logs).toEqual([]);
    });
  });
});

describe("not configured", () => {
  const key = (n: number) => "k".repeat(n);
  const cases: [string, Partial<Env>, string][] = [
    ["LINEAR_API_KEY unset", { LINEAR_API_KEY: undefined }, "LINEAR_API_KEY"],
    ["LINEAR_API_KEY empty", { LINEAR_API_KEY: "" }, "LINEAR_API_KEY"],
    ["LINEAR_API_KEY blank", { LINEAR_API_KEY: " \n " }, "LINEAR_API_KEY"],
    ["LINEAR_API_KEY with an inner space", { LINEAR_API_KEY: "lin_api_abc def" }, "LINEAR_API_KEY"],
    ["LINEAR_API_KEY with an inner newline", { LINEAR_API_KEY: "lin_api_abc\ndef12345" }, "LINEAR_API_KEY"],
    ["LINEAR_API_KEY with non-ASCII text", { LINEAR_API_KEY: "lin_api_\u2026abcdef12" }, "LINEAR_API_KEY"],
    ["LINEAR_API_KEY far too short", { LINEAR_API_KEY: "abc" }, "LINEAR_API_KEY"],
    ["IP_HASH_KEY unset", { IP_HASH_KEY: undefined }, "IP_HASH_KEY"],
    ["IP_HASH_KEY empty", { IP_HASH_KEY: "" }, "IP_HASH_KEY"],
    ["IP_HASH_KEY 31 characters", { IP_HASH_KEY: key(31) }, "IP_HASH_KEY"],
    ["IP_HASH_KEY 31 characters plus padding", { IP_HASH_KEY: `  ${key(31)}\n` }, "IP_HASH_KEY"],
    ["LINEAR_CONFIG unset", { LINEAR_CONFIG: undefined }, "LINEAR_CONFIG"],
    ["LINEAR_CONFIG empty", { LINEAR_CONFIG: "" }, "LINEAR_CONFIG"],
    ["LINEAR_CONFIG not JSON", { LINEAR_CONFIG: "{teamId: nope" }, "LINEAR_CONFIG"],
    ["LINEAR_CONFIG without a team", { LINEAR_CONFIG: "{}" }, "LINEAR_CONFIG"],
    ["LINEAR_CONFIG with a bad team id", { LINEAR_CONFIG: JSON.stringify({ teamId: "team-1" }) }, "LINEAR_CONFIG"],
    ["LINEAR_CONFIG with an unknown key", { LINEAR_CONFIG: JSON.stringify({ teamId: TEAM_ID, state: "x" }) }, "LINEAR_CONFIG"],
    ["LINEAR_CONFIG with a bad label id", { LINEAR_CONFIG: JSON.stringify({ teamId: TEAM_ID, labelIds: ["x"] }) }, "LINEAR_CONFIG"],
    ["LINEAR_CONFIG with a bad kind label", { LINEAR_CONFIG: JSON.stringify({ teamId: TEAM_ID, kindLabelIds: { bug: 1 } }) }, "LINEAR_CONFIG"],
  ];

  it.each(cases)("answers 503 when %s", async (_name, overrides, setting) => {
    const t = makeEnv(overrides);
    const fetchImpl = fakeFetch();
    const res = await run(post(valid), t.env, { fetchImpl });

    expect(res.status).toBe(503);
    expect(await bodyOf(res)).toEqual({ ok: false, error: "feedback not configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(t.kv.calls).toEqual([]);
    expect(t.burst.seen).toEqual([]);
    expect(t.global.seen).toEqual([]);

    const events = logged();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "not_configured", setting });
    expect(Object.keys(events[0]).sort()).toEqual(["event", "reason", "setting"]);
  });

  it("never writes a secret value, or the config's contents, to a log line", async () => {
    const secretish = {
      LINEAR_API_KEY: "lin_api_SHOULD_NEVER_BE_LOGGED",
      IP_HASH_KEY: "too-short-but-secret",
      LINEAR_CONFIG: `{"teamId":"${TEAM_ID}","assigneeId":"SECRET-ASSIGNEE","labelIds":["${LABEL_BASE}"]}`,
    };
    for (const broken of ["LINEAR_API_KEY", "IP_HASH_KEY", "LINEAR_CONFIG"] as const) {
      logs = [];
      const overrides: Partial<Env> = { ...SECRETS_AS_ENV, ...secretish };
      if (broken === "LINEAR_API_KEY") overrides.LINEAR_API_KEY = "";
      if (broken === "IP_HASH_KEY") overrides.IP_HASH_KEY = secretish.IP_HASH_KEY;
      const t = makeEnv(overrides);
      const res = await run(post(valid), t.env, { fetchImpl: fakeFetch() });
      expect(res.status).toBe(503);
      const everything = logs.join("\n") + (await res.clone().text());
      for (const value of Object.values(secretish)) expect(everything).not.toContain(value);
      expect(everything).not.toContain("SECRET-ASSIGNEE");
      expect(everything).not.toContain(TEAM_ID);
    }
  });

  it("accepts an IP_HASH_KEY of exactly 32 characters", async () => {
    const t = makeEnv({ IP_HASH_KEY: key(32) });
    const res = await run(post(valid), t.env, { fetchImpl: fakeFetch() });
    expect(res.status).toBe(201);
  });

  it("accepts a config with only the team", async () => {
    const t = makeEnv({ LINEAR_CONFIG: JSON.stringify({ teamId: TEAM_ID }) });
    const fetchImpl = fakeFetch();
    const res = await run(post(valid), t.env, { fetchImpl });
    expect(res.status).toBe(201);
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body as string).variables.input;
    expect(Object.keys(sent).sort()).toEqual(["description", "teamId", "title"]);
  });
});

const SECRETS_AS_ENV: Partial<Env> = {
  LINEAR_API_KEY: SECRETS.apiKey,
  IP_HASH_KEY: SECRETS.ipHashKey,
  LINEAR_CONFIG: SECRETS.config,
};

describe("filing a report", () => {
  it("answers 201 with only the ticket ref", async () => {
    const t = makeEnv();
    const res = await run(post(valid), t.env, { fetchImpl: fakeFetch(() => linearOk("FP-7")) });
    expect(res.status).toBe(201);
    expect(await bodyOf(res)).toEqual({ ok: true, ref: "FP-7" });
    expect(logged()).toEqual([{ event: "created", ref: "FP-7", kind: "bug" }]);
  });

  it("sends the configured team, assignee and labels, the sanitised text and the raw key", async () => {
    const t = makeEnv({ LINEAR_API_KEY: `  ${SECRETS.apiKey}\n` });
    const fetchImpl = fakeFetch();
    await run(
      post({ ...valid, title: "Crash @alice", description: "ping @bob\nrepos=a/b", tool: "click-element", foxpilotVersion: "1.0.30" }),
      t.env,
      { fetchImpl }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.linear.app/graphql");
    expect((init.headers as Record<string, string>).Authorization).toBe(SECRETS.apiKey);
    const input = JSON.parse(init.body as string).variables.input;
    expect(input.teamId).toBe(TEAM_ID);
    expect(input.assigneeId).toBe(ASSIGNEE_ID);
    expect(input.labelIds).toEqual([LABEL_BASE, LABEL_BUG]);
    expect(input.title).toBe("[FoxPilot feedback] Crash ＠alice");
    expect(input.description).toContain("**Submitted via the public FoxPilot feedback API");
    expect(input.description).toContain("| Tool | click-element |");
    expect(input.description).toContain("ping ＠bob\nrepos＝a/b");
  });

  it("limits by the hashed client and records the report under that hash", async () => {
    const t = makeEnv();
    await run(post(valid), t.env, { fetchImpl: fakeFetch(() => linearOk("FP-7")) });

    const client = await clientHash(IP, SECRETS.ipHashKey);
    const content = await contentHash({ ...valid, kind: "bug" });
    expect(t.burst.seen).toEqual([client]);
    expect(t.global.seen).toEqual(["global"]);
    const submission = `sub:${DAY}:${client}:${NOON.getTime().toString(36)}-abc12345`;
    expect([...t.kv.store.keys()].sort()).toEqual([kvKeys.dedupe(content), submission].sort());
    expect(t.kv.store.get(submission)).toEqual({ value: "1", ttl: 2 * 24 * 3600 });
    expect(t.kv.store.get(kvKeys.dedupe(content))).toEqual({ value: "FP-7", ttl: 24 * 3600 });
  });

  it("files a report whose ticket has no usable ref, and remembers it as filed", async () => {
    const t = makeEnv();
    const fetchImpl = fakeFetch(() => linearOk("not a ref"));
    const res = await run(post(valid), t.env, { fetchImpl });
    expect(res.status).toBe(201);
    expect(await bodyOf(res)).toEqual({ ok: true, ref: null });
    const repeat = await run(post(valid), t.env, { fetchImpl });
    expect(await bodyOf(repeat)).toEqual({ ok: true, ref: null, duplicate: true });
  });

  it("still answers 201 when the dedupe note cannot be saved", async () => {
    const t = makeEnv();
    t.kv.failPutFor = (key) => key.startsWith("dup:");
    const res = await run(post(valid), t.env, { fetchImpl: fakeFetch() });
    expect(res.status).toBe(201);
    expect(logged()).toEqual([
      { event: "dedupe_write_failed", outcome: "created", error: "Error" },
      { event: "created", ref: "FP-7", kind: "bug" },
    ]);
  });

  it("applies the daily cap through real storage", async () => {
    const t = makeEnv();
    const fetchImpl = fakeFetch();
    for (let i = 0; i < 10; i++) {
      const res = await run(post({ ...valid, title: `Report number ${i}` }), t.env, { fetchImpl, nonce: () => `n${i}` });
      expect(res.status).toBe(201);
    }
    const eleventh = await run(post({ ...valid, title: "Report number 10" }), t.env, { fetchImpl });
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("Retry-After")).toBe("43200");
    expect(await bodyOf(eleventh)).toEqual({
      ok: false,
      error: "daily limit reached for your network; it resets at 00:00 UTC",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(10);

    const elsewhere = await run(post({ ...valid, title: "From another network" }, { "cf-connecting-ip": "198.51.100.1" }), t.env, { fetchImpl });
    expect(elsewhere.status).toBe(201);
  });
});

describe("duplicates", () => {
  it("answers 200 with the first ticket and files nothing new", async () => {
    const t = makeEnv();
    const fetchImpl = fakeFetch(() => linearOk("FP-7"));
    await run(post(valid), t.env, { fetchImpl });
    const res = await run(post(valid), t.env, { fetchImpl });

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ ok: true, ref: "FP-7", duplicate: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logged().at(-1)).toEqual({ event: "duplicate", ref: "FP-7" });
  });

  it("matches regardless of case, spacing and metadata, and from another network", async () => {
    const t = makeEnv();
    const fetchImpl = fakeFetch(() => linearOk("FP-7"));
    await run(post(valid), t.env, { fetchImpl });
    const variant = { ...valid, title: "  CRASH on   startup ", description: "it crashes when i open\na tab.", platform: "linux" };
    const res = await run(post(variant, { "cf-connecting-ip": "198.51.100.1" }), t.env, { fetchImpl });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not match a different kind or text", async () => {
    const t = makeEnv();
    const fetchImpl = fakeFetch();
    await run(post(valid), t.env, { fetchImpl });
    expect((await run(post({ ...valid, kind: "feature" }), t.env, { fetchImpl })).status).toBe(201);
    expect((await run(post({ ...valid, description: "A different description." }), t.env, { fetchImpl })).status).toBe(201);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("still counts against the burst limiter", async () => {
    const t = makeEnv({}, { burst: 2 });
    const fetchImpl = fakeFetch();
    await run(post(valid), t.env, { fetchImpl });
    await run(post(valid), t.env, { fetchImpl });
    expect((await run(post(valid), t.env, { fetchImpl })).status).toBe(429);
  });
});

describe("rate limits", () => {
  it("answers 429 with Retry-After when the burst limiter refuses", async () => {
    const t = makeEnv({}, { burst: 0 });
    const fetchImpl = fakeFetch();
    const res = await run(post(valid), t.env, { fetchImpl });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await bodyOf(res)).toEqual({ ok: false, error: "too many submissions from your network" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(t.kv.store.size).toBe(0);
    expect(logged()).toEqual([{ event: "rate_limited", reason: "burst" }]);
  });

  it("answers 429 when the global limiter refuses", async () => {
    const t = makeEnv({}, { global: 0 });
    const res = await run(post(valid), t.env, { fetchImpl: fakeFetch() });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await bodyOf(res)).toEqual({ ok: false, error: "the service is receiving too many submissions" });
    expect(logged()).toEqual([{ event: "rate_limited", reason: "busy" }]);
  });

  it("answers 429 until midnight UTC when the service-wide daily cap is reached", async () => {
    const t = makeEnv();
    for (let i = 0; i < 100; i++) t.kv.seed(`sub:${DAY}:${(i % 7).toString().repeat(32)}:${i.toString().padStart(3, "0")}-n`);
    const fetchImpl = fakeFetch();
    const res = await run(post(valid), t.env, { fetchImpl, now: () => new Date("2026-10-16T18:30:00.000Z") });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(5.5 * 3600));
    expect(await bodyOf(res)).toEqual({
      ok: false,
      error: "the service's daily limit is reached; it resets at 00:00 UTC",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("ticket service failures", () => {
  it("answers 502 when Linear refuses, and lets the report be sent again", async () => {
    const t = makeEnv();
    const refuse = fakeFetch(() => Response.json({ errors: [{ message: "bad label", extensions: { code: "INVALID" } }] }, { status: 400 }));
    const res = await run(post(valid), t.env, { fetchImpl: refuse });

    expect(res.status).toBe(502);
    expect(await bodyOf(res)).toEqual({ ok: false, error: "the ticket service rejected the report" });
    expect(logged()).toEqual([
      { event: "linear_error", outcome: "rejected", status: 400, code: "INVALID", message: "issueCreate returned no issue" },
    ]);
    expect([...t.kv.store.keys()].some((k) => k.startsWith("dup:"))).toBe(false);
    expect([...t.kv.store.keys()].filter((k) => k.startsWith("sub:"))).toHaveLength(1);

    const retry = await run(post(valid), t.env, { fetchImpl: fakeFetch() });
    expect(retry.status).toBe(201);
  });

  it.each([
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["an HTTP 500", async () => new Response("oops", { status: 500 })],
    ["an HTTP 503 with a JSON error", async () => Response.json({ errors: [{ message: "down" }] }, { status: 503 })],
    ["a 200 that is not JSON", async () => new Response("<html>", { status: 200 })],
  ])("answers 504 after %s, and treats a repeat as a duplicate", async (_name, respond) => {
    const t = makeEnv();
    const fetchImpl = fakeFetch(respond);
    const res = await run(post(valid), t.env, { fetchImpl });

    expect(res.status).toBe(504);
    expect(await bodyOf(res)).toEqual({
      ok: false,
      error: "the ticket service did not answer; the report may have been filed",
    });
    const content = await contentHash({ ...valid, kind: "bug" });
    expect(t.kv.store.get(kvKeys.dedupe(content))?.value).toBe("pending");

    const repeat = await run(post(valid), t.env, { fetchImpl });
    expect(repeat.status).toBe(200);
    expect(await bodyOf(repeat)).toEqual({ ok: true, ref: null, duplicate: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("answers 504 when Linear does not answer within the timeout", async () => {
    const t = makeEnv();
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    const res = await run(post(valid), t.env, { fetchImpl: hang, linearTimeoutMs: 20 });
    expect(res.status).toBe(504);
    expect(logged()).toEqual([{ event: "linear_error", outcome: "unknown", status: 0, message: "timeout" }]);
  });
});

describe("storage failures", () => {
  it.each(["get", "list"] as const)("answers 503 when KV %s fails, without filing anything", async (op) => {
    const t = makeEnv();
    t.kv.failing.add(op);
    const fetchImpl = fakeFetch();
    const res = await run(post(valid), t.env, { fetchImpl });
    expect(res.status).toBe(503);
    expect(await bodyOf(res)).toEqual({ ok: false, error: "feedback temporarily unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged()).toEqual([{ event: "limits_unavailable", error: "Error" }]);
  });

  it.each([["burst"], ["global"]] as const)("answers 503 when the %s limiter fails", async (which) => {
    const t = makeEnv();
    t[which].throwOnLimit = true;
    const fetchImpl = fakeFetch();
    const res = await run(post(valid), t.env, { fetchImpl });
    expect(res.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged()).toEqual([{ event: "limits_unavailable", error: "Error" }]);
  });

  it("answers 503 and does not call Linear when the submission cannot be recorded", async () => {
    const t = makeEnv();
    t.kv.failPutFor = (key) => key.startsWith("sub:");
    const fetchImpl = fakeFetch();
    const res = await run(post(valid), t.env, { fetchImpl });
    expect(res.status).toBe(503);
    expect(await bodyOf(res)).toEqual({ ok: false, error: "feedback temporarily unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged()).toEqual([{ event: "record_failed", error: "Error" }]);
  });

  it("answers 503 when the limiter binding is missing", async () => {
    const t = makeEnv();
    const env = { ...t.env, BURST_LIMITER: undefined } as unknown as Env;
    const res = await run(post(valid), env, { fetchImpl: fakeFetch() });
    expect(res.status).toBe(503);
    expect(logged()).toEqual([{ event: "limits_unavailable", error: "TypeError" }]);
  });
});

describe("unexpected errors", () => {
  it("answers 500 and logs only the error's name", async () => {
    const t = makeEnv();
    const res = await run(post(valid), t.env, {
      now: () => {
        throw new RangeError(`boom ${SECRETS.apiKey} ${IP}`);
      },
    });
    expect(res.status).toBe(500);
    expect(await bodyOf(res)).toEqual({ ok: false, error: "internal error" });
    expect(logged()).toEqual([{ event: "unhandled", error: "RangeError" }]);
    expect(logs.join("")).not.toContain(SECRETS.apiKey);
  });
});

describe("client addresses stay out of storage, logs, responses and the ticket", () => {
  const addresses: { ip: string; fragments: string[] }[] = [
    { ip: "203.0.113.7", fragments: ["203.0.113", "113.7"] },
    { ip: "2001:db8:5a5a:12::1", fragments: ["2001:db8", "5a5a:12", "db8:5a5a"] },
    { ip: "::ffff:198.51.100.9", fragments: ["198.51.100", "51.100.9"] },
  ];

  it.each(addresses)("never contains $ip", async ({ ip, fragments }) => {
    const t = makeEnv();
    const fetchImpl = fakeFetch();
    const seen: string[] = [];
    const send = async (body: unknown, headers: Record<string, string> = {}, deps: Deps = {}) => {
      const res = await run(post(body, { "cf-connecting-ip": ip, ...headers }), t.env, { fetchImpl, ...deps });
      seen.push(`${res.status} ${[...res.headers].join(",")} ${await res.text()}`);
    };

    await send(valid); // 201
    await send(valid); // 200 duplicate
    await send({ nope: 1 }); // 400
    await send(valid, { "content-type": "text/plain" }); // 400
    await send({ ...valid, title: "Another report" }, {}, { fetchImpl: fakeFetch(() => new Response("x", { status: 500 })) }); // 504
    await send({ ...valid, title: "A third report" }, {}, { fetchImpl: fakeFetch(() => Response.json({ errors: [{ message: "no" }] }, { status: 400 })) }); // 502
    t.kv.failing.add("get");
    await send({ ...valid, title: "A fourth report" }); // 503

    const limited = makeEnv({}, { burst: 0 });
    const res = await run(post(valid, { "cf-connecting-ip": ip }), limited.env, { fetchImpl });
    seen.push(`${res.status} ${[...res.headers].join(",")} ${await res.text()}`);

    const stored = [...t.kv.store.entries()].map(([k, v]) => `${k}=${v.value}`);
    const keysTouched = t.kv.calls.map((c) => c.key);
    const linearRequests = fetchImpl.mock.calls.map(([url, init]) => `${url} ${JSON.stringify(init.headers)} ${init.body}`);
    const everything = [
      ...stored,
      ...keysTouched,
      ...logs,
      ...seen,
      ...linearRequests,
      ...t.burst.seen,
      ...t.global.seen,
      ...limited.burst.seen,
    ].join("\n");

    expect(logs.length).toBeGreaterThan(3);
    expect(stored.length).toBeGreaterThan(2);
    expect(everything).not.toContain(ip);
    for (const fragment of fragments) expect(everything).not.toContain(fragment);
  });

  it("stores a stable per-network hash in place of the address", async () => {
    const t = makeEnv();
    const fetchImpl = fakeFetch();
    const submit = (title: string, ip: string, nonce: string) =>
      run(post({ ...valid, title }, { "cf-connecting-ip": ip }), t.env, { fetchImpl, nonce: () => nonce });
    await submit("First report", "2001:db8:5a5a:1::1", "n1");
    await submit("Second report", "2001:db8:5a5a:2::2", "n2");
    await submit("Third report", "2001:db8:5a5b:2::2", "n3");

    // key shape: sub:<yyyy-mm-dd>:<client>:<time>-<nonce>
    const clients = [...t.kv.store.keys()]
      .filter((k) => k.startsWith("sub:"))
      .map((k) => /^sub:[\d-]+:([0-9a-f]{32}):/.exec(k)?.[1]);
    expect(clients).toHaveLength(3);
    expect(clients.every(Boolean)).toBe(true);
    expect(clients[0]).toBe(clients[1]);
    expect(clients[2]).not.toBe(clients[0]);
  });

  it("buckets requests with no address together", async () => {
    const t = makeEnv();
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    const res = await run(request, t.env, { fetchImpl: fakeFetch() });
    expect(res.status).toBe(201);
    expect(t.burst.seen).toEqual([await clientHash(null, SECRETS.ipHashKey)]);
  });
});
