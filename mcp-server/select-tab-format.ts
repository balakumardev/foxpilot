// Formats the select-tab reply. Extracted from server.ts (which self-executes
// on import, see navigate-format.ts) so the wording is unit-testable.
//
// select-tab focuses the tab's browser window unless told not to, and a focused
// window takes the keyboard from whatever app the user was typing into: their
// keystrokes then land in the page, and silently change a field that has
// focus. The reply says so whenever it happened. An older extension does not
// report windowFocused, so its reply keeps the established one-line wording.
export function formatSelectTabResult(result: {
  tabId: number;
  windowFocused?: boolean;
}): string {
  const text = `Selected tab ${result.tabId}`;
  if (result.windowFocused === true) {
    return (
      text +
      "\nIts browser window now has the keyboard: anything the user types goes into this page until they switch away, so check field values before you submit. Pass focusWindow:false to select a tab without taking the keyboard."
    );
  }
  if (result.windowFocused === false) {
    return text + " (its window was not focused, so the user keeps the keyboard)";
  }
  return text;
}
