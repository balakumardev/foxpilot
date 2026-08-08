/**
 * Tests for the background network-capture module.
 *
 * NOTE on scope: the live `webRequest` event flow and the `filterResponseData`
 * response-body capture are browser-only — jsdom has no `webRequest` engine and
 * `browser.webRequest.filterResponseData` does not actually stream bytes. So
 * these tests cover the parts that run as plain logic in the background's
 * isolated world:
 *   - the pure updater functions (onBeforeRequest/onSendHeaders/
 *     onHeadersReceived/onCompleted/onErrorOccurred) driven with synthetic
 *     `details` objects through a full request lifecycle,
 *   - the per-tab ring buffer (cap / isolation / clear-on-removal),
 *   - `getNetworkRequests` filtering (url substring + resourceType) and limit,
 *   - registration toggling as Automation Mode flips via `storage.onChanged`.
 * The actual byte interception is verified manually in a real Firefox profile.
 */

import {
  onBeforeRequestRecord,
  onSendHeadersRecord,
  onHeadersReceivedRecord,
  onCompletedRecord,
  onErrorOccurredRecord,
  getNetworkRequests,
  clearNetworkRequests,
  clearAllNetworkState,
  initNetworkCapture,
  registerNetworkListeners,
  unregisterNetworkListeners,
  setBodyCaptureEnabled,
  NETWORK_BUFFER_CAP,
} from "../network-capture";

// Grab the most-recently-registered listener for a mocked event API.
function lastListener(mockFn: jest.Mock): (...args: any[]) => any {
  const calls = mockFn.mock.calls;
  return calls[calls.length - 1][0];
}

// Flush pending promise chains (microtasks across multiple awaits).
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Build a synthetic webRequest details object for a request lifecycle.
function details(over: Record<string, unknown>): any {
  return {
    requestId: "r1",
    url: "https://example.com/api",
    method: "GET",
    type: "xmlhttprequest",
    tabId: 1,
    timeStamp: 1000,
    ...over,
  };
}

describe("network-capture lifecycle (pure updaters)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear buffers for the tabs used here so suites don't leak into each other.
    [1, 2, 3, 10, 11, 12].forEach(clearNetworkRequests);
  });

  it("finalizes a successful request (beforeRequest→sendHeaders→headersReceived→completed)", () => {
    onBeforeRequestRecord(
      details({ requestId: "rA", tabId: 10, timeStamp: 1000 })
    );
    onSendHeadersRecord(
      details({
        requestId: "rA",
        tabId: 10,
        requestHeaders: [{ name: "Accept", value: "application/json" }],
      })
    );
    onHeadersReceivedRecord(
      details({
        requestId: "rA",
        tabId: 10,
        statusCode: 200,
        responseHeaders: [{ name: "Content-Length", value: "1234" }],
      })
    );
    // Not in the tab buffer until completed/errored.
    expect(getNetworkRequests(10)).toEqual([]);

    onCompletedRecord(
      details({
        requestId: "rA",
        tabId: 10,
        statusCode: 200,
        fromCache: false,
        responseHeaders: [{ name: "Content-Length", value: "1234" }],
        timeStamp: 1250,
      })
    );

    const recs = getNetworkRequests(10);
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    expect(rec.requestId).toBe("rA");
    expect(rec.url).toBe("https://example.com/api");
    expect(rec.method).toBe("GET");
    expect(rec.type).toBe("xmlhttprequest");
    expect(rec.statusCode).toBe(200);
    expect(rec.fromCache).toBe(false);
    expect(rec.completedTimeStamp).toBe(1250);
    expect(rec.durationMs).toBe(250);
    expect(rec.responseSize).toBe(1234);
    expect(rec.requestHeaders).toEqual([
      { name: "Accept", value: "application/json" },
    ]);
    expect(rec.responseHeaders).toEqual([
      { name: "Content-Length", value: "1234" },
    ]);
    expect(rec.error).toBeUndefined();
  });

  it("prefers details.responseSize over the Content-Length header when present", () => {
    onBeforeRequestRecord(details({ requestId: "rS", tabId: 10 }));
    onCompletedRecord(
      details({
        requestId: "rS",
        tabId: 10,
        statusCode: 200,
        responseSize: 999,
        responseHeaders: [{ name: "content-length", value: "5" }],
        timeStamp: 1100,
      })
    );
    expect(getNetworkRequests(10)[0].responseSize).toBe(999);
  });

  it("records an error lifecycle (beforeRequest→errorOccurred)", () => {
    onBeforeRequestRecord(details({ requestId: "rE", tabId: 11, timeStamp: 1000 }));
    onErrorOccurredRecord(
      details({
        requestId: "rE",
        tabId: 11,
        error: "NS_ERROR_NET_RESET",
        timeStamp: 1080,
      })
    );

    const recs = getNetworkRequests(11);
    expect(recs).toHaveLength(1);
    expect(recs[0].error).toBe("NS_ERROR_NET_RESET");
    expect(recs[0].durationMs).toBe(80);
    expect(recs[0].statusCode).toBeUndefined();
  });

  it("finalizes a completed request even if beforeRequest was missed", () => {
    // onCompleted for a requestId never seen in-flight should still produce a
    // record (synthesized from the completed details) rather than be dropped.
    onCompletedRecord(
      details({
        requestId: "rOrphan",
        tabId: 12,
        statusCode: 204,
        timeStamp: 1500,
      })
    );
    const recs = getNetworkRequests(12);
    expect(recs).toHaveLength(1);
    expect(recs[0].statusCode).toBe(204);
  });

  it("caps a tab's buffer at NETWORK_BUFFER_CAP, dropping the oldest", () => {
    expect(NETWORK_BUFFER_CAP).toBe(200);
    const total = NETWORK_BUFFER_CAP + 25;
    for (let i = 0; i < total; i++) {
      onBeforeRequestRecord(
        details({ requestId: `c${i}`, tabId: 2, url: `https://x/${i}` })
      );
      onCompletedRecord(
        details({
          requestId: `c${i}`,
          tabId: 2,
          url: `https://x/${i}`,
          statusCode: 200,
          timeStamp: 1000 + i,
        })
      );
    }
    const recs = getNetworkRequests(2);
    expect(recs).toHaveLength(NETWORK_BUFFER_CAP);
    expect(recs[0].url).toBe(`https://x/${total - NETWORK_BUFFER_CAP}`);
    expect(recs[recs.length - 1].url).toBe(`https://x/${total - 1}`);
  });

  it("isolates buffers per tab", () => {
    onBeforeRequestRecord(details({ requestId: "a", tabId: 1, url: "https://a/" }));
    onCompletedRecord(
      details({ requestId: "a", tabId: 1, url: "https://a/", statusCode: 200 })
    );
    onBeforeRequestRecord(details({ requestId: "b", tabId: 2, url: "https://b/" }));
    onCompletedRecord(
      details({ requestId: "b", tabId: 2, url: "https://b/", statusCode: 200 })
    );

    expect(getNetworkRequests(1).map((r) => r.url)).toEqual(["https://a/"]);
    expect(getNetworkRequests(2).map((r) => r.url)).toEqual(["https://b/"]);
  });

  it("clears a tab's buffer on removal", () => {
    onBeforeRequestRecord(details({ requestId: "g", tabId: 3 }));
    onCompletedRecord(details({ requestId: "g", tabId: 3, statusCode: 200 }));
    expect(getNetworkRequests(3)).toHaveLength(1);
    clearNetworkRequests(3);
    expect(getNetworkRequests(3)).toEqual([]);
  });

  it("does not buffer requests with no tab (tabId < 0)", () => {
    onBeforeRequestRecord(details({ requestId: "noTab", tabId: -1 }));
    onCompletedRecord(
      details({ requestId: "noTab", tabId: -1, statusCode: 200 })
    );
    // Nothing should land in any of the tab buffers we track.
    expect(getNetworkRequests(-1)).toEqual([]);
  });
});

describe("getNetworkRequests filtering and limit", () => {
  beforeEach(() => {
    clearNetworkRequests(20);
    function add(
      requestId: string,
      url: string,
      type: string,
      status: number
    ) {
      onBeforeRequestRecord(details({ requestId, tabId: 20, url, type }));
      onCompletedRecord(
        details({
          requestId,
          tabId: 20,
          url,
          type,
          statusCode: status,
          timeStamp: 1000 + Number(requestId.replace(/\D/g, "")),
        })
      );
    }
    add("f1", "https://example.com/api/users", "xmlhttprequest", 200);
    add("f2", "https://cdn.example.com/app.js", "script", 200);
    add("f3", "https://example.com/api/orders", "xmlhttprequest", 500);
    add("f4", "https://img.example.com/logo.png", "image", 200);
  });

  it("returns all records when no filter is given", () => {
    expect(getNetworkRequests(20)).toHaveLength(4);
  });

  it("filters by case-insensitive url substring", () => {
    const recs = getNetworkRequests(20, { filter: "API/ORDERS" });
    expect(recs.map((r) => r.requestId)).toEqual(["f3"]);
  });

  it("filters by exact resourceType match", () => {
    const recs = getNetworkRequests(20, { filter: "script" });
    expect(recs.map((r) => r.requestId)).toEqual(["f2"]);
  });

  it("matches url substring OR resourceType (image matches the type, not a url)", () => {
    const recs = getNetworkRequests(20, { filter: "image" });
    expect(recs.map((r) => r.requestId)).toEqual(["f4"]);
  });

  it("applies the most-recent limit after filtering", () => {
    const recs = getNetworkRequests(20, { filter: "example.com", limit: 2 });
    // All 4 match the host; the 2 most-recent are f3 and f4.
    expect(recs.map((r) => r.requestId)).toEqual(["f3", "f4"]);
  });
});

describe("initNetworkCapture wiring", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await unregisterNetworkListeners();
    jest.clearAllMocks();
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
  });

  it("does not touch the browser API on mere import (registration is explicit)", () => {
    expect(browser.webRequest.onBeforeRequest.addListener).not.toHaveBeenCalled();
    expect(browser.tabs.onRemoved.addListener).not.toHaveBeenCalled();
    expect(browser.storage.onChanged.addListener).not.toHaveBeenCalled();
  });

  it("registers tabs.onRemoved and storage.onChanged listeners", () => {
    initNetworkCapture();
    expect(browser.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
    expect(browser.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
  });

  it("clears a tab's buffer when the tab is removed", () => {
    initNetworkCapture();
    const onRemoved = lastListener(browser.tabs.onRemoved.addListener as jest.Mock);
    onBeforeRequestRecord(details({ requestId: "x", tabId: 30 }));
    onCompletedRecord(details({ requestId: "x", tabId: 30, statusCode: 200 }));
    expect(getNetworkRequests(30)).toHaveLength(1);
    onRemoved(30, { windowId: 1, isWindowClosing: false });
    expect(getNetworkRequests(30)).toEqual([]);
  });

  it("registers the webRequest listeners on init when Automation Mode is already on", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], automationMode: true },
    });
    initNetworkCapture();
    await flushPromises();
    expect(browser.webRequest.onBeforeRequest.addListener).toHaveBeenCalledTimes(1);
    expect(browser.webRequest.onSendHeaders.addListener).toHaveBeenCalledTimes(1);
    expect(browser.webRequest.onHeadersReceived.addListener).toHaveBeenCalledTimes(1);
    expect(browser.webRequest.onCompleted.addListener).toHaveBeenCalledTimes(1);
    expect(browser.webRequest.onErrorOccurred.addListener).toHaveBeenCalledTimes(1);
    // onSendHeaders/onHeadersReceived must request the header extra info specs.
    const sendArgs = (browser.webRequest.onSendHeaders.addListener as jest.Mock)
      .mock.calls[0];
    expect(sendArgs[2]).toEqual(["requestHeaders"]);
    const recvArgs = (browser.webRequest.onHeadersReceived.addListener as jest.Mock)
      .mock.calls[0];
    expect(recvArgs[2]).toEqual(["responseHeaders"]);
    // The url filter should be all-URLs.
    expect(sendArgs[1]).toEqual({ urls: ["<all_urls>"] });
  });

  it("does NOT register the webRequest listeners on init when Automation Mode is off", async () => {
    initNetworkCapture();
    await flushPromises();
    expect(browser.webRequest.onBeforeRequest.addListener).not.toHaveBeenCalled();
  });

  it("registers when storage.onChanged flips automationMode on, unregisters when off", async () => {
    initNetworkCapture();
    const onChanged = lastListener(browser.storage.onChanged.addListener as jest.Mock);

    onChanged(
      { config: { oldValue: { automationMode: false }, newValue: { automationMode: true } } },
      "local"
    );
    await flushPromises();
    expect(browser.webRequest.onBeforeRequest.addListener).toHaveBeenCalledTimes(1);

    onChanged(
      { config: { oldValue: { automationMode: true }, newValue: { automationMode: false } } },
      "local"
    );
    await flushPromises();
    expect(browser.webRequest.onBeforeRequest.removeListener).toHaveBeenCalledTimes(1);
  });

  it("ignores storage.onChanged events from other areas or unrelated keys", async () => {
    initNetworkCapture();
    const onChanged = lastListener(browser.storage.onChanged.addListener as jest.Mock);
    onChanged({ config: { newValue: { automationMode: true } } }, "sync");
    onChanged({ somethingElse: { newValue: 1 } }, "local");
    await flushPromises();
    expect(browser.webRequest.onBeforeRequest.addListener).not.toHaveBeenCalled();
  });
});

describe("registerNetworkListeners idempotency and error handling", () => {
  beforeEach(async () => {
    await unregisterNetworkListeners();
    jest.clearAllMocks();
  });

  it("registers each listener only once across repeated calls (idempotent)", async () => {
    await registerNetworkListeners();
    await registerNetworkListeners();
    expect(browser.webRequest.onBeforeRequest.addListener).toHaveBeenCalledTimes(1);
    await unregisterNetworkListeners();
  });

  it("unregister removes all five listeners and allows re-registration", async () => {
    await registerNetworkListeners();
    await unregisterNetworkListeners();
    expect(browser.webRequest.onBeforeRequest.removeListener).toHaveBeenCalledTimes(1);
    expect(browser.webRequest.onCompleted.removeListener).toHaveBeenCalledTimes(1);
    expect(browser.webRequest.onErrorOccurred.removeListener).toHaveBeenCalledTimes(1);
    await registerNetworkListeners();
    expect(browser.webRequest.onBeforeRequest.addListener).toHaveBeenCalledTimes(2);
    await unregisterNetworkListeners();
  });

  it("swallows a registration failure (missing permission) without throwing", async () => {
    (browser.webRequest.onBeforeRequest.addListener as jest.Mock).mockImplementationOnce(
      () => {
        throw new Error("missing webRequest permission");
      }
    );
    await expect(registerNetworkListeners()).resolves.toBeUndefined();
    await unregisterNetworkListeners();
  });

  it("setBodyCaptureEnabled toggles a tab's flag without throwing", () => {
    expect(() => setBodyCaptureEnabled(1, true)).not.toThrow();
    expect(() => setBodyCaptureEnabled(1, false)).not.toThrow();
  });
});

// A stand-in for Firefox's StreamFilter returned by
// `browser.webRequest.filterResponseData(requestId)`. jsdom has no real
// `webRequest` byte-streaming engine, so we hand the module a fake filter and
// drive its `ondata`/`onstop`/`onerror` callbacks by hand, exactly as the
// browser would, to exercise the otherwise browser-only body-capture path.
interface FakeFilter {
  write: jest.Mock;
  disconnect: jest.Mock;
  close: jest.Mock;
  ondata: ((event: { data: ArrayBuffer }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
}

function makeFakeFilter(): FakeFilter {
  return {
    write: jest.fn(),
    disconnect: jest.fn(),
    close: jest.fn(),
    ondata: null,
    onstop: null,
    onerror: null,
  };
}

// Encode a string to an ArrayBuffer for feeding `ondata`. `TextEncoder` is
// installed as a global by the jest setup (jsdom omits it; real Firefox has it).
function bytesOf(text: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(text);
  // Return a standalone ArrayBuffer (not a view) like the browser hands us.
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

describe("attachBodyFilter response-body capture (fake StreamFilter)", () => {
  beforeEach(async () => {
    await unregisterNetworkListeners();
    jest.clearAllMocks();
    clearAllNetworkState();
  });

  afterEach(async () => {
    await unregisterNetworkListeners();
    clearAllNetworkState();
  });

  // Register the real listeners and return the onBeforeRequest handler the
  // module installed (which is what calls attachBodyFilter when body capture
  // is on). Also installs `filterResponseData` to return our fake filter.
  async function setupWithFilter(
    filter: FakeFilter
  ): Promise<(details: any) => any> {
    (browser.webRequest as any).filterResponseData = jest
      .fn()
      .mockReturnValue(filter);
    await registerNetworkListeners();
    return lastListener(
      browser.webRequest.onBeforeRequest.addListener as jest.Mock
    );
  }

  it("attaches no filter when body capture is DISABLED", async () => {
    const filter = makeFakeFilter();
    const onBeforeRequest = await setupWithFilter(filter);

    // Body capture is off (default in beforeEach).
    onBeforeRequest(details({ requestId: "nb", tabId: 40 }));

    expect((browser.webRequest as any).filterResponseData).not.toHaveBeenCalled();
    expect(filter.write).not.toHaveBeenCalled();
  });

  it("re-emits each chunk, disconnects on stop, and decodes the body onto the record", async () => {
    setBodyCaptureEnabled(41, true);
    const filter = makeFakeFilter();
    const onBeforeRequest = await setupWithFilter(filter);

    onBeforeRequest(details({ requestId: "bc", tabId: 41, url: "https://x/y" }));

    // The module should have requested a stream filter for this request.
    expect((browser.webRequest as any).filterResponseData).toHaveBeenCalledWith(
      "bc"
    );
    expect(typeof filter.ondata).toBe("function");
    expect(typeof filter.onstop).toBe("function");

    // Drive two chunks of bytes, then stop.
    const chunk1 = bytesOf("hello ");
    const chunk2 = bytesOf("world");
    filter.ondata!({ data: chunk1 });
    filter.ondata!({ data: chunk2 });

    // (a) The page still receives BOTH chunks unchanged.
    expect(filter.write).toHaveBeenCalledTimes(2);
    expect(filter.write).toHaveBeenNthCalledWith(1, chunk1);
    expect(filter.write).toHaveBeenNthCalledWith(2, chunk2);

    // The body is not finalized until stop.
    filter.onstop!();
    // (b) disconnect is called on stop so the stream completes for the page.
    expect(filter.disconnect).toHaveBeenCalledTimes(1);

    // Finalize the request so the record lands in the tab buffer.
    onCompletedRecord(
      details({ requestId: "bc", tabId: 41, url: "https://x/y", statusCode: 200 })
    );

    // (c) The decoded body text lands on the record.
    const recs = getNetworkRequests(41);
    expect(recs).toHaveLength(1);
    expect(recs[0].body).toBe("hello world");
  });

  it("caps the stored body at ~64KB but still re-emits every (over-cap) chunk to the page", async () => {
    setBodyCaptureEnabled(42, true);
    const filter = makeFakeFilter();
    const onBeforeRequest = await setupWithFilter(filter);

    onBeforeRequest(details({ requestId: "big", tabId: 42, url: "https://x/big" }));

    // 64KB cap. Send 50KB then another 50KB (total 100KB > cap).
    const CAP = 64 * 1024;
    const part = "a".repeat(50 * 1024);
    const chunkA = bytesOf(part);
    const chunkB = bytesOf(part);
    filter.ondata!({ data: chunkA });
    filter.ondata!({ data: chunkB });
    filter.onstop!();

    // Page integrity: BOTH chunks are written out even though the stored body
    // is capped — we must never starve the page of bytes to save memory.
    expect(filter.write).toHaveBeenCalledTimes(2);
    expect(filter.write).toHaveBeenNthCalledWith(1, chunkA);
    expect(filter.write).toHaveBeenNthCalledWith(2, chunkB);
    expect(filter.disconnect).toHaveBeenCalledTimes(1);

    onCompletedRecord(
      details({ requestId: "big", tabId: 42, url: "https://x/big", statusCode: 200 })
    );
    const rec = getNetworkRequests(42)[0];
    // Body is ASCII so 1 byte == 1 char; the stored snippet is clamped to CAP.
    expect(rec.body!.length).toBe(CAP);
  });

  it("re-emits the chunk to the page EVEN IF the capture logic throws (write in finally)", async () => {
    // This guards the robustness fix: a capture error must never truncate the
    // page's response. We feed `ondata` an event whose `data` is not a valid
    // ArrayBuffer, so `new Uint8Array(event.data)` throws inside the capture
    // block — and assert the chunk was still written out to the page.
    setBodyCaptureEnabled(43, true);
    const filter = makeFakeFilter();
    const onBeforeRequest = await setupWithFilter(filter);

    onBeforeRequest(details({ requestId: "thr", tabId: 43 }));

    const hostileData = { byteLength: 5 } as unknown as ArrayBuffer; // not a real buffer
    expect(() => filter.ondata!({ data: hostileData })).not.toThrow();
    // The page still got its bytes despite the capture throwing.
    expect(filter.write).toHaveBeenCalledTimes(1);
    expect(filter.write).toHaveBeenCalledWith(hostileData);

    // Stop still disconnects so the page's stream completes.
    filter.onstop!();
    expect(filter.disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnects on filter error without throwing", async () => {
    setBodyCaptureEnabled(44, true);
    const filter = makeFakeFilter();
    const onBeforeRequest = await setupWithFilter(filter);

    onBeforeRequest(details({ requestId: "err", tabId: 44 }));
    expect(typeof filter.onerror).toBe("function");
    expect(() => filter.onerror!()).not.toThrow();
    expect(filter.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("request-body capture (covert, no debugger)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAllNetworkState();
  });

  afterEach(() => {
    clearAllNetworkState();
  });

  // Complete the request so its in-flight record lands in the tab buffer, then
  // return the captured request body (or undefined) for assertions.
  function bodyAfter(requestId: string, tabId: number): string | undefined {
    onCompletedRecord(
      details({ requestId, tabId, statusCode: 200, timeStamp: 1100 })
    );
    const recs = getNetworkRequests(tabId);
    return recs[recs.length - 1].requestBody;
  }

  it("does NOT capture a request body when body capture is DISABLED", () => {
    // Body capture off (default from beforeEach): requestBody must be ignored.
    onBeforeRequestRecord(
      details({
        requestId: "rbOff",
        tabId: 50,
        method: "POST",
        requestBody: { formData: { a: ["1"] } },
      })
    );
    expect(bodyAfter("rbOff", 50)).toBeUndefined();
  });

  it("serializes formData to JSON when body capture is enabled", () => {
    setBodyCaptureEnabled(51, true);
    onBeforeRequestRecord(
      details({
        requestId: "rbForm",
        tabId: 51,
        method: "POST",
        requestBody: { formData: { user: ["alice"], tags: ["x", "y"] } },
      })
    );
    expect(bodyAfter("rbForm", 51)).toBe(
      JSON.stringify({ user: ["alice"], tags: ["x", "y"] })
    );
  });

  it("decodes a raw ArrayBuffer part to a UTF-8 string when body capture is enabled", () => {
    setBodyCaptureEnabled(52, true);
    onBeforeRequestRecord(
      details({
        requestId: "rbRaw",
        tabId: 52,
        method: "POST",
        requestBody: { raw: [{ bytes: bytesOf('{"q":"hi"}') }] },
      })
    );
    expect(bodyAfter("rbRaw", 52)).toBe('{"q":"hi"}');
  });

  it("concatenates raw byte parts and skips file-upload parts (no bytes)", () => {
    setBodyCaptureEnabled(53, true);
    onBeforeRequestRecord(
      details({
        requestId: "rbMulti",
        tabId: 53,
        method: "POST",
        requestBody: {
          raw: [
            { bytes: bytesOf("hello ") },
            { file: "/tmp/upload.bin" }, // file-upload part: no bytes, skipped
            { bytes: bytesOf("world") },
          ],
        },
      })
    );
    expect(bodyAfter("rbMulti", 53)).toBe("hello world");
  });

  it("captures nothing for a pure file upload (all parts lack bytes)", () => {
    setBodyCaptureEnabled(54, true);
    onBeforeRequestRecord(
      details({
        requestId: "rbFile",
        tabId: 54,
        method: "POST",
        requestBody: { raw: [{ file: "/tmp/a.png" }, { file: "/tmp/b.png" }] },
      })
    );
    expect(bodyAfter("rbFile", 54)).toBeUndefined();
  });

  // The tool is tab-scoped, so the flag must be too — a single module-wide flag
  // meant one includeBody:true call started retaining request bodies (and
  // attaching a filterResponseData stream filter to every response) for EVERY
  // tab in the browser.
  describe("body capture is per-tab", () => {
    function postOn(tabId: number, requestId: string) {
      onBeforeRequestRecord(
        details({
          requestId,
          tabId,
          method: "POST",
          requestBody: { formData: { field: ["value"] } },
        })
      );
    }

    it("enabling capture for one tab does not enable it for another", () => {
      setBodyCaptureEnabled(55, true);

      postOn(55, "mine");
      postOn(56, "theirs");

      expect(bodyAfter("mine", 55)).toBe(JSON.stringify({ field: ["value"] }));
      expect(bodyAfter("theirs", 56)).toBeUndefined();
    });

    it("disabling capture for one tab leaves other tabs enabled", () => {
      setBodyCaptureEnabled(57, true);
      setBodyCaptureEnabled(58, true);
      setBodyCaptureEnabled(57, false);

      postOn(57, "off");
      postOn(58, "on");

      expect(bodyAfter("off", 57)).toBeUndefined();
      expect(bodyAfter("on", 58)).toBe(JSON.stringify({ field: ["value"] }));
    });

    it("clears the flag when the tab is removed, so a recycled tabId starts clean", () => {
      setBodyCaptureEnabled(59, true);
      clearNetworkRequests(59); // the tabs.onRemoved path

      postOn(59, "recycled");

      expect(bodyAfter("recycled", 59)).toBeUndefined();
    });

    it("clearAllNetworkState resets every tab's flag", () => {
      setBodyCaptureEnabled(60, true);
      clearAllNetworkState();

      postOn(60, "after");

      expect(bodyAfter("after", 60)).toBeUndefined();
    });
  });
});

describe("in-flight map eviction (never-completing requests cannot leak)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAllNetworkState();
  });

  afterEach(() => {
    clearAllNetworkState();
  });

  it("bounds the in-flight map at its cap, evicting the oldest, as requests pile up uncompleted", () => {
    // Start far more requests than the 1000 in-flight cap and never complete
    // them, so the eviction path runs. We probe in-flight membership via
    // `onSendHeadersRecord`, which attaches its headers ONLY when the request is
    // still in-flight: the oldest started request must have been evicted (so no
    // probe header survives onto its later-synthesized record), while the most
    // recent one is still in-flight (so its probe header is retained).
    const CAP = 1000;
    const EXTRA = 50;
    const tabId = 70;

    for (let i = 0; i < CAP + EXTRA; i++) {
      onBeforeRequestRecord({
        requestId: `if${i}`,
        url: `https://x/${i}`,
        method: "GET",
        type: "xmlhttprequest",
        tabId,
        timeStamp: 1000 + i,
      });
    }

    // The oldest started request (if0) was evicted from in-flight, so
    // onSendHeaders for it is a no-op (its probe header is dropped), while a
    // recent one (the very last) is still in-flight and DOES get the header.
    onSendHeadersRecord({
      requestId: "if0",
      tabId,
      requestHeaders: [{ name: "X-Probe", value: "old" }],
    } as any);
    onSendHeadersRecord({
      requestId: `if${CAP + EXTRA - 1}`,
      tabId,
      requestHeaders: [{ name: "X-Probe", value: "new" }],
    } as any);

    onCompletedRecord({
      requestId: "if0",
      url: "https://x/0",
      method: "GET",
      type: "xmlhttprequest",
      tabId,
      statusCode: 200,
      timeStamp: 5000,
    } as any);
    onCompletedRecord({
      requestId: `if${CAP + EXTRA - 1}`,
      url: `https://x/${CAP + EXTRA - 1}`,
      method: "GET",
      type: "xmlhttprequest",
      tabId,
      statusCode: 200,
      timeStamp: 5001,
    } as any);

    const recs = getNetworkRequests(tabId);
    const old = recs.find((r) => r.requestId === "if0");
    const recent = recs.find((r) => r.requestId === `if${CAP + EXTRA - 1}`);

    // if0 was evicted from in-flight before completion: completion synthesized a
    // fresh record (tabId >= 0), so it has NO probe header attached.
    expect(old).toBeDefined();
    expect(old!.requestHeaders).toBeUndefined();
    // The most-recent request survived in-flight, so its probe header is present.
    expect(recent).toBeDefined();
    expect(recent!.requestHeaders).toEqual([{ name: "X-Probe", value: "new" }]);
  });
});

describe("clearing all state when Automation Mode turns OFF", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await unregisterNetworkListeners();
    jest.clearAllMocks();
    clearAllNetworkState();
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
  });

  afterEach(async () => {
    await unregisterNetworkListeners();
    clearAllNetworkState();
  });

  it("clearAllNetworkState drops finalized buffers and in-flight records across all tabs", () => {
    onBeforeRequestRecord(details({ requestId: "p1", tabId: 80 }));
    onCompletedRecord(details({ requestId: "p1", tabId: 80, statusCode: 200 }));
    onBeforeRequestRecord(details({ requestId: "p2", tabId: 81 })); // left in-flight
    expect(getNetworkRequests(80)).toHaveLength(1);

    clearAllNetworkState();

    expect(getNetworkRequests(80)).toEqual([]);
    expect(getNetworkRequests(81)).toEqual([]);
    // The in-flight p2 is gone too: completing it now synthesizes a fresh record
    // rather than finding a buffered in-flight one (proves in-flight was cleared).
    onSendHeadersRecord(
      details({ requestId: "p2", tabId: 81, requestHeaders: [{ name: "A", value: "1" }] })
    );
    onCompletedRecord(details({ requestId: "p2", tabId: 81, statusCode: 200 }));
    expect(getNetworkRequests(81)[0].requestHeaders).toBeUndefined();
  });

  it("toggling Automation Mode off via storage.onChanged clears the captured buffers", async () => {
    initNetworkCapture();
    const onChanged = lastListener(
      browser.storage.onChanged.addListener as jest.Mock
    );

    // Flip Automation Mode ON so the webRequest listeners are actually
    // registered (otherwise the OFF path's unregister is a no-op).
    onChanged(
      {
        config: {
          oldValue: { automationMode: false },
          newValue: { automationMode: true },
        },
      },
      "local"
    );
    await flushPromises();
    expect(browser.webRequest.onBeforeRequest.addListener).toHaveBeenCalledTimes(1);

    // Some captured activity from this (on) session.
    onBeforeRequestRecord(details({ requestId: "s1", tabId: 82 }));
    onCompletedRecord(details({ requestId: "s1", tabId: 82, statusCode: 200 }));
    expect(getNetworkRequests(82)).toHaveLength(1);

    // Flip Automation Mode OFF.
    onChanged(
      {
        config: {
          oldValue: { automationMode: true },
          newValue: { automationMode: false },
        },
      },
      "local"
    );
    await flushPromises();

    // Listeners unregistered AND the buffer cleared.
    expect(browser.webRequest.onBeforeRequest.removeListener).toHaveBeenCalledTimes(1);
    expect(getNetworkRequests(82)).toEqual([]);
  });
});
