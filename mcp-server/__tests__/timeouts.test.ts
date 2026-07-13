import { getCommandTimeout } from "../timeouts";

// D23: input actions run a covert human-like layer (cursor motion + per-char
// typing) that legitimately takes seconds; the 5s default caused spurious
// "Timed out waiting for response from the browser extension". These are the
// real wire `cmd` strings the broker sees (ServerMessage `cmd` values in
// common/server-messages.ts), not the tool display names.
describe("getCommandTimeout", () => {
  const INPUT_ACTION_CMDS = [
    "click-element",
    "fill-element",
    "press-key",
    "type-text",
    "drag-element",
    "hover-element",
    "click-at",
    "type-at",
    "hover-at",
    "scroll-at",
  ];

  it("gives every input-action cmd a 15000ms budget (> 5s default)", () => {
    for (const cmd of INPUT_ACTION_CMDS) {
      expect(getCommandTimeout(cmd)).toBe(15000);
    }
  });

  it("gives fill-form extra headroom for its many sequential fields", () => {
    expect(getCommandTimeout("fill-form")).toBe(30000);
  });

  it("falls back to the 5000ms default for an unlisted cmd", () => {
    expect(getCommandTimeout("get-tab-list")).toBe(5000);
    expect(getCommandTimeout("some-unknown-cmd")).toBe(5000);
  });

  it("keeps the existing longer budgets", () => {
    expect(getCommandTimeout("take-snapshot")).toBe(30000);
    expect(getCommandTimeout("navigate-tab")).toBe(30000);
    expect(getCommandTimeout("take-screenshot")).toBe(45000);
    expect(getCommandTimeout("select-option")).toBe(15000);
  });
});
