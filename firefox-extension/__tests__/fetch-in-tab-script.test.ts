/**
 * fetchInTab / abortFetchInTab (injected/fetch-in-tab-script.ts) against jsdom
 * with a stubbed global `fetch`.
 *
 * What this does NOT prove: that a real browser sends the page's Origin and
 * Referer from the isolated content-script world, or that Firefox's
 * `content.fetch` behaves as modelled here. jsdom has no network stack and no
 * Origin policy; the stub only records how the function CALLS fetch and how it
 * turns the Response into the result shape. The live-browser proof is separate.
 */
import { ReadableStream as NodeReadableStream } from "stream/web";
import { fetchInTab, abortFetchInTab } from "../injected/fetch-in-tab-script";

// jsdom's own origin ("http://localhost" under jest's default testURL).
const PAGE_ORIGIN = "http://localhost";

function fakeHeaders(rec: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) lower[k.toLowerCase()] = v;
  return {
    forEach(cb: (value: string, key: string) => void) {
      for (const [k, v] of Object.entries(lower)) cb(v, k);
    },
    get(name: string) {
      return lower[name.toLowerCase()] ?? null;
    },
  };
}

function fakeResponse(opts: {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
  noStream?: boolean;
  url?: string;
  onCancel?: () => void;
}): any {
  const chunks = opts.chunks ?? [];
  const resp: any = {
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers: fakeHeaders(opts.headers ?? {}),
    url: opts.url ?? "https://app.example.test/api/thing",
  };
  if (opts.noStream) {
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    resp.body = null;
    resp.arrayBuffer = async () => all.buffer;
  } else {
    resp.body = new NodeReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
      cancel() {
        opts.onCancel?.();
      },
    });
  }
  return resp;
}

const enc = (s: string) => new TextEncoder().encode(s);

let fetchStub: jest.Mock;

beforeEach(() => {
  fetchStub = jest.fn();
  (global as any).fetch = fetchStub;
  delete (global as any).content;
  delete (global as any).wrappedJSObject;
  delete (global as any).cloneInto;
  delete (global as any).__foxpilotTabFetches;
});

afterEach(() => {
  delete (global as any).content;
  delete (global as any).wrappedJSObject;
  delete (global as any).cloneInto;
});

describe("fetchInTab request", () => {
  it("defaults to a same-origin credentialed GET with follow redirects, like a page's own fetch", async () => {
    fetchStub.mockResolvedValue(
      fakeResponse({ headers: { "content-type": "application/json" }, chunks: [enc("{}")] })
    );
    await fetchInTab({ requestId: "r1", url: "https://app.example.test/api/thing" });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe("https://app.example.test/api/thing");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    expect(init.redirect).toBe("follow");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("forwards method, headers, a text body, credentials and redirect", async () => {
    fetchStub.mockResolvedValue(fakeResponse({ chunks: [enc("")] }));
    await fetchInTab({
      requestId: "r2",
      url: "https://app.example.test/api/thing",
      method: "POST",
      headers: { "x-csrf-token": "fake-token-123", "content-type": "application/json" },
      body: '{"a":1}',
      credentials: "include",
      redirect: "manual",
    });
    const init = fetchStub.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "x-csrf-token": "fake-token-123",
      "content-type": "application/json",
    });
    expect(init.body).toBe('{"a":1}');
    expect(init.credentials).toBe("include");
    expect(init.redirect).toBe("manual");
  });

  it("decodes bodyBase64 into request bytes", async () => {
    fetchStub.mockResolvedValue(fakeResponse({ chunks: [] }));
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 255]);
    await fetchInTab({
      requestId: "r3",
      url: "https://app.example.test/upload",
      method: "PUT",
      bodyBase64: Buffer.from(bytes).toString("base64"),
    });
    const body = fetchStub.mock.calls[0][1].body;
    expect(Array.from(body as Uint8Array)).toEqual(Array.from(bytes));
  });

  it("prefers a text body over bodyBase64 when both are set (background path parity)", async () => {
    fetchStub.mockResolvedValue(fakeResponse({ chunks: [] }));
    await fetchInTab({
      requestId: "r3b",
      url: "https://app.example.test/x",
      method: "POST",
      body: "text-wins",
      bodyBase64: Buffer.from("bytes-lose").toString("base64"),
    });
    expect(fetchStub.mock.calls[0][1].body).toBe("text-wins");
  });

  it("refuses to send when the tab has moved to another origin since the gate ran", async () => {
    const result = await fetchInTab({
      requestId: "r4",
      url: "https://app.example.test/api/thing",
      expectOrigin: "https://app.example.test",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(PAGE_ORIGIN);
    expect(result.error).toContain("https://app.example.test");
    expect(result.error).toMatch(/nothing was sent/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("sends when the origin still matches", async () => {
    fetchStub.mockResolvedValue(fakeResponse({ chunks: [enc("x")], headers: { "content-type": "text/plain" } }));
    const result = await fetchInTab({
      requestId: "r5",
      url: `${PAGE_ORIGIN}/api/thing`,
      expectOrigin: PAGE_ORIGIN,
    });
    expect(result.ok).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe("fetchInTab response", () => {
  it("returns the background path's shape for a text response", async () => {
    fetchStub.mockResolvedValue(
      fakeResponse({
        status: 403,
        statusText: "Forbidden",
        headers: { "Content-Type": "application/json; charset=utf-8", "X-Req": "abc" },
        chunks: [enc('{"error":'), enc('"nope"}')],
        url: "https://app.example.test/api/final",
      })
    );
    const result = await fetchInTab({ requestId: "r6", url: "https://app.example.test/api/thing" });
    expect(result).toEqual({
      ok: true,
      status: 403,
      statusText: "Forbidden",
      headers: { "content-type": "application/json; charset=utf-8", "x-req": "abc" },
      finalUrl: "https://app.example.test/api/final",
      truncated: false,
      bodyText: '{"error":"nope"}',
    });
    // Every value must survive scripting.executeScript / tabs.executeScript.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it.each([
    ["application/ld+json", true],
    ["application/atom+xml", true],
    ["application/javascript", true],
    ["application/x-www-form-urlencoded", true],
    ["text/html; charset=utf-8", true],
    ["application/octet-stream", false],
    ["image/png", false],
  ])("treats %s as textual=%s", async (contentType, textual) => {
    fetchStub.mockResolvedValue(
      fakeResponse({ headers: { "content-type": contentType }, chunks: [enc("hi")] })
    );
    const result = await fetchInTab({ requestId: "r7", url: "https://app.example.test/x" });
    if (textual) {
      expect(result.bodyText).toBe("hi");
      expect(result.bodyBase64).toBeUndefined();
    } else {
      expect(result.bodyBase64).toBe(Buffer.from("hi").toString("base64"));
      expect(result.bodyText).toBeUndefined();
    }
  });

  it("base64-encodes a large binary body exactly (no argument-limit blowup)", async () => {
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    fetchStub.mockResolvedValue(
      fakeResponse({
        headers: { "content-type": "application/octet-stream" },
        chunks: [bytes.slice(0, 70_000), bytes.slice(70_000)],
      })
    );
    const result = await fetchInTab({ requestId: "r8", url: "https://app.example.test/bin" });
    expect(result.bodyBase64).toBe(Buffer.from(bytes).toString("base64"));
    expect(result.truncated).toBe(false);
  });

  it("an empty body without a content type comes back as bodyBase64 '' (what a bare 403 looks like)", async () => {
    fetchStub.mockResolvedValue(fakeResponse({ status: 403, statusText: "Forbidden", chunks: [] }));
    const result = await fetchInTab({ requestId: "r9", url: "https://app.example.test/x" });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(403);
    expect(result.bodyBase64).toBe("");
    expect(result.bodyText).toBeUndefined();
  });

  it("falls back to arrayBuffer() when the response has no stream", async () => {
    fetchStub.mockResolvedValue(
      fakeResponse({ headers: { "content-type": "text/plain" }, chunks: [enc("plain body")], noStream: true })
    );
    const result = await fetchInTab({ requestId: "r10", url: "https://app.example.test/x" });
    expect(result.bodyText).toBe("plain body");
  });
});

describe("fetchInTab maxBytes", () => {
  it("stops reading at the cap, cancels the stream and flags truncation", async () => {
    const onCancel = jest.fn();
    fetchStub.mockResolvedValue(
      fakeResponse({
        headers: { "content-type": "text/plain" },
        chunks: [enc("aaaa"), enc("bbbb"), enc("cccc")],
        onCancel,
      })
    );
    const result = await fetchInTab({
      requestId: "r11",
      url: "https://app.example.test/x",
      maxBytes: 6,
    });
    expect(result.bodyText).toBe("aaaabb");
    expect(result.truncated).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a body of exactly maxBytes is not truncated (background path parity)", async () => {
    fetchStub.mockResolvedValue(
      fakeResponse({ headers: { "content-type": "text/plain" }, chunks: [enc("abcd"), enc("efgh")] })
    );
    const result = await fetchInTab({
      requestId: "r12",
      url: "https://app.example.test/x",
      maxBytes: 8,
    });
    expect(result.bodyText).toBe("abcdefgh");
    expect(result.truncated).toBe(false);
  });

  it("maxBytes:0 returns an empty, truncated body for any non-empty response", async () => {
    fetchStub.mockResolvedValue(
      fakeResponse({ headers: { "content-type": "text/plain" }, chunks: [enc("abc")] })
    );
    const result = await fetchInTab({
      requestId: "r13",
      url: "https://app.example.test/x",
      maxBytes: 0,
    });
    expect(result.bodyText).toBe("");
    expect(result.truncated).toBe(true);
  });

  it("truncates when there is no stream too", async () => {
    fetchStub.mockResolvedValue(
      fakeResponse({
        headers: { "content-type": "text/plain" },
        chunks: [enc("0123456789")],
        noStream: true,
      })
    );
    const result = await fetchInTab({
      requestId: "r14",
      url: "https://app.example.test/x",
      maxBytes: 4,
    });
    expect(result.bodyText).toBe("0123");
    expect(result.truncated).toBe(true);
  });

  it("defaults to 5,000,000 bytes, the background path's cap", async () => {
    const big = new Uint8Array(5_000_001).fill(97);
    fetchStub.mockResolvedValue(
      fakeResponse({ headers: { "content-type": "text/plain" }, chunks: [big] })
    );
    const result = await fetchInTab({ requestId: "r15", url: "https://app.example.test/x" });
    expect(result.bodyText).toHaveLength(5_000_000);
    expect(result.truncated).toBe(true);
  });
});

describe("fetchInTab failures", () => {
  it("returns ok:false with the message for a same-origin network error", async () => {
    fetchStub.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await fetchInTab({ requestId: "r16", url: `${PAGE_ORIGIN}/api` });
    expect(result).toEqual({ ok: false, error: "Failed to fetch" });
  });

  it("names the page's CORS rules when a cross-origin target fails with a network error", async () => {
    fetchStub.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await fetchInTab({ requestId: "r17", url: "https://api.example.test/x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to fetch");
    expect(result.error).toMatch(/different origin than the page.*CORS/);
    expect(result.error).toContain(PAGE_ORIGIN);
  });

  it("an invalid fetch() call (for example a body on GET) is reported, not thrown", async () => {
    fetchStub.mockImplementation(() => {
      throw new TypeError("Request with GET/HEAD method cannot have body");
    });
    const result = await fetchInTab({
      requestId: "r18",
      url: `${PAGE_ORIGIN}/api`,
      body: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot have body/);
  });

  it("retries once WITHOUT the signal when fetch() rejects its arguments synchronously", async () => {
    fetchStub
      .mockImplementationOnce((_u: string, init: any) => {
        expect(init.signal).toBeDefined();
        throw new TypeError("'signal' is not an AbortSignal");
      })
      .mockResolvedValueOnce(
        fakeResponse({ headers: { "content-type": "text/plain" }, chunks: [enc("ok")] })
      );
    const result = await fetchInTab({ requestId: "r19", url: `${PAGE_ORIGIN}/api` });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub.mock.calls[1][1].signal).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.bodyText).toBe("ok");
    // No request existed to abort, and nothing is left registered.
    expect(abortFetchInTab("r19")).toBe(false);
  });
});

describe("abortFetchInTab", () => {
  function hangUntilAborted() {
    fetchStub.mockImplementation(
      (_u: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }))
          );
        })
    );
  }

  it("cancels an in-flight request by requestId and the fetch reports it as aborted", async () => {
    hangUntilAborted();
    const pending = fetchInTab({ requestId: "hang-1", url: `${PAGE_ORIGIN}/slow` });
    expect(abortFetchInTab("hang-1")).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, error: "The request was aborted." });
    expect(abortFetchInTab("hang-1")).toBe(false);
  });

  it("only aborts the request it names", async () => {
    hangUntilAborted();
    const a = fetchInTab({ requestId: "a", url: `${PAGE_ORIGIN}/a` });
    const b = fetchInTab({ requestId: "b", url: `${PAGE_ORIGIN}/b` });
    expect(abortFetchInTab("a")).toBe(true);
    await expect(a).resolves.toMatchObject({ ok: false });
    expect(abortFetchInTab("b")).toBe(true);
    await expect(b).resolves.toMatchObject({ ok: false });
  });

  it("returns false for an unknown id, and when nothing has ever been registered", () => {
    expect(abortFetchInTab("nope")).toBe(false);
  });

  it("a finished request leaves nothing registered", async () => {
    fetchStub.mockResolvedValue(fakeResponse({ chunks: [] }));
    await fetchInTab({ requestId: "done-1", url: `${PAGE_ORIGIN}/x` });
    expect(abortFetchInTab("done-1")).toBe(false);
  });
});

describe("which fetch it uses (Firefox MV2 sandbox vs Chrome)", () => {
  it("uses content.fetch (the page-principal fetch) when the sandbox has it, never the plain fetch", async () => {
    const contentFetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ headers: { "content-type": "text/plain" }, chunks: [enc("via content")] })
      );
    (global as any).content = { fetch: contentFetch };
    const result = await fetchInTab({ requestId: "c1", url: `${PAGE_ORIGIN}/api` });
    expect(contentFetch).toHaveBeenCalledTimes(1);
    expect(contentFetch.mock.calls[0][0]).toBe(`${PAGE_ORIGIN}/api`);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(result.bodyText).toBe("via content");
  });

  it("falls back to the page's own fetch through wrappedJSObject, cloning the init into the page realm", async () => {
    const pageFetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ headers: { "content-type": "text/plain" }, chunks: [enc("via page")] })
      );
    const pageWindow = { fetch: pageFetch };
    (global as any).wrappedJSObject = pageWindow;
    (global as any).cloneInto = jest.fn((obj: any) => ({ ...obj, __cloned: true }));
    const result = await fetchInTab({
      requestId: "c2",
      url: `${PAGE_ORIGIN}/api`,
      method: "POST",
      body: "x",
    });
    expect((global as any).cloneInto).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", body: "x" }),
      pageWindow,
      { wrapReflectors: true }
    );
    expect(pageFetch.mock.calls[0][1].__cloned).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(result.bodyText).toBe("via page");
  });

  it("uses the plain fetch where neither Firefox global exists (Chrome: already the page's fetch)", async () => {
    fetchStub.mockResolvedValue(fakeResponse({ chunks: [] }));
    await fetchInTab({ requestId: "c3", url: `${PAGE_ORIGIN}/api` });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("ignores a `content` that is not a fetch-bearing object (an element named #content)", async () => {
    (global as any).content = { tagName: "DIV" };
    fetchStub.mockResolvedValue(fakeResponse({ chunks: [] }));
    await fetchInTab({ requestId: "c4", url: `${PAGE_ORIGIN}/api` });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe("no page timers", () => {
  it("never calls setTimeout/setInterval/requestAnimationFrame (a hidden tab clamps them)", async () => {
    const st = jest.spyOn(global, "setTimeout");
    const si = jest.spyOn(global, "setInterval");
    fetchStub.mockResolvedValue(
      fakeResponse({ headers: { "content-type": "text/plain" }, chunks: [enc("a"), enc("b")] })
    );
    await fetchInTab({ requestId: "t1", url: `${PAGE_ORIGIN}/x`, maxBytes: 1 });
    abortFetchInTab("t1");
    expect(st).not.toHaveBeenCalled();
    expect(si).not.toHaveBeenCalled();
    expect(fetchInTab.toString()).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
    st.mockRestore();
    si.mockRestore();
  });
});
