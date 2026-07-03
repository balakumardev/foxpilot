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

  describe("textContains query mode (Task 6)", () => {
    it("returns the deepest element whose visible text contains the string (case-insensitive)", () => {
      document.body.innerHTML = `
        <main><section><div id="open-card">Open</div></section></main>
        <p>unrelated</p>
      `;
      const { tree } = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        textContains: "open",
      });
      // The leaf #open-card matches; its ancestors (main/section) do NOT get
      // their own entry (deepest-wins).
      expect(tree).toMatch(/clickable "Open" \[uid=e\d+\]/);
      const clickableLines = (tree.match(/clickable "Open"/g) || []).length;
      expect(clickableLines).toBe(1);
      expect(tree).not.toContain("unrelated");
    });

    it("composes with selector (AND)", () => {
      document.body.innerHTML = `
        <button>Open settings</button>
        <button>Close</button>
        <div>Open (not a button)</div>
      `;
      const { tree } = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        selector: "button",
        textContains: "open",
      });
      expect(tree).toContain('button "Open settings"');
      expect(tree).not.toContain('button "Close"');
      expect(tree).not.toContain("not a button");
    });
  });

  describe("rootSelector scoping (Task 7)", () => {
    it("collects only within the matched subtree, excluding a sibling sidebar", () => {
      document.body.innerHTML = `
        <nav id="sidebar"><a href="/1">Side 1</a><a href="/2">Side 2</a></nav>
        <main id="main-panel"><button>Main Action</button></main>
      `;
      const { tree } = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        rootSelector: "#main-panel",
      });
      expect(tree).toContain('button "Main Action"');
      expect(tree).not.toContain("Side 1");
      expect(tree).not.toContain("Side 2");
    });

    it("returns an error when rootSelector matches nothing", () => {
      document.body.innerHTML = `<button>X</button>`;
      const res = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        rootSelector: "#does-not-exist",
      });
      expect(res.error).toMatch(/rootSelector matched no element/);
      expect(res.tree).toBe("");
    });

    it("returns an error for a malformed rootSelector", () => {
      document.body.innerHTML = `<button>X</button>`;
      const res = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        rootSelector: ":::",
      });
      expect(res.error).toMatch(/Invalid rootSelector/);
      expect(res.tree).toBe("");
    });
  });

  describe("offset/limit paging + total/hasMore (Task 8)", () => {
    function tenButtons() {
      let html = "";
      for (let i = 0; i < 10; i++) html += `<button>Btn ${i}</button>`;
      document.body.innerHTML = html;
    }

    it("reports total across the full candidate list", () => {
      tenButtons();
      const res = buildSnapshot(document, { verbose: false, maxLength: 25000 });
      expect(res.total).toBe(10);
      expect(res.hasMore).toBe(false);
    });

    it("returns only the requested page and sets hasMore when more remain", () => {
      tenButtons();
      const res = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        offset: 0,
        limit: 3,
      });
      expect(res.total).toBe(10);
      expect(res.hasMore).toBe(true);
      const lines = res.tree.split("\n").filter(Boolean);
      expect(lines.length).toBe(3);
      expect(res.tree).toContain('button "Btn 0"');
      expect(res.tree).toContain('button "Btn 2"');
      expect(res.tree).not.toContain('button "Btn 3"');
    });

    it("pages from an offset and clears hasMore on the last page", () => {
      tenButtons();
      const res = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        offset: 8,
        limit: 5,
      });
      expect(res.total).toBe(10);
      expect(res.hasMore).toBe(false);
      const lines = res.tree.split("\n").filter(Boolean);
      expect(lines.length).toBe(2); // items 8 and 9
      expect(res.tree).toContain('button "Btn 8"');
      expect(res.tree).toContain('button "Btn 9"');
    });
  });
});
