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
    expect(tree).toContain('link "Home" [uid=e1]');
  });

  it("renders buttons with the button role and accessible name", () => {
    document.body.innerHTML = `<button>Sign in</button>`;
    const { tree } = build();
    expect(tree).toContain('button "Sign in" [uid=e1]');
  });

  it("renders text inputs as textbox via the associated label", () => {
    document.body.innerHTML = `
      <label for="email">Email</label>
      <input id="email" type="text" />
    `;
    const { tree } = build();
    expect(tree).toContain('textbox "Email" [uid=');
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
    expect(tree).toContain('tab "Settings" [uid=');
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
    expect(tree).toContain('textbox "Email" [uid=e1] (required)');
    expect(tree).toMatch(/checkbox "Agree" \[uid=e\d+\] \(checked\)/);
    expect(tree).toMatch(/button "Submit" \[uid=e\d+\] \(disabled\)/);
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
    expect(tree).toMatch(/button "Nope" \[uid=e\d+\] \(disabled\)/);
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
    expect(tree).toContain('textbox "Full name" [uid=');
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

  it("does not absorb an embedded control's text into a wrapping label's name", () => {
    document.body.innerHTML = `
      <label>Country
        <select>
          <option>United States</option>
          <option>Canada</option>
        </select>
      </label>
    `;
    const { tree } = build();
    expect(tree).toContain('combobox "Country"');
    expect(tree).not.toContain("United States");
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

    it("captures a non-semantic div with inline cursor:pointer as a clickable (verbose only)", () => {
      document.body.innerHTML = `<div style="cursor: pointer">Click me</div>`;
      const verbose = build(true);
      expect(verbose.tree).toMatch(/clickable "Click me" \[uid=e\d+\]/);
      // It is verbose-only: the default snapshot must not contain it.
      const nonVerbose = build(false);
      expect(nonVerbose.tree).not.toContain("Click me");
    });

    it("derives the clickable name from aria-label when present", () => {
      document.body.innerHTML = `<div style="cursor: pointer" aria-label="Open menu"></div>`;
      const { tree } = build(true);
      expect(tree).toMatch(/clickable "Open menu" \[uid=e\d+\]/);
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
      expect(tree).toMatch(/clickable "Outer" \[uid=e\d+\]/);
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
      expect(tree).toMatch(/clickable "Toggle" \[uid=e\d+\] \(expanded\)/);
    });
  });
});
