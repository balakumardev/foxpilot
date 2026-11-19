import { formatBrowserFetchReply } from "../fetch-format";

const URL_ = "https://app.example.test/api/v1/things";

const ok = (over: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  finalUrl: URL_,
  bodyText: '{"a":1}',
  truncated: false,
  context: "background" as const,
  ...over,
});

describe("formatBrowserFetchReply: layout (unchanged for background fetches)", () => {
  it("prints status line, headers and body, byte for byte as before", () => {
    const out = formatBrowserFetchReply({ url: URL_ }, ok());
    expect(out.isError).toBe(false);
    expect(out.text).toBe(
      `200 OK  ${URL_}\n\n${JSON.stringify({ "content-type": "application/json" }, null, 2)}\n\n{"a":1}`
    );
  });

  it("falls back to the requested url when the reply has no finalUrl", () => {
    const out = formatBrowserFetchReply({ url: URL_ }, ok({ finalUrl: undefined }));
    expect(out.text.startsWith(`200 OK  ${URL_}\n`)).toBe(true);
  });

  it("notes a truncated body and describes a binary body by its base64 length", () => {
    const out = formatBrowserFetchReply(
      { url: URL_ },
      ok({ bodyText: undefined, bodyBase64: "QUJD", truncated: true })
    );
    expect(out.text).toContain("[binary body: base64 length 4]");
    expect(out.text.endsWith("\n(truncated)")).toBe(true);
  });

  it("a transport failure is an error with the extension's message", () => {
    const out = formatBrowserFetchReply(
      { url: URL_ },
      { ok: false, error: "Timed out after 30000 ms", context: "background" }
    );
    expect(out).toEqual({ text: "Fetch failed: Timed out after 30000 ms", isError: true });
  });

  it("a failure with no message still says something", () => {
    expect(formatBrowserFetchReply({ url: URL_ }, { ok: false }).text).toBe(
      "Fetch failed: unknown error"
    );
  });
});

describe("formatBrowserFetchReply: empty-body 401/403 hint", () => {
  const BACKGROUND_HINT = /ran in the extension background.*extension's Origin.*Retry with tabId set to a tab on the same site/s;
  const TAB_HINT = /already carried the page's Origin.*session may have expired.*CSRF.*get-network-requests with includeHeaders/s;

  it.each([401, 403])("background %i with an empty text body gets the Origin/Referer hint", (status) => {
    const out = formatBrowserFetchReply(
      { url: URL_ },
      ok({ status, statusText: "Forbidden", bodyText: "" })
    );
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(BACKGROUND_HINT);
    expect(out.text).not.toMatch(TAB_HINT);
    // One short hint paragraph after the body.
    expect(out.text.split("\n\nHint: ")).toHaveLength(2);
  });

  it("a bare 403 arrives as bodyBase64 '' (no content type): that is an empty body too", () => {
    const out = formatBrowserFetchReply(
      { url: URL_ },
      ok({ status: 403, statusText: "Forbidden", bodyText: undefined, bodyBase64: "", headers: {} })
    );
    expect(out.text).toContain("[binary body: base64 length 0]");
    expect(out.text).toMatch(BACKGROUND_HINT);
  });

  it("an extension that sent neither body field is treated as empty as well", () => {
    const out = formatBrowserFetchReply(
      { url: URL_ },
      ok({ status: 401, statusText: "Unauthorized", bodyText: undefined })
    );
    expect(out.text).toMatch(BACKGROUND_HINT);
  });

  it("a whitespace-only body is empty", () => {
    const out = formatBrowserFetchReply({ url: URL_ }, ok({ status: 403, bodyText: " \n" }));
    expect(out.text).toMatch(BACKGROUND_HINT);
  });

  it.each([401, 403])("tab-context %i with an empty body gets the session/CSRF hint instead", (status) => {
    const out = formatBrowserFetchReply(
      { url: URL_, tabId: 7 },
      ok({ status, bodyText: "", context: "tab", tabOrigin: "https://app.example.test" })
    );
    expect(out.text).toMatch(TAB_HINT);
    expect(out.text).not.toMatch(BACKGROUND_HINT);
  });

  it("no hint when the 403 has a body", () => {
    const out = formatBrowserFetchReply(
      { url: URL_ },
      ok({ status: 403, statusText: "Forbidden", bodyText: '{"error":"forbidden"}' })
    );
    expect(out.text).not.toContain("Hint:");
  });

  it("no hint when the 403 has a binary body", () => {
    const out = formatBrowserFetchReply(
      { url: URL_ },
      ok({ status: 403, bodyText: undefined, bodyBase64: "QUJD" })
    );
    expect(out.text).not.toContain("Hint:");
  });

  it.each([200, 201, 204, 301, 400, 404, 405, 429, 500, 502])(
    "no hint and unchanged output for an empty %i",
    (status) => {
      const out = formatBrowserFetchReply(
        { url: URL_ },
        ok({ status, statusText: "X", bodyText: "" })
      );
      expect(out.text).not.toContain("Hint:");
      expect(out.text).toBe(
        `${status} X  ${URL_}\n\n${JSON.stringify({ "content-type": "application/json" }, null, 2)}\n\n`
      );
    }
  );

  it("the hint comes after the truncation note", () => {
    const out = formatBrowserFetchReply(
      { url: URL_ },
      ok({ status: 403, bodyText: "", truncated: true })
    );
    expect(out.text.indexOf("(truncated)")).toBeLessThan(out.text.indexOf("Hint:"));
  });
});

describe("formatBrowserFetchReply: tab context", () => {
  it("opens with a one-line banner naming the tab and the origin (host only), then the usual layout", () => {
    const out = formatBrowserFetchReply(
      { url: "/api/v1/things", tabId: 7 },
      ok({ context: "tab", tabOrigin: "https://app.example.test" })
    );
    expect(out.isError).toBe(false);
    const [first, second] = out.text.split("\n");
    expect(first).toBe("[ran inside tab 7 as the page: origin https://app.example.test]");
    expect(second).toBe(`200 OK  ${URL_}`);
  });

  it("never shows a path or query in the banner", () => {
    const out = formatBrowserFetchReply(
      { url: URL_, tabId: 7 },
      ok({ context: "tab", tabOrigin: "https://app.example.test:8443" })
    );
    expect(out.text.split("\n")[0]).toBe(
      "[ran inside tab 7 as the page: origin https://app.example.test:8443]"
    );
  });

  it("copes with a reply that has no tabOrigin", () => {
    const out = formatBrowserFetchReply({ url: URL_, tabId: 7 }, ok({ context: "tab" }));
    expect(out.text.split("\n")[0]).toBe("[ran inside tab 7 as the page]");
  });

  it("a tab-context failure is a plain failure, not the old-extension error", () => {
    const out = formatBrowserFetchReply(
      { url: URL_, tabId: 7 },
      { ok: false, error: "Timed out after 5000 ms waiting inside tab 7", context: "tab" }
    );
    expect(out).toEqual({
      text: "Fetch failed: Timed out after 5000 ms waiting inside tab 7",
      isError: true,
    });
  });

  it("a background fetch has no banner", () => {
    const out = formatBrowserFetchReply({ url: URL_ }, ok());
    expect(out.text).not.toContain("[ran inside tab");
  });
});

describe("formatBrowserFetchReply: an extension older than tabId mode", () => {
  const oldReply = {
    ok: true,
    status: 200,
    statusText: "OK",
    bodyText: "secret-ish",
    headers: {},
    finalUrl: URL_,
  };

  it("refuses to present a background response (no context) as a tab response", () => {
    const out = formatBrowserFetchReply({ url: URL_, tabId: 7 }, oldReply);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/NOT run inside tab 7/);
    expect(out.text).toMatch(/too old for tabId mode/);
    expect(out.text).toMatch(/nothing was sent in the page context/);
    // It says the request WAS sent from the background, since an old extension ran one.
    expect(out.text).toMatch(/ran the request from its background instead \(HTTP 200\), so it WAS sent once/);
    // And it does not print that response.
    expect(out.text).not.toContain("secret-ish");
    expect(out.text).not.toContain(URL_);
  });

  it("a read-only request is told to update the extension and retry with tabId", () => {
    const out = formatBrowserFetchReply({ url: URL_, tabId: 7, method: "get" }, oldReply);
    expect(out.text).toMatch(/Update the FoxPilot extension, then retry with tabId/);
    expect(out.text).not.toMatch(/without tabId/);
  });

  it.each(["POST", "put", "PATCH", "DELETE"])(
    "a %s is NOT sent again: the error says it may already have taken effect and to check first",
    (method) => {
      const out = formatBrowserFetchReply({ url: URL_, tabId: 7, method }, oldReply);
      expect(out.isError).toBe(true);
      expect(out.text).toContain(`This ${method.toUpperCase()} may already have taken effect: check before sending it again`);
      // The advice that would double-send is gone.
      expect(out.text).not.toMatch(/without tabId/);
      expect(out.text).not.toMatch(/retry with tabId/);
    }
  );

  it("an explicit context:background reply to a tabId request is refused the same way", () => {
    const out = formatBrowserFetchReply(
      { url: URL_, tabId: 7 },
      ok({ context: "background" })
    );
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/too old for tabId mode/);
  });

  it("an old extension's failed background attempt is reported as not run in the tab, and as maybe-sent", () => {
    const out = formatBrowserFetchReply(
      { url: URL_, tabId: 7, method: "POST" },
      { ok: false, error: "Failed to fetch" }
    );
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/NOT run inside tab 7/);
    expect(out.text).toMatch(/reported a failure \(Failed to fetch\); it may or may not have reached the server/);
    expect(out.text).toMatch(/This POST may already have taken effect/);
    expect(out.text).not.toMatch(/WAS sent once/);
  });

  it("a request without tabId never triggers the guard, whatever the context says", () => {
    expect(formatBrowserFetchReply({ url: URL_ }, ok({ context: undefined })).isError).toBe(false);
    expect(formatBrowserFetchReply({ url: URL_ }, ok({ context: "background" })).isError).toBe(false);
  });
});
