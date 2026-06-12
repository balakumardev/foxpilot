import {
  rewriteUserAgentHeader,
  setTabUserAgent,
  clearTabUserAgent,
  getTabUserAgent,
  __getUserAgentMap,
} from "../emulate";
import type { NetworkHeader } from "@browser-control-mcp/common";

/**
 * These tests exercise the PURE `rewriteUserAgentHeader` rewriter and the
 * per-tab User-Agent map. The live `webRequest.onBeforeSendHeaders` registration
 * and the actual header rewrite on the wire are browser-only; here we drive the
 * pure function with synthetic `details` and a map, which is exactly what the
 * blocking listener does at request time.
 */
describe("emulate user-agent map", () => {
  afterEach(() => {
    // Clear any UA overrides set during a test so they don't leak.
    clearTabUserAgent(1);
    clearTabUserAgent(2);
    clearTabUserAgent(3);
  });

  it("set/get/clear a tab's user agent", () => {
    expect(getTabUserAgent(1)).toBeUndefined();
    setTabUserAgent(1, "UA/1.0");
    expect(getTabUserAgent(1)).toBe("UA/1.0");
    clearTabUserAgent(1);
    expect(getTabUserAgent(1)).toBeUndefined();
  });
});

describe("rewriteUserAgentHeader", () => {
  function detailsFor(
    tabId: number,
    requestHeaders: NetworkHeader[]
  ): { tabId: number; requestHeaders: NetworkHeader[] } {
    return { tabId, requestHeaders };
  }

  it("replaces an existing User-Agent header for a tab in the map", () => {
    const map = new Map<number, string>([[5, "Custom/9.9"]]);
    const details = detailsFor(5, [
      { name: "Accept", value: "*/*" },
      { name: "User-Agent", value: "Mozilla/5.0 (original)" },
    ]);

    const result = rewriteUserAgentHeader(details, map);

    expect(result).toBeDefined();
    const ua = result!.requestHeaders.find(
      (h) => h.name.toLowerCase() === "user-agent"
    );
    expect(ua?.value).toBe("Custom/9.9");
    // The replacement is in place — there is exactly one User-Agent header still.
    const uaCount = result!.requestHeaders.filter(
      (h) => h.name.toLowerCase() === "user-agent"
    ).length;
    expect(uaCount).toBe(1);
    // Other headers are preserved.
    expect(
      result!.requestHeaders.find((h) => h.name === "Accept")?.value
    ).toBe("*/*");
  });

  it("matches the User-Agent header case-insensitively when replacing", () => {
    const map = new Map<number, string>([[5, "Custom/9.9"]]);
    const details = detailsFor(5, [{ name: "user-agent", value: "old" }]);

    const result = rewriteUserAgentHeader(details, map);

    expect(result).toBeDefined();
    const uaCount = result!.requestHeaders.filter(
      (h) => h.name.toLowerCase() === "user-agent"
    ).length;
    expect(uaCount).toBe(1);
    expect(result!.requestHeaders[0].value).toBe("Custom/9.9");
  });

  it("appends a User-Agent header when one is absent for a tab in the map", () => {
    const map = new Map<number, string>([[5, "Custom/9.9"]]);
    const details = detailsFor(5, [{ name: "Accept", value: "*/*" }]);

    const result = rewriteUserAgentHeader(details, map);

    expect(result).toBeDefined();
    const ua = result!.requestHeaders.find(
      (h) => h.name.toLowerCase() === "user-agent"
    );
    expect(ua?.value).toBe("Custom/9.9");
    expect(result!.requestHeaders).toHaveLength(2);
  });

  it("returns undefined (no change) for a tab not in the map", () => {
    const map = new Map<number, string>([[5, "Custom/9.9"]]);
    const details = detailsFor(99, [
      { name: "User-Agent", value: "Mozilla/5.0 (original)" },
    ]);

    const result = rewriteUserAgentHeader(details, map);

    expect(result).toBeUndefined();
  });

  it("returns undefined when the map is empty", () => {
    const map = new Map<number, string>();
    const details = detailsFor(5, [{ name: "User-Agent", value: "x" }]);

    expect(rewriteUserAgentHeader(details, map)).toBeUndefined();
  });

  it("handles details with no requestHeaders gracefully (still injects the UA)", () => {
    const map = new Map<number, string>([[5, "Custom/9.9"]]);
    const details = { tabId: 5 } as {
      tabId: number;
      requestHeaders?: NetworkHeader[];
    };

    const result = rewriteUserAgentHeader(details, map);

    expect(result).toBeDefined();
    const ua = result!.requestHeaders.find(
      (h) => h.name.toLowerCase() === "user-agent"
    );
    expect(ua?.value).toBe("Custom/9.9");
  });

  it("the module-level map drives the rewrite after setTabUserAgent (clear removes the override)", () => {
    setTabUserAgent(3, "Set/2.0");
    const map = __getUserAgentMap();
    const details = detailsFor(3, [{ name: "User-Agent", value: "old" }]);

    let result = rewriteUserAgentHeader(details, map);
    expect(result).toBeDefined();
    expect(
      result!.requestHeaders.find((h) => h.name.toLowerCase() === "user-agent")
        ?.value
    ).toBe("Set/2.0");

    clearTabUserAgent(3);
    // After clearing, the same tab is no longer rewritten.
    result = rewriteUserAgentHeader(
      detailsFor(3, [{ name: "User-Agent", value: "old" }]),
      map
    );
    expect(result).toBeUndefined();
  });
});
