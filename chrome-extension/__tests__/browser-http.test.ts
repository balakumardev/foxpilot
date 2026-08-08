import {
  isTextualContentType,
  splitSseFrames,
  mapChromeCookie,
  buildCookieHeaderRule,
  getCookies,
  browserFetch,
  startStream,
  pollStream,
  closeStream,
  clearStaleCookieRules,
  COOKIE_RULE_ID_BASE,
  COOKIE_RULE_ID_MAX,
  __nextCookieRuleId,
  __releaseCookieRuleId,
} from "../browser-http";

// Build a minimal fetch Response stand-in for the one-shot browserFetch path.
function fakeResponse(opts: {
  status?: number;
  statusText?: string;
  contentType?: string;
  bytes: Uint8Array;
  url?: string;
}): any {
  const headers = new Headers(
    opts.contentType ? { "content-type": opts.contentType } : {}
  );
  return {
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers,
    url: opts.url ?? "https://example.com/resource",
    arrayBuffer: async () =>
      opts.bytes.buffer.slice(
        opts.bytes.byteOffset,
        opts.bytes.byteOffset + opts.bytes.byteLength
      ),
  };
}

// Build a streaming Response whose body emits the given string chunks in order.
function fakeStreamResponse(chunks: string[], opts?: { contentType?: string }): any {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
      }
      controller.close();
    },
  });
  return {
    status: 200,
    statusText: "OK",
    headers: new Headers({
      "content-type": opts?.contentType ?? "text/event-stream",
    }),
    url: "https://example.com/stream",
    body,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (browser as any).declarativeNetRequest.updateSessionRules.mockResolvedValue(
    undefined
  );
  (browser as any).cookies.getAll.mockResolvedValue([]);
});

describe("isTextualContentType", () => {
  it("treats text/*, JSON, XML, JS and form-urlencoded as textual", () => {
    expect(isTextualContentType("text/html; charset=utf-8")).toBe(true);
    expect(isTextualContentType("text/plain")).toBe(true);
    expect(isTextualContentType("application/json")).toBe(true);
    expect(isTextualContentType("application/ld+json")).toBe(true);
    expect(isTextualContentType("application/xml")).toBe(true);
    expect(isTextualContentType("application/atom+xml")).toBe(true);
    expect(isTextualContentType("application/javascript")).toBe(true);
    expect(isTextualContentType("application/x-www-form-urlencoded")).toBe(true);
  });

  it("treats binary types and empty content-type as non-textual", () => {
    expect(isTextualContentType("application/octet-stream")).toBe(false);
    expect(isTextualContentType("image/png")).toBe(false);
    expect(isTextualContentType("")).toBe(false);
    expect(isTextualContentType(null)).toBe(false);
    expect(isTextualContentType(undefined)).toBe(false);
  });
});

describe("splitSseFrames", () => {
  it("splits complete frames and keeps the partial remainder", () => {
    const r = splitSseFrames("", "data: a\n\ndata: b\n\ndata: c");
    expect(r.frames).toEqual(["data: a", "data: b"]);
    expect(r.remainder).toBe("data: c");
  });

  it("reassembles a frame split across chunk boundaries", () => {
    const first = splitSseFrames("", "data: hel");
    expect(first.frames).toEqual([]);
    expect(first.remainder).toBe("data: hel");

    const second = splitSseFrames(first.remainder, "lo\n\ndata: wor");
    expect(second.frames).toEqual(["data: hello"]);
    expect(second.remainder).toBe("data: wor");
  });

  it("tolerates CRLF delimiters, including a split \\r\\n across chunks", () => {
    const r = splitSseFrames("", "data: a\r\n\r\ndata: b\r\n");
    expect(r.frames).toEqual(["data: a"]);
    expect(r.remainder).toBe("data: b\n");

    // A CRLF straddling the boundary: first chunk ends with "\r", next starts "\n".
    const a = splitSseFrames("", "data: x\r");
    const b = splitSseFrames(a.remainder, "\n\r\n");
    expect(b.frames).toEqual(["data: x"]);
  });
});

describe("mapChromeCookie", () => {
  it("marks a cookie without expirationDate as a session cookie", () => {
    const rec = mapChromeCookie({
      name: "s",
      value: "v",
      domain: "example.com",
      path: "/",
      secure: false,
      httpOnly: false,
    });
    expect(rec.session).toBe(true);
    expect(rec.expirationDate).toBeUndefined();
  });

  it("passes through sameSite/expirationDate/storeId and clears session flag", () => {
    const rec = mapChromeCookie({
      name: "sid",
      value: "abc",
      domain: "example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 1893456000,
      storeId: "0",
    });
    expect(rec).toEqual({
      name: "sid",
      value: "abc",
      domain: "example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      session: false,
      expirationDate: 1893456000,
      storeId: "0",
    });
  });
});

describe("buildCookieHeaderRule", () => {
  it("builds a modifyHeaders rule that SETS the Cookie header scoped to the url", () => {
    const rule = buildCookieHeaderRule(
      "https://example.com/api",
      "a=1; b=2",
      210005
    );
    expect(rule.id).toBe(210005);
    expect(rule.action.type).toBe("modifyHeaders");
    expect(rule.action.requestHeaders).toEqual([
      { header: "cookie", operation: "set", value: "a=1; b=2" },
    ]);
    expect(rule.condition.urlFilter).toBe("https://example.com/api");
    expect(rule.condition.resourceTypes).toEqual(["xmlhttprequest", "other"]);
  });
});

describe("getCookies", () => {
  it("drops undefined query keys and maps to CookieRecord[]", async () => {
    (browser as any).cookies.getAll.mockResolvedValue([
      {
        name: "a",
        value: "1",
        domain: "x.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expirationDate: 123,
      },
      {
        name: "s",
        value: "2",
        domain: "x.com",
        path: "/",
        secure: false,
        httpOnly: false,
      },
    ]);

    const cookies = await getCookies({ url: "https://x.com" });

    expect((browser as any).cookies.getAll).toHaveBeenCalledWith({
      url: "https://x.com",
    });
    expect(cookies).toHaveLength(2);
    expect(cookies[0].session).toBe(false);
    expect(cookies[1].session).toBe(true);
  });

  it("filters getAll results to `names[]` (httpOnly included) without constraining the query by name", async () => {
    (browser as any).cookies.getAll.mockResolvedValue([
      { name: "sid", value: "s", domain: "x.com", path: "/", secure: true, httpOnly: true, expirationDate: 1 },
      { name: "csrf", value: "c", domain: "x.com", path: "/", secure: true, httpOnly: false, expirationDate: 1 },
      { name: "theme", value: "dark", domain: "x.com", path: "/", secure: false, httpOnly: false },
    ]);

    const cookies = await getCookies({ url: "https://x.com", names: ["sid", "csrf"] });

    // getAll is queried only by url — NOT by name — so multi-name filtering
    // happens in-memory.
    expect((browser as any).cookies.getAll).toHaveBeenCalledWith({ url: "https://x.com" });
    expect(cookies.map((c) => c.name).sort()).toEqual(["csrf", "sid"]);
    // httpOnly cookie survived the filter.
    expect(cookies.find((c) => c.name === "sid")!.httpOnly).toBe(true);
  });
});

describe("browserFetch", () => {
  it("returns decoded text for a textual content-type and truncates at maxBytes", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      fakeResponse({
        contentType: "text/plain",
        bytes: new TextEncoder().encode("abcdefghij"),
      })
    );

    const result = await browserFetch({
      url: "https://example.com/resource",
      maxBytes: 4,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe("abcd");
    expect(result.bodyBase64).toBeUndefined();
    expect(result.truncated).toBe(true);
    expect(result.finalUrl).toBe("https://example.com/resource");
    expect(result.headers?.["content-type"]).toBe("text/plain");
  });

  it("returns base64 for a binary content-type without truncation", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      fakeResponse({
        contentType: "application/octet-stream",
        bytes: new Uint8Array([0, 1, 2, 255]),
      })
    );

    const result = await browserFetch({ url: "https://example.com/bin" });

    expect(result.ok).toBe(true);
    expect(result.bodyText).toBeUndefined();
    expect(result.truncated).toBe(false);
    // atob-decoding the base64 recovers the original bytes.
    const decoded = atob(result.bodyBase64 as string);
    expect([
      decoded.charCodeAt(0),
      decoded.charCodeAt(1),
      decoded.charCodeAt(2),
      decoded.charCodeAt(3),
    ]).toEqual([0, 1, 2, 255]);
  });

  it("installs and then removes a Cookie DNR rule when useSessionCookies is set", async () => {
    (browser as any).cookies.getAll.mockResolvedValue([
      { name: "sid", value: "abc", domain: "x.com", path: "/" },
    ]);
    (global.fetch as jest.Mock).mockResolvedValue(
      fakeResponse({
        contentType: "text/plain",
        bytes: new TextEncoder().encode("ok"),
      })
    );

    const result = await browserFetch({
      url: "https://x.com/api",
      useSessionCookies: true,
    });

    expect(result.ok).toBe(true);
    const calls = (browser as any).declarativeNetRequest.updateSessionRules.mock
      .calls;
    // First call installs the rule (addRules present); a later call removes it.
    const install = calls.find((c: any[]) => c[0].addRules?.length);
    expect(install[0].addRules[0].action.requestHeaders[0]).toEqual({
      header: "cookie",
      operation: "set",
      value: "sid=abc",
    });
    const removedId = install[0].addRules[0].id;
    const remove = calls.find(
      (c: any[]) => !c[0].addRules && c[0].removeRuleIds?.includes(removedId)
    );
    expect(remove).toBeDefined();
  });

  it("returns { ok:false, error } when fetch rejects", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("network down"));

    const result = await browserFetch({ url: "https://example.com/x" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });
});

describe("streaming (start/poll/close)", () => {
  it("starts, buffers SSE frames, polls to done, and closes", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      fakeStreamResponse(["data: hello\n\n", "data: world\n\n"])
    );

    const started = await startStream({ url: "https://example.com/stream" });
    expect(started.ok).toBe(true);
    expect(started.status).toBe(200);
    expect(typeof started.streamId).toBe("string");

    const streamId = started.streamId as string;
    const poll = await pollStream(streamId, 0);

    expect(poll.ok).toBe(true);
    expect(poll.frames).toEqual(["data: hello", "data: world"]);
    expect(poll.done).toBe(true);
    expect(poll.nextIndex).toBe(2);

    const closed = await closeStream(streamId);
    expect(closed).toEqual({ ok: true });

    // After close the session is gone: a subsequent poll reports unknown/done.
    const afterClose = await pollStream(streamId, 0);
    expect(afterClose.ok).toBe(false);
    expect(afterClose.done).toBe(true);
  });

  it("marks the stream done when a frame contains [DONE]", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      fakeStreamResponse(["data: one\n\n", "data: [DONE]\n\n"])
    );

    const started = await startStream({ url: "https://example.com/stream" });
    const poll = await pollStream(started.streamId as string, 0);

    expect(poll.done).toBe(true);
    expect(poll.frames).toContain("data: [DONE]");

    await closeStream(started.streamId as string);
  });

  it("pollStream on an unknown id reports ok:false and done:true", async () => {
    const poll = await pollStream("does-not-exist", 0);
    expect(poll.ok).toBe(false);
    expect(poll.done).toBe(true);
    expect(poll.frames).toEqual([]);
    expect(poll.nextIndex).toBe(0);
    expect(poll.error).toBeDefined();
  });

  it("closeStream is idempotent for an unknown id", async () => {
    await expect(closeStream("nope")).resolves.toEqual({ ok: true });
  });
});

describe("Cookie rule id allocation band", () => {
  it("never returns an id outside the reserved band, however many are allocated", () => {
    // An ever-incrementing counter escapes its OWN sweep window once it passes
    // COOKIE_RULE_ID_MAX: clearStaleCookieRules() then cannot reap the rule, so
    // a mid-stream service-worker eviction leaves a stale Cookie-injecting DNR
    // rule installed until the browser restarts. Allocate past a full band width
    // (releasing each, as the fetch/stream finally paths do) and assert none
    // escapes.
    const span = COOKIE_RULE_ID_MAX - COOKIE_RULE_ID_BASE;
    let escaped = 0;
    for (let i = 0; i < span + 10; i++) {
      const id = __nextCookieRuleId();
      if (id < COOKIE_RULE_ID_BASE || id >= COOKIE_RULE_ID_MAX) {
        escaped++;
      }
      __releaseCookieRuleId(id);
    }
    expect(escaped).toBe(0);
  });

  it("never hands out an id that is still in use", () => {
    // Guards the wrap: a bare modulo would collide with a live rule after one
    // full lap, silently replacing another request's Cookie header rule.
    const held = __nextCookieRuleId();
    const span = COOKIE_RULE_ID_MAX - COOKIE_RULE_ID_BASE;
    let collided = false;
    for (let i = 0; i < span; i++) {
      const id = __nextCookieRuleId();
      if (id === held) {
        collided = true;
      }
      __releaseCookieRuleId(id);
    }
    __releaseCookieRuleId(held);
    expect(collided).toBe(false);
  });
});

describe("clearStaleCookieRules", () => {
  it("removes only orphaned session rules within the cookie-rule id band", async () => {
    (browser as any).declarativeNetRequest.getSessionRules.mockResolvedValue([
      { id: 100001 }, // emulate.ts User-Agent rule — must be left alone
      { id: 210000 }, // orphaned cookie rule
      { id: 210007 }, // orphaned cookie rule
      { id: 999999 }, // out of band — left alone
    ]);

    await clearStaleCookieRules();

    expect(
      (browser as any).declarativeNetRequest.updateSessionRules
    ).toHaveBeenCalledWith({ removeRuleIds: [210000, 210007] });
  });

  it("does not delete a rule installed while the sweep awaits getSessionRules", async () => {
    // initBrowserHttp() void-s this sweep and background.ts continues on to
    // connect the broker clients, so a browser-fetch can land while the sweep is
    // still awaiting its read-back. Reading the in-use set BEFORE that await
    // would let the sweep delete the just-installed rule while the allocator
    // still holds its id — the rule is gone but the id stays reserved.
    let releaseRead!: (rules: Array<{ id: number }>) => void;
    const read = new Promise<Array<{ id: number }>>((r) => {
      releaseRead = r;
    });
    (browser as any).declarativeNetRequest.getSessionRules.mockReturnValue(read);

    const sweep = clearStaleCookieRules();
    await Promise.resolve(); // let the sweep reach its await

    const liveId = __nextCookieRuleId(); // a fetch allocates mid-sweep
    releaseRead([{ id: liveId }]);
    await sweep;

    const removed = (
      browser as any
    ).declarativeNetRequest.updateSessionRules.mock.calls.flatMap(
      (c: any[]) => c[0].removeRuleIds ?? []
    );
    expect(removed).not.toContain(liveId);

    __releaseCookieRuleId(liveId);
  });

  it("makes no removal call when there are no stale cookie rules", async () => {
    (browser as any).declarativeNetRequest.getSessionRules.mockResolvedValue([
      { id: 100001 },
    ]);

    await clearStaleCookieRules();

    expect(
      (browser as any).declarativeNetRequest.updateSessionRules
    ).not.toHaveBeenCalled();
  });
});
