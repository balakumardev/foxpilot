import { formatNavigateResult } from "../navigate-format";

// The navigate-tab tool text is composed here rather than in server.ts, which
// self-executes on import and cannot be loaded into a test (same reason as
// snapshot-format.ts / point-format.ts). The wire tests (navigate-tab-args)
// only prove the fields arrive; this pins what the model is actually told.
describe("formatNavigateResult", () => {
  const REQUESTED = "https://app.example.com/settings";

  it("reports the settled url in the established wording", () => {
    const out = formatNavigateResult(REQUESTED, {
      tabId: 7,
      url: "https://app.example.com/settings/profile",
    });
    expect(out).toEqual({
      content: [
        { type: "text", text: "Navigated tab 7 to https://app.example.com/settings/profile" },
      ],
    });
  });

  it("falls back to the requested url when the extension sent none", () => {
    const out = formatNavigateResult(REQUESTED, { tabId: 7 });
    expect(out.content[0].text).toBe("Navigated tab 7 to https://app.example.com/settings");
  });

  it("does not present the old url as the destination when the navigation never committed", () => {
    const out = formatNavigateResult(REQUESTED, {
      tabId: 7,
      url: "https://app.example.com/dashboard",
      committed: false,
    });
    const text = out.content[0].text;
    expect(text.startsWith("Navigated tab")).toBe(false);
    expect(text).not.toContain("to https://app.example.com/dashboard");
    expect(text).toContain(REQUESTED);
    expect(text).toContain("still shows https://app.example.com/dashboard");
    // It is an honest status, not a tool failure: the navigation was issued and
    // may still land.
    expect(out.isError).toBeUndefined();
  });

  it("names the url the browser is still loading when it knows it", () => {
    const out = formatNavigateResult(REQUESTED, {
      tabId: 7,
      url: "https://app.example.com/dashboard",
      committed: false,
      pendingUrl: "https://app.example.com/settings",
    });
    expect(out.content[0].text).toContain("still loading https://app.example.com/settings");
  });
});
