import { extractPageContent } from "../injected/page-content-script";

// --- jsdom innerText stand-in ------------------------------------------------
// jsdom implements no innerText. Real engines (verified on Chromium 149 and
// Firefox 151) compute it over the DOM tree only: they never enter a shadow
// root, a host's light children render only through the slot they are assigned
// to, a slot's fallback children render only while nothing is assigned to it,
// and an element that is not rendered at all returns its textContent. This
// stand-in models exactly that, plus the rendered-text rules the fixtures use
// (display:none skipped, block / <p> boundaries, <br>, table-cell tabs,
// visibility, whitespace collapsing), so the tests see the same gap the
// browsers have. It is written against compact fixture HTML and does not try
// to be the full CSS whitespace model.
const closedRoots = new WeakMap<Element, ShadowRoot>();

function rootOfHost(el: Element): ShadowRoot | null {
  return el.shadowRoot || closedRoots.get(el) || null;
}

// A light child of a shadow host renders only when a slot has it assigned.
function assignedIfHosted(n: Node): boolean {
  const parent = n.parentNode;
  if (!parent || parent.nodeType !== 1) return true;
  const root = rootOfHost(parent as Element);
  if (!root) return true;
  const slots = root.querySelectorAll("slot");
  for (let i = 0; i < slots.length; i++) {
    if ((slots[i] as HTMLSlotElement).assignedNodes().indexOf(n as ChildNode) >= 0) {
      return true;
    }
  }
  return false;
}

function isRendered(el: Element): boolean {
  for (let n: Element | null = el; n; ) {
    if (getComputedStyle(n).display === "none" || !assignedIfHosted(n)) return false;
    const p: Node | null = n.parentNode;
    n = p && p.nodeType === 11 ? (p as ShadowRoot).host : (n.parentElement as Element | null);
  }
  return true;
}

function collect(node: Node, out: Array<string | number>): void {
  if (node.nodeType === 3) {
    if (!assignedIfHosted(node)) return;
    if (getComputedStyle(node.parentNode as Element).visibility === "hidden") return;
    out.push((node as Text).data.replace(/\s+/g, " "));
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || el.localName === "noscript" || !assignedIfHosted(el)) return;
  const shadowSlot = el.localName === "slot" && el.getRootNode() instanceof ShadowRoot;
  const kids =
    shadowSlot && (el as HTMLSlotElement).assignedNodes().length > 0
      ? []
      : Array.from(el.childNodes);
  const shown = cs.visibility !== "hidden";
  const breaks = !shown
    ? 0
    : el.localName === "p"
      ? 2
      : /^(block|list-item|table|table-row|flex|grid)$/.test(cs.display)
        ? 1
        : 0;
  if (breaks) out.push(breaks);
  kids.forEach((k) => collect(k, out));
  if (shown && el.localName === "br") out.push("\n");
  if (shown && cs.display === "table-cell" && el.nextElementSibling) out.push("\t");
  if (breaks) out.push(breaks);
}

function stubInnerText(this: HTMLElement): string {
  if (!this.isConnected || !isRendered(this)) return this.textContent || "";
  const items: Array<string | number> = [];
  this.childNodes.forEach((k) => collect(k, items));
  let s = "";
  let pending = 0;
  for (const it of items) {
    if (typeof it === "number") {
      pending = Math.max(pending, it);
      continue;
    }
    if (it === "") continue;
    if (pending && s) s += "\n".repeat(pending);
    pending = 0;
    s += it;
  }
  return s
    .replace(/ {2,}/g, " ")
    .replace(/ *([\n\t]) */g, "$1")
    .replace(/^ +| +$/g, "");
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get: stubInnerText,
  });
});
afterAll(() => {
  delete (HTMLElement.prototype as any).innerText;
});
afterEach(() => {
  document.body.innerHTML = "";
});

// The extractor exactly as it shipped before shadow-DOM support (Chrome's
// content-script getTabContent, identical in behaviour to the code string
// Firefox's handler injected), kept verbatim as the oracle for "a page with no
// shadow root produces byte-identical output".
function legacyExtract(doc: Document, offset: number) {
  const MAX_CONTENT_LENGTH = 50_000;
  const linkElements = doc.querySelectorAll("a[href]");
  const links = Array.from(linkElements)
    .map((el) => ({
      url: (el as HTMLAnchorElement).href,
      text:
        (el as HTMLElement).innerText.trim() ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        "",
    }))
    .filter(
      (link) =>
        link.text !== "" &&
        link.url.startsWith("https://") &&
        !link.url.includes("#")
    );

  let isTruncated = false;
  let text = doc.body.innerText.substring(offset);
  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.substring(0, MAX_CONTENT_LENGTH);
    isTruncated = true;
  }

  return {
    links,
    fullText: text,
    isTruncated,
    totalLength: doc.body.innerText.length,
  };
}

function q(sel: string, root: ParentNode = document): Element {
  const el = root.querySelector(sel);
  if (!el) throw new Error("fixture is missing " + sel);
  return el;
}
function openRoot(host: Element, html: string): ShadowRoot {
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = html;
  return root;
}
function closedRoot(host: Element, html: string): ShadowRoot {
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = html;
  closedRoots.set(host, root);
  return root;
}
function occurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

// Firefox shape: a read-only `openOrClosedShadowRoot` PROPERTY on Element.
function withFirefoxClosedRootApi(fn: () => void): void {
  Object.defineProperty(Element.prototype, "openOrClosedShadowRoot", {
    configurable: true,
    get(this: Element) {
      return this.shadowRoot || closedRoots.get(this) || null;
    },
  });
  try {
    fn();
  } finally {
    delete (Element.prototype as any).openOrClosedShadowRoot;
  }
}
// Chrome shape: a `chrome.dom.openOrClosedShadowRoot(el)` FUNCTION. The Chrome
// suite's setup installs a `chrome` mock without `dom`; Firefox's installs no
// `chrome` at all. The helper is byte-identical, so both shapes run in both.
function withChromeClosedRootApi(fn: () => void): void {
  const g = globalThis as any;
  const hadChrome = Object.prototype.hasOwnProperty.call(g, "chrome");
  if (!hadChrome) {
    Object.defineProperty(g, "chrome", { value: {}, configurable: true, writable: true });
  }
  g.chrome.dom = {
    openOrClosedShadowRoot: (el: Element) => el.shadowRoot || closedRoots.get(el) || null,
  };
  try {
    fn();
  } finally {
    delete g.chrome.dom;
    if (!hadChrome) delete g.chrome;
  }
}

describe("extractPageContent — pages without a shadow root are unchanged", () => {
  const RICH = `
    <header><nav><a href="https://example.com/a">Alpha</a> <a href="http://example.com/insecure">Insecure</a>
      <a href="https://example.com/b#frag">Hash</a></nav></header>
    <main>
      <h1>Title</h1>
      <p>First paragraph with <b>bold</b> and <i>italic</i>.</p>
      <ul><li>One</li><li>Two</li></ul>
      <table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>
      <p>Line one<br>Line two</p>
      <a href="https://example.com/label" aria-label="Labelled"></a>
      <a href="https://example.com/titled" title="Titled"></a>
      <a href="https://example.com/empty"></a>
      <a href="/relative">Relative</a> <a href="javascript:void(0)">JS</a>
      <div hidden>Hidden text <a href="https://example.com/hidden">Hidden link</a></div>
      <script>var leak = 1;</script><style>.y { color: red }</style>
      <template><a href="https://example.com/tmpl">Tmpl</a></template>
      <x-plain>A custom element with no shadow root</x-plain>
      <slot>A light-DOM slot</slot>
    </main>
    <footer>Footer text</footer>`;

  it.each([0, 7, 100000])("matches the pre-shadow extractor byte for byte (offset %i)", (offset) => {
    document.body.innerHTML = RICH;
    expect(extractPageContent(document, { offset })).toEqual(legacyExtract(document, offset));
  });

  it("keeps the old link list and its filters (https only, no '#', aria-label/title fallback)", () => {
    document.body.innerHTML = RICH;
    expect(extractPageContent(document, { offset: 0 }).links).toEqual([
      { url: "https://example.com/a", text: "Alpha" },
      { url: "https://example.com/label", text: "Labelled" },
      { url: "https://example.com/titled", text: "Titled" },
      // A display:none link is listed, as it always was: innerText of an
      // element that is not rendered is its textContent.
      { url: "https://example.com/hidden", text: "Hidden link" },
    ]);
  });

  it.each([0, 10, 59990, 70000])(
    "matches the pre-shadow truncation, offset and totalLength (offset %i)",
    (offset) => {
      document.body.innerHTML = "<p>" + "abcdefghij".repeat(6000) + "</p><p>tail</p>";
      const r = extractPageContent(document, { offset });
      expect(r).toEqual(legacyExtract(document, offset));
      if (offset === 0) {
        expect(r.isTruncated).toBe(true);
        expect(r.fullText.length).toBe(50000);
      }
    }
  );

  it("treats a missing or non-numeric offset as 0, like both call sites did", () => {
    document.body.innerHTML = "<p>Hello</p>";
    expect(extractPageContent(document, {})).toEqual(legacyExtract(document, 0));
    expect(extractPageContent(document, { offset: NaN })).toEqual(legacyExtract(document, 0));
  });
});

describe("extractPageContent — shadow DOM text and links, in reading order", () => {
  // Mirrors the shared shadow-dom fixture: an open nav with a NESTED open
  // account menu, a slotted card (assigned + fallback + unassigned), a CLOSED
  // root, a display:none host, light-DOM main content, and an open footer.
  function buildShadowPage(): void {
    document.body.innerHTML =
      '<header><amp-nav style="display:block"></amp-nav></header>' +
      '<main><h1>Apps</h1><p>Main content paragraph</p>' +
      '<a href="https://example.com/main">Main link</a> <button>Light Button</button></main>' +
      '<amp-card style="display:block"><a href="https://example.com/slotted">Slotted link</a>' +
      '<span slot="title">Slotted Title</span><button slot="nope">Unassigned</button></amp-card>' +
      '<amp-secret style="display:block"></amp-secret>' +
      '<div style="display:none"><amp-hidden></amp-hidden></div>' +
      '<amp-footer style="display:block"></amp-footer>';
    const nav = openRoot(
      q("amp-nav"),
      '<nav aria-label="Primary"><a href="https://example.com/apps">Apps</a> ' +
        '<a href="https://example.com/business">Business</a> <button>Users and Access</button> ' +
        '<button aria-label="Account menu"><svg viewBox="0 0 1 1"></svg></button>' +
        "<h2>Account</h2><amp-account-menu></amp-account-menu></nav>"
    );
    openRoot(q("amp-account-menu", nav), "<button>Sign Out</button>");
    openRoot(
      q("amp-card"),
      '<div><slot name="title">Fallback title</slot></div><div><slot></slot></div>' +
        '<slot name="empty"><button>Fallback button</button></slot> <button>Card action</button>'
    );
    closedRoot(
      q("amp-secret"),
      '<button>Closed Button</button> <a href="https://example.com/closed">Closed link</a>'
    );
    openRoot(q("amp-hidden"), "<button>Inside hidden host</button>");
    openRoot(
      q("amp-footer"),
      '<footer><a href="https://example.com/privacy">Privacy</a> ' +
        '<a href="https://example.com/terms">Terms</a></footer>'
    );
  }

  const OPEN_TEXT =
    "Apps Business Users and Access\nAccount\nSign Out\n" +
    "Apps\n\nMain content paragraph\n\nMain link Light Button\n" +
    "Slotted Title\nSlotted link\nFallback button Card action\n" +
    "Privacy Terms";
  const OPEN_LINKS = [
    { url: "https://example.com/apps", text: "Apps" },
    { url: "https://example.com/business", text: "Business" },
    { url: "https://example.com/main", text: "Main link" },
    { url: "https://example.com/slotted", text: "Slotted link" },
    { url: "https://example.com/privacy", text: "Privacy" },
    { url: "https://example.com/terms", text: "Terms" },
  ];

  it("includes open and nested shadow text, in flat-tree reading order", () => {
    buildShadowPage();
    const r = extractPageContent(document, { offset: 0 });
    expect(r.fullText).toBe(OPEN_TEXT);
    expect(r.totalLength).toBe(OPEN_TEXT.length);
    expect(r.isTruncated).toBe(false);
    const t = r.fullText;
    expect(t.indexOf("Users and Access")).toBeLessThan(t.indexOf("Sign Out"));
    expect(t.indexOf("Sign Out")).toBeLessThan(t.indexOf("Main content paragraph"));
    expect(t.indexOf("Main content paragraph")).toBeLessThan(t.indexOf("Privacy"));
  });

  it("lists shadow and slotted links where they render, once each", () => {
    buildShadowPage();
    expect(extractPageContent(document, { offset: 0 }).links).toEqual(OPEN_LINKS);
  });

  it("renders slots like the browser: assigned content at the slot, fallback only when unassigned, unassigned light children never", () => {
    buildShadowPage();
    const t = extractPageContent(document, { offset: 0 }).fullText;
    // The title slot comes first in the shadow tree, so its assigned span reads
    // before the default slot's link even though the link is first in the light DOM.
    expect(t.indexOf("Slotted Title")).toBeLessThan(t.indexOf("Slotted link"));
    expect(t).toContain("Fallback button");
    expect(t).not.toContain("Fallback title");
    expect(t).not.toContain("Unassigned");
    for (const s of ["Slotted Title", "Slotted link", "Users and Access", "Sign Out", "Card action", "Privacy"]) {
      expect(occurrences(t, s)).toBe(1);
    }
  });

  it("leaves closed-root content out when no extension API can reach it (page world)", () => {
    buildShadowPage();
    const r = extractPageContent(document, { offset: 0 });
    expect(r.fullText).not.toContain("Closed Button");
    expect(r.links.map((l) => l.text)).not.toContain("Closed link");
  });

  it("skips a display:none host and everything in its shadow root", () => {
    buildShadowPage();
    expect(extractPageContent(document, { offset: 0 }).fullText).not.toContain("Inside hidden host");
  });

  const CLOSED_TEXT = OPEN_TEXT.replace(
    "Card action\n",
    "Card action\nClosed Button Closed link\n"
  );
  const CLOSED_LINKS = [
    ...OPEN_LINKS.slice(0, 4),
    { url: "https://example.com/closed", text: "Closed link" },
    ...OPEN_LINKS.slice(4),
  ];

  it("reads a closed root through Firefox's openOrClosedShadowRoot property", () => {
    buildShadowPage();
    withFirefoxClosedRootApi(() => {
      const r = extractPageContent(document, { offset: 0 });
      expect(r.fullText).toBe(CLOSED_TEXT);
      expect(r.links).toEqual(CLOSED_LINKS);
    });
  });

  it("reads a closed root through chrome.dom.openOrClosedShadowRoot", () => {
    buildShadowPage();
    withChromeClosedRootApi(() => {
      const r = extractPageContent(document, { offset: 0 });
      expect(r.fullText).toBe(CLOSED_TEXT);
      expect(r.links).toEqual(CLOSED_LINKS);
    });
  });

  // chrome.dom.openOrClosedShadowRoot costs microseconds per call and div/span
  // are host candidates, so a probe per element per pass adds up on a big page.
  // The scan, the text walk and the link walk all ask; only the first may pay.
  it.each([
    ["with shadow roots", true],
    ["without shadow roots", false],
  ])("probes each element's closed root at most once per call (chrome.dom, %s)", (_label, shadow) => {
    if (shadow) buildShadowPage();
    else document.body.innerHTML = "<header><nav><a href='https://example.com/a'>A</a></nav></header><main><div><span>x</span></div><p>p</p></main>";
    const calls = new Map<Element, number>();
    withChromeClosedRootApi(() => {
      const dom = (globalThis as any).chrome.dom;
      const probe = dom.openOrClosedShadowRoot;
      dom.openOrClosedShadowRoot = (el: Element) => {
        calls.set(el, (calls.get(el) || 0) + 1);
        return probe(el);
      };
      extractPageContent(document, { offset: 0 });
    });
    expect(calls.size).toBeGreaterThan(0);
    expect(Math.max(...Array.from(calls.values()))).toBe(1);
  });

  it("probes each element's closed root at most once per call (Firefox property)", () => {
    buildShadowPage();
    const calls = new Map<Element, number>();
    Object.defineProperty(Element.prototype, "openOrClosedShadowRoot", {
      configurable: true,
      get(this: Element) {
        calls.set(this, (calls.get(this) || 0) + 1);
        return this.shadowRoot || closedRoots.get(this) || null;
      },
    });
    try {
      expect(extractPageContent(document, { offset: 0 }).fullText).toBe(CLOSED_TEXT);
    } finally {
      delete (Element.prototype as any).openOrClosedShadowRoot;
    }
    expect(calls.size).toBeGreaterThan(0);
    expect(Math.max(...Array.from(calls.values()))).toBe(1);
  });

  it("keeps a closed host's projected light content in the page world, and places it at its slot with the API", () => {
    document.body.innerHTML = "<amp-closed><span>Projected</span></amp-closed>";
    closedRoot(q("amp-closed"), "<div>Closed text <slot></slot> <x-inner></x-inner></div>");
    // An open root nested INSIDE the closed one.
    const inner = (closedRoots.get(q("amp-closed")) as ShadowRoot).querySelector("x-inner") as Element;
    openRoot(inner, "Deep inside");
    // Page world: what the browser's own innerText gives — the slotted light
    // text, none of the closed root's own content.
    expect(extractPageContent(document, { offset: 0 }).fullText).toBe("Projected");
    withFirefoxClosedRootApi(() => {
      expect(extractPageContent(document, { offset: 0 }).fullText).toBe(
        "Closed text Projected Deep inside"
      );
    });
    withChromeClosedRootApi(() => {
      expect(extractPageContent(document, { offset: 0 }).fullText).toBe(
        "Closed text Projected Deep inside"
      );
    });
  });

  it("composes inline shadow content into the surrounding line", () => {
    document.body.innerHTML = "<p>Hello <amp-x></amp-x> world</p><p>Next</p>";
    openRoot(q("amp-x"), "there");
    expect(extractPageContent(document, { offset: 0 }).fullText).toBe("Hello there world\n\nNext");
  });

  it("drops inter-element whitespace at line boundaries and keeps it between inline runs", () => {
    document.body.innerHTML = "<amp-x></amp-x>";
    openRoot(
      q("amp-x"),
      "\n  <div>One</div>\n  <div>Two</div>\n  <span>three</span> <span>four</span>\n"
    );
    expect(extractPageContent(document, { offset: 0 }).fullText).toBe("One\nTwo\nthree four");
  });

  it("turns <br>, <p> and block boundaries inside a shadow root into newlines", () => {
    document.body.innerHTML = "<amp-x></amp-x>";
    openRoot(q("amp-x"), "Line one<br>Line two<h2>Heading</h2><p>Para</p><div>Div</div>");
    expect(extractPageContent(document, { offset: 0 }).fullText).toBe(
      "Line one\nLine two\nHeading\n\nPara\n\nDiv"
    );
  });

  it("keeps table cell and row separators around a host inside a cell", () => {
    // The spaces around the host start and end the cell's line, so they drop.
    document.body.innerHTML =
      "<table><tbody><tr><td>Name</td><td> <x-status></x-status> </td></tr>" +
      "<tr><td>Build</td><td>Green</td></tr></tbody></table>";
    openRoot(q("x-status"), "Passing");
    expect(extractPageContent(document, { offset: 0 }).fullText).toBe("Name\tPassing\nBuild\tGreen");
  });

  it("skips script, style, template, noscript, display:none and visibility:hidden inside shadow roots", () => {
    document.body.innerHTML = '<amp-x><span style="visibility:visible">Visible slotted</span></amp-x>';
    openRoot(
      q("amp-x"),
      "<style>.x { color: red }</style><script>var leak = 1;</script>" +
        "<template><b>Template text</b></template><noscript>Noscript text</noscript>" +
        '<div style="display:none">Gone</div>' +
        '<div style="visibility:hidden">Hidden text <slot></slot></div>' +
        "<div>Middle</div>" +
        '<div style="visibility:hidden">Also hidden <span style="visibility:visible">Shown</span></div>'
    );
    // Visible descendants of a visibility:hidden element still render (and the
    // hidden element adds no line breaks of its own — both engines agree).
    const t = extractPageContent(document, { offset: 0 }).fullText;
    expect(t).toBe("Visible slotted\nMiddle\nShown");
  });

  it("lists a link whose text is slotted into it, and applies the old filters to shadow links", () => {
    document.body.innerHTML = "<fancy-link><span>Docs</span></fancy-link><amp-links></amp-links>";
    openRoot(q("fancy-link"), '<a href="https://example.com/docs"><slot></slot></a>');
    openRoot(
      q("amp-links"),
      '<a href="http://example.com/insecure">Insecure</a>' +
        '<a href="https://example.com/page#frag">Hash</a>' +
        '<a href="https://example.com/label" aria-label="Labelled"></a>' +
        '<a href="https://example.com/titled" title="Titled"></a>' +
        '<a href="https://example.com/blank"></a>'
    );
    expect(extractPageContent(document, { offset: 0 }).links).toEqual([
      { url: "https://example.com/docs", text: "Docs" },
      { url: "https://example.com/label", text: "Labelled" },
      { url: "https://example.com/titled", text: "Titled" },
    ]);
  });

  it("applies offset, the 50,000-char cap and totalLength to the composed text", () => {
    document.body.innerHTML = '<p>Intro</p><amp-long style="display:block"></amp-long><p>Outro</p>';
    openRoot(q("amp-long"), "<p>" + "x".repeat(60000) + "</p>");
    const full = "Intro\n\n" + "x".repeat(60000) + "\n\nOutro";

    const first = extractPageContent(document, { offset: 0 });
    expect(first.totalLength).toBe(full.length);
    expect(first.isTruncated).toBe(true);
    expect(first.fullText).toBe(full.substring(0, 50000));

    const last = extractPageContent(document, { offset: 59990 });
    expect(last.isTruncated).toBe(false);
    expect(last.fullText).toBe(full.substring(59990));
    expect(last.fullText.endsWith("x\n\nOutro")).toBe(true);
  });
});
