import { buildSnapshot } from "../injected/snapshot-script";
import * as vm from "vm";

/**
 * These tests run in jsdom (the default Jest test environment for this package).
 * They call `buildSnapshot` directly against a DOM built with
 * `document.body.innerHTML`. The same function is also stringified and injected
 * into the page at runtime, so it must remain fully self-contained.
 */
describe("buildSnapshot", () => {
  function build(verbose = false, maxLength = 25000) {
    return buildSnapshot(document, { verbose, maxLength });
  }

  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("renders links with the link role, accessible name, and a uid", () => {
    document.body.innerHTML = `<a href="/home">Home</a>`;
    const { tree } = build();
    expect(tree).toContain('link "Home" |  |  [uid=e1]');
  });

  it("renders buttons with the button role and accessible name", () => {
    document.body.innerHTML = `<button>Sign in</button>`;
    const { tree } = build();
    expect(tree).toContain('button "Sign in" |  |  [uid=e1]');
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
      const { tree } = build();
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
      const { tree } = build();
      expect(tree).toContain('menuitem "Delete"');
      expect(tree).toContain('treeitem "Node A"');
      expect(tree).toContain('switch "Dark mode"');
    });

    it("aria-label still wins over contents", () => {
      document.body.innerHTML = `<div role="tab" aria-label="Tab one">ignored inner</div>`;
      const { tree } = build();
      expect(tree).toContain('tab "Tab one"');
      expect(tree).not.toContain("ignored inner");
    });
  });

  it("renders text inputs as textbox via the associated label", () => {
    document.body.innerHTML = `
      <label for="email">Email</label>
      <input id="email" type="text" />
    `;
    const { tree } = build();
    expect(tree).toContain('textbox "Email" |  |  [uid=');
  });

  it("derives implicit roles for input types", () => {
    document.body.innerHTML = `
      <input type="checkbox" aria-label="Remember me" checked />
      <input type="radio" aria-label="Pick one" />
      <input type="search" aria-label="Search site" />
      <select aria-label="Country"><option>US</option></select>
      <textarea aria-label="Bio"></textarea>
    `;
    const { tree } = build();
    expect(tree).toContain('checkbox "Remember me"');
    expect(tree).toContain('radio "Pick one"');
    expect(tree).toContain('searchbox "Search site"');
    expect(tree).toContain('combobox "Country"');
    expect(tree).toContain('textbox "Bio"');
  });

  it("honors an explicit role attribute over the implicit one", () => {
    document.body.innerHTML = `<div role="tab" aria-label="Settings"></div>`;
    const { tree } = build();
    expect(tree).toContain('tab "Settings" |  |  [uid=');
  });

  it("stamps data-bcmcp-uid attributes on selected elements", () => {
    document.body.innerHTML = `<a href="/a">A</a><button>B</button>`;
    build();
    const link = document.querySelector("a")!;
    const button = document.querySelector("button")!;
    expect(link.getAttribute("data-bcmcp-uid")).toBe("e1");
    expect(button.getAttribute("data-bcmcp-uid")).toBe("e2");
  });

  it("clears stale uids from a previous run before re-stamping", () => {
    document.body.innerHTML = `<a href="/a" data-bcmcp-uid="e99">A</a>`;
    build();
    const link = document.querySelector("a")!;
    // The stale e99 must have been cleared and replaced with a fresh value.
    expect(link.getAttribute("data-bcmcp-uid")).toBe("e1");
  });

  it("excludes elements hidden via the hidden attribute", () => {
    document.body.innerHTML = `
      <button hidden>Hidden</button>
      <button>Visible</button>
    `;
    const { tree } = build();
    expect(tree).not.toContain("Hidden");
    expect(tree).toContain('button "Visible"');
  });

  it("excludes elements hidden via aria-hidden", () => {
    document.body.innerHTML = `
      <a href="/x" aria-hidden="true">Secret</a>
      <a href="/y">Shown</a>
    `;
    const { tree } = build();
    expect(tree).not.toContain("Secret");
    expect(tree).toContain('link "Shown"');
  });

  it("excludes elements hidden via inline display:none and visibility:hidden", () => {
    document.body.innerHTML = `
      <button style="display:none">Gone</button>
      <button style="visibility:hidden">Invisible</button>
      <button style="color:red">Here</button>
    `;
    const { tree } = build();
    expect(tree).not.toContain("Gone");
    expect(tree).not.toContain("Invisible");
    expect(tree).toContain('button "Here"');
  });

  it("excludes hidden inputs", () => {
    document.body.innerHTML = `
      <input type="hidden" value="token" aria-label="csrf" />
      <input type="text" aria-label="Name" />
    `;
    const { tree } = build();
    expect(tree).not.toContain("csrf");
    expect(tree).toContain('textbox "Name"');
  });

  it("renders required, checked, and disabled state flags", () => {
    document.body.innerHTML = `
      <input type="text" aria-label="Email" required />
      <input type="checkbox" aria-label="Agree" checked />
      <button disabled>Submit</button>
    `;
    const { tree } = build();
    expect(tree).toContain('textbox "Email" |  |  [uid=e1] (required)');
    expect(tree).toMatch(/checkbox "Agree" \|  \|  \[uid=e\d+\] \(checked\)/);
    expect(tree).toMatch(/button "Submit" \|  \|  \[uid=e\d+\] \(disabled\)/);
  });

  it("renders aria-expanded and aria-selected state flags", () => {
    document.body.innerHTML = `
      <button aria-expanded="true" aria-label="Menu">Menu</button>
      <button aria-expanded="false" aria-label="More">More</button>
      <div role="option" aria-selected="true" aria-label="Opt"></div>
    `;
    const { tree } = build();
    expect(tree).toContain("(expanded)");
    expect(tree).toContain("(collapsed)");
    expect(tree).toContain("(selected)");
  });

  it("renders aria-disabled as a disabled flag", () => {
    document.body.innerHTML = `<button aria-disabled="true">Nope</button>`;
    const { tree } = build();
    expect(tree).toMatch(/button "Nope" \|  \|  \[uid=e\d+\] \(disabled\)/);
  });

  it("prefers aria-label over label, placeholder, and text content", () => {
    document.body.innerHTML = `
      <label for="f1">LabelName</label>
      <input id="f1" type="text" aria-label="AriaName" placeholder="PlaceholderName" />
    `;
    const { tree } = build();
    expect(tree).toContain('textbox "AriaName"');
    expect(tree).not.toContain("LabelName");
    expect(tree).not.toContain("PlaceholderName");
  });

  it("falls back to placeholder when no label or aria-label is present", () => {
    document.body.innerHTML = `<input type="text" placeholder="Your name" />`;
    const { tree } = build();
    expect(tree).toContain('textbox "Your name"');
  });

  it("uses aria-labelledby to resolve the accessible name", () => {
    document.body.innerHTML = `
      <span id="lbl">Username</span>
      <input type="text" aria-labelledby="lbl" />
    `;
    const { tree } = build();
    expect(tree).toContain('textbox "Username"');
  });

  it("resolves the name from an ancestor label element", () => {
    document.body.innerHTML = `
      <label>Full name <input type="text" /></label>
    `;
    const { tree } = build();
    expect(tree).toContain('textbox "Full name" |  |  [uid=');
  });

  it("uses title and alt as name fallbacks", () => {
    document.body.innerHTML = `
      <a href="/t" title="TitleName"></a>
      <button title="ButtonTitle"></button>
    `;
    const { tree } = build();
    expect(tree).toContain('link "TitleName"');
    expect(tree).toContain('button "ButtonTitle"');
  });

  it("does not dump textContent for non link/button/heading roles", () => {
    // A container with role=region holds a lot of text; we should not emit the
    // whole textContent as its accessible name.
    document.body.innerHTML = `
      <div role="region">Lots and lots of nested text content here</div>
    `;
    const { tree } = build();
    expect(tree).toContain("region");
    expect(tree).not.toContain("Lots and lots of nested text");
  });

  it("excludes headings in non-verbose mode and includes them in verbose mode", () => {
    document.body.innerHTML = `<h1>Title</h1><h2>Sub</h2>`;
    const nonVerbose = build(false);
    expect(nonVerbose.tree).not.toContain("Title");

    const verbose = build(true);
    expect(verbose.tree).toContain('heading "Title"');
    expect(verbose.tree).toContain('heading "Sub"');
  });

  it("includes aria-label-only elements in verbose mode", () => {
    document.body.innerHTML = `<div aria-label="Decorative region"></div>`;
    const nonVerbose = build(false);
    expect(nonVerbose.tree).not.toContain("Decorative region");

    const verbose = build(true);
    expect(verbose.tree).toContain("Decorative region");
  });

  it("includes contenteditable, summary, [tabindex], [role], and [onclick] elements", () => {
    document.body.innerHTML = `
      <div contenteditable="true" aria-label="Editor"></div>
      <details><summary>Toggle</summary>body</details>
      <span tabindex="0" aria-label="Focusable"></span>
      <div role="tab" aria-label="RoleTab"></div>
    `;
    const { tree } = build();
    expect(tree).toContain('textbox "Editor"');
    expect(tree).toContain('button "Toggle"');
    expect(tree).toContain("Focusable");
    expect(tree).toContain("RoleTab");
  });

  it("truncates the tree at maxLength and reports isTruncated", () => {
    let html = "";
    for (let i = 0; i < 50; i++) {
      html += `<button>Button number ${i}</button>`;
    }
    document.body.innerHTML = html;
    const { tree, isTruncated } = build(false, 40);
    expect(isTruncated).toBe(true);
    expect(tree.length).toBeLessThanOrEqual(40);
  });

  it("does not report truncation when within maxLength", () => {
    document.body.innerHTML = `<button>Tiny</button>`;
    const { isTruncated } = build(false, 25000);
    expect(isTruncated).toBe(false);
  });

  it("truncates at a complete-line boundary so no uid token is cut mid-way", () => {
    let html = "";
    for (let i = 0; i < 30; i++) {
      html += `<button>Btn ${i}</button>`;
    }
    document.body.innerHTML = html;
    // A small maxLength forces truncation partway through a line. The cut must
    // land on a newline boundary so the final emitted line is whole and every
    // `[uid=eN]` token keeps its trailing digits.
    const { tree, isTruncated } = build(false, 45);
    expect(isTruncated).toBe(true);
    // No dangling `[uid=e` without digits anywhere in the output.
    expect(tree).not.toMatch(/\[uid=e\]|\[uid=e$|\[uid=e\D/);
    // Output must end exactly at a complete line (no trailing partial line).
    if (tree.length > 0) {
      expect(tree.endsWith("\n")).toBe(false);
      const lines = tree.split("\n");
      // Every emitted line is a complete entry ending in a closing bracket
      // (optionally followed by a state-flag group).
      for (const line of lines) {
        expect(line).toMatch(/\[uid=e\d+\](?: \([^)]*\))?$/);
      }
    }
    expect(tree.length).toBeLessThanOrEqual(45);
  });

  it("emits an empty tree (truncated) when no complete line fits within maxLength", () => {
    document.body.innerHTML = `<button>A very long button label that overflows</button>`;
    // The single line is longer than maxLength and there is no earlier newline,
    // so nothing can be emitted while keeping the last line complete.
    const { tree, isTruncated } = build(false, 5);
    expect(isTruncated).toBe(true);
    expect(tree).toBe("");
  });

  it("keeps the wrapping-label name in the name slot and shows the selected option in the value slot", () => {
    document.body.innerHTML = `
      <label>Country
        <select>
          <option>United States</option>
          <option>Canada</option>
        </select>
      </label>
    `;
    const { tree } = build();
    // Name slot is the label text only; the selected option surfaces in VALUE.
    expect(tree).toContain('combobox "Country" | "United States" |');
    // The name slot must NOT absorb the option text.
    expect(tree).not.toContain('combobox "Country United States"');
    // Value is shown once (dedup does not fire here — name != value).
    expect(tree).not.toContain('| "United States" | "United States"');
    // Canada is not selected → must not appear anywhere.
    expect(tree).not.toContain("Canada");
  });

  it("excludes contenteditable=\"false\" but includes contenteditable \"\" and \"true\"", () => {
    document.body.innerHTML = `
      <div contenteditable="false">NotEditable</div>
      <div contenteditable="" aria-label="EmptyEditable"></div>
      <div contenteditable="true" aria-label="TrueEditable"></div>
    `;
    const { tree } = build();
    expect(tree).not.toContain("NotEditable");
    // The non-editable div must not be selected at all (no noise `clickable ""`).
    expect(tree).not.toMatch(/clickable ""/);
    expect(tree).toContain("EmptyEditable");
    expect(tree).toContain("TrueEditable");
  });

  it("assigns sequential uids across multiple elements", () => {
    document.body.innerHTML = `
      <a href="/1">One</a>
      <button>Two</button>
      <input type="text" aria-label="Three" />
    `;
    const { tree } = build();
    expect(tree).toContain("[uid=e1]");
    expect(tree).toContain("[uid=e2]");
    expect(tree).toContain("[uid=e3]");
  });

  describe("includePointer (Task 4)", () => {
    it("captures an inline cursor:pointer div by DEFAULT (includePointer defaults true)", () => {
      document.body.innerHTML = `<div style="cursor: pointer">Open</div>`;
      const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
      expect(tree).toMatch(/clickable "Open" \|  \|  \[uid=e\d+\]/);
    });

    it("omits pointer elements when includePointer is explicitly false", () => {
      document.body.innerHTML = `<div style="cursor: pointer">Open</div>`;
      const { tree } = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        includePointer: false,
      });
      expect(tree).not.toContain("Open");
    });

    it("honors maxInteractive as the pointer-pass cap", () => {
      let html = "";
      for (let i = 0; i < 5; i++) html += `<div style="cursor: pointer">P${i}</div>`;
      document.body.innerHTML = html;
      const { tree } = buildSnapshot(document, {
        verbose: false,
        maxLength: 25000,
        maxInteractive: 2,
      });
      const matches = tree.match(/clickable "P\d"/g) || [];
      expect(matches.length).toBe(2);
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

  /**
   * The verbose-only second pass captures "visually clickable" non-semantic
   * elements — `<div onClick={...}>`-style controls that modern React apps
   * (e.g. Linear) build without any role/tabindex/href/onclick attribute.
   * These are invisible to the base pass but carry `cursor: pointer`.
   *
   * jsdom note: jsdom has no layout engine, but it DOES reflect an inline
   * `cursor: pointer` declaration through `getComputedStyle().cursor`. It does
   * NOT compute `cursor: pointer` from a UA/author stylesheet rule or from an
   * element's default behaviour, so the only cursor:pointer inclusions
   * exercisable here are inline-styled ones. Real pages set the cursor through
   * CSS classes — that path is browser-only and not reproducible in jsdom.
   */
  describe("verbose visually-clickable second pass", () => {
    it("does not throw and returns a valid result for a DOM of plain divs (guard is safe)", () => {
      document.body.innerHTML = `
        <div>One</div>
        <div><span>Two</span></div>
        <div>Three</div>
      `;
      expect(() => build(true)).not.toThrow();
      const { tree } = build(true);
      expect(typeof tree).toBe("string");
    });

    it("produces byte-identical base lines in verbose vs non-verbose for a semantic-only DOM", () => {
      // No headings, no aria-label-only, no cursor:pointer elements — so the
      // verbose extras (headings/aria-label/clickable pass) contribute nothing
      // and the output must be exactly the same in both modes.
      document.body.innerHTML = `
        <a href="/home">Home</a>
        <button>Sign in</button>
        <input type="text" aria-label="Name" />
      `;
      const nonVerbose = build(false);
      const verbose = build(true);
      expect(verbose.tree).toBe(nonVerbose.tree);
    });

    it("still surfaces base-pass elements (links/buttons/inputs) in verbose mode", () => {
      document.body.innerHTML = `
        <a href="/home">Home</a>
        <button>Sign in</button>
        <input type="text" aria-label="Name" />
      `;
      const { tree } = build(true);
      expect(tree).toContain('link "Home"');
      expect(tree).toContain('button "Sign in"');
      expect(tree).toContain('textbox "Name"');
    });

    it("captures a non-semantic div with inline cursor:pointer as a clickable (default and verbose)", () => {
      document.body.innerHTML = `<div style="cursor: pointer">Click me</div>`;
      const verbose = build(true);
      expect(verbose.tree).toMatch(/clickable "Click me" \|  \|  \[uid=e\d+\]/);
      // includePointer now defaults true, so the DEFAULT snapshot includes it too.
      const nonVerbose = build(false);
      expect(nonVerbose.tree).toMatch(/clickable "Click me" \|  \|  \[uid=e\d+\]/);
    });

    it("derives the clickable name from aria-label when present", () => {
      document.body.innerHTML = `<div style="cursor: pointer" aria-label="Open menu"></div>`;
      const { tree } = build(true);
      expect(tree).toMatch(/clickable "Open menu" \|  \|  \[uid=e\d+\]/);
    });

    it("skips a cursor:pointer element that has no derivable name (noise)", () => {
      document.body.innerHTML = `<div style="cursor: pointer"></div>`;
      const { tree } = build(true);
      // An empty-named clickable would be pure noise — it must not be emitted.
      expect(tree).not.toMatch(/clickable ""/);
    });

    it("does not capture a cursor:pointer wrapper that contains a stamped descendant (leaf preference)", () => {
      // The wrapper is cursor:pointer but it already contains a real <button>
      // captured by the base pass. Adding the wrapper too would just duplicate
      // a bigger target, so it must be skipped (dedup-by-descendant).
      document.body.innerHTML = `
        <div style="cursor: pointer">Wrapper text
          <button>Inner</button>
        </div>
      `;
      const { tree } = build(true);
      expect(tree).toContain('button "Inner"');
      // The wrapper's own text must not appear as a separate clickable entry.
      expect(tree).not.toMatch(/clickable "Wrapper text"/);
    });

    it("uses only the element's own direct text, not deep textContent of a container", () => {
      // The outer div is cursor:pointer and has direct text "Outer" plus a deep
      // nested span with lots of text. The clickable name must be derived from
      // the immediate text node ("Outer"), never the nested content.
      document.body.innerHTML = `<div style="cursor: pointer">Outer<span>deeply nested content that should not be dumped</span></div>`;
      const { tree } = build(true);
      expect(tree).toMatch(/clickable "Outer" \|  \|  \[uid=e\d+\]/);
      expect(tree).not.toContain("deeply nested content");
    });

    it("does not re-stamp an element already captured by the base pass", () => {
      // A <button> with cursor:pointer is already a base-pass element; the
      // second pass must skip it (it is already stamped) so it appears once.
      document.body.innerHTML = `<button style="cursor: pointer">Only Once</button>`;
      const { tree } = build(true);
      const matches = tree.match(/Only Once/g) || [];
      expect(matches.length).toBe(1);
      expect(tree).toContain('button "Only Once"');
      expect(tree).not.toMatch(/clickable "Only Once"/);
    });

    it("skips hidden cursor:pointer elements", () => {
      document.body.innerHTML = `
        <div style="cursor: pointer; display:none">HiddenClick</div>
        <div style="cursor: pointer" aria-hidden="true">AriaHiddenClick</div>
      `;
      const { tree } = build(true);
      expect(tree).not.toContain("HiddenClick");
      expect(tree).not.toContain("AriaHiddenClick");
    });

    it("carries state flags on a captured clickable", () => {
      document.body.innerHTML = `<div style="cursor: pointer" aria-label="Toggle" aria-expanded="true"></div>`;
      const { tree } = build(true);
      expect(tree).toMatch(/clickable "Toggle" \|  \|  \[uid=e\d+\] \(expanded\)/);
    });

    it("emits full 3-slot grammar for a cursor:pointer clickable", () => {
      document.body.innerHTML = `<div class="card"><h3>Templates</h3><div style="cursor: pointer">Use this</div></div>`;
      const { tree } = build(true);
      expect(tree).toContain('clickable "Use this" |  | Templates [uid=');
    });
  });

  describe("3-slot grammar (Wave 2)", () => {
    it("emits empty value and section slots for a plain link", () => {
      document.body.innerHTML = `<a href="/home">Home</a>`;
      const { tree } = build();
      expect(tree).toContain('link "Home" |  |  [uid=e1]');
    });

    it("emits empty slots for a plain button", () => {
      document.body.innerHTML = `<button>Sign in</button>`;
      const { tree } = build();
      expect(tree).toContain('button "Sign in" |  |  [uid=e1]');
    });

    it("shows a text input's current value in the value slot", () => {
      document.body.innerHTML = `<input type="text" aria-label="Search" value="hello world" />`;
      const { tree } = build();
      expect(tree).toContain('textbox "Search" | "hello world" |  [uid=e1]');
    });

    it("shows a native select's selected option in the value slot", () => {
      document.body.innerHTML = `<select aria-label="Country"><option>US</option><option>UK</option></select>`;
      const { tree } = build();
      expect(tree).toContain('combobox "Country" | "US" |  [uid=e1]');
    });

    it("leaves the value slot empty for a checkbox (state is in flags, not value)", () => {
      document.body.innerHTML = `<input type="checkbox" aria-label="Agree" checked />`;
      const { tree } = build();
      expect(tree).toContain('checkbox "Agree" |  |  [uid=e1] (checked)');
    });

    it("never surfaces a password input's value in the value slot", () => {
      // A typed/autofilled password must NOT leak into the snapshot value slot.
      document.body.innerHTML = `<input type="password" aria-label="Password" value="hunter2" />`;
      const { tree } = build();
      expect(tree).toContain('textbox "Password" |  |  [uid=e1]');
      expect(tree).not.toContain("hunter2");
    });

    it("collapses a literal pipe in slot text to a slash so the delimiter stays unambiguous", () => {
      document.body.innerHTML = `<button>Save | Exit</button>`;
      const { tree } = build();
      expect(tree).toContain('button "Save / Exit" |  |  [uid=e1]');
    });
  });

  describe("custom combobox (react-select) enrichment (Wave 2)", () => {
    it("names a bare react-select from its placeholder child and shows it once (dedup)", () => {
      document.body.innerHTML = `
        <div role="combobox">
          <div class="Select__placeholder">Select a country...</div>
        </div>`;
      const { tree } = build();
      // Placeholder is the only signal → it names the control; the value slot is
      // deduped away (value === name) so it appears exactly once.
      expect(tree).toContain('combobox "Select a country..." |  |  [uid=e1]');
    });

    it("shows the selected value (singleValue child) in the value slot", () => {
      document.body.innerHTML = `
        <div role="combobox" aria-label="Country">
          <div class="Select__single-value">United States</div>
        </div>`;
      const { tree } = build();
      expect(tree).toContain('combobox "Country" | "United States" |  [uid=e1]');
    });

    it("reads aria-valuetext as the value when present", () => {
      document.body.innerHTML = `<div role="combobox" aria-label="Plan" aria-valuetext="Enterprise"></div>`;
      const { tree } = build();
      expect(tree).toContain('combobox "Plan" | "Enterprise" |  [uid=e1]');
    });

    it("widens the textContent fallback to an explicit-role combobox with no attrs/children", () => {
      document.body.innerHTML = `<div role="combobox">Account-scoped</div>`;
      const { tree } = build();
      expect(tree).toContain('combobox "Account-scoped" |  |  [uid=e1]');
    });
  });

  describe("section breadcrumb slot (Wave 2)", () => {
    it("uses a fieldset legend as the breadcrumb", () => {
      document.body.innerHTML = `
        <fieldset>
          <legend>Billing address</legend>
          <input type="text" aria-label="Street" />
        </fieldset>`;
      const { tree } = build();
      expect(tree).toContain('textbox "Street" |  | Billing address [uid=e1]');
    });

    it("uses a titled card's heading as the breadcrumb (disambiguates repeats)", () => {
      document.body.innerHTML = `
        <div class="card"><h3>Zone resources</h3><button>Use template</button></div>
        <div class="card"><h3>Account resources</h3><button>Use template</button></div>`;
      const { tree } = build();
      expect(tree).toContain('button "Use template" |  | Zone resources [uid=e1]');
      expect(tree).toContain('button "Use template" |  | Account resources [uid=e2]');
    });

    it("uses aria-labelledby on a titled container", () => {
      document.body.innerHTML = `
        <h2 id="sec">API tokens</h2>
        <div role="group" aria-labelledby="sec"><button>Create</button></div>`;
      const { tree } = build();
      expect(tree).toContain('button "Create" |  | API tokens [uid=');
    });

    it("walks ancestors + previous siblings to the nearest heading when no container matches", () => {
      document.body.innerHTML = `
        <h2>Account settings</h2>
        <div><button>Save</button></div>`;
      const { tree } = build();
      expect(tree).toContain('button "Save" |  | Account settings [uid=e1]');
    });

    it("leaves the breadcrumb empty when there is no titled context", () => {
      document.body.innerHTML = `<button>Standalone</button>`;
      const { tree } = build();
      expect(tree).toContain('button "Standalone" |  |  [uid=e1]');
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
 * `[snapshot: 0 elements]`. Mirrored by the block in
 * chrome-extension/__tests__/snapshot-script.test.ts.
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

/**
 * Pins the exact output for a representative light-DOM page in every mode,
 * captured from the implementation that predates the shadow-DOM walk. The
 * flat-tree walk, root-aware names and composed text must be invisible on a
 * page with no shadow roots and no role wrappers; this is the byte-for-byte
 * guard for that promise.
 */
describe("light-DOM output is unchanged by the flat-tree walk", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  const PAGE = `
<header>
  <nav id="top"><a href="/home">Home</a> <a href="/docs" title="Documentation">Docs</a></nav>
</header>
<main id="main">
  <h1>Account settings</h1>
  <section>
    <h2>Profile</h2>
    <label for="name">Full name</label><input id="name" type="text" value="Ada" />
    <label>Email <input type="email" required /></label>
    <span id="bio-l">Biography</span><textarea aria-labelledby="bio-l">Hello</textarea>
    <select aria-label="Country"><option>US</option><option selected>UK</option></select>
  </section>
  <fieldset><legend>Notifications</legend>
    <input type="checkbox" aria-label="Email me" checked />
    <input type="radio" name="f" aria-label="Daily" />
  </fieldset>
  <div class="card"><h3>Danger zone</h3><button disabled>Delete account</button><div style="cursor: pointer">Export data</div></div>
  <div role="tablist"><div role="tab" aria-selected="true">General</div><div role="tab">Security</div></div>
  <ul role="listbox"><li role="option">E2E</li><li role="option" aria-selected="true">PRD</li></ul>
  <div contenteditable="true" aria-label="Notes"></div>
  <details><summary>More</summary><p>Details body text</p></details>
  <span tabindex="0">Focusable span</span>
  <div onclick="void 0">Inline handler</div>
  <button hidden>Hidden button</button>
  <button style="display:none">Gone</button>
  <div aria-hidden="true"><a href="/x">Aria hidden link</a></div>
  <p>Some paragraph mentioning the quarterly report.</p>
  <div style="cursor: pointer">Outer<span>deep text</span></div>
  <div style="cursor: pointer" aria-label="Icon only"></div>
  <div style="cursor: pointer">Wrapper <button>Inner</button></div>
</main>`;

  const BASE = [
    'link "Home" |  |  [uid=e1]',
    'link "Documentation" |  |  [uid=e2]',
    'textbox "Full name" | "Ada" | Profile [uid=e3]',
    'textbox "Email" |  | Profile [uid=e4] (required)',
    'textbox "Biography" | "Hello" | Biography [uid=e5]',
    'combobox "Country" | "UK" | Profile [uid=e6]',
    'checkbox "Email me" |  | Notifications [uid=e7] (checked)',
    'radio "Daily" |  | Notifications [uid=e8]',
    'button "Delete account" |  | Danger zone [uid=e9] (disabled)',
    'tablist "" |  |  [uid=e10]',
    'tab "General" |  | Account settings [uid=e11] (selected)',
    'tab "Security" |  | Account settings [uid=e12]',
    'listbox "" |  |  [uid=e13]',
    'option "E2E" |  | Account settings [uid=e14]',
    'option "PRD" |  | Account settings [uid=e15] (selected)',
    'textbox "Notes" |  |  [uid=e16]',
    'button "More" |  | Account settings [uid=e17]',
    'clickable "" |  |  [uid=e18]',
    'clickable "" |  |  [uid=e19]',
    'link "Aria hidden link" |  | Account settings [uid=e20]',
    'button "Inner" |  | Account settings [uid=e21]',
  ];
  const CASES: Array<[string, Record<string, unknown>, string[], number, boolean]> = [
    [
      "default",
      {},
      BASE.concat([
        'clickable "Export data" |  | Danger zone [uid=e22]',
        'clickable "Outer" |  |  [uid=e23]',
        'clickable "Icon only" |  |  [uid=e24]',
      ]),
      24,
      false,
    ],
    [
      "verbose",
      { verbose: true },
      [
        'link "Home" |  |  [uid=e1]',
        'link "Documentation" |  |  [uid=e2]',
        'heading "Account settings" |  |  [uid=e3]',
        'heading "Profile" |  | Profile [uid=e4]',
        'textbox "Full name" | "Ada" | Profile [uid=e5]',
        'textbox "Email" |  | Profile [uid=e6] (required)',
        'textbox "Biography" | "Hello" | Biography [uid=e7]',
        'combobox "Country" | "UK" | Profile [uid=e8]',
        'checkbox "Email me" |  | Notifications [uid=e9] (checked)',
        'radio "Daily" |  | Notifications [uid=e10]',
        'heading "Danger zone" |  | Danger zone [uid=e11]',
        'button "Delete account" |  | Danger zone [uid=e12] (disabled)',
        'tablist "" |  |  [uid=e13]',
        'tab "General" |  | Account settings [uid=e14] (selected)',
        'tab "Security" |  | Account settings [uid=e15]',
        'listbox "" |  |  [uid=e16]',
        'option "E2E" |  | Account settings [uid=e17]',
        'option "PRD" |  | Account settings [uid=e18] (selected)',
        'textbox "Notes" |  |  [uid=e19]',
        'button "More" |  | Account settings [uid=e20]',
        'clickable "" |  |  [uid=e21]',
        'clickable "" |  |  [uid=e22]',
        'link "Aria hidden link" |  | Account settings [uid=e23]',
        'clickable "Icon only" |  |  [uid=e24]',
        'button "Inner" |  | Account settings [uid=e25]',
        'clickable "Export data" |  | Danger zone [uid=e26]',
        'clickable "Outer" |  |  [uid=e27]',
      ],
      27,
      false,
    ],
    ["includePointer:false", { includePointer: false }, BASE, 21, false],
    [
      "textContains (paragraph text)",
      { textContains: "quarterly" },
      ['clickable "Some paragraph mentioning the quarterly report." |  |  [uid=e1]'],
      1,
      false,
    ],
    [
      "textContains (text inside <details>)",
      { textContains: "details body" },
      ['clickable "Details body text" |  | Account settings [uid=e1]'],
      1,
      false,
    ],
    [
      "selector",
      { selector: "input, select" },
      [
        'textbox "Full name" | "Ada" | Profile [uid=e1]',
        'textbox "Email" |  | Profile [uid=e2] (required)',
        'combobox "Country" | "UK" | Profile [uid=e3]',
        'checkbox "Email me" |  | Notifications [uid=e4] (checked)',
        'radio "Daily" |  | Notifications [uid=e5]',
      ],
      5,
      false,
    ],
    [
      "rootSelector + offset/limit",
      { rootSelector: "#main", offset: 2, limit: 4 },
      [
        'textbox "Biography" | "Hello" | Biography [uid=e3]',
        'combobox "Country" | "UK" | Profile [uid=e4]',
        'checkbox "Email me" |  | Notifications [uid=e5] (checked)',
        'radio "Daily" |  | Notifications [uid=e6]',
      ],
      22,
      true,
    ],
  ];

  it.each(CASES)("%s", (_label, extra, lines, total, hasMore) => {
    document.body.innerHTML = PAGE;
    const res = buildSnapshot(document, { verbose: false, maxLength: 25000, ...extra });
    expect(res.tree).toBe(lines.join("\n"));
    expect(res.total).toBe(total);
    expect(res.hasMore).toBe(hasMore);
    expect(res.isTruncated).toBe(false);
  });
});

// --- shadow-DOM fixtures -----------------------------------------------------

/** Append a new `tag` element to `parent`, give it `light` children, attach a shadow root holding `html`. */
function attachHost(
  tag: string,
  html: string,
  opts: { mode?: "open" | "closed"; parent?: ParentNode; light?: string; style?: string } = {}
): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement(tag);
  if (opts.style) host.setAttribute("style", opts.style);
  if (opts.light) host.innerHTML = opts.light;
  (opts.parent || document.body).appendChild(host);
  const root = host.attachShadow({ mode: opts.mode || "open" });
  root.innerHTML = html;
  return { host, root };
}

/**
 * Firefox's content-script-only API: a read-only `openOrClosedShadowRoot`
 * PROPERTY on Element (open or closed). jsdom has neither API, so stub it.
 */
function withFirefoxClosedRoots(
  roots: Map<Element, ShadowRoot>,
  fn: () => void,
  onProbe?: (el: Element) => void
): void {
  Object.defineProperty(Element.prototype, "openOrClosedShadowRoot", {
    configurable: true,
    get(this: Element) {
      if (onProbe) onProbe(this);
      return this.shadowRoot || roots.get(this) || null;
    },
  });
  try {
    fn();
  } finally {
    delete (Element.prototype as any).openOrClosedShadowRoot;
  }
}

/**
 * Chrome's content-script-only API: `chrome.dom.openOrClosedShadowRoot(el)`, a
 * FUNCTION that throws for non-HTMLElements. The Chrome jest setup installs a
 * `chrome` mock without `dom`; the Firefox setup has no `chrome` at all.
 */
function withChromeDom(
  roots: Map<Element, ShadowRoot>,
  fn: () => void,
  onProbe?: (el: Element) => void
): void {
  const g = globalThis as any;
  const hadChrome = typeof g.chrome !== "undefined";
  if (!hadChrome) g.chrome = {};
  const prevDom = g.chrome.dom;
  g.chrome.dom = {
    openOrClosedShadowRoot(el: Element) {
      if (onProbe) onProbe(el);
      if (!(el instanceof HTMLElement)) throw new TypeError("Error in invocation of dom.openOrClosedShadowRoot");
      return el.shadowRoot || roots.get(el) || null;
    },
  };
  try {
    fn();
  } finally {
    if (prevDom === undefined) delete g.chrome.dom;
    else g.chrome.dom = prevDom;
    if (!hadChrome) delete g.chrome;
  }
}

function snap(extra: Record<string, unknown> = {}) {
  return buildSnapshot(document, { verbose: false, maxLength: 25000, ...extra });
}

/** Every uid value stamped anywhere: the document tree plus the given shadow roots. */
function stampedUids(roots: ParentNode[]): string[] {
  const out: string[] = [];
  for (const r of [document as ParentNode].concat(roots)) {
    r.querySelectorAll("[data-bcmcp-uid]").forEach((el) => out.push(el.getAttribute("data-bcmcp-uid")!));
  }
  return out;
}

/** An App Store Connect-style header: nav in an open root, a nested root inside it, light main, footer root. */
function buildAmpPage() {
  document.body.innerHTML = `<header id="top"></header><main><h1>Apps</h1><p>Main content paragraph</p><button>Light Button</button></main><footer id="foot"></footer>`;
  const nav = attachHost(
    "amp-nav",
    `<nav aria-label="Primary"><a href="#apps">Apps</a><a href="#business">Business</a><button>Users and Access</button><button aria-label="Account menu"><svg></svg></button><h2>Account</h2></nav>`,
    { parent: document.getElementById("top")! }
  );
  const menu = attachHost("amp-account-menu", `<button>Sign Out</button>`, {
    parent: nav.root.querySelector("nav")!,
  });
  const footer = attachHost("amp-footer", `<a href="#privacy">Privacy</a><a href="#terms">Terms</a>`, {
    parent: document.getElementById("foot")!,
  });
  return { nav, menu, footer };
}

describe("shadow DOM: the snapshot walks the flat tree", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("lists controls in open and nested shadow roots in reading order and stamps uids inside them", () => {
    const { nav, menu } = buildAmpPage();
    const { tree } = snap();
    expect(tree).toBe(
      [
        'link "Apps" |  |  [uid=e1]',
        'link "Business" |  |  [uid=e2]',
        'button "Users and Access" |  |  [uid=e3]',
        'button "Account menu" |  |  [uid=e4]',
        'button "Sign Out" |  |  [uid=e5]',
        'button "Light Button" |  |  [uid=e6]',
        'link "Privacy" |  |  [uid=e7]',
        'link "Terms" |  |  [uid=e8]',
      ].join("\n")
    );
    const users = nav.root.querySelectorAll("button")[0];
    expect(users.getAttribute("data-bcmcp-uid")).toBe("e3");
    expect(users.getAttribute("data-bcmcp-sig")).toBeTruthy();
    expect(menu.root.querySelector("button")!.getAttribute("data-bcmcp-uid")).toBe("e5");
  });

  it("renders slotted children once at their slot, fallback content when nothing is assigned, and skips unassigned children", () => {
    document.body.innerHTML = `<main id="m"></main>`;
    attachHost(
      "amp-card",
      `<div><h3><slot name="title">Fallback title</slot></h3><slot></slot><slot name="empty"><button>Fallback button</button></slot><button>Card action</button></div>`,
      {
        parent: document.getElementById("m")!,
        light: `<span slot="title">Slotted Title</span><a href="#slotted">Slotted link</a><button slot="nope">Unassigned</button>`,
      }
    );
    const { tree } = snap();
    // The heading's breadcrumb is the SLOTTED title, not the slot's fallback text.
    expect(tree).toBe(
      [
        'link "Slotted link" |  |  [uid=e1]',
        'button "Fallback button" |  | Slotted Title [uid=e2]',
        'button "Card action" |  |  [uid=e3]',
      ].join("\n")
    );
    expect(tree).not.toContain("Unassigned");
    expect(snap({ verbose: true }).tree).toContain('heading "Slotted Title"');
  });

  it("does not reach a CLOSED root without the extension APIs (page world)", () => {
    document.body.innerHTML = `<div id="w"></div>`;
    attachHost("amp-secret", `<button>Closed Button</button>`, {
      mode: "closed",
      parent: document.getElementById("w")!,
    });
    expect(snap().tree).not.toContain("Closed Button");
  });

  it("reaches a CLOSED root through Firefox's openOrClosedShadowRoot property", () => {
    document.body.innerHTML = `<div id="w"></div>`;
    const secret = attachHost("amp-secret", `<button>Closed Button</button>`, {
      mode: "closed",
      parent: document.getElementById("w")!,
    });
    const publish = attachHost("x-closed-btn", `<button><slot></slot></button>`, {
      mode: "closed",
      parent: document.getElementById("w")!,
      light: "Publish",
    });
    withFirefoxClosedRoots(
      new Map([
        [secret.host, secret.root],
        [publish.host, publish.root],
      ]),
      () => {
        const { tree } = snap();
        expect(tree).toBe(['button "Closed Button" |  |  [uid=e1]', 'button "Publish" |  |  [uid=e2]'].join("\n"));
        expect(secret.root.querySelector("button")!.getAttribute("data-bcmcp-uid")).toBe("e1");
        // rootSelector reaches into the closed root as well.
        expect(snap({ rootSelector: "x-closed-btn" }).tree).toBe('button "Publish" |  |  [uid=e1]');
      }
    );
  });

  it("reaches a CLOSED root through chrome.dom.openOrClosedShadowRoot", () => {
    document.body.innerHTML = `<div id="w"><svg><g></g></svg></div>`;
    const secret = attachHost("amp-secret", `<button>Closed Button</button>`, {
      mode: "closed",
      parent: document.getElementById("w")!,
    });
    withChromeDom(new Map([[secret.host, secret.root]]), () => {
      const { tree } = snap();
      expect(tree).toBe('button "Closed Button" |  |  [uid=e1]');
      expect(secret.root.querySelector("button")!.getAttribute("data-bcmcp-uid")).toBe("e1");
    });
  });

  it("probes each element's closed root at most once per snapshot (the extension APIs are slow)", () => {
    buildAmpPage();
    const secret = attachHost("amp-secret", `<button>Closed Button</button>`, { mode: "closed" });
    const roots = new Map([[secret.host, secret.root]]);
    const probes = new Map<Element, number>();
    const count = (el: Element) => probes.set(el, (probes.get(el) || 0) + 1);
    const modes: Array<Record<string, unknown>> = [
      {},
      { verbose: true },
      { textContains: "closed button" },
      { selector: "button" },
      { rootSelector: "amp-secret" },
    ];
    for (const install of [withFirefoxClosedRoots, withChromeDom]) {
      install(
        roots,
        () => {
          for (const extra of modes) {
            probes.clear();
            expect(snap(extra).tree).toContain('button "Closed Button"');
            expect(probes.size).toBeGreaterThan(0);
            expect(Math.max(...Array.from(probes.values()))).toBe(1);
          }
        },
        count
      );
    }
  });

  it("maps a light child of a CLOSED host to its slot from the root side (assignedSlot is null there)", () => {
    document.body.innerHTML = `<div id="w"></div>`;
    const c = attachHost(
      "amp-closed-slots",
      `<div style="display:none"><slot name="hidden"></slot></div><div><slot name="shown"></slot></div>`,
      {
        mode: "closed",
        parent: document.getElementById("w")!,
        light: `<button slot="hidden">Hidden via slot</button><button slot="shown">Shown via slot</button>`,
      }
    );
    withFirefoxClosedRoots(new Map([[c.host, c.root]]), () => {
      expect(snap().tree).toBe('button "Shown via slot" |  |  [uid=e1]');
    });
  });

  // An <svg><slot> (icon sets ship them) parses as an SVG element whose
  // localName is "slot" but that has no assignedNodes / assignedElements. The
  // flat-tree helpers must treat it as a plain element, not abort the walk.
  it("walks past an <svg><slot> in an OPEN root (default, verbose and textContains)", () => {
    document.body.innerHTML = `<div id="w"></div>`;
    attachHost(
      "x-icon-card",
      `<svg><slot></slot></svg><button><svg><slot name="icon"></slot></svg>Icon Button</button><button>Plain Button</button>`,
      { parent: document.getElementById("w")!, light: `<span>Light child</span>` }
    );
    expect(snap().tree).toBe(['button "Icon Button" |  |  [uid=e1]', 'button "Plain Button" |  |  [uid=e2]'].join("\n"));
    expect(snap({ verbose: true }).tree).toContain('button "Plain Button"');
    expect(snap({ textContains: "plain button" }).tree).toBe('button "Plain Button" |  |  [uid=e1]');
  });

  it("walks past an <svg><slot> in a CLOSED root, incl. the root-side slot lookup for its light children", () => {
    document.body.innerHTML = `<div id="w"></div>`;
    const c = attachHost("x-closed-icon-card", `<svg><slot></slot></svg><div><slot></slot></div><button>Closed Plain</button>`, {
      mode: "closed",
      parent: document.getElementById("w")!,
      light: `<div id="slotted"><button>Slotted Light</button></div>`,
    });
    for (const install of [withFirefoxClosedRoots, withChromeDom]) {
      install(new Map([[c.host, c.root]]), () => {
        expect(snap().tree).toBe(['button "Slotted Light" |  |  [uid=e1]', 'button "Closed Plain" |  |  [uid=e2]'].join("\n"));
        // Scoped to the light child: only its hidden-ancestor climb (the
        // root-side slot lookup) meets the <svg><slot>.
        expect(snap({ rootSelector: "#slotted" }).tree).toBe('button "Slotted Light" |  |  [uid=e1]');
      });
    }
  });

  it("excludes controls in a display:none host or under a display:none ancestor of the host", () => {
    document.body.innerHTML = `<div id="a"></div><div id="b" style="display:none"></div><div id="c"></div>`;
    attachHost("x-hidden", `<button>Inside Hidden Host</button>`, {
      parent: document.getElementById("a")!,
      style: "display:none",
    });
    attachHost("x-deep", `<button>Under Hidden Ancestor</button>`, { parent: document.getElementById("b")! });
    attachHost("x-shown", `<button>Visible Shadow Button</button>`, { parent: document.getElementById("c")! });
    expect(snap().tree).toBe('button "Visible Shadow Button" |  |  [uid=e1]');
  });

  it("clears stale uids left inside open and closed shadow roots, so no uid is issued twice", () => {
    document.body.innerHTML = `<button>Light</button><div id="h"></div>`;
    const open = attachHost(
      "x-open",
      `<span data-bcmcp-uid="e1" data-bcmcp-sig="x">stale</span><button data-bcmcp-uid="e9">Shadow</button>`,
      { parent: document.getElementById("h")! }
    );
    const closed = attachHost("x-closed", `<i data-bcmcp-uid="e2" data-bcmcp-sig="y">stale closed</i>`, {
      mode: "closed",
      parent: document.getElementById("h")!,
    });
    withFirefoxClosedRoots(new Map([[closed.host, closed.root]]), () => {
      const { tree } = snap();
      expect(tree).toBe(['button "Light" |  |  [uid=e1]', 'button "Shadow" |  |  [uid=e2]'].join("\n"));
      expect(open.root.querySelector("span")!.hasAttribute("data-bcmcp-uid")).toBe(false);
      expect(open.root.querySelector("span")!.hasAttribute("data-bcmcp-sig")).toBe(false);
      expect(closed.root.querySelector("i")!.hasAttribute("data-bcmcp-uid")).toBe(false);
      const uids = stampedUids([open.root, closed.root]);
      expect(uids.sort()).toEqual(["e1", "e2"]);
    });
  });

  it("names controls from label[for] / aria-labelledby in their OWN shadow root, not the document", () => {
    document.body.innerHTML = `<label for="q">Wrong label</label><span id="plat">Wrong</span><div id="s"></div>`;
    attachHost(
      "amp-search",
      `<label for="q">Search apps</label><input id="q" type="search"><span id="plat">Platform</span><select aria-labelledby="plat"><option>iOS</option><option>macOS</option><option>tvOS</option></select>`,
      { parent: document.getElementById("s")! }
    );
    expect(snap().tree).toBe(
      // (The select's own aria-labelledby doubles as its section breadcrumb —
      // getSection's closest() includes the element itself, as on light DOM.)
      ['searchbox "Search apps" |  |  [uid=e1]', 'combobox "Platform" | "iOS" | Platform [uid=e2]'].join("\n")
    );
  });

  it("names a shadow button from text slotted into it (name from composed contents)", () => {
    document.body.innerHTML = `<x-btn id="xb">Save draft</x-btn>`;
    document.getElementById("xb")!.attachShadow({ mode: "open" }).innerHTML = `<button><slot></slot></button>`;
    expect(snap().tree).toBe('button "Save draft" |  |  [uid=e1]');
  });

  it("runs the pointer pass inside shadow roots and skips a light wrapper around a stamped shadow control", () => {
    document.body.innerHTML = `<div id="h"></div><div id="card" style="cursor: pointer">Card body</div>`;
    attachHost("x-tiles", `<div style="cursor: pointer">Pointer Tile</div>`, { parent: document.getElementById("h")! });
    attachHost("x-inner", `<button>Inner action</button>`, { parent: document.getElementById("card")! });
    expect(snap().tree).toBe(
      ['button "Inner action" |  |  [uid=e1]', 'clickable "Pointer Tile" |  |  [uid=e2]'].join("\n")
    );
  });

  it("verbose mode includes headings inside shadow roots", () => {
    buildAmpPage();
    const { tree } = snap({ verbose: true });
    expect(tree).toContain('heading "Account" |  |  [uid=');
    expect(tree).toContain('heading "Apps" |  |  [uid=');
  });

  it("textContains finds text inside open and nested shadow roots", () => {
    buildAmpPage();
    expect(snap({ textContains: "users and access" }).tree).toBe('button "Users and Access" |  |  [uid=e1]');
    expect(snap({ textContains: "Sign out" }).tree).toBe('button "Sign Out" |  |  [uid=e1]');
  });

  it("textContains ignores text that exists only in unassigned light children", () => {
    document.body.innerHTML = `<div id="m"></div>`;
    attachHost("amp-card", `<slot name="title"></slot><button>Card action</button>`, {
      parent: document.getElementById("m")!,
      light: `<button slot="nope">Unassigned</button>`,
    });
    expect(snap({ textContains: "unassigned" }).total).toBe(0);
  });

  it("rootSelector on a host scopes to its shadow content", () => {
    buildAmpPage();
    expect(snap({ rootSelector: "amp-nav" }).tree).toBe(
      [
        'link "Apps" |  |  [uid=e1]',
        'link "Business" |  |  [uid=e2]',
        'button "Users and Access" |  |  [uid=e3]',
        'button "Account menu" |  |  [uid=e4]',
        'button "Sign Out" |  |  [uid=e5]',
      ].join("\n")
    );
  });

  it("rootSelector can match an element inside a shadow root (document tree first)", () => {
    buildAmpPage();
    const inner = snap({ rootSelector: "nav" });
    expect(inner.error).toBeUndefined();
    expect(inner.total).toBe(5);
    expect(inner.tree).toContain('link "Apps"');
    expect(inner.tree).not.toContain("Light Button");
    expect(snap({ rootSelector: "amp-account-menu" }).tree).toBe('button "Sign Out" |  |  [uid=e1]');
    // A document-tree match wins over one inside a shadow tree.
    const lightNav = document.createElement("nav");
    lightNav.innerHTML = `<a href="#light">Light nav link</a>`;
    document.body.appendChild(lightNav);
    expect(snap({ rootSelector: "nav" }).tree).toBe('link "Light nav link" |  |  [uid=e1]');
    // Error strings are unchanged.
    expect(snap({ rootSelector: "#nope" }).error).toBe("rootSelector matched no element: #nope");
    expect(snap({ rootSelector: ":::" }).error).toBe("Invalid rootSelector: :::");
  });

  it("selector mode matches inside each shadow tree, in flat-tree order", () => {
    buildAmpPage();
    expect(snap({ selector: "button" }).tree).toBe(
      [
        'button "Users and Access" |  |  [uid=e1]',
        'button "Account menu" |  |  [uid=e2]',
        'button "Sign Out" |  |  [uid=e3]',
        'button "Light Button" |  |  [uid=e4]',
      ].join("\n")
    );
    // Combinators work within a tree but (standard CSS) never across a boundary.
    expect(snap({ selector: "nav a" }).tree).toBe(
      ['link "Apps" |  |  [uid=e1]', 'link "Business" |  |  [uid=e2]'].join("\n")
    );
    expect(snap({ selector: "amp-nav button" }).total).toBe(0);
    expect(snap({ selector: "::::bad" }).error).toBe("Invalid CSS selector: ::::bad");
    // selector AND textContains compose through shadow roots too.
    expect(snap({ selector: "button", textContains: "sign out" }).tree).toBe('button "Sign Out" |  |  [uid=e1]');
  });

  it("keeps a shadow root's <style> text out of names and text matches", () => {
    document.body.innerHTML = `<ul role="menu"><li role="menuitem"><x-button id="xb">Rename</x-button></li><x-item id="xi" role="menuitem" tabindex="0">Delete</x-item></ul>`;
    document.getElementById("xb")!.attachShadow({ mode: "open" }).innerHTML = `<style>button { color: red }</style><button><slot></slot></button>`;
    document.getElementById("xi")!.attachShadow({ mode: "open" }).innerHTML = `<style>:host { display: block }</style><slot></slot>`;
    expect(snap().tree).toBe(
      ['menu "" |  |  [uid=e1]', 'menuitem "Rename" |  |  [uid=e2] (via inner button)', 'menuitem "Delete" |  |  [uid=e3]'].join("\n")
    );
    expect(snap({ textContains: "color" }).total).toBe(0);
  });
});

describe("textContains also matches the accessible name", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("matches an icon-only button by its aria-label", () => {
    document.body.innerHTML = `<button aria-label="Close"><svg></svg></button><p>Nothing here</p>`;
    expect(snap({ textContains: "close" }).tree).toBe('button "Close" |  |  [uid=e1]');
  });

  it("matches aria-labelledby, title and alt names", () => {
    document.body.innerHTML = `<span id="gear-l" style="display:none">Gear settings</span><div role="button" tabindex="0" aria-labelledby="gear-l"></div>`;
    const lb = snap({ textContains: "gear" });
    expect(lb.total).toBe(1);
    expect(lb.tree).toContain('button "Gear settings" |');

    document.body.innerHTML = `<a href="/s" title="Open settings"><svg></svg></a>`;
    expect(snap({ textContains: "settings" }).tree).toBe('link "Open settings" |  |  [uid=e1]');

    document.body.innerHTML = `<img src="logo.png" alt="Company logo">`;
    expect(snap({ textContains: "logo" }).tree).toBe('clickable "Company logo" |  |  [uid=e1]');
  });

  it("matches a form control by its <label> name", () => {
    document.body.innerHTML = `<label for="em">Email address</label><input id="em" type="email">`;
    expect(snap({ textContains: "email" }).tree).toContain('textbox "Email address" |  |  [uid=');
  });

  it("does not turn every element inside a <label> into a name match", () => {
    document.body.innerHTML = `<label class="ant-checkbox-wrapper"><span class="ant-checkbox"><input type="checkbox" class="ant-checkbox-input"><span class="ant-checkbox-inner"></span></span><span>Remember me</span></label>`;
    expect(snap({ textContains: "remember" }).tree).toBe(
      ['checkbox "Remember me" |  |  [uid=e1]', 'clickable "Remember me" |  |  [uid=e2]'].join("\n")
    );
  });

  it("matches an aria-label inside a shadow root", () => {
    buildAmpPage();
    expect(snap({ textContains: "account menu" }).tree).toBe('button "Account menu" |  |  [uid=e1]');
  });
});

describe("role-wrapper collapse", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  const MENU = `<ul role="menu"><li role="menuitem"><button tabindex="0">Draft macOS Submission (1)<p>Started by Jane Today at 11:21 AM</p></button></li><li role="menuitem"><button tabindex="0">Draft iOS Submission (2)<p>Started by Bob Yesterday</p></button></li><li role="menuitem" onclick="void 0"><span>Delete draft</span></li></ul>`;

  it("lists a menuitem wrapping one same-named button once, with the uid on the button", () => {
    document.body.innerHTML = MENU;
    const { tree, total } = snap();
    expect(tree).toBe(
      [
        'menu "" |  |  [uid=e1]',
        'menuitem "Draft macOS Submission (1)Started by Jane Today at 11:21 AM" |  |  [uid=e2] (via inner button)',
        'menuitem "Draft iOS Submission (2)Started by Bob Yesterday" |  |  [uid=e3] (via inner button)',
        'menuitem "Delete draft" |  |  [uid=e4]',
      ].join("\n")
    );
    expect(total).toBe(4);
    const [li1, , li3] = Array.from(document.querySelectorAll("li"));
    const b1 = li1.querySelector("button")!;
    expect(b1.getAttribute("data-bcmcp-uid")).toBe("e2");
    expect(b1.getAttribute("data-bcmcp-sig")).toBeTruthy();
    expect(li1.hasAttribute("data-bcmcp-uid")).toBe(false);
    // The li whose own handler does the work keeps the uid itself.
    expect(li3.getAttribute("data-bcmcp-uid")).toBe("e4");
  });

  it("keeps the wrapper's own states on the collapsed row", () => {
    document.body.innerHTML = `<div role="listbox"><div role="option" aria-selected="true"><button>US</button></div><div role="option"><button>UK</button></div></div>`;
    expect(snap().tree).toBe(
      [
        'listbox "" |  |  [uid=e1]',
        'option "US" |  |  [uid=e2] (selected, via inner button)',
        'option "UK" |  |  [uid=e3] (via inner button)',
      ].join("\n")
    );
  });

  it("does not collapse a label wrapping a checkbox or radio (no wrapper role)", () => {
    document.body.innerHTML = `<label><span class="box"><input type="checkbox"><span class="inner"></span></span><span>Remember me</span></label><label><input type="radio" name="r"> Daily</label>`;
    expect(snap().tree).toBe(['checkbox "Remember me" |  |  [uid=e1]', 'radio "Daily" |  |  [uid=e2]'].join("\n"));
  });

  it("does not collapse multiple controls, a differently-named control, or a wrapper with none", () => {
    document.body.innerHTML = `<div role="row" aria-label="Order 42"><button>Edit</button><button>Delete</button></div><div role="tab" aria-label="Settings tab"><button>Settings</button></div><div role="option">E2E</div><div role="gridcell"><span tabindex="-1">Not in tab order</span></div>`;
    expect(snap().tree).toBe(
      [
        'row "Order 42" |  |  [uid=e1]',
        'button "Edit" |  |  [uid=e2]',
        'button "Delete" |  |  [uid=e3]',
        'tab "Settings tab" |  |  [uid=e4]',
        'button "Settings" |  |  [uid=e5]',
        'option "E2E" |  |  [uid=e6]',
        'gridcell "Not in tab order" |  |  [uid=e7]',
        'clickable "" |  |  [uid=e8]',
      ].join("\n")
    );
  });

  it("lists nested list/grid wrappers that collapse onto one control as that control's own row", () => {
    document.body.innerHTML = `<div role="listitem" aria-label="Open file"><div role="gridcell"><a href="/f">Open file</a></div></div>`;
    const { tree } = snap();
    expect(tree).toBe('link "Open file" |  |  [uid=e1]');
    expect(document.querySelector("a")!.getAttribute("data-bcmcp-uid")).toBe("e1");
  });

  it("compares names whitespace-collapsed and case-insensitively", () => {
    document.body.innerHTML = `<div role="menu"><div role="menuitem" aria-label="  sign   OUT "><button>Sign out</button></div><div role="menuitem">
        <a href="/p">Profile</a>
      </div></div>`;
    expect(snap().tree).toBe(
      [
        'menu "" |  |  [uid=e1]',
        'menuitem "sign OUT" |  |  [uid=e2] (via inner button)',
        'menuitem "Profile" |  |  [uid=e3] (via inner link)',
      ].join("\n")
    );
  });

  it("ignores hidden interactive descendants when counting", () => {
    document.body.innerHTML = `<div role="menuitem" aria-label="Archive"><button>Archive</button><button style="display:none">Archive</button></div>`;
    expect(snap().tree).toBe('menuitem "Archive" |  |  [uid=e1] (via inner button)');
  });

  it("does not re-list a collapsed cursor:pointer wrapper in the pointer pass", () => {
    document.body.innerHTML = `<div role="menuitem" style="cursor: pointer"><button>Rename</button></div>`;
    expect(snap().tree).toBe('menuitem "Rename" |  |  [uid=e1] (via inner button)');
  });

  it("collapses onto a control inside a shadow root", () => {
    document.body.innerHTML = `<div role="tab" aria-label="Apps"><x-tab id="t"></x-tab></div>`;
    const root = document.getElementById("t")!.attachShadow({ mode: "open" });
    root.innerHTML = `<button>Apps</button>`;
    expect(snap().tree).toBe('tab "Apps" |  |  [uid=e1] (via inner button)');
    expect(root.querySelector("button")!.getAttribute("data-bcmcp-uid")).toBe("e1");
  });

  it("textContains renders a matched inner control as its collapsing wrapper's row", () => {
    document.body.innerHTML = MENU;
    const { tree } = snap({ textContains: "draft macos" });
    expect(tree).toBe(
      'menuitem "Draft macOS Submission (1)Started by Jane Today at 11:21 AM" |  |  [uid=e1] (via inner button)'
    );
    expect(document.querySelector("li button")!.getAttribute("data-bcmcp-uid")).toBe("e1");
  });

  it("selector mode lists exactly the matches and hints at a match's single inner control", () => {
    document.body.innerHTML = MENU;
    const res = snap({ selector: 'li[role="menuitem"]' });
    expect(res.tree).toBe(
      [
        'menuitem "Draft macOS Submission (1)Started by Jane Today at 11:21 AM" |  |  [uid=e1] (wraps button [uid=e2])',
        'menuitem "Draft iOS Submission (2)Started by Bob Yesterday" |  |  [uid=e3] (wraps button [uid=e4])',
        'menuitem "Delete draft" |  |  [uid=e5]',
      ].join("\n")
    );
    expect(res.total).toBe(3);
    const [li1] = Array.from(document.querySelectorAll("li"));
    expect(li1.getAttribute("data-bcmcp-uid")).toBe("e1");
    expect(li1.querySelector("button")!.getAttribute("data-bcmcp-uid")).toBe("e2");
    // Selecting the inner controls themselves lists them plainly.
    expect(snap({ selector: "button" }).tree).toBe(
      [
        'button "Draft macOS Submission (1)Started by Jane Today at 11:21 AM" |  |  [uid=e1]',
        'button "Draft iOS Submission (2)Started by Bob Yesterday" |  |  [uid=e2]',
      ].join("\n")
    );
  });
});

/**
 * A <form> exposes its controls as named properties that SHADOW built-ins
 * ([LegacyOverrideBuiltIns]): `<select name="children">` makes `form.children`
 * return that select, so a walk over it lists the select's options and skips
 * the rest of the form. jsdom implements no form named properties, so these
 * tests shadow the property on the form itself — which is what the browser's
 * named-property lookup amounts to. The oracle is the same page unshadowed.
 */
describe("a form's named controls cannot hide its children", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  const FORM = `<button>Outside</button><form id="f"><h2>Search stays</h2><label>Adults <input name="adults" type="number" value="2"></label><label>Kids <select name="children"><option>0</option><option>1</option></select></label><input name="childNodes" aria-label="Promo code"><button>Search</button></form>`;

  function shadowFormProperties(): void {
    const form = document.getElementById("f")!;
    const select = form.querySelector("select")!;
    const promo = form.querySelector('[name="childNodes"]')!;
    Object.defineProperty(form, "children", { configurable: true, get: () => select });
    Object.defineProperty(form, "childNodes", { configurable: true, get: () => promo });
  }

  it.each([
    ["default", {}],
    ["verbose", { verbose: true }],
    ["rootSelector on the form", { rootSelector: "form" }],
    ["textContains", { textContains: "search" }],
    ["selector", { selector: "input, select, button" }],
  ])("%s: lists the form exactly as if nothing were shadowed", (_label, extra) => {
    document.body.innerHTML = FORM;
    const expected = snap(extra);
    expect(expected.total).toBeGreaterThan(0);
    shadowFormProperties();
    const got = snap(extra);
    expect(got.tree).toBe(expected.tree);
    expect(got.total).toBe(expected.total);
  });

  it("still lists every control of the shadowed form (default mode)", () => {
    document.body.innerHTML = FORM;
    shadowFormProperties();
    expect(snap().tree).toBe(
      [
        'button "Outside" |  |  [uid=e1]',
        'textbox "Adults" | "2" | Search stays [uid=e2]',
        'combobox "Kids" | "0" | Search stays [uid=e3]',
        'textbox "Promo code" |  |  [uid=e4]',
        'button "Search" |  |  [uid=e5]',
      ].join("\n")
    );
  });

  it("names a cursor:pointer form from its own text when childNodes is shadowed", () => {
    document.body.innerHTML = `<form id="f" style="cursor: pointer">Open calendar<img name="childNodes" alt=""></form>`;
    const form = document.getElementById("f")!;
    const img = form.querySelector("img")!;
    Object.defineProperty(form, "childNodes", { configurable: true, get: () => img });
    expect(snap().tree).toBe('clickable "Open calendar" |  |  [uid=e1]');
  });
});

/**
 * A hostile page can name form controls after the DOM's traversal properties:
 * `<form><input name="parentNode">` makes `form.parentNode` return that input,
 * which turns every walk up through the form into a cycle — and a content
 * script shares the page's main thread, so an unbounded walk freezes the tab.
 * The walks read the prototype getters and are capped. jsdom implements no form
 * named properties, so each test shadows the property on the form with a getter
 * that counts its reads and throws once it is clearly read in a loop. The
 * snapshot memoizes parents, so a cycle can also spin in memory without reading
 * the property again; the shadowed runs therefore execute the stringified
 * function (as Firefox injects it) in a vm with a time limit. Either way a
 * regression fails the test instead of hanging the suite. The oracle is the same
 * page unshadowed.
 */
describe("a form's named controls cannot trap the snapshot in a cycle", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  function trapFormProperty(form: Element, name: string, inner: Element): void {
    let reads = 0;
    Object.defineProperty(form, name, {
      configurable: true,
      get() {
        reads += 1;
        if (reads > 5000) {
          throw new Error("cycle: form." + name + " read " + reads + " times");
        }
        return inner;
      },
    });
  }

  function snapBounded(extra: Record<string, unknown>) {
    const ctx = vm.createContext({
      document,
      Element,
      Node,
      opts: { verbose: false, maxLength: 25000, ...extra },
    });
    return vm.runInContext("(" + buildSnapshot.toString() + ")(document, opts)", ctx, {
      timeout: 4000,
    }) as ReturnType<typeof buildSnapshot>;
  }

  const PAGE = `<h2>Checkout</h2><form id="f"><label>Card number <input name="cc"></label><input id="trap" aria-label="Coupon"><button>Pay</button></form><button>Help</button>`;

  // No `parentElement` case here: jsdom's own selector engine (behind
  // getComputedStyle and closest) walks the JS-visible parentElement, so
  // shadowing it loops inside jsdom, which no browser engine does. That name is
  // covered for real in e2e/snapshot-edge-cases.spec.ts.
  it.each(["parentNode", "assignedSlot", "previousElementSibling"])(
    "form.%s pointing back inside the form",
    (prop) => {
      document.body.innerHTML = PAGE;
      const modes: Array<Record<string, unknown>> = [
        {},
        { verbose: true },
        { textContains: "pay" },
        { textContains: "coupon" },
        { selector: "input, button" },
        { rootSelector: "form" },
      ];
      const expected = modes.map((extra) => snap(extra).tree);
      expect(expected[0]).toContain('button "Pay" |  | Checkout [uid=');
      trapFormProperty(document.getElementById("f")!, prop, document.getElementById("trap")!);
      expect(modes.map((extra) => snapBounded(extra).tree)).toEqual(expected);
    }
  );
});

/**
 * textContains decides, per occurrence of the needle, which element owns it:
 * the deepest element whose composed text contains it. A slot or a
 * display:contents element has no box of its own, and a hidden element cannot
 * be acted on, so neither may own a match and hide every visible ancestor.
 * Slotted (box-less) text goes to the first control between it and its
 * component's host, else to the nearest element with a box; hidden text only to
 * a visible control right above it — never to a bare container such as body.
 */
describe("textContains: slots, box-less wrappers and hidden text", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  function host(tag: string, light: string, shadow: string, attrs = ""): { host: Element; root: ShadowRoot } {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<${tag} ${attrs}>${light}</${tag}>`;
    const el = wrap.firstElementChild!;
    document.body.appendChild(el);
    const root = el.attachShadow({ mode: "open" });
    root.innerHTML = shadow;
    return { host: el, root };
  }

  it("credits slotted text to the component's own role=button host", () => {
    const x = host("x-btn", "Save draft", `<div part="label"><slot></slot></div>`, 'role="button" tabindex="0"');
    expect(snap({ textContains: "save draft" }).tree).toBe('button "Save draft" |  |  [uid=e1]');
    expect(x.host.getAttribute("data-bcmcp-uid")).toBe("e1");
  });

  it("credits slotted text to the button inside the component when the host is not a control", () => {
    const x = host("x-btn", "Save draft", `<button part="base"><span part="label"><slot></slot></span></button>`);
    expect(snap({ textContains: "save draft" }).tree).toBe('button "Save draft" |  |  [uid=e1]');
    expect(x.root.querySelector("button")!.getAttribute("data-bcmcp-uid")).toBe("e1");
  });

  it("credits slotted text with no control around it to the nearest element with a box", () => {
    const x = host("amp-card", "Card body text", `<div class="body"><slot></slot></div>`);
    expect(snap({ textContains: "card body" }).tree).toBe('clickable "Card body text" |  |  [uid=e1]');
    expect(x.root.querySelector(".body")!.getAttribute("data-bcmcp-uid")).toBe("e1");
  });

  it("credits text inside a display:contents wrapper to the element that renders it", () => {
    document.body.innerHTML = `<button><span style="display:contents">Save</span></button>`;
    expect(snap({ textContains: "save" }).tree).toBe('button "Save" |  |  [uid=e1]');
  });

  it("lets text hidden with CSS inside a control find that control", () => {
    document.body.innerHTML = `<button>Close<span style="display:none"> and archive</span></button><p>Other</p>`;
    expect(snap({ textContains: "and archive" }).tree).toBe('button "Close and archive" |  |  [uid=e1]');
  });

  it("does not list a bare container for text that is hidden everywhere inside it", () => {
    document.body.innerHTML = `<main><div style="display:none"><p>Quarterly report</p></div><button>Other</button></main><div class="modal" hidden>Delete account?</div>`;
    expect(snap({ textContains: "quarterly" }).total).toBe(0);
    expect(snap({ textContains: "delete account" }).total).toBe(0);
    document.body.innerHTML = `<p>Report <span style="display:none">(archived)</span> quarterly</p>`;
    expect(snap({ textContains: "archived" }).total).toBe(0);
    expect(snap({ textContains: "quarterly" }).tree).toBe('clickable "Report (archived) quarterly" |  |  [uid=e1]');
  });

  it("never lists html or body for <title> or <script> text", () => {
    document.head.innerHTML = `<title>Quarterly numbers</title>`;
    document.body.innerHTML = `<script>var q = "quarterly";</script><p>Nothing to see</p>`;
    expect(snap({ textContains: "quarterly" }).total).toBe(0);
  });

  it("never attributes text inside display:contents directly under body to body or html", () => {
    document.body.innerHTML = `<div style="display:contents">Welcome back, Ada</div><button>Logout</button>`;
    expect(snap({ textContains: "welcome" }).total).toBe(0);
    expect(snap({ textContains: "welcome" }).tree).toBe("");
  });
});

/**
 * Name matches (aria-label, alt, title, <label> …) join text matches, with two
 * guards against noise: a descendant that matches ONLY by name never hides an
 * ancestor that matches by its own text, and such a name-only match is dropped
 * when a matching control around it is the real target (the <img alt> inside a
 * link or button). Selector mode keeps deepest-wins among the selector's own
 * matches only, and only form controls take a name from a wrapping <label>.
 */
describe("textContains: name matches never steal a control's match", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("keeps the link, not its icon, when both match", () => {
    document.body.innerHTML = `<a href="/cart"><img alt="Cart icon"> Cart (3)</a>`;
    expect(snap({ textContains: "cart" }).tree).toBe('link "Cart (3)" |  |  [uid=e1]');
  });

  it("keeps the button and its disabled state, not its icon", () => {
    document.body.innerHTML = `<button disabled><img alt="Delete"> Delete</button>`;
    expect(snap({ textContains: "delete" }).tree).toBe('button "Delete" |  |  [uid=e1] (disabled)');
  });

  it("keeps an icon button, not the icon inside it, when both match by name", () => {
    document.body.innerHTML = `<button aria-label="Cart"><img alt="Cart"></button>`;
    expect(snap({ textContains: "cart" }).tree).toBe('button "Cart" |  |  [uid=e1]');
  });

  it("a name-only match on a descendant does not hide an ancestor that matches by its own text", () => {
    document.body.innerHTML = `<div class="toolbar">Close panel <button aria-label="Close"></button></div>`;
    expect(snap({ textContains: "close" }).tree).toBe(
      ['clickable "Close panel" |  |  [uid=e1]', 'button "Close" |  |  [uid=e2]'].join("\n")
    );
  });

  it("selector mode applies deepest-wins among the selector's own matches only", () => {
    document.body.innerHTML = `<label>Email <input></label>`;
    expect(snap({ selector: "label", textContains: "email" }).tree).toBe('clickable "Email" |  |  [uid=e1]');
    document.body.innerHTML = `<button><span>Save</span></button>`;
    expect(snap({ selector: "button", textContains: "save" }).tree).toBe('button "Save" |  |  [uid=e1]');
  });

  it("gives a wrapping <label>'s text only to the control it labels", () => {
    document.body.innerHTML = `<label><input type="checkbox"> I agree to the <a href="/terms">Terms</a></label>`;
    // Default mode: the link keeps its own name (it used to read the label's).
    expect(snap().tree).toBe(
      ['checkbox "I agree to the Terms" |  |  [uid=e1]', 'link "Terms" |  |  [uid=e2]'].join("\n")
    );
    expect(snap({ textContains: "agree" }).tree).toBe(
      ['clickable "I agree to the Terms" |  |  [uid=e1]', 'checkbox "I agree to the Terms" |  |  [uid=e2]'].join("\n")
    );
  });

  it("gives a wrapping <label>'s text to custom ARIA controls", () => {
    document.body.innerHTML = `<label><span role="checkbox" tabindex="0"></span> Remember me</label>`;
    expect(snap().tree).toBe('checkbox "Remember me" |  |  [uid=e1]');

    document.body.innerHTML = `<label><span role="switch" tabindex="0"></span> Dark mode</label>`;
    expect(snap().tree).toBe('switch "Dark mode" |  |  [uid=e1]');

    document.body.innerHTML = `<label>Notes <div contenteditable="true" role="textbox"></div></label>`;
    expect(snap().tree).toBe('textbox "Notes" |  |  [uid=e1]');
  });
});

/**
 * label[for] names come from one map per tree (the document, each shadow root)
 * per snapshot. Querying the tree for every element with an id made the default
 * snapshot, and textContains' name matching, quadratic on pages with ids
 * (measured: 16k elements, textContains 154 ms → 2.8 s; 32k → 8.3 s).
 */
describe("label[for] names are looked up once per tree", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it.each([
    ["default", {}],
    ["textContains", { textContains: "field" }],
  ])("%s: one label query for the whole document, none per element", (_label, extra) => {
    document.body.innerHTML = Array.from(
      { length: 40 },
      (_, i) => `<label for="f${i}">Field ${i}</label><input id="f${i}">`
    ).join("");
    const one = jest.spyOn(Document.prototype, "querySelector");
    const many = jest.spyOn(Document.prototype, "querySelectorAll");
    const res = snap(extra);
    const perElement = one.mock.calls.filter((c) => String(c[0]).indexOf("label[for") === 0).length;
    const perTree = many.mock.calls.filter((c) => String(c[0]) === "label[for]").length;
    expect(perElement).toBe(0);
    expect(perTree).toBe(1);
    expect(res.tree).toContain('textbox "Field 39" |');
  });

  it("still takes the first label[for] in tree order, and resolves per tree", () => {
    document.body.innerHTML = `<label for="a">First</label><label for="a">Second</label><input id="a"><div id="h"></div>`;
    attachHost("x-field", `<label for="a">Shadow label</label><input id="a">`, {
      parent: document.getElementById("h")!,
    });
    expect(snap().tree).toBe(
      ['textbox "First" |  |  [uid=e1]', 'textbox "Shadow label" |  |  [uid=e2]'].join("\n")
    );
  });
});

/**
 * A collapsed menu item / option / tab / tree item row also carries its inner
 * control's states and value — the wrapper's own win — and says, inside the
 * (flags) group, that its uid targets that control. A list or grid wrapper
 * (listitem, row, gridcell) is only structure: its single same-named control is
 * listed as its own row instead. The same rule holds in textContains mode.
 */
describe("collapsed rows: merged states and structural wrappers", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("merges the control's disabled and aria-expanded states; the wrapper's own expansion wins", () => {
    document.body.innerHTML = `<ul role="menu"><li role="menuitem"><button disabled>Paste</button></li><li role="menuitem"><button aria-expanded="false">More</button></li><li role="menuitem" aria-expanded="true"><button aria-expanded="false">Tools</button></li></ul>`;
    expect(snap().tree).toBe(
      [
        'menu "" |  |  [uid=e1]',
        'menuitem "Paste" |  |  [uid=e2] (disabled, via inner button)',
        'menuitem "More" |  |  [uid=e3] (collapsed, via inner button)',
        'menuitem "Tools" |  |  [uid=e4] (expanded, via inner button)',
      ].join("\n")
    );
  });

  it("merges a checked checkbox, and a textbox's value and required state", () => {
    document.body.innerHTML = `<div role="listbox"><div role="option" aria-label="Notify me"><input type="checkbox" aria-label="Notify me" checked></div><div role="option" aria-label="Quantity"><input aria-label="Quantity" value="3" required></div></div>`;
    expect(snap().tree).toBe(
      [
        'listbox "" |  |  [uid=e1]',
        'option "Notify me" |  |  [uid=e2] (checked, via inner checkbox)',
        'option "Quantity" | "3" |  [uid=e3] (required, via inner textbox)',
      ].join("\n")
    );
  });

  it("lists a list or grid wrapper's single control as that control's own row", () => {
    document.body.innerHTML = `<ul><li role="listitem"><a href="/apps">Apps</a></li></ul><div role="grid" aria-label="Cart"><div role="row" aria-label="Remove"><button>Remove</button></div><div role="row" aria-label="Line 1"><div role="gridcell" aria-label="Quantity"><input aria-label="Quantity" value="3" required></div></div></div>`;
    expect(snap().tree).toBe(
      [
        'link "Apps" |  |  [uid=e1]',
        'grid "Cart" |  |  [uid=e2]',
        'button "Remove" |  |  [uid=e3]',
        'row "Line 1" |  |  [uid=e4]',
        'textbox "Quantity" | "3" |  [uid=e5] (required)',
      ].join("\n")
    );
  });

  it("applies the same rule in textContains mode", () => {
    document.body.innerHTML = `<ul role="menu"><li role="menuitem"><button disabled>Paste</button></li></ul><ul><li role="listitem"><a href="/apps">Apps</a></li></ul><div role="grid"><div role="row" aria-label="Line 1"><div role="gridcell" aria-label="Quantity"><input aria-label="Quantity" value="3" required></div></div></div>`;
    expect(snap({ textContains: "paste" }).tree).toBe('menuitem "Paste" |  |  [uid=e1] (disabled, via inner button)');
    expect(snap({ textContains: "apps" }).tree).toBe('link "Apps" |  |  [uid=e1]');
    expect(snap({ textContains: "quantity" }).tree).toBe('textbox "Quantity" | "3" |  [uid=e1] (required)');
  });

  it("keeps every row, collapsed or hinted, to one line ending in [uid=eN] (flags)", () => {
    document.body.innerHTML = `<ul role="menu"><li role="menuitem" aria-selected="true"><button>Rename</button></li><li role="menuitem"><button>Delete</button></li></ul>`;
    for (const extra of [{}, { selector: "li" }, { textContains: "rename" }]) {
      for (const line of snap(extra).tree.split("\n")) {
        expect(line).toMatch(/^\S+ "[^"]*" \| [^|]* \| [^[]*\[uid=e\d+\](?: \([^)]*\))?$/);
      }
    }
    expect(snap({ selector: "li" }).tree).toBe(
      [
        'menuitem "Rename" |  |  [uid=e1] (selected, wraps button [uid=e2])',
        'menuitem "Delete" |  |  [uid=e3] (wraps button [uid=e4])',
      ].join("\n")
    );
  });

  it("merges dropped structural wrapper states into the control's row", () => {
    document.body.innerHTML = `<div role="grid"><div role="row"><div role="gridcell" aria-selected="true"><button>15</button></div></div></div>`;
    expect(snap().tree).toBe(
      ['grid "" |  |  [uid=e1]', 'row "" |  |  [uid=e2]', 'button "15" |  |  [uid=e3] (selected)'].join("\n")
    );
  });

  it("keeps innermost semantic wrapper row when nested through a structural wrapper", () => {
    document.body.innerHTML = `<div role="listbox"><div role="option" aria-selected="true" aria-label="Open file"><div role="gridcell"><a href="/f">Open file</a></div></div></div>`;
    expect(snap().tree).toBe(
      ['listbox "" |  |  [uid=e1]', 'option "Open file" |  |  [uid=e2] (selected, via inner link)'].join("\n")
    );
  });
});
