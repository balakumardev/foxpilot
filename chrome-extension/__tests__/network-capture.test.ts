/**
 * Tests for the Chrome MV3 background network-capture module.
 *
 * NOTE on scope: the live `webRequest` event flow is browser-only (jsdom has no
 * `webRequest` engine). So these tests cover the parts that run as plain logic
 * in the service-worker's isolated world:
 *   - the pure updater functions (onBeforeRequest/onSendHeaders/
 *     onHeadersReceived/onCompleted/onErrorOccurred) driven with synthetic
 *     `details` objects through a full request lifecycle,
 *   - REQUEST-body capture (covert, via the onBeforeRequest `requestBody`
 *     extraInfoSpec) for both the `formData` and `raw` byte-part shapes,
 *   - the per-tab ring buffer (cap / isolation / clear-on-removal),
 *   - `getNetworkRequests` filtering (url substring + resourceType) and limit,
 *   - registration toggling as Automation Mode flips via `storage.onChanged`,
 *     including the extraInfoSpec wiring (requestBody + extraHeaders).
 *
 * Chrome MV3 cannot read RESPONSE bodies covertly (that needs chrome.debugger),
 * so there is no `filterResponseData`-style body test here (unlike Firefox).
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
  attachDebugger,
  detachDebugger,
  forceDetachDebugger,
  isDebuggerAttached,
  reconcileDebuggerAttachments,
  DEBUGGER_SESSION_KEY,
  ATTACH_JOIN_TIMEOUT_MS,
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

// Encode a string to a standalone ArrayBuffer (as Chrome hands us in
// `requestBody.raw[i].bytes`). `TextEncoder` is installed by the jest setup.
function bytesOf(text: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(text);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

describe("network-capture lifecycle (pure updaters)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Per-tab body capture is cleared by clearNetworkRequests below.
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
    // No body captured when body capture is disabled (the default here).
    expect(rec.requestBody).toBeUndefined();
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
        error: "net::ERR_CONNECTION_RESET",
        timeStamp: 1080,
      })
    );

    const recs = getNetworkRequests(11);
    expect(recs).toHaveLength(1);
    expect(recs[0].error).toBe("net::ERR_CONNECTION_RESET");
    expect(recs[0].durationMs).toBe(80);
    expect(recs[0].statusCode).toBeUndefined();
  });

  it("finalizes a completed request even if beforeRequest was missed", () => {
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
    expect(getNetworkRequests(-1)).toEqual([]);
  });
});

describe("request-body capture (covert, via onBeforeRequest requestBody)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAllNetworkState();
  });

  afterEach(() => {
    clearAllNetworkState();
  });

  it("does NOT capture a request body when body capture is disabled", () => {
    onBeforeRequestRecord(
      details({
        requestId: "nb",
        tabId: 50,
        method: "POST",
        requestBody: { formData: { username: ["alice"] } },
      })
    );
    onCompletedRecord(details({ requestId: "nb", tabId: 50, statusCode: 200 }));
    expect(getNetworkRequests(50)[0].requestBody).toBeUndefined();
  });

  it("serializes formData to JSON when body capture is enabled", () => {
    setBodyCaptureEnabled(51, true);
    const formData = { username: ["alice"], token: ["secret-value"] };
    onBeforeRequestRecord(
      details({
        requestId: "fd",
        tabId: 51,
        method: "POST",
        requestBody: { formData },
      })
    );
    onCompletedRecord(details({ requestId: "fd", tabId: 51, statusCode: 200 }));
    expect(getNetworkRequests(51)[0].requestBody).toBe(JSON.stringify(formData));
  });

  it("decodes raw byte parts as UTF-8 when body capture is enabled", () => {
    setBodyCaptureEnabled(52, true);
    const payload = '{"q":"hello world","n":42}';
    onBeforeRequestRecord(
      details({
        requestId: "raw",
        tabId: 52,
        method: "POST",
        requestBody: { raw: [{ bytes: bytesOf(payload) }] },
      })
    );
    onCompletedRecord(details({ requestId: "raw", tabId: 52, statusCode: 200 }));
    expect(getNetworkRequests(52)[0].requestBody).toBe(payload);
  });

  it("concatenates multiple raw byte parts in order", () => {
    setBodyCaptureEnabled(53, true);
    onBeforeRequestRecord(
      details({
        requestId: "raw2",
        tabId: 53,
        method: "POST",
        requestBody: {
          raw: [{ bytes: bytesOf("hello ") }, { bytes: bytesOf("world") }],
        },
      })
    );
    onCompletedRecord(details({ requestId: "raw2", tabId: 53, statusCode: 200 }));
    expect(getNetworkRequests(53)[0].requestBody).toBe("hello world");
  });

  it("prefers formData over raw when both are present", () => {
    setBodyCaptureEnabled(54, true);
    const formData = { a: ["1"] };
    onBeforeRequestRecord(
      details({
        requestId: "both",
        tabId: 54,
        method: "POST",
        requestBody: { formData, raw: [{ bytes: bytesOf("ignored") }] },
      })
    );
    onCompletedRecord(details({ requestId: "both", tabId: 54, statusCode: 200 }));
    expect(getNetworkRequests(54)[0].requestBody).toBe(JSON.stringify(formData));
  });

  it("skips raw parts without bytes (file uploads) and stores nothing when only files", () => {
    setBodyCaptureEnabled(55, true);
    onBeforeRequestRecord(
      details({
        requestId: "file",
        tabId: 55,
        method: "POST",
        requestBody: { raw: [{ file: "blob:https://x/abc-123" }] },
      })
    );
    onCompletedRecord(details({ requestId: "file", tabId: 55, statusCode: 200 }));
    expect(getNetworkRequests(55)[0].requestBody).toBeUndefined();
  });

  it("caps the stored request body at ~64KB", () => {
    setBodyCaptureEnabled(56, true);
    const CAP = 64 * 1024;
    // Two 50KB ASCII parts => 100KB total, over the cap.
    const part = "a".repeat(50 * 1024);
    onBeforeRequestRecord(
      details({
        requestId: "big",
        tabId: 56,
        method: "POST",
        requestBody: { raw: [{ bytes: bytesOf(part) }, { bytes: bytesOf(part) }] },
      })
    );
    onCompletedRecord(details({ requestId: "big", tabId: 56, statusCode: 200 }));
    // ASCII => 1 byte == 1 char; the stored snippet is clamped to CAP.
    expect(getNetworkRequests(56)[0].requestBody!.length).toBe(CAP);
  });

  it("captures nothing (no throw) for an absent/empty requestBody", () => {
    setBodyCaptureEnabled(57, true);
    onBeforeRequestRecord(details({ requestId: "empty", tabId: 57, method: "POST" }));
    onCompletedRecord(details({ requestId: "empty", tabId: 57, statusCode: 200 }));
    expect(getNetworkRequests(57)[0].requestBody).toBeUndefined();
  });
});

describe("request-body capture is per-tab (includeBody must not leak across tabs)", () => {
  const T = [58, 59, 60];

  function postOn(tabId: number, requestId: string) {
    onBeforeRequestRecord(
      details({
        requestId,
        tabId,
        method: "POST",
        requestBody: { formData: { field: ["value"] } },
      })
    );
    onCompletedRecord(details({ requestId, tabId, statusCode: 200 }));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    clearAllNetworkState();
  });

  afterEach(() => {
    clearAllNetworkState();
  });

  // The tool is tab-scoped, so the flag must be too — a single module-wide flag
  // meant one includeBody:true call started retaining request bodies (form
  // fields, JSON payloads, tokens) for EVERY tab in the browser.
  it("enabling capture for one tab does not enable it for another", () => {
    setBodyCaptureEnabled(58, true);

    postOn(58, "mine");
    postOn(59, "theirs");

    expect(getNetworkRequests(58)[0].requestBody).toBe(
      JSON.stringify({ field: ["value"] })
    );
    expect(getNetworkRequests(59)[0].requestBody).toBeUndefined();
  });

  it("disabling capture for one tab leaves other tabs enabled", () => {
    setBodyCaptureEnabled(58, true);
    setBodyCaptureEnabled(59, true);
    setBodyCaptureEnabled(58, false);

    postOn(58, "off");
    postOn(59, "on");

    expect(getNetworkRequests(58)[0].requestBody).toBeUndefined();
    expect(getNetworkRequests(59)[0].requestBody).toBe(
      JSON.stringify({ field: ["value"] })
    );
  });

  it("clears the flag when the tab is removed, so a recycled tabId starts clean", () => {
    setBodyCaptureEnabled(60, true);
    clearNetworkRequests(60); // the tabs.onRemoved path

    postOn(60, "recycled");

    expect(getNetworkRequests(60)[0].requestBody).toBeUndefined();
  });

  it("clearAllNetworkState resets every tab's flag", () => {
    T.forEach((t) => setBodyCaptureEnabled(t, true));
    clearAllNetworkState();

    T.forEach((t) => postOn(t, `after-${t}`));

    T.forEach((t) =>
      expect(getNetworkRequests(t)[0].requestBody).toBeUndefined()
    );
  });

  it("never body-captures a request with no tab (tabId < 0)", () => {
    setBodyCaptureEnabled(-1, true);
    onBeforeRequestRecord(
      details({
        requestId: "notab",
        tabId: -1,
        method: "POST",
        requestBody: { formData: { field: ["value"] } },
      })
    );
    expect(getNetworkRequests(-1)).toEqual([]);
  });
});

describe("getNetworkRequests filtering and limit", () => {
  beforeEach(() => {
    setBodyCaptureEnabled(20, false);
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

  it("registers the webRequest listeners with the right extraInfoSpecs when Automation Mode is already on", async () => {
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

    // onBeforeRequest must request the requestBody extraInfoSpec (covert request
    // bodies), on all URLs.
    const beforeArgs = (browser.webRequest.onBeforeRequest.addListener as jest.Mock)
      .mock.calls[0];
    expect(beforeArgs[1]).toEqual({ urls: ["<all_urls>"] });
    expect(beforeArgs[2]).toEqual(["requestBody"]);

    // Header events must include "extraHeaders" so Chrome surfaces
    // Cookie/Set-Cookie/Authorization (omitted from the default header lists).
    const sendArgs = (browser.webRequest.onSendHeaders.addListener as jest.Mock)
      .mock.calls[0];
    expect(sendArgs[2]).toEqual(["requestHeaders", "extraHeaders"]);
    const recvArgs = (browser.webRequest.onHeadersReceived.addListener as jest.Mock)
      .mock.calls[0];
    expect(recvArgs[2]).toEqual(["responseHeaders", "extraHeaders"]);
    const completedArgs = (browser.webRequest.onCompleted.addListener as jest.Mock)
      .mock.calls[0];
    expect(completedArgs[2]).toEqual(["responseHeaders", "extraHeaders"]);
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

describe("in-flight map eviction (never-completing requests cannot leak)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAllNetworkState();
  });

  afterEach(() => {
    clearAllNetworkState();
  });

  it("bounds the in-flight map at its cap, evicting the oldest, as requests pile up uncompleted", () => {
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

    expect(old).toBeDefined();
    expect(old!.requestHeaders).toBeUndefined();
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

    onBeforeRequestRecord(details({ requestId: "s1", tabId: 82 }));
    onCompletedRecord(details({ requestId: "s1", tabId: 82, statusCode: 200 }));
    expect(getNetworkRequests(82)).toHaveLength(1);

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

    expect(browser.webRequest.onBeforeRequest.removeListener).toHaveBeenCalledTimes(1);
    expect(getNetworkRequests(82)).toEqual([]);
  });
});

describe("chrome.debugger (CDP) deep-capture path", () => {
  let dbg: any;
  // The module registers its onEvent/onDetach listeners exactly once (guarded by
  // a module flag), so capture them on the first attach in beforeAll — later
  // clearAllMocks() calls wipe the mock's call log but not these references.
  let onEvent: (source: any, method: string, params: any) => any;
  let onDetach: (source: any, reason: string) => void;

  const TABS = [999, 900, 901, 902, 903, 904, 905, 906, 907];

  beforeAll(async () => {
    dbg = (chrome as any).debugger;
    await attachDebugger(999);
    onEvent = lastListener(dbg.onEvent.addListener as jest.Mock);
    onDetach = lastListener(dbg.onDetach.addListener as jest.Mock);
    await detachDebugger(999);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    clearAllNetworkState();
    // Re-establish deterministic defaults (clearAllMocks keeps implementations,
    // so reset sendCommand to shed any per-test getResponseBody stub).
    dbg.attach.mockResolvedValue(undefined);
    dbg.detach.mockResolvedValue(undefined);
    dbg.sendCommand.mockReset();
    dbg.sendCommand.mockResolvedValue({});
  });

  afterEach(async () => {
    // Never leave a tab attached — it would suppress the covert path in later
    // suites via the dedup guard. detachDebugger is idempotent.
    for (const t of TABS) {
      await detachDebugger(t);
    }
    clearAllNetworkState();
  });

  it("attaches, enables the Network domain, and reports the tab attached", async () => {
    expect(isDebuggerAttached(900)).toBe(false);
    await attachDebugger(900);
    expect(isDebuggerAttached(900)).toBe(true);
    expect(dbg.attach).toHaveBeenCalledWith({ tabId: 900 }, "1.3");
    expect(dbg.sendCommand).toHaveBeenCalledWith({ tabId: 900 }, "Network.enable");
  });

  it("detaches and clears the attached flag", async () => {
    await attachDebugger(901);
    expect(isDebuggerAttached(901)).toBe(true);
    await detachDebugger(901);
    expect(isDebuggerAttached(901)).toBe(false);
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 901 });
  });

  it("captures headers, request body, response headers, and body from CDP events", async () => {
    await attachDebugger(902);
    dbg.sendCommand.mockImplementation((_t: any, method: string) =>
      method === "Network.getResponseBody"
        ? Promise.resolve({ body: '{"ok":true}', base64Encoded: false })
        : Promise.resolve({})
    );
    const src = { tabId: 902 };
    await onEvent(src, "Network.requestWillBeSent", {
      requestId: "cdp-1",
      type: "XHR",
      timestamp: 2,
      request: {
        url: "https://example.com/api",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer x",
        },
        postData: '{"q":"hi"}',
      },
    });
    await onEvent(src, "Network.responseReceived", {
      requestId: "cdp-1",
      response: {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": "a=b" },
        encodedDataLength: 321,
      },
    });
    await onEvent(src, "Network.loadingFinished", { requestId: "cdp-1" });

    const recs = getNetworkRequests(902);
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    expect(rec.requestId).toBe("cdp-1");
    expect(rec.url).toBe("https://example.com/api");
    expect(rec.method).toBe("POST");
    expect(rec.type).toBe("XHR");
    expect(rec.statusCode).toBe(200);
    expect(rec.responseSize).toBe(321);
    expect(rec.requestHeaders).toEqual(
      expect.arrayContaining([
        { name: "Content-Type", value: "application/json" },
        { name: "Authorization", value: "Bearer x" },
      ])
    );
    // CDP response headers include Set-Cookie (unlike Chrome's default lists).
    expect(rec.responseHeaders).toEqual(
      expect.arrayContaining([{ name: "Set-Cookie", value: "a=b" }])
    );
    expect(rec.requestBody).toBe('{"q":"hi"}');
    expect(rec.body).toBe('{"ok":true}');
  });

  it("marks a base64-encoded response body with a [base64] prefix", async () => {
    await attachDebugger(903);
    dbg.sendCommand.mockImplementation((_t: any, method: string) =>
      method === "Network.getResponseBody"
        ? Promise.resolve({ body: "AAAA", base64Encoded: true })
        : Promise.resolve({})
    );
    const src = { tabId: 903 };
    await onEvent(src, "Network.requestWillBeSent", {
      requestId: "b64",
      type: "Image",
      timestamp: 1,
      request: { url: "https://x/i.png", method: "GET", headers: {} },
    });
    await onEvent(src, "Network.loadingFinished", { requestId: "b64" });
    expect(getNetworkRequests(903)[0].body).toBe("[base64] AAAA");
  });

  it("still records the request when getResponseBody throws (e.g. redirects)", async () => {
    await attachDebugger(904);
    dbg.sendCommand.mockImplementation((_t: any, method: string) =>
      method === "Network.getResponseBody"
        ? Promise.reject(new Error("No resource with given identifier found"))
        : Promise.resolve({})
    );
    const src = { tabId: 904 };
    await onEvent(src, "Network.requestWillBeSent", {
      requestId: "nb",
      type: "Document",
      timestamp: 1,
      request: { url: "https://x/", method: "GET", headers: {} },
    });
    await onEvent(src, "Network.loadingFinished", { requestId: "nb" });
    const recs = getNetworkRequests(904);
    expect(recs).toHaveLength(1);
    expect(recs[0].body).toBeUndefined();
  });

  it("records a loadingFailed event with the error text", async () => {
    await attachDebugger(905);
    const src = { tabId: 905 };
    await onEvent(src, "Network.requestWillBeSent", {
      requestId: "f1",
      type: "XHR",
      timestamp: 1,
      request: { url: "https://x/f", method: "GET", headers: {} },
    });
    await onEvent(src, "Network.loadingFailed", {
      requestId: "f1",
      errorText: "net::ERR_FAILED",
    });
    const recs = getNetworkRequests(905);
    expect(recs).toHaveLength(1);
    expect(recs[0].error).toBe("net::ERR_FAILED");
  });

  it("skips the covert webRequest path for a debugger-owned tab (no double-record)", async () => {
    await attachDebugger(906);
    // Both the create path and the completed/synthesize path must be suppressed.
    onBeforeRequestRecord(details({ requestId: "wr", tabId: 906 }));
    onCompletedRecord(details({ requestId: "wr", tabId: 906, statusCode: 200 }));
    expect(getNetworkRequests(906)).toEqual([]);
  });

  it("clears the attached flag when the debugger detaches externally (banner dismissed)", async () => {
    await attachDebugger(907);
    expect(isDebuggerAttached(907)).toBe(true);
    onDetach({ tabId: 907 }, "target_closed");
    expect(isDebuggerAttached(907)).toBe(false);
  });
});

describe("debugger attach purpose-refcounting (Phase 3)", () => {
  let dbg: any;
  const T = [910, 911, 912, 913];

  beforeEach(() => {
    dbg = (chrome as any).debugger;
    jest.clearAllMocks();
    clearAllNetworkState();
    dbg.attach.mockReset().mockResolvedValue(undefined);
    dbg.detach.mockReset().mockResolvedValue(undefined);
    dbg.sendCommand.mockReset().mockResolvedValue({});
  });

  afterEach(async () => {
    const { forceDetachDebugger } = require("../network-capture");
    for (const t of T) await forceDetachDebugger(t);
    clearAllNetworkState();
  });

  it("an input-purpose attach does NOT enable the Network domain and is not 'network attached'", async () => {
    await attachDebugger(910, "input");
    expect(dbg.attach).toHaveBeenCalledWith({ tabId: 910 }, "1.3");
    expect(dbg.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 910 },
      "Network.enable"
    );
    expect(isDebuggerAttached(910)).toBe(false); // network purpose absent
  });

  it("an input-only attach does NOT suppress the covert webRequest path", async () => {
    await attachDebugger(911, "input");
    onBeforeRequestRecord(details({ requestId: "wr2", tabId: 911 }));
    onCompletedRecord(details({ requestId: "wr2", tabId: 911, statusCode: 200 }));
    expect(getNetworkRequests(911)).toHaveLength(1);
  });

  it("two purposes on one tab attach ONCE and detach only after both release", async () => {
    await attachDebugger(912, "network");
    await attachDebugger(912, "input");
    expect(dbg.attach).toHaveBeenCalledTimes(1);
    await detachDebugger(912, "input");
    expect(dbg.detach).not.toHaveBeenCalled();
    expect(isDebuggerAttached(912)).toBe(true);
    await detachDebugger(912, "network");
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 912 });
    expect(isDebuggerAttached(912)).toBe(false);
  });

  it("runs Network.enable exactly once even if the network purpose is added twice", async () => {
    await attachDebugger(913, "network");
    await attachDebugger(913, "network");
    const enables = (dbg.sendCommand as jest.Mock).mock.calls.filter(
      (c: any[]) => c[1] === "Network.enable"
    );
    expect(enables).toHaveLength(1);
    expect(dbg.attach).toHaveBeenCalledTimes(1);
  });

  it("forceDetachDebugger tears down every purpose at once", async () => {
    await attachDebugger(910, "network");
    await attachDebugger(910, "input");
    const { forceDetachDebugger } = require("../network-capture");
    await forceDetachDebugger(910);
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 910 });
    expect(isDebuggerAttached(910)).toBe(false);
  });
});

// Did anything ever call dbg.detach for this tab?
function detachedTab(dbg: any, tabId: number): boolean {
  return (dbg.detach as jest.Mock).mock.calls.some(
    (c: any[]) => c[0]?.tabId === tabId
  );
}

describe("debugger attach failure + concurrency (lifecycle leak regressions)", () => {
  let dbg: any;
  const T = [920, 921, 922, 923, 924];

  beforeEach(() => {
    dbg = (chrome as any).debugger;
    jest.clearAllMocks();
    clearAllNetworkState();
    dbg.attach.mockReset().mockResolvedValue(undefined);
    dbg.detach.mockReset().mockResolvedValue(undefined);
    dbg.sendCommand.mockReset().mockResolvedValue({});
  });

  afterEach(async () => {
    dbg.attach.mockReset().mockResolvedValue(undefined);
    dbg.detach.mockReset().mockResolvedValue(undefined);
    dbg.sendCommand.mockReset().mockResolvedValue({});
    for (const t of T) await forceDetachDebugger(t);
    clearAllNetworkState();
  });

  // BUG A — dbg.attach succeeds, Network.enable rejects. The debugger really IS
  // attached at that point, so the bookkeeping must never end up claiming
  // otherwise: the attach has to be rolled back so the thrown error matches
  // reality (and the banner goes away).
  it("rolls the attach back when Network.enable rejects", async () => {
    dbg.sendCommand.mockRejectedValue(new Error("Network.enable failed"));

    await expect(attachDebugger(920, "network")).rejects.toThrow(
      "Network.enable failed"
    );

    expect(dbg.attach).toHaveBeenCalledWith({ tabId: 920 }, "1.3");
    expect(detachedTab(dbg, 920)).toBe(true);
  });

  // BUG A — the leak itself, stated as the invariant that matters: after a failed
  // Network.enable the tab must not be strandable. Storing an EMPTY purpose Set
  // makes detachDebugger (needs the purpose) AND forceDetachDebugger (needs
  // size > 0) both short-circuit, so nothing can ever detach it again.
  it("never strands a tab attached-but-undetachable after a failed Network.enable", async () => {
    dbg.sendCommand.mockRejectedValue(new Error("Network.enable failed"));
    await expect(attachDebugger(921, "network")).rejects.toThrow();

    const rolledBack = detachedTab(dbg, 921);
    dbg.detach.mockClear();
    await forceDetachDebugger(921);
    const reachableByForce = detachedTab(dbg, 921);

    expect(rolledBack || reachableByForce).toBe(true);
  });

  // BUG A (race) — while the first attach is in flight the tracked state must
  // already claim the tab, otherwise a second purpose sees "size === 0" and
  // issues a SECOND dbg.attach on an already-attached tab.
  it("issues exactly ONE dbg.attach when two purposes race on the same tab", async () => {
    let release: () => void = () => {};
    dbg.attach.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        })
    );

    const first = attachDebugger(922, "network");
    const second = attachDebugger(922, "input");
    release();
    await Promise.all([first, second]);

    expect(dbg.attach).toHaveBeenCalledTimes(1);
  });

  // BUG A guard — the rollback must not over-detach: an existing holder keeps the
  // debugger when a LATER network purpose fails to enable.
  it("keeps an existing holder attached when a later network purpose fails to enable", async () => {
    await attachDebugger(923, "input");
    dbg.sendCommand.mockRejectedValue(new Error("Network.enable failed"));

    await expect(attachDebugger(923, "network")).rejects.toThrow();

    expect(detachedTab(dbg, 923)).toBe(false);
    expect(isDebuggerAttached(923)).toBe(false); // network purpose never took hold
  });

  // BUG A guard — a failed dbg.attach attached nothing, so nothing must be
  // detached and no tracked state may survive.
  it("leaves no tracked state when dbg.attach itself rejects", async () => {
    dbg.attach.mockRejectedValue(new Error("Another debugger is already attached"));

    await expect(attachDebugger(924, "network")).rejects.toThrow();

    expect(detachedTab(dbg, 924)).toBe(false);
    expect(isDebuggerAttached(924)).toBe(false);
  });
});

describe("teardown that races an in-flight attach", () => {
  let dbg: any;
  const T = [950, 951, 952, 953, 954, 955];

  // Hold dbg.attach open so the tab sits in the "attach dispatched, not yet
  // resolved" window — where it is in neither attachedTabs nor attachedPurposes.
  function stallAttach(): () => void {
    let release: () => void = () => {};
    dbg.attach.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        })
    );
    return () => release();
  }

  beforeEach(() => {
    dbg = (chrome as any).debugger;
    jest.clearAllMocks();
    clearAllNetworkState();
    dbg.attach.mockReset().mockResolvedValue(undefined);
    dbg.detach.mockReset().mockResolvedValue(undefined);
    dbg.sendCommand.mockReset().mockResolvedValue({});
    (browser as any).storage.session.get.mockReset().mockResolvedValue({});
    (browser as any).storage.session.set.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    // Restore real timers unconditionally: a test that times out inside the
    // fake-timer block never reaches its own `finally`, and leaked fake timers
    // would silently hang every later setTimeout-based flush in this file.
    jest.useRealTimers();
    dbg.attach.mockReset().mockResolvedValue(undefined);
    dbg.detach.mockReset().mockResolvedValue(undefined);
    for (const t of T) await forceDetachDebugger(t);
    clearAllNetworkState();
  });

  // F1 — forceDetachDebugger cannot see an attach that has not resolved yet, so
  // the tab is left attached (banner up) after teardown and nothing releases it
  // until the next service-worker boot.
  it("detaches a tab whose attach was still in flight when forceDetachDebugger ran", async () => {
    const release = stallAttach();

    const attaching = attachDebugger(950, "network");
    await forceDetachDebugger(950); // teardown lands mid-attach

    release();
    await attaching.catch(() => {});
    await flushPromises();

    expect(detachedTab(dbg, 950)).toBe(true);
    expect(isDebuggerAttached(950)).toBe(false);
  });

  // F1 — the attach's own caller must be told it no longer holds the tab, rather
  // than being handed a "successful" attach on a tab that was just detached.
  it("fails the in-flight attach that a teardown cancelled", async () => {
    const release = stallAttach();

    const attaching = attachDebugger(951, "network");
    await forceDetachDebugger(951);

    release();
    await expect(attaching).rejects.toThrow(/torn down/i);
    expect(isDebuggerAttached(951)).toBe(false);
  });

  // F1 — the Automation-Mode-off sweep builds its tab list from
  // attachedPurposes + attachedTabs, so an in-flight attach is invisible to it.
  it("releases an in-flight attach when Automation Mode is turned off", async () => {
    const release = stallAttach();
    initNetworkCapture();
    const onChanged = lastListener(
      browser.storage.onChanged.addListener as jest.Mock
    );

    const attaching = attachDebugger(952, "network");
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

    release();
    await attaching.catch(() => {});
    await flushPromises();

    expect(detachedTab(dbg, 952)).toBe(true);
  });

  // N1 — the already-attached FAST PATH skips the whole attach block, so it used
  // to ignore the teardown marker entirely. Window: the attach has already done
  // `attachedTabs.add` and is suspended in `persistAttachedTabs`, a teardown has
  // marked the tab and started detaching, and `attachedTabs.delete` has not
  // landed yet. A second attachDebugger then registers a purpose and returns
  // SUCCESS on a tab that is about to be detached — leaving a stale
  // attachedPurposes entry whose "network" member makes hasNetworkPurpose
  // suppress the covert webRequest path forever while nothing is capturing.
  it("refuses the fast path while a teardown is already marked for the tab", async () => {
    // Collect EVERY pending persist resolver — the teardown's own detach also
    // persists, and overwriting a single resolver would orphan the attach's.
    const persistResolvers: Array<() => void> = [];
    (browser as any).storage.session.set.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          persistResolvers.push(() => resolve());
        })
    );

    const first = attachDebugger(954, "network");
    await flushPromises(); // dbg.attach resolved; now suspended in the persist

    const teardown = forceDetachDebugger(954); // marks + starts detaching
    // Fast path: attachedTabs still has 954 because the detach has not landed.
    await expect(attachDebugger(954, "network")).rejects.toThrow(/torn down/i);

    persistResolvers.forEach((release) => release());
    (browser as any).storage.session.set.mockResolvedValue(undefined);
    await teardown;
    await first.catch(() => {});
    await flushPromises();

    // The payload: no stale purpose left claiming a capture that isn't running.
    expect(isDebuggerAttached(954)).toBe(false);
  });

  // N1 (same room, other door) — a detach can also be in flight WITHOUT any
  // in-flight attach, so there is no marker to consult. `attachedTabs` still
  // holds the tab until `dbg.detach` resolves, so the fast path would register a
  // purpose that outlives the detach.
  it("refuses the fast path while a detach is already in flight for the tab", async () => {
    await attachDebugger(955, "network");
    let releaseDetach: () => void = () => {};
    dbg.detach.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDetach = () => resolve();
        })
    );

    const teardown = forceDetachDebugger(955); // suspended inside dbg.detach
    await expect(attachDebugger(955, "input")).rejects.toThrow(/torn down/i);

    releaseDetach();
    await teardown;

    expect(isDebuggerAttached(955)).toBe(false);
    // And nothing was left holding the tab after the teardown finished.
    await forceDetachDebugger(955);
    expect(isDebuggerAttached(955)).toBe(false);
  });

  // F4 — joining an in-flight attach must not let a dbg.attach that never
  // settles wedge every later caller on that tab for the life of the worker.
  it("gives up on a join of an attach that never settles, without issuing a second attach", async () => {
    jest.useFakeTimers();
    try {
      stallAttach(); // never released

      const first = attachDebugger(953, "network");
      const second = attachDebugger(953, "input");
      const firstSettled = first.then(
        () => "ok",
        () => "failed"
      );
      const secondSettled = second.then(
        () => "ok",
        () => "failed"
      );

      await jest.advanceTimersByTimeAsync(ATTACH_JOIN_TIMEOUT_MS + 100);

      await expect(firstSettled).resolves.toBe("failed");
      await expect(secondSettled).resolves.toBe("failed");
      // Crucially: NO duplicate dbg.attach. Retrying the attach would create the
      // untracked second attachment this whole module exists to prevent.
      expect(dbg.attach).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("detach failure bookkeeping (a rejected detach must not lose the tab)", () => {
  let dbg: any;
  const T = [930, 931, 932];

  beforeEach(() => {
    dbg = (chrome as any).debugger;
    jest.clearAllMocks();
    clearAllNetworkState();
    dbg.attach.mockReset().mockResolvedValue(undefined);
    dbg.detach.mockReset().mockResolvedValue(undefined);
    dbg.sendCommand.mockReset().mockResolvedValue({});
  });

  afterEach(async () => {
    dbg.detach.mockReset().mockResolvedValue(undefined);
    for (const t of T) await forceDetachDebugger(t);
    clearAllNetworkState();
  });

  // BUG D — the map entry is deleted BEFORE the detach is awaited, so a rejected
  // detach leaves the tab really attached and completely untracked.
  it("keeps a tab tracked when detach fails for a reason other than the target being gone", async () => {
    await attachDebugger(930, "network");
    dbg.detach.mockRejectedValueOnce(new Error("Detach failed: internal error"));

    await detachDebugger(930, "network");

    // Still attached in reality -> a retry must still be able to reach it.
    dbg.detach.mockReset().mockResolvedValue(undefined);
    await forceDetachDebugger(930);
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 930 });
  });

  // NON-REGRESSION GUARD (not a red — the unfixed code also dropped the entry,
  // it just dropped it unconditionally). This pins the OTHER half of the
  // classification introduced for Bug D: a target-gone rejection must keep
  // behaving as before and NOT start retrying forever. The half that genuinely
  // fails on unfixed code is the "keeps a tab tracked when detach fails for a
  // reason other than the target being gone" test above; together they pin the
  // distinction.
  it("guard: still forgets a tab when detach fails because the target is already gone", async () => {
    await attachDebugger(931, "network");
    dbg.detach.mockRejectedValueOnce(
      new Error("No target with given id found: 931")
    );

    await detachDebugger(931, "network");

    dbg.detach.mockReset().mockResolvedValue(undefined);
    await forceDetachDebugger(931);
    expect(dbg.detach).not.toHaveBeenCalled();
  });

  // BUG D — same hole on the force path (entry deleted before the await).
  it("keeps a tab tracked when forceDetachDebugger's detach genuinely fails", async () => {
    await attachDebugger(932, "network");
    dbg.detach.mockRejectedValueOnce(new Error("Detach failed: internal error"));

    await forceDetachDebugger(932);

    dbg.detach.mockReset().mockResolvedValue(undefined);
    await forceDetachDebugger(932);
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 932 });
  });
});

describe("boot reconciliation of debugger attachments (MV3 service-worker eviction)", () => {
  let dbg: any;
  let session: any;
  const T = [940, 941, 942, 943, 944, 945];

  beforeEach(() => {
    dbg = (chrome as any).debugger;
    session = (browser as any).storage.session;
    jest.clearAllMocks();
    clearAllNetworkState();
    dbg.attach.mockReset().mockResolvedValue(undefined);
    dbg.detach.mockReset().mockResolvedValue(undefined);
    dbg.sendCommand.mockReset().mockResolvedValue({});
    session.get.mockReset().mockResolvedValue({});
    session.set.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    dbg.detach.mockReset().mockResolvedValue(undefined);
    for (const t of T) await forceDetachDebugger(t);
    clearAllNetworkState();
  });

  // BUG C — `attachedPurposes` is in-memory only. If the tabIds are not mirrored
  // somewhere that outlives the service worker, an eviction loses them while the
  // attachments survive, and nothing can ever detach them.
  it("records attached tabs in chrome.storage.session so a later generation can find them", async () => {
    await attachDebugger(940, "network");

    expect(session.set).toHaveBeenCalledWith({
      [DEBUGGER_SESSION_KEY]: expect.arrayContaining([940]),
    });
  });

  it("drops a tab from chrome.storage.session once it is detached", async () => {
    await attachDebugger(945, "network");
    session.set.mockClear();
    await detachDebugger(945, "network");

    expect(session.set).toHaveBeenCalledWith({
      [DEBUGGER_SESSION_KEY]: expect.not.arrayContaining([945]),
    });
  });

  it("detaches attachments recorded by a prior service-worker generation", async () => {
    session.get.mockResolvedValue({ [DEBUGGER_SESSION_KEY]: [941, 942] });

    await reconcileDebuggerAttachments();

    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 941 });
    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 942 });
  });

  // DESIGN-INTENT TRIPWIRE — NOT coverage. `getTargets` is not called anywhere in
  // the implementation today, so this assertion cannot fail against the current
  // code; it exists to fail LATER if someone "improves" the sweep by enumerating
  // targets. That would be wrong: getTargets() reports `attached: true` without
  // saying WHO attached, so acting on it would tear down the user's own DevTools
  // sessions. The real coverage for the sweep is the orphan/current-generation
  // tests around it.
  it("tripwire: the sweep must never start enumerating chrome.debugger.getTargets", async () => {
    const getTargets = jest
      .fn()
      .mockResolvedValue([{ tabId: 99, attached: true }]);
    dbg.getTargets = getTargets;
    session.get.mockResolvedValue({ [DEBUGGER_SESSION_KEY]: [941] });

    await reconcileDebuggerAttachments();

    expect(getTargets).not.toHaveBeenCalled();
    delete dbg.getTargets;
  });

  // F3 — the orphan list is computed once, then walked sequentially with awaits
  // in between. An attach that completes mid-sweep gets torn down when the loop
  // reaches it, and Chrome does NOT fire onDetach for our own detach(), so the
  // bookkeeping never self-heals: attachedTabs/attachedPurposes keep claiming
  // the tab, hasNetworkPurpose suppresses the covert webRequest path, and the
  // tab silently captures nothing while the tool reported ok:true.
  it("does not tear down a tab attached by the current generation mid-sweep", async () => {
    session.get.mockResolvedValue({ [DEBUGGER_SESSION_KEY]: [946, 947] });
    dbg.detach.mockImplementation(async (target: { tabId: number }) => {
      // Attach 947 while the sweep is between iterations.
      if (target.tabId === 946) {
        await attachDebugger(947, "network");
      }
    });

    await reconcileDebuggerAttachments();

    const detached947 = (dbg.detach as jest.Mock).mock.calls.filter(
      (c: any[]) => c[0]?.tabId === 947
    );
    expect(detached947).toHaveLength(0);
    expect(isDebuggerAttached(947)).toBe(true);
  });

  it("leaves an attachment held by the CURRENT generation alone", async () => {
    await attachDebugger(943, "network");
    session.get.mockResolvedValue({ [DEBUGGER_SESSION_KEY]: [943] });
    dbg.detach.mockClear();

    await reconcileDebuggerAttachments();

    expect(dbg.detach).not.toHaveBeenCalled();
    expect(isDebuggerAttached(943)).toBe(true);
  });

  it("survives a storage.session read failure without throwing", async () => {
    session.get.mockRejectedValue(new Error("session storage unavailable"));
    await expect(reconcileDebuggerAttachments()).resolves.toBeUndefined();
  });

  it("initNetworkCapture runs the reconcile sweep at startup", async () => {
    session.get.mockResolvedValue({ [DEBUGGER_SESSION_KEY]: [944] });

    initNetworkCapture();
    await flushPromises();

    expect(dbg.detach).toHaveBeenCalledWith({ tabId: 944 });
  });
});
