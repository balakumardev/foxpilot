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
    expect(tree).toMatch(/clickable "Open" \|  \|  \[uid=e\d+\]/);
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
    expect(tree).toContain('link "Home" |  |  [uid=e1]');
    expect(tree).toContain('button "Go" |  |  [uid=e2]');
  });

  describe("name-from-contents fallback for custom-widget roles", () => {
    // Regression: IDS combobox options / tabs with no aria-label used to
    // snapshot as option "" / tab "", indistinguishable from one another.
    it("labels role=option / role=tab from their own text when unlabelled", () => {
      document.body.innerHTML = `
        <div role="tab">Secrets</div>
        <div role="tab">Application Identities</div>
        <div role="option">E2E</div>
        <div role="option">PRD</div>
      `;
      const { tree } = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        includePointer: false,
      });
      expect(tree).toContain('tab "Secrets"');
      expect(tree).toContain('tab "Application Identities"');
      expect(tree).toContain('option "E2E"');
      expect(tree).toContain('option "PRD"');
    });

    it("labels menuitem / treeitem / switch from their own text", () => {
      document.body.innerHTML = `
        <div role="menuitem">Delete</div>
        <div role="treeitem">Node A</div>
        <div role="switch">Dark mode</div>
      `;
      const { tree } = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        includePointer: false,
      });
      expect(tree).toContain('menuitem "Delete"');
      expect(tree).toContain('treeitem "Node A"');
      expect(tree).toContain('switch "Dark mode"');
    });

    it("aria-label still wins over contents", () => {
      document.body.innerHTML = `<div role="tab" aria-label="Tab one">ignored inner</div>`;
      const { tree } = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        includePointer: false,
      });
      expect(tree).toContain('tab "Tab one"');
      expect(tree).not.toContain("ignored inner");
    });
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
      expect(tree).toMatch(/textbox "Message input" \|  \|  \[uid=e\d+\]/);
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
      expect(tree).toMatch(/clickable "Open" \|  \|  \[uid=e\d+\]/);
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

  describe("3-slot grammar parity (Wave 2)", () => {
    it("emits empty value/section slots on a plain button", () => {
      document.body.innerHTML = `<button>Sign in</button>`;
      const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
      expect(tree).toContain('button "Sign in" |  |  [uid=e1]');
    });
    it("shows a native select's selected option in the value slot", () => {
      document.body.innerHTML = `<select aria-label="Country"><option>US</option></select>`;
      const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
      expect(tree).toContain('combobox "Country" | "US" |  [uid=e1]');
    });
    it("shows a react-select singleValue and a card breadcrumb", () => {
      document.body.innerHTML = `
        <div class="card"><h3>Billing</h3>
          <div role="combobox" aria-label="Country"><div class="Select__single-value">United States</div></div>
        </div>`;
      const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
      expect(tree).toContain('combobox "Country" | "United States" | Billing [uid=');
    });
    it("never surfaces a password input's value in the value slot", () => {
      // A typed/autofilled password must NOT leak into the snapshot value slot.
      document.body.innerHTML = `<input type="password" aria-label="Password" value="hunter2" />`;
      const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
      expect(tree).toContain('textbox "Password" |  |  [uid=e1]');
      expect(tree).not.toContain("hunter2");
    });
  });
});

describe("B10: snapshot stamps a data-bcmcp-sig identity signature", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("stamps both uid and sig, and re-stamps fresh ones on the next snapshot", () => {
    document.body.innerHTML = `<button aria-label="Save">S</button>`;
    const btn = document.querySelector("button")!;
    buildSnapshot(document, { verbose: false, maxLength: 25000 });
    expect(btn.getAttribute("data-bcmcp-uid")).toMatch(/^e\d+$/);
    expect(btn.getAttribute("data-bcmcp-sig")).toBeTruthy();

    buildSnapshot(document, { verbose: false, maxLength: 25000 });
    expect(btn.getAttribute("data-bcmcp-uid")).toMatch(/^e\d+$/);
    expect(btn.getAttribute("data-bcmcp-sig")).toBeTruthy();
  });

  it("produces a different sig once the element identity (aria-label) changes", () => {
    document.body.innerHTML = `<button aria-label="Save">S</button>`;
    const btn = document.querySelector("button")!;
    buildSnapshot(document, { verbose: false, maxLength: 25000 });
    const sigA = btn.getAttribute("data-bcmcp-sig");
    btn.setAttribute("aria-label", "Delete");
    buildSnapshot(document, { verbose: false, maxLength: 25000 });
    const sigB = btn.getAttribute("data-bcmcp-sig");
    expect(sigA).toBeTruthy();
    expect(sigB).toBeTruthy();
    expect(sigA).not.toBe(sigB);
  });

  it("also stamps a sig on pointer-pass (cursor:pointer div) elements", () => {
    // Force the pointer pass to see cursor:pointer via a getComputedStyle stub.
    document.body.innerHTML = `<div>Card</div>`;
    const div = document.querySelector("div")!;
    jest
      .spyOn(window, "getComputedStyle")
      .mockImplementation(
        () => ({ display: "block", visibility: "visible", opacity: "", cursor: "pointer" }) as unknown as CSSStyleDeclaration
      );
    buildSnapshot(document, { verbose: false, maxLength: 25000 });
    jest.restoreAllMocks();
    expect(div.getAttribute("data-bcmcp-uid")).toMatch(/^e\d+$/);
    expect(div.getAttribute("data-bcmcp-sig")).toBeTruthy();
  });
});

describe("B11: visibility filter uses computed style (runtime-guarded)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("excludes an element whose computed display is none (CSS class), keeps siblings", () => {
    document.body.innerHTML = `<button class="ghost">Ghost</button><button>Visible</button>`;
    const ghost = document.querySelector(".ghost")!;
    jest.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
      const base = { visibility: "visible", opacity: "", cursor: "" };
      if (el === ghost) {
        return { ...base, display: "none" } as unknown as CSSStyleDeclaration;
      }
      return { ...base, display: "block" } as unknown as CSSStyleDeclaration;
    });

    const { tree } = buildSnapshot(document, {
      verbose: false,
      maxLength: 25000,
      includePointer: false,
    });

    expect(tree).toContain('button "Visible"');
    expect(tree).not.toContain("Ghost");
  });

  it("excludes visibility:hidden but KEEPS opacity:0 (still in a11y tree / interactive)", () => {
    document.body.innerHTML = `<button class="invis">Invis</button><button class="faded">Faded</button><button>Shown</button>`;
    const invis = document.querySelector(".invis")!;
    const faded = document.querySelector(".faded")!;
    jest.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
      const base = { display: "block", visibility: "visible", opacity: "", cursor: "" };
      if (el === invis) return { ...base, visibility: "hidden" } as unknown as CSSStyleDeclaration;
      if (el === faded) return { ...base, opacity: "0" } as unknown as CSSStyleDeclaration;
      return base as unknown as CSSStyleDeclaration;
    });

    const { tree } = buildSnapshot(document, {
      verbose: false,
      maxLength: 25000,
      includePointer: false,
    });

    expect(tree).toContain('button "Shown"');
    expect(tree).not.toContain("Invis");
    // opacity:0 elements stay reachable (focusable/clickable) and remain in the
    // a11y tree, so they are NOT hidden — they must still be enumerated.
    expect(tree).toContain('button "Faded"');
  });

  it("excludes an element whose ANCESTOR has computed display:none", () => {
    document.body.innerHTML = `<div class="wrap"><button>Inside Hidden</button></div><button>Outside</button>`;
    const wrap = document.querySelector(".wrap")!;
    jest.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
      const base = { display: "block", visibility: "visible", opacity: "", cursor: "" };
      if (el === wrap) return { ...base, display: "none" } as unknown as CSSStyleDeclaration;
      return base as unknown as CSSStyleDeclaration;
    });

    const { tree } = buildSnapshot(document, {
      verbose: false,
      maxLength: 25000,
      includePointer: false,
    });

    expect(tree).toContain('button "Outside"');
    expect(tree).not.toContain("Inside Hidden");
  });

  it("falls back to inline-only detection when getComputedStyle is unavailable (jsdom path)", () => {
    document.body.innerHTML = `<button style="display:none">Inline Hidden</button><button>Shown</button>`;
    const orig = window.getComputedStyle;
    (window as unknown as { getComputedStyle?: unknown }).getComputedStyle = undefined;
    try {
      const { tree } = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        includePointer: false,
      });
      expect(tree).not.toContain("Inline Hidden");
      expect(tree).toContain('button "Shown"');
    } finally {
      (window as unknown as { getComputedStyle?: unknown }).getComputedStyle = orig;
    }
  });

  it("does not regress: normal elements stay visible under real jsdom getComputedStyle", () => {
    document.body.innerHTML = `<button>Alpha</button><a href="/x">Beta</a>`;
    const { tree } = buildSnapshot(document, {
      verbose: false,
      maxLength: 25000,
      includePointer: false,
    });
    expect(tree).toContain('button "Alpha"');
    expect(tree).toContain('link "Beta"');
  });
});

/**
 * docState lets the server tell a mid-navigation or blank document apart from a
 * page that genuinely has no controls — all three otherwise render as a bare
 * `[snapshot: 0 elements]`. Mirrors the block in
 * firefox-extension/__tests__/snapshot-script.test.ts.
 */
describe("buildSnapshot docState", () => {
  it("reports readyState, url and body child count", () => {
    document.body.innerHTML = `<button>Alpha</button><div></div>`;
    const { docState } = buildSnapshot(document, {
      verbose: false,
      maxLength: 25000,
      includePointer: false,
    });
    expect(docState).toBeDefined();
    // jsdom reports "complete" for a fully parsed document.
    expect(typeof docState!.readyState).toBe("string");
    expect(docState!.readyState.length).toBeGreaterThan(0);
    expect(docState!.url).toBe(document.URL);
    expect(docState!.bodyChildren).toBe(2);
  });

  it("reports bodyChildren 0 for an empty body, alongside total 0", () => {
    document.body.innerHTML = ``;
    const { total, docState } = buildSnapshot(document, {
      verbose: false,
      maxLength: 25000,
      includePointer: false,
    });
    expect(total).toBe(0);
    expect(docState!.bodyChildren).toBe(0);
  });

  it("distinguishes a content-bearing page with no interactive elements", () => {
    document.body.innerHTML = `<p>Just prose.</p><p>More prose.</p>`;
    const { total, docState } = buildSnapshot(document, {
      verbose: false,
      maxLength: 25000,
      includePointer: false,
    });
    // The pair (total 0, bodyChildren > 0) is exactly what the server needs to
    // say "loaded, nothing interactive" instead of "empty page".
    expect(total).toBe(0);
    expect(docState!.bodyChildren).toBe(2);
  });

  it("is present on the truncated path too", () => {
    document.body.innerHTML = Array.from(
      { length: 50 },
      (_, i) => `<button>Button number ${i}</button>`
    ).join("");
    const { isTruncated, docState } = buildSnapshot(document, {
      verbose: false,
      maxLength: 40,
      includePointer: false,
    });
    expect(isTruncated).toBe(true);
    expect(docState).toBeDefined();
    expect(docState!.bodyChildren).toBe(50);
  });
});
