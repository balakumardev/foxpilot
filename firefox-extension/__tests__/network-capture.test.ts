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

  it("setBodyCaptureEnabled toggles a module flag without throwing", () => {
    expect(() => setBodyCaptureEnabled(true)).not.toThrow();
    expect(() => setBodyCaptureEnabled(false)).not.toThrow();
  });
});
