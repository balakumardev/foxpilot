import {
  isTextualContentType,
  splitSseFrames,
  mapFirefoxCookie,
  getCookies,
  browserFetch,
  startStream,
  pollStream,
  closeStream,
  rewriteCookieHeader,
} from "../browser-http";
import { mockBrowser } from "./setup";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

// A minimal Headers-like object supporting the two methods browser-http reads:
// `.get(name)` (case-insensitive) and `.forEach(cb)`.
function makeHeaders(record: Record<string, string>): any {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(record)) {
    map.set(k.toLowerCase(), v);
  }
  return {
    get: (k: string) => map.get(k.toLowerCase()) ?? null,
    forEach: (cb: (value: string, key: string) => void) =>
      map.forEach((value, key) => cb(value, key)),
  };
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
}

// A one-shot fetch Response mock whose body is fully buffered.
function mockResponse(opts: {
  status?: number;
  statusText?: string;
  url?: string;
  contentType?: string;
  body: Uint8Array;
}): any {
  return {
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    url: opts.url ?? "https://example.com/",
    headers: makeHeaders(
      opts.contentType ? { "content-type": opts.contentType } : {}
    ),
    arrayBuffer: async () => toArrayBuffer(opts.body),
    body: null,
  };
}

// A streaming Response body that yields the given chunks then closes. Emulates
// just the `getReader().read()` surface the pump consumes.
function fakeStreamBody(chunks: Uint8Array[]): any {
  let i = 0;
  return {
    getReader() {
      return {
        read: async () => {
          if (i < chunks.length) {
            return { done: false, value: chunks[i++] };
          }
          return { done: true, value: undefined };
        },
        cancel: async () => {},
        releaseLock: () => {},
      };
    },
  };
}

function setFetch(impl: (...args: any[]) => any): void {
  (global as any).fetch = jest.fn(impl);
}

// Poll a stream to completion, accumulating frames across polls. A single poll
// returns as soon as the first new frame is buffered (correct streaming
// semantics), so the realistic caller loops from `nextIndex` until `done`.
async function drainStream(
  streamId: string
): Promise<{ ok: boolean; frames: string[]; done: boolean }> {
  const frames: string[] = [];
  let index = 0;
  let ok = true;
  let done = false;
  for (let i = 0; i < 100; i++) {
    const poll = await pollStream(streamId, index);
    ok = poll.ok;
    frames.push(...poll.frames);
    index = poll.nextIndex;
    done = poll.done;
    if (done) {
      break;
    }
  }
  return { ok, frames, done };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isTextualContentType", () => {
  it("treats text/* and JSON/XML/JS/form families as text", () => {
    for (const ct of [
      "text/html",
      "text/plain; charset=utf-8",
      "text/event-stream",
      "application/json",
      "application/json; charset=utf-8",
      "application/ld+json",
      "application/xml",
      "application/rss+xml",
      "application/xhtml+xml",
      "application/javascript",
      "application/x-www-form-urlencoded",
      "APPLICATION/JSON",
    ]) {
      expect(isTextualContentType(ct)).toBe(true);
    }
  });

  it("treats binary and unknown types as non-text", () => {
    for (const ct of [
      "image/png",
      "application/octet-stream",
      "application/pdf",
      "font/woff2",
      "",
      null,
      undefined,
    ]) {
      expect(isTextualContentType(ct as any)).toBe(false);
    }
  });
});

describe("splitSseFrames", () => {
  it("returns complete frames and carries the incomplete leftover", () => {
    const first = splitSseFrames("", "data: a\n\ndata:");
    expect(first.frames).toEqual(["data: a"]);
    expect(first.remainder).toBe("data:");

    // The leftover from the first call completes on the next chunk.
    const second = splitSseFrames(first.remainder, " b\n\n");
    expect(second.frames).toEqual(["data: b"]);
    expect(second.remainder).toBe("");
  });

  it("splits a frame delivered across a mid-delimiter chunk boundary", () => {
    // The blank-line delimiter itself is split across two chunks.
    const first = splitSseFrames("", "event: ping\n");
    expect(first.frames).toEqual([]);
    expect(first.remainder).toBe("event: ping\n");

    const second = splitSseFrames(first.remainder, "\nnext");
    expect(second.frames).toEqual(["event: ping"]);
    expect(second.remainder).toBe("next");
  });

  it("tolerates CRLF (\\r\\n\\r\\n) delimiters", () => {
    const out = splitSseFrames("", "data: x\r\n\r\ndata: y\r\n\r\n");
    expect(out.frames).toEqual(["data: x", "data: y"]);
    expect(out.remainder).toBe("");
  });
});

describe("mapFirefoxCookie", () => {
  it("flags a cookie with an expiry as non-session and passes fields through", () => {
    const rec = mapFirefoxCookie({
      name: "sid",
      value: "secret",
      domain: "example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      session: false,
      expirationDate: 1893456000,
      storeId: "firefox-default",
    });
    expect(rec.session).toBe(false);
    expect(rec.expirationDate).toBe(1893456000);
    expect(rec.sameSite).toBe("lax");
    expect(rec.storeId).toBe("firefox-default");
    expect(rec.secure).toBe(true);
    expect(rec.httpOnly).toBe(true);
  });

  it("flags a cookie without an expiry as a session cookie", () => {
    const rec = mapFirefoxCookie({
      name: "csrf",
      value: "t",
      domain: "example.com",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "strict",
      storeId: "firefox-default",
    });
    expect(rec.session).toBe(true);
    expect(rec.expirationDate).toBeUndefined();
  });
});

describe("rewriteCookieHeader", () => {
  it("replaces an existing Cookie header for a matching URL", () => {
    const map = new Map<string, string>([["https://x.com/", "a=1; b=2"]]);
    const out = rewriteCookieHeader(
      { url: "https://x.com/", requestHeaders: [{ name: "Cookie", value: "old=0" }] },
      map
    );
    expect(out).toEqual({ requestHeaders: [{ name: "Cookie", value: "a=1; b=2" }] });
  });

  it("appends a Cookie header when none was present", () => {
    const map = new Map<string, string>([["https://x.com/", "a=1"]]);
    const out = rewriteCookieHeader(
      { url: "https://x.com/", requestHeaders: [{ name: "Accept", value: "*/*" }] },
      map
    );
    expect(out?.requestHeaders).toContainEqual({ name: "Cookie", value: "a=1" });
  });

  it("leaves non-matching URLs untouched", () => {
    const map = new Map<string, string>([["https://x.com/", "a=1"]]);
    expect(
      rewriteCookieHeader({ url: "https://other.com/", requestHeaders: [] }, map)
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getCookies
// ---------------------------------------------------------------------------

describe("getCookies", () => {
  it("passes only defined narrowing keys and maps the result", async () => {
    mockBrowser.cookies.getAll.mockResolvedValue([
      {
        name: "sid",
        value: "abc",
        domain: "x.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        session: false,
        expirationDate: 4102444800,
        storeId: "firefox-default",
      },
    ]);
    const cookies = await getCookies({ url: "https://x.com/", name: "sid" });
    expect(mockBrowser.cookies.getAll).toHaveBeenCalledWith({
      url: "https://x.com/",
      name: "sid",
    });
    expect(cookies).toHaveLength(1);
    expect(cookies[0].session).toBe(false);
    expect(cookies[0].value).toBe("abc");
  });
});

// ---------------------------------------------------------------------------
// browserFetch
// ---------------------------------------------------------------------------

describe("browserFetch", () => {
  it("returns a textual body decoded as UTF-8", async () => {
    setFetch(async () =>
      mockResponse({
        url: "https://api.example/x",
        contentType: "application/json",
        body: enc.encode('{"a":1}'),
      })
    );
    const result = await browserFetch({ url: "https://api.example/x" });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe("https://api.example/x");
    expect(result.headers?.["content-type"]).toBe("application/json");
    expect(result.bodyText).toBe('{"a":1}');
    expect(result.bodyBase64).toBeUndefined();
    expect(result.truncated).toBe(false);
  });

  it("returns a binary body as base64", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 250]);
    setFetch(async () =>
      mockResponse({ contentType: "image/png", body: bytes })
    );
    const result = await browserFetch({ url: "https://cdn.example/i.png" });
    expect(result.ok).toBe(true);
    expect(result.bodyText).toBeUndefined();
    expect(result.bodyBase64).toBe(btoa(String.fromCharCode(1, 2, 3, 4, 250)));
  });

  it("truncates a body larger than maxBytes and flags it", async () => {
    setFetch(async () =>
      mockResponse({ contentType: "text/plain", body: enc.encode("abcdefgh") })
    );
    const result = await browserFetch({
      url: "https://api.example/big",
      maxBytes: 4,
    });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.bodyText).toBe("abcd");
  });

  it("returns ok:false with an error message on fetch rejection", async () => {
    setFetch(async () => {
      throw new Error("network down");
    });
    const result = await browserFetch({ url: "https://api.example/fail" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("streaming", () => {
  it("starts, polls to completion, and closes", async () => {
    setFetch(async () => ({
      status: 200,
      statusText: "OK",
      url: "https://sse.example/stream",
      headers: makeHeaders({ "content-type": "text/event-stream" }),
      body: fakeStreamBody([enc.encode("data: a\n\n"), enc.encode("data: b\n\n")]),
    }));

    const started = await startStream({ url: "https://sse.example/stream" });
    expect(started.ok).toBe(true);
    expect(started.streamId).toBeDefined();
    expect(started.status).toBe(200);
    const streamId = started.streamId!;

    const drained = await drainStream(streamId);
    expect(drained.ok).toBe(true);
    expect(drained.frames).toEqual(["data: a", "data: b"]);
    expect(drained.done).toBe(true);

    // Close is idempotent.
    expect(closeStream(streamId).ok).toBe(true);
    expect(closeStream(streamId).ok).toBe(true);

    // After close the streamId is unknown.
    const after = await pollStream(streamId, 0);
    expect(after.ok).toBe(false);
    expect(after.done).toBe(true);
  });

  it("stops at a [DONE] sentinel frame", async () => {
    setFetch(async () => ({
      status: 200,
      statusText: "OK",
      url: "https://sse.example/done",
      headers: makeHeaders({ "content-type": "text/event-stream" }),
      body: fakeStreamBody([
        enc.encode("data: one\n\n"),
        enc.encode("data: [DONE]\n\n"),
        enc.encode("data: never\n\n"),
      ]),
    }));

    const started = await startStream({ url: "https://sse.example/done" });
    const streamId = started.streamId!;
    const drained = await drainStream(streamId);
    expect(drained.done).toBe(true);
    // The frame after [DONE] is never buffered.
    expect(drained.frames).toEqual(["data: one", "data: [DONE]"]);
    closeStream(streamId);
  });

  it("returns ok:false / done:true for an unknown streamId", async () => {
    const poll = await pollStream("does-not-exist", 0);
    expect(poll.ok).toBe(false);
    expect(poll.done).toBe(true);
    expect(poll.frames).toEqual([]);
    expect(poll.nextIndex).toBe(0);
    expect(poll.error).toBeDefined();
  });

  it("closeStream on an unknown streamId is a no-op ack", () => {
    expect(closeStream("nope").ok).toBe(true);
  });
});
