import { describe, expect, it } from "vitest";
import {
  checkLimits,
  clientBucket,
  clientHash,
  contentHash,
  kvKeys,
  recordOutcome,
  recordSubmission,
  secondsUntilUtcMidnight,
  utcDay,
} from "../src/limits";
import type { Feedback } from "../src/validate";
import { FakeKv, FakeLimiter } from "./fakes";

const NOON = new Date("2026-10-16T12:00:00.000Z");
const DAY = "2026-10-16";
const CLIENT = "a".repeat(32);

describe("clientBucket", () => {
  it.each([undefined, null, ""])("buckets a missing address together: %j", (ip) => {
    expect(clientBucket(ip)).toBe("unknown");
  });

  it("uses an IPv4 address as is, trimmed", () => {
    expect(clientBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(clientBucket("  203.0.113.7 ")).toBe("203.0.113.7");
    expect(clientBucket("203.0.113.7")).not.toBe(clientBucket("203.0.113.8"));
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 address", () => {
    expect(clientBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientBucket("::FFFF:203.0.113.7")).toBe("203.0.113.7");
  });

  it("buckets IPv6 by /48", () => {
    expect(clientBucket("2001:db8:abcd:1234:5678:9abc:def0:1234")).toBe("2001:db8:abcd::/48");
    expect(clientBucket("2001:db8:abcd:ffff::1")).toBe("2001:db8:abcd::/48");
    expect(clientBucket("2001:db8:abcd:1::")).toBe("2001:db8:abcd::/48");
    expect(clientBucket("2001:db8:abce:1::1")).not.toBe(clientBucket("2001:db8:abcd:1::1"));
  });

  it("gives every spelling of the same IPv6 address the same bucket", () => {
    const expected = "2001:db8:0::/48";
    expect(clientBucket("2001:db8::1")).toBe(expected);
    expect(clientBucket("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(expected);
    expect(clientBucket("2001:DB8::1")).toBe(expected);
    expect(clientBucket("2001:db8:0:0:0:0:0:1")).toBe(expected);
  });

  it("handles the unspecified and loopback addresses and a zone id", () => {
    expect(clientBucket("::")).toBe("0:0:0::/48");
    expect(clientBucket("::1")).toBe("0:0:0::/48");
    expect(clientBucket("fe80::1%eth0")).toBe("fe80:0:0::/48");
  });

  it.each(["1::2::3", "12345::1", "1:2:3:4:5:6:7::8", "1:2:3:4:5:6:7:8:9", "g::1", ":::", "::ffff:1.2.3"])(
    "falls back to the whole (lower-cased) string for a malformed address: %s",
    (ip) => {
      expect(clientBucket(ip)).toBe(ip.toLowerCase());
    }
  );
});

describe("clientHash", () => {
  const secret = "s".repeat(40);

  async function referenceHmac(message: string, key: string): Promise<string> {
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", k, enc.encode(message));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  it("is the first 32 hex characters of an HMAC-SHA-256 over the bucket", async () => {
    expect(await clientHash("203.0.113.7", secret)).toBe((await referenceHmac("client:203.0.113.7", secret)).slice(0, 32));
    expect(await clientHash("2001:db8:abcd:1::9", secret)).toBe(
      (await referenceHmac("client:2001:db8:abcd::/48", secret)).slice(0, 32)
    );
    expect(await clientHash(null, secret)).toBe((await referenceHmac("client:unknown", secret)).slice(0, 32));
  });

  it("does not contain the address", async () => {
    const hash = await clientHash("203.0.113.7", secret);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).not.toContain("203");
  });

  it("is stable inside a bucket and differs across buckets and keys", async () => {
    expect(await clientHash("2001:db8:abcd:1::1", secret)).toBe(await clientHash("2001:db8:abcd:2::2", secret));
    expect(await clientHash("::ffff:203.0.113.7", secret)).toBe(await clientHash("203.0.113.7", secret));
    expect(await clientHash("203.0.113.7", secret)).not.toBe(await clientHash("203.0.113.8", secret));
    expect(await clientHash("203.0.113.7", secret)).not.toBe(await clientHash("203.0.113.7", "t".repeat(40)));
  });
});

describe("contentHash", () => {
  const fb: Feedback = { title: "Crash on start", description: "It crashes on start.", kind: "bug" };

  it("ignores case, whitespace and metadata", async () => {
    const same = { ...fb, title: "  CRASH   on\nstart ", description: "it crashes\ton START.", tool: "x", platform: "y" };
    expect(await contentHash(same)).toBe(await contentHash(fb));
  });

  it("changes with the kind, the title or the description", async () => {
    const hash = await contentHash(fb);
    expect(await contentHash({ ...fb, kind: "feature" })).not.toBe(hash);
    expect(await contentHash({ ...fb, title: "Crash on stop" })).not.toBe(hash);
    expect(await contentHash({ ...fb, description: "It crashes on stop." })).not.toBe(hash);
  });

  it("does not let text move between the title and the description", async () => {
    const a = await contentHash({ ...fb, title: "abc", description: "defghijklm" });
    const b = await contentHash({ ...fb, title: "abcd", description: "efghijklm" });
    expect(a).not.toBe(b);
  });
});

describe("utcDay / secondsUntilUtcMidnight", () => {
  it("formats the UTC date", () => {
    expect(utcDay(new Date("2026-10-16T23:59:59.999Z"))).toBe("2026-10-16");
    expect(utcDay(new Date("2026-10-17T00:00:00.000Z"))).toBe("2026-10-17");
  });

  it("counts seconds to the next 00:00 UTC, never less than one", () => {
    expect(secondsUntilUtcMidnight(NOON)).toBe(12 * 3600);
    expect(secondsUntilUtcMidnight(new Date("2026-10-16T23:59:30.000Z"))).toBe(30);
    expect(secondsUntilUtcMidnight(new Date("2026-10-16T00:00:00.000Z"))).toBe(86400);
    expect(secondsUntilUtcMidnight(new Date("2026-10-16T23:59:59.999Z"))).toBe(1);
    expect(secondsUntilUtcMidnight(new Date("2026-12-31T12:00:00.000Z"))).toBe(12 * 3600);
  });
});

describe("checkLimits", () => {
  function setup(limits?: { burst?: number; global?: number }) {
    const kv = new FakeKv();
    const clientLimiter = new FakeLimiter(limits?.burst);
    const globalLimiter = new FakeLimiter(limits?.global);
    const run = (client = CLIENT, content = "c1", now = NOON) =>
      checkLimits({ kv, clientLimiter, globalLimiter, now, client, content });
    return { kv, clientLimiter, globalLimiter, run };
  }

  function seedSubmissions(kv: FakeKv, client: string, count: number, day = DAY) {
    for (let i = 0; i < count; i++) kv.seed(`sub:${day}:${client}:${i.toString().padStart(4, "0")}-n`);
  }

  it("allows a first report and keys the limiters by client and by 'global'", async () => {
    const { run, clientLimiter, globalLimiter } = setup();
    expect(await run()).toEqual({ action: "allow" });
    expect(clientLimiter.seen).toEqual([CLIENT]);
    expect(globalLimiter.seen).toEqual(["global"]);
  });

  describe("burst limiter", () => {
    it("answers 429 with a 60 second retry and skips everything after it", async () => {
      const { run, kv, globalLimiter } = setup({ burst: 0 });
      expect(await run()).toEqual({ action: "limit", reason: "burst", retryAfter: 60 });
      expect(globalLimiter.seen).toEqual([]);
      expect(kv.calls).toEqual([]);
    });

    it("limits each client separately", async () => {
      const { run } = setup({ burst: 3 });
      for (let i = 0; i < 3; i++) expect((await run(CLIENT)).action).toBe("allow");
      expect(await run(CLIENT)).toMatchObject({ action: "limit", reason: "burst" });
      expect((await run("b".repeat(32))).action).toBe("allow");
    });
  });

  describe("global limiter", () => {
    it("answers busy with a 60 second retry and skips KV", async () => {
      const { run, kv } = setup({ global: 0 });
      expect(await run()).toEqual({ action: "limit", reason: "busy", retryAfter: 60 });
      expect(kv.calls).toEqual([]);
    });

    it("is shared by all clients", async () => {
      const { run } = setup({ global: 5 });
      for (let i = 0; i < 5; i++) expect((await run(i.toString().repeat(32).slice(0, 32))).action).toBe("allow");
      expect(await run("f".repeat(32))).toMatchObject({ action: "limit", reason: "busy" });
    });
  });

  describe("dedupe", () => {
    it("returns the stored ticket ref", async () => {
      const { run, kv } = setup();
      kv.seed(kvKeys.dedupe("c1"), "FP-12");
      expect(await run()).toEqual({ action: "duplicate", ref: "FP-12" });
    });

    it.each(["filed", "pending", "", "fp-1", "<b>FP-1"])("returns no ref for stored value %j", async (value) => {
      const { run, kv } = setup();
      kv.seed(kvKeys.dedupe("c1"), value);
      const decision = await run();
      expect(decision).toEqual(value === "" ? { action: "allow" } : { action: "duplicate", ref: null });
    });

    it("is checked before the daily caps, so a repeat still gets its answer", async () => {
      const { run, kv } = setup();
      kv.seed(kvKeys.dedupe("c1"), "FP-12");
      kv.seed(kvKeys.capped(DAY));
      kv.seed(kvKeys.clientCapped(DAY, CLIENT));
      expect(await run()).toEqual({ action: "duplicate", ref: "FP-12" });
    });

    it("is not shared between different content", async () => {
      const { run, kv } = setup();
      kv.seed(kvKeys.dedupe("c1"), "FP-12");
      expect((await run(CLIENT, "c2")).action).toBe("allow");
    });
  });

  describe("per-client daily cap", () => {
    it("allows 9 reports and refuses the 11th attempt after 10", async () => {
      const { run, kv } = setup();
      seedSubmissions(kv, CLIENT, 9);
      expect((await run()).action).toBe("allow");
      kv.seed(`sub:${DAY}:${CLIENT}:9999-n`);
      expect(await run()).toEqual({ action: "limit", reason: "ip-daily", retryAfter: 12 * 3600 });
    });

    it("remembers the cap for two days and then skips the listing", async () => {
      const { run, kv } = setup();
      seedSubmissions(kv, CLIENT, 10);
      await run();
      expect(kv.store.get(kvKeys.clientCapped(DAY, CLIENT))).toEqual({ value: "1", ttl: 2 * 24 * 3600 });
      const lists = kv.count("list");
      expect(await run()).toMatchObject({ action: "limit", reason: "ip-daily" });
      expect(kv.count("list")).toBe(lists);
    });

    it("counts only this client's reports against its cap", async () => {
      const { run, kv } = setup();
      seedSubmissions(kv, "b".repeat(32), 50);
      expect((await run()).action).toBe("allow");
    });

    it("counts only today's reports", async () => {
      const { run, kv } = setup();
      seedSubmissions(kv, CLIENT, 10, "2026-10-15");
      expect((await run()).action).toBe("allow");
    });

    it("does not carry a cap flag over to the next day", async () => {
      const { run, kv } = setup();
      kv.seed(kvKeys.clientCapped("2026-10-15", CLIENT));
      expect((await run()).action).toBe("allow");
    });

    it("still answers when the flag cannot be written", async () => {
      const { run, kv } = setup();
      seedSubmissions(kv, CLIENT, 10);
      kv.failPutFor = (key) => key.startsWith("cap:");
      expect(await run()).toMatchObject({ action: "limit", reason: "ip-daily" });
    });
  });

  describe("global daily cap", () => {
    it("allows 99 reports and refuses at 100", async () => {
      const { run, kv } = setup();
      for (let i = 0; i < 99; i++) kv.seed(`sub:${DAY}:${(i % 20).toString(16).repeat(32).slice(0, 32)}:${i}-n`);
      expect((await run()).action).toBe("allow");
      kv.seed(`sub:${DAY}:${"e".repeat(32)}:last-n`);
      expect(await run()).toEqual({ action: "limit", reason: "global-daily", retryAfter: 12 * 3600 });
    });

    it("remembers the cap and then skips the listing", async () => {
      const { run, kv } = setup();
      for (let i = 0; i < 100; i++) kv.seed(`sub:${DAY}:${"c".repeat(32)}:${i.toString().padStart(3, "0")}-n`);
      await run();
      expect(kv.store.get(kvKeys.capped(DAY))).toEqual({ value: "1", ttl: 2 * 24 * 3600 });
      const lists = kv.count("list");
      expect(await run()).toMatchObject({ action: "limit", reason: "global-daily" });
      expect(kv.count("list")).toBe(lists);
    });

    it("is reported before the per-client cap", async () => {
      const { run, kv } = setup();
      for (let i = 0; i < 100; i++) kv.seed(`sub:${DAY}:${CLIENT}:${i.toString().padStart(3, "0")}-n`);
      expect(await run()).toMatchObject({ reason: "global-daily" });
    });

    it("counts a full day across pages of the listing", async () => {
      const { run, kv } = setup();
      kv.pageSize = 30;
      for (let i = 0; i < 100; i++) kv.seed(`sub:${DAY}:${"d".repeat(31)}${(i % 10)}:${i.toString().padStart(3, "0")}-n`);
      expect(await run()).toMatchObject({ action: "limit", reason: "global-daily" });
      expect(kv.count("list")).toBe(4);
    });

    it("lists with the day prefix, a limit of 100 and a cursor from the previous page", async () => {
      const { run, kv } = setup();
      kv.pageSize = 2;
      for (let i = 0; i < 5; i++) kv.seed(`sub:${DAY}:${CLIENT}:${i}-n`);
      const seen: unknown[] = [];
      const realList = kv.list.bind(kv);
      kv.list = async (options) => {
        seen.push(options);
        return realList(options);
      };
      await run();
      expect(seen).toEqual([
        { prefix: `sub:${DAY}:`, limit: 100, cursor: undefined },
        { prefix: `sub:${DAY}:`, limit: 100, cursor: "2" },
        { prefix: `sub:${DAY}:`, limit: 100, cursor: "4" },
      ]);
    });
  });

  describe("storage failures", () => {
    it.each(["get", "list"] as const)("rejects when KV %s fails", async (op) => {
      const { run, kv } = setup();
      kv.failing.add(op);
      await expect(run()).rejects.toThrow("unavailable");
    });

    it("rejects when a limiter fails", async () => {
      const { run, clientLimiter } = setup();
      clientLimiter.throwOnLimit = true;
      await expect(run()).rejects.toThrow("limiter unavailable");
    });
  });
});

describe("recordSubmission", () => {
  it("stores a day-and-client-scoped key for two days", async () => {
    const kv = new FakeKv();
    await recordSubmission(kv, NOON, CLIENT, "abc12345");
    expect([...kv.store.entries()]).toEqual([
      [`sub:${DAY}:${CLIENT}:${NOON.getTime().toString(36)}-abc12345`, { value: "1", ttl: 2 * 24 * 3600 }],
    ]);
  });

  it("lets a later check count it", async () => {
    const kv = new FakeKv();
    for (let i = 0; i < 10; i++) await recordSubmission(kv, new Date(NOON.getTime() + i), CLIENT, `n${i}`);
    const decision = await checkLimits({
      kv,
      clientLimiter: new FakeLimiter(),
      globalLimiter: new FakeLimiter(),
      now: NOON,
      client: CLIENT,
      content: "c",
    });
    expect(decision).toMatchObject({ reason: "ip-daily" });
  });
});

describe("recordOutcome", () => {
  const detail = { status: 200 };

  it("remembers a created ticket by its ref for a day", async () => {
    const kv = new FakeKv();
    await recordOutcome(kv, "c1", { kind: "created", ref: "FP-9", ...detail });
    expect(kv.store.get("dup:c1")).toEqual({ value: "FP-9", ttl: 86400 });
  });

  it("remembers a created ticket without a usable ref as filed", async () => {
    const kv = new FakeKv();
    await recordOutcome(kv, "c1", { kind: "created", ref: null, ...detail });
    expect(kv.store.get("dup:c1")?.value).toBe("filed");
  });

  it("remembers an unknown outcome as pending, because the ticket may exist", async () => {
    const kv = new FakeKv();
    await recordOutcome(kv, "c1", { kind: "unknown", status: 0, message: "timeout" });
    expect(kv.store.get("dup:c1")).toEqual({ value: "pending", ttl: 86400 });
  });

  it("forgets a rejected report so it can be sent again", async () => {
    const kv = new FakeKv();
    await recordOutcome(kv, "c1", { kind: "rejected", ...detail });
    expect(kv.store.size).toBe(0);
  });
});
