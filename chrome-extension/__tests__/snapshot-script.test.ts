import { buildSnapshot } from "../injected/snapshot-script";

// jsdom unit tests for the Chrome copy of the (byte-identical) snapshot
// builder. Mirrors firefox-extension/__tests__/snapshot-script.test.ts.
describe("buildSnapshot (chrome)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("captures an inline cursor:pointer div by default (includePointer default true)", () => {
    document.body.innerHTML = `<div style="cursor: pointer">Open</div>`;
    const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
    expect(tree).toMatch(/clickable "Open" \[uid=e\d+\]/);
  });

  it("omits pointer elements when includePointer is false", () => {
    document.body.innerHTML = `<div style="cursor: pointer">Open</div>`;
    const { tree } = buildSnapshot(document, {
      verbose: false,
      maxLength: 25000,
      includePointer: false,
    });
    expect(tree).not.toContain("Open");
  });

  it("still surfaces base-pass semantic elements", () => {
    document.body.innerHTML = `<a href="/h">Home</a><button>Go</button>`;
    const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
    expect(tree).toContain('link "Home" [uid=e1]');
    expect(tree).toContain('button "Go" [uid=e2]');
  });

  describe("selector query mode (Task 5)", () => {
    it("returns exactly the selector matches with fresh uids, even non-interactive", () => {
      document.body.innerHTML = `
        <div contenteditable="true" aria-label="Message input"></div>
        <p>ignore me</p>
        <button>Send</button>
      `;
      const { tree } = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        selector: "[contenteditable]",
      });
      expect(tree).toMatch(/textbox "Message input" \[uid=e\d+\]/);
      // Selector mode is self-contained: unrelated base elements are NOT emitted.
      expect(tree).not.toContain('button "Send"');
    });

    it("returns an error for an invalid selector", () => {
      document.body.innerHTML = `<div>x</div>`;
      const res = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        selector: "::::bad",
      });
      expect(res.error).toMatch(/Invalid CSS selector/);
      expect(res.tree).toBe("");
    });
  });
});
