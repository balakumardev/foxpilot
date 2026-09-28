import { formatClickResult } from "../click-format";

// click-element's reply text. The dispatchedTo clause is new; every other shape
// must read exactly as it did before it existed.
describe("formatClickResult", () => {
  it("plain click / double-click / navigated read exactly as before", () => {
    expect(formatClickResult("e2", undefined, {})).toBe("Clicked element e2");
    expect(formatClickResult("e2", true, {})).toBe("Double-clicked element e2");
    expect(formatClickResult("e2", false, { navigated: true })).toBe(
      "Clicked element e2 (page navigated)"
    );
  });

  it("names the descendant a retargeted click was dispatched on", () => {
    expect(
      formatClickResult("e2", undefined, {
        dispatchedTo: { tag: "button", name: "Draft macOS Submission (1)" },
      })
    ).toBe('Clicked element e2 (dispatched on its descendant <button> "Draft macOS Submission (1)")');
  });

  it("omits the name when the descendant has none, and keeps (page navigated) after it", () => {
    expect(
      formatClickResult("e7", true, { dispatchedTo: { tag: "label" }, navigated: true })
    ).toBe("Double-clicked element e7 (dispatched on its descendant <label>) (page navigated)");
  });

  it("clips a long name to ~60 chars and quotes it safely", () => {
    const text = formatClickResult("e3", undefined, {
      dispatchedTo: {
        tag: "a",
        name: 'Say "hi" to the release notes for version 1.0.26 and everything else that shipped',
      },
    });
    const quoted = text.slice(text.indexOf("<a> ") + 4, -1);
    const name = JSON.parse(quoted) as string;
    expect(name.length).toBe(60);
    expect(name.endsWith("…")).toBe(true);
    expect(name.startsWith('Say "hi" to the release notes')).toBe(true);
  });

  it("appends the interception warning with the #id → tag.class → tag selector rule", () => {
    expect(
      formatClickResult("e1", undefined, {
        intercepted: { tag: "div", id: "onetrust-banner-sdk", classes: "ot-sdk-row" },
      })
    ).toBe(
      "Clicked element e1\n⚠ click may be intercepted by #onetrust-banner-sdk — consider dismiss-overlays"
    );
    expect(
      formatClickResult("e1", undefined, { intercepted: { tag: "div", classes: "scrim dark" } })
    ).toBe("Clicked element e1\n⚠ click may be intercepted by div.scrim — consider dismiss-overlays");
    expect(formatClickResult("e1", undefined, { intercepted: { tag: "cookie-banner" } })).toBe(
      "Clicked element e1\n⚠ click may be intercepted by cookie-banner — consider dismiss-overlays"
    );
  });
});
