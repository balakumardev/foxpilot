import { test, expect, type Page } from "@playwright/test";
import { extractPageContent } from "../firefox-extension/injected/page-content-script";

// get-tab-web-content's extractor, run in REAL Chromium and Firefox. jsdom has
// no innerText and no layout, so only a real engine can show that the composed
// text matches what the browser renders. extractPageContent is byte-identical
// between the two extensions; importing the Firefox copy exercises the shared
// body. Same eval harness as the other specs: it runs in the page MAIN world,
// where neither closed-root API exists — so a closed root stays unreadable here
// exactly as it does for page script. The extension-world path that opens
// closed roots is covered by the jest suites.
const SRC = extractPageContent.toString();

type Content = {
  links: { url: string; text: string }[];
  fullText: string;
  isTruncated: boolean;
  totalLength: number;
};

// The extractor exactly as it shipped before shadow-DOM support: the oracle
// for "a page with no shadow root produces byte-identical output".
function legacyExtract(doc: Document, offset: number) {
  const MAX_CONTENT_LENGTH = 50000;
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
  return { links, fullText: text, isTruncated, totalLength: doc.body.innerText.length };
}
const LEGACY_SRC = legacyExtract.toString();

async function extract(page: Page, offset = 0): Promise<Content> {
  return page.evaluate(
    ({ src, offset }) => {
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return fn(document, { offset });
    },
    { src: SRC, offset }
  );
}
async function legacy(page: Page, offset = 0): Promise<Content> {
  return page.evaluate(
    ({ src, offset }) => {
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return fn(document, offset);
    },
    { src: LEGACY_SRC, offset }
  );
}
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

// A self-contained shadow page (open nav with a nested open menu, a slotted
// card, a closed root, a display:none host, light main content, an open
// footer). Roots are attached from the test so the page needs no script.
async function buildInlineShadowPage(page: Page): Promise<void> {
  await page.setContent(
    "<!doctype html><html><body>" +
      '<header><amp-nav style="display:block"></amp-nav></header>' +
      '<main><h1>Apps</h1><p>Main content paragraph</p>' +
      '<a href="https://example.com/main">Main link</a> <button>Light Button</button></main>' +
      '<amp-card style="display:block"><a href="https://example.com/slotted">Slotted link</a>' +
      '<span slot="title">Slotted Title</span><button slot="nope">Unassigned</button></amp-card>' +
      '<amp-secret style="display:block"></amp-secret>' +
      '<div style="display:none"><amp-hidden></amp-hidden></div>' +
      '<amp-footer style="display:block"></amp-footer>' +
      "</body></html>"
  );
  await page.evaluate(() => {
    const open = (host: Element, html: string): ShadowRoot => {
      const r = host.attachShadow({ mode: "open" });
      r.innerHTML = html;
      return r;
    };
    const $ = (sel: string, root: ParentNode = document) => root.querySelector(sel) as Element;
    const nav = open(
      $("amp-nav"),
      '<nav aria-label="Primary"><a href="https://example.com/apps">Apps</a> ' +
        '<a href="https://example.com/business">Business</a> <button>Users and Access</button> ' +
        '<button aria-label="Account menu"><svg viewBox="0 0 1 1" width="10" height="10"><title>Menu icon</title></svg></button>' +
        "<h2>Account</h2><amp-account-menu></amp-account-menu></nav>"
    );
    open($("amp-account-menu", nav), "<button>Sign Out</button>");
    open(
      $("amp-card"),
      '<div><slot name="title">Fallback title</slot></div><div><slot></slot></div>' +
        '<slot name="empty"><button>Fallback button</button></slot> <button>Card action</button>'
    );
    const secret = $("amp-secret").attachShadow({ mode: "closed" });
    secret.innerHTML =
      '<button>Closed Button</button> <a href="https://example.com/closed">Closed link</a>';
    open($("amp-hidden"), "<button>Inside hidden host</button>");
    open(
      $("amp-footer"),
      '<footer><a href="https://example.com/privacy">Privacy</a> ' +
        '<a href="https://example.com/terms">Terms</a></footer>'
    );
  });
}

test.describe("get-tab-web-content extractor on shadow DOM (inline page)", () => {
  test("reads shadow text in reading order, lists shadow links, leaves the closed root out", async ({
    page,
  }) => {
    await buildInlineShadowPage(page);
    const before = await legacy(page);
    const r = await extract(page);

    // Before: the browser's own body.innerText — no shadow text at all, and
    // the slotted content at its light-DOM position.
    expect(before.fullText).not.toContain("Users and Access");
    expect(before.links.map((l) => l.text)).toEqual(["Main link", "Slotted link"]);

    // After: the same composition the jsdom suites pin, in both engines.
    expect(r.fullText).toBe(
      "Apps Business Users and Access\nAccount\nSign Out\n" +
        "Apps\n\nMain content paragraph\n\nMain link Light Button\n" +
        "Slotted Title\nSlotted link\nFallback button Card action\n" +
        "Privacy Terms"
    );
    expect(r.links).toEqual([
      { url: "https://example.com/apps", text: "Apps" },
      { url: "https://example.com/business", text: "Business" },
      { url: "https://example.com/main", text: "Main link" },
      { url: "https://example.com/slotted", text: "Slotted link" },
      { url: "https://example.com/privacy", text: "Privacy" },
      { url: "https://example.com/terms", text: "Terms" },
    ]);
    const t = r.fullText;
    expect(t.indexOf("Users and Access")).toBeLessThan(t.indexOf("Main content paragraph"));
    expect(t.indexOf("Main content paragraph")).toBeLessThan(t.indexOf("Privacy"));
    for (const s of ["Slotted Title", "Slotted link", "Sign Out", "Card action"]) {
      expect(count(t, s)).toBe(1);
    }
    expect(t).not.toContain("Fallback title");
    expect(t).not.toContain("Unassigned");
    expect(t).not.toContain("Menu icon"); // SVG <title> is not rendered text
    expect(t).not.toContain("Inside hidden host");
    expect(t).not.toContain("Closed Button"); // main world: the closed root is unreachable
  });

  test("skips an unrendered light child of a closed host even when it holds an open root", async ({
    page,
  }) => {
    // In the main world the closed root is invisible, so the walk sees the
    // host's light children directly. The one slotted nowhere has no layout box
    // and must not leak (innerText on it would return its textContent).
    await page.setContent(
      "<!doctype html><html><body><p>Before</p>" +
        '<x-closed><span slot="nowhere">Unslotted <x-open></x-open></span><span>Slotted</span></x-closed>' +
        "<p>After</p></body></html>"
    );
    await page.evaluate(() => {
      const host = document.querySelector("x-closed") as Element;
      host.attachShadow({ mode: "closed" }).innerHTML = "<div><slot></slot></div>";
      (document.querySelector("x-open") as Element).attachShadow({ mode: "open" }).innerHTML =
        "Open inside unslotted";
    });
    const r = await extract(page);
    expect(r.fullText).toBe("Before\n\nSlotted\n\nAfter");
  });

  test("renders slots, whitespace, line breaks and table cells like the engine", async ({ page }) => {
    await page.setContent(
      "<!doctype html><html><body>" +
        "<p>Hello <amp-x></amp-x> world</p>" +
        '<amp-lines style="display:block"></amp-lines>' +
        "<table><tbody><tr><td>Name</td><td> <x-status></x-status> </td></tr>" +
        "<tr><td>Build</td><td>Green</td></tr></tbody></table>" +
        '<fancy-link><span>Docs</span></fancy-link>' +
        "</body></html>"
    );
    await page.evaluate(() => {
      const open = (sel: string, html: string) => {
        (document.querySelector(sel) as Element).attachShadow({ mode: "open" }).innerHTML = html;
      };
      open("amp-x", "there");
      open(
        "amp-lines",
        "\n  <div>One</div>\n  <div>Two</div>\n  <span>three</span> <span>four</span>\n" +
          "<p>Line one<br>Line two</p><style>b { color: red }</style>"
      );
      open("x-status", "Passing");
      open("fancy-link", '<a href="https://example.com/docs"><slot></slot></a>');
    });
    const r = await extract(page);
    expect(r.fullText).toBe(
      "Hello there world\n\nOne\nTwo\nthree four\n\nLine one\nLine two\n\n" +
        "Name\tPassing\nBuild\tGreen\nDocs"
    );
    expect(r.links).toEqual([{ url: "https://example.com/docs", text: "Docs" }]);
  });
});

test.describe("get-tab-web-content extractor on the shadow-dom fixture", () => {
  const SHADOW_URL = `http://localhost:${Number(process.env.SHADOW_FIXTURE_PORT || 8880)}/`;
  // Every string here occurs once in the rendered page (the #state oracle's
  // keys are camelCase precisely so they cannot match), in this reading order:
  // the nav's shadow root, light <main>, the slotted card, the search widget,
  // then the footer's shadow root.
  const READING_ORDER = [
    "Developer Portal",
    "Users and Access",
    "Sign Out",
    "Main content paragraph",
    "Light Button",
    "Slotted Title",
    "Slotted link",
    "Fallback button",
    "Card action",
    "Search apps",
    "Load more results",
    "Privacy",
    "Terms",
  ];

  test.beforeEach(async ({ page }) => {
    await page.goto(SHADOW_URL);
    // app.js defines the hosts at the end of <body>, so they are upgraded (and
    // their roots attached) once the oracle has rendered.
    await expect(page.locator("#state")).not.toBeEmpty();
  });

  test("reads nav, main and footer text in reading order, once each", async ({ page }) => {
    const before = await legacy(page);
    const r = await extract(page);
    let last = -1;
    for (const s of READING_ORDER) {
      expect(count(r.fullText, s), s).toBe(1);
      const at = r.fullText.indexOf(s);
      expect(at, s).toBeGreaterThan(last);
      last = at;
    }
    // Before: body.innerText saw none of the shadow-root text.
    for (const s of ["Developer Portal", "Users and Access", "Sign Out", "Card action", "Privacy"]) {
      expect(before.fullText).not.toContain(s);
    }
    expect(r.totalLength).toBe(r.fullText.length);
  });

  test("lists the shadow and slotted links in reading order", async ({ page }) => {
    expect((await legacy(page)).links).toEqual([
      { url: "https://example.com/slotted", text: "Slotted link" },
    ]);
    expect((await extract(page)).links).toEqual([
      { url: "https://example.com/apps", text: "Apps" },
      { url: "https://example.com/business", text: "Business" },
      { url: "https://example.com/slotted", text: "Slotted link" },
      { url: "https://example.com/privacy", text: "Privacy" },
      { url: "https://example.com/terms", text: "Terms" },
    ]);
  });

  test("leaves out the closed root, the display:none host, the unassigned child and replaced fallback", async ({
    page,
  }) => {
    const t = (await extract(page)).fullText;
    expect(t).not.toContain("Closed Button"); // main world: the closed root is unreachable
    expect(t).not.toContain("Hidden Host Button");
    expect(t).not.toContain("Unassigned");
    expect(t).not.toContain("Fallback title");
  });
});

test.describe("get-tab-web-content extractor on SVG links", () => {
  test("lists SVG links where the old extractor threw, resolving hrefs against the base URL", async ({
    page,
  }) => {
    await page.setContent(
      '<!doctype html><html><head><base href="https://example.com/dir/"></head><body>' +
        '<a href="https://example.com/html">HTML link</a>' +
        '<svg width="80" height="20">' +
        '<a href="https://example.com/svg"><text x="0" y="15">SVG\n   link</text></a>' +
        '<a href="page"><text x="0" y="15">Relative</text></a>' +
        '<a href="https://example.com/tip"><title>Tooltip</title><rect width="5" height="5"></rect></a>' +
        // a[href] has never matched an xlink:href-only anchor: still not listed.
        '<a xlink:href="https://example.com/xlink-only"><text x="0" y="15">XL</text></a>' +
        "</svg></body></html>"
    );
    // SVG elements have no innerText: the pre-shadow extractor threw here.
    await expect(legacy(page)).rejects.toThrow(/trim/);
    const r = await extract(page);
    expect(r.links).toEqual([
      { url: "https://example.com/html", text: "HTML link" },
      { url: "https://example.com/svg", text: "SVG link" },
      { url: "https://example.com/dir/page", text: "Relative" },
      { url: "https://example.com/tip", text: "Tooltip" },
    ]);
    expect(r.fullText).toBe(await page.evaluate(() => document.body.innerText));
  });

  test("an SVG-namespace <slot> inside a shadow root is a plain element, not a slot", async ({
    page,
  }) => {
    await page.setContent(
      '<!doctype html><html><body><amp-chart><span slot="icon">Unrendered icon</span></amp-chart></body></html>'
    );
    await page.evaluate(() => {
      (document.querySelector("amp-chart") as Element).attachShadow({ mode: "open" }).innerHTML =
        '<p>Revenue</p><svg width="80" height="20"><slot name="icon"></slot>' +
        '<a href="https://example.com/q3"><text x="0" y="15">Q3</text></a></svg><p>Total</p>';
    });
    const r = await extract(page);
    expect(r.links).toEqual([{ url: "https://example.com/q3", text: "Q3" }]);
    expect(r.fullText).toBe("Revenue\n\nQ3\n\nTotal");
  });
});

test.describe("get-tab-web-content extractor on pages without shadow roots", () => {
  test("the spa-widgets fixture is byte-identical to the pre-shadow extractor", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#app")).not.toBeEmpty();
    for (const offset of [0, 25]) {
      expect(await extract(page, offset)).toEqual(await legacy(page, offset));
    }
  });

  test("the antd4 fixture is byte-identical to the pre-shadow extractor", async ({ page }) => {
    await page.goto(`http://localhost:${Number(process.env.ANTD_FIXTURE_PORT || 8879)}/`);
    await expect(page.locator("body")).not.toBeEmpty();
    for (const offset of [0, 25]) {
      expect(await extract(page, offset)).toEqual(await legacy(page, offset));
    }
  });

  test("a link-heavy page is byte-identical, links, filters and truncation included", async ({
    page,
  }) => {
    await page.setContent(
      "<!doctype html><html><body>" +
        '<nav><a href="https://example.com/a">Alpha</a> <a href="http://example.com/insecure">Insecure</a> ' +
        '<a href="https://example.com/b#frag">Hash</a></nav>' +
        "<main><h1>Title</h1><p>First <b>bold</b> and <i>italic</i>.</p><ul><li>One</li><li>Two</li></ul>" +
        "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>" +
        '<a href="https://example.com/label" aria-label="Labelled"></a>' +
        '<a href="https://example.com/titled" title="Titled"></a>' +
        '<div hidden>Hidden <a href="https://example.com/hidden">Hidden link</a></div>' +
        "<x-plain>No shadow root</x-plain><slot>Light slot</slot>" +
        "<p>" + "abcdefghij".repeat(6000) + "</p></main>" +
        "</body></html>"
    );
    for (const offset of [0, 10, 59990]) {
      expect(await extract(page, offset)).toEqual(await legacy(page, offset));
    }
    const r = await extract(page, 0);
    expect(r.isTruncated).toBe(true);
    expect(r.links.map((l) => l.text)).toEqual(["Alpha", "Labelled", "Titled", "Hidden link"]);
  });
});
