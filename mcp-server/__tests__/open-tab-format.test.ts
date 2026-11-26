import { formatOpenTabResult } from "../open-tab-format";
import { COOKIE_STORE_ID_PATTERN } from "@foxpilot/common";

// open-browser-tab's reply. With a cookieStoreId (Firefox container) it must
// not claim the container was used unless the extension confirmed it.
describe("formatOpenTabResult", () => {
  const url = "https://a.example.test/";

  it("reads exactly as before without a cookieStoreId", () => {
    expect(formatOpenTabResult({ url, tabId: 5 })).toBe(
      "https://a.example.test/ opened in tab id 5"
    );
    // A Firefox extension now always reports the store; without a request it is not printed.
    expect(
      formatOpenTabResult({ url, tabId: 5, cookieStoreId: "firefox-default" })
    ).toBe("https://a.example.test/ opened in tab id 5");
  });

  it("names the container when the extension confirms it", () => {
    expect(
      formatOpenTabResult({
        url,
        tabId: 5,
        requestedCookieStoreId: "firefox-container-2",
        cookieStoreId: "firefox-container-2",
      })
    ).toBe("https://a.example.test/ opened in tab id 5 (cookieStoreId=firefox-container-2)");
  });

  it("warns when an older extension did not confirm the container", () => {
    const text = formatOpenTabResult({
      url,
      tabId: 5,
      requestedCookieStoreId: "firefox-container-2",
    })!;
    expect(text.split("\n")[0]).toBe("https://a.example.test/ opened in tab id 5");
    expect(text).toContain("WARNING:");
    expect(text).toContain("default container");
    expect(text).toContain("close-browser-tabs");
  });

  it("warns when the tab opened in another store than requested", () => {
    const text = formatOpenTabResult({
      url,
      tabId: 5,
      requestedCookieStoreId: "firefox-container-2",
      cookieStoreId: "firefox-default",
    })!;
    expect(text).toContain(
      "WARNING: the tab opened in cookieStoreId=firefox-default, not firefox-container-2."
    );
  });

  it("returns undefined when no tab id came back", () => {
    expect(formatOpenTabResult({ url, tabId: undefined })).toBeUndefined();
  });
});

describe("COOKIE_STORE_ID_PATTERN", () => {
  it.each(["firefox-default", "firefox-private", "firefox-container-1", "firefox-container-42"])(
    "accepts %s",
    (id) => {
      expect(COOKIE_STORE_ID_PATTERN.test(id)).toBe(true);
    }
  );

  it.each(["", "Work", "firefox-container-", "firefox-container-x", "firefox-default ", "chrome-default"])(
    "rejects %j",
    (id) => {
      expect(COOKIE_STORE_ID_PATTERN.test(id)).toBe(false);
    }
  );
});
