import { buildSnapshot } from "../injected/snapshot-script";

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
