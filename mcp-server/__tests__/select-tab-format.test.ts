import { formatSelectTabResult } from "../select-tab-format";

// select-tab's reply. Focusing the window hands it the user's keyboard, which
// the reply must say; an older extension (no windowFocused) reads as before.
describe("formatSelectTabResult", () => {
  it("warns that the window now has the keyboard when it was focused", () => {
    const text = formatSelectTabResult({ tabId: 82, windowFocused: true });
    expect(text.split("\n")[0]).toBe("Selected tab 82");
    expect(text).toContain("now has the keyboard");
    expect(text).toContain("anything the user types goes into this page");
    expect(text).toContain("focusWindow:false");
  });

  it("says the user keeps the keyboard when only the tab was activated", () => {
    expect(formatSelectTabResult({ tabId: 82, windowFocused: false })).toBe(
      "Selected tab 82 (its window was not focused, so the user keeps the keyboard)"
    );
  });

  it("an older extension that does not report windowFocused reads exactly as before", () => {
    expect(formatSelectTabResult({ tabId: 82 })).toBe("Selected tab 82");
  });
});
