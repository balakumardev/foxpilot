import { test, expect, type Page } from "@playwright/test";
import { buildSnapshot } from "../firefox-extension/injected/snapshot-script";
import { classifyHit, performInputAction } from "../firefox-extension/injected/action-script";
import { extractPageContent } from "../firefox-extension/injected/page-content-script";

/**
 * take-snapshot edge cases that only a real engine can show, on both projects.
 *
 * A <form> exposes its controls as named properties that shadow built-ins
 * ([LegacyOverrideBuiltIns]); jsdom implements none of that, so the jest suites
 * can only simulate it. Here the forms are real: `<select name="children">`
 * makes `form.children` return the select, and `<input name="parentNode">`
 * makes `form.parentNode` return that input, a cycle for any walk up through the
 * form. A content script shares the page's main thread, so a walk that never
 * ends freezes the tab — each test therefore also proves the call returns.
 *
 * Like the other specs, the FIREFOX copies are stringified and eval'd in the
 * page MAIN world (the named properties behave the same in Chrome's isolated
 * world; Firefox's Xray sandbox hides them). Rows are matched by quoted name and
 * `[uid=eN]` only.
 */
const SNAPSHOT_SRC = buildSnapshot.toString();
const CLASSIFY_SRC = classifyHit.toString();
const ACTION_SRC = performInputAction.toString();
const CONTENT_SRC = extractPageContent.toString();

type SnapshotOptions = Partial<Parameters<typeof buildSnapshot>[1]>;
type Snapshot = ReturnType<typeof buildSnapshot>;

function snapshot(page: Page, opts: SnapshotOptions = {}): Promise<Snapshot> {
  return page.evaluate(
    ({ src, opts }) => {
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return fn(document, { verbose: false, maxLength: 25000, ...opts });
    },
    { src: SNAPSHOT_SRC, opts }
  );
}

function rowsNamed(tree: string, name: string): string[] {
  return tree.split("\n").filter((l) => /\[uid=e\d+\]/.test(l) && l.includes(`"${name}"`));
}

// One form per hostile name: a name shared with an id would make the property a
// RadioNodeList instead of a single control, which is a different (harmless) case.
const HOSTILE_FORMS = `
  <h2>Checkout</h2>
  <form id="fa"><input name="parentNode" aria-label="Trap A"><button>Pay A</button></form>
  <form id="fb"><input id="parentNode" aria-label="Trap B"><button>Pay B</button></form>
  <form id="fc"><label>Card <input name="cc"></label><input name="parentElement" aria-label="Trap C"><button>Pay C</button></form>
  <form id="fd"><input name="assignedSlot" aria-label="Trap D"><button>Pay D</button></form>
  <form id="fe"><label>Adults <input name="adults" value="2"></label><label>Kids <select name="children"><option>0</option><option>1</option></select></label><input name="childNodes" aria-label="Promo code"><a href="https://example.com/help">Form help</a><button>Search</button></form>
  <button>Outside</button>
  <div id="overlay">cookies</div>
  <amp-x></amp-x>
  <script>document.querySelector("amp-x").attachShadow({ mode: "open" }).innerHTML = "<button>Shadow button</button>";</script>`;

const EVERY_CONTROL = [
  "Trap A", "Pay A", "Trap B", "Pay B", "Card", "Trap C", "Pay C", "Trap D", "Pay D",
  "Adults", "Kids", "Promo code", "Form help", "Search", "Outside", "Shadow button",
];

test.describe("a form's named controls cannot hide or trap the page walks", () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(HOSTILE_FORMS);
    // The fixture is only meaningful if the browser really shadows the built-ins.
    const shadowed = await page.evaluate(() => ({
      children: (document.getElementById("fe") as any).children.localName,
      parentNodeA: (document.getElementById("fa") as any).parentNode.localName,
      parentNodeB: (document.getElementById("fb") as any).parentNode.localName,
      parentElement: (document.getElementById("fc") as any).parentElement.localName,
      assignedSlot: (document.getElementById("fd") as any).assignedSlot.localName,
    }));
    expect(shadowed).toEqual({
      children: "select",
      parentNodeA: "input",
      parentNodeB: "input",
      parentElement: "input",
      assignedSlot: "input",
    });
  });

  test("the default snapshot returns and lists every control once", async ({ page }) => {
    const { tree } = await snapshot(page);
    const counts = Object.fromEntries(EVERY_CONTROL.map((n) => [n, rowsNamed(tree, n).length]));
    expect(counts).toEqual(Object.fromEntries(EVERY_CONTROL.map((n) => [n, 1])));
  });

  test("verbose, textContains, selector and rootSelector return too", async ({ page }) => {
    expect(rowsNamed((await snapshot(page, { verbose: true })).tree, "Checkout")).toHaveLength(1);
    expect(rowsNamed((await snapshot(page, { textContains: "pay c" })).tree, "Pay C")).toHaveLength(1);
    expect(rowsNamed((await snapshot(page, { textContains: "promo" })).tree, "Promo code")).toHaveLength(1);
    const buttons = (await snapshot(page, { selector: "form button" })).tree;
    expect(["Pay A", "Pay B", "Pay C", "Pay D", "Search"].map((n) => rowsNamed(buttons, n).length)).toEqual([1, 1, 1, 1, 1]);
    for (const [form, name] of [["#fa", "Pay A"], ["#fb", "Pay B"], ["#fc", "Pay C"], ["#fd", "Pay D"], ["#fe", "Kids"]]) {
      const res = await snapshot(page, { rootSelector: form });
      expect(res.error).toBeUndefined();
      expect(rowsNamed(res.tree, name)).toHaveLength(1);
    }
  });

  test("classifyHit through each hostile form returns", async ({ page }) => {
    const verdicts = await page.evaluate((src) => {
      // eslint-disable-next-line no-eval
      const classify = (0, eval)("(" + src + ")");
      const overlay = document.getElementById("overlay");
      return ["fa", "fb", "fc", "fd", "fe"].map((id) => {
        const form = document.getElementById(id)!;
        const pay = form.querySelector("button")!;
        return [classify(pay, overlay), classify(overlay, pay), classify(form, pay), classify(pay, form)];
      });
    }, CLASSIFY_SRC);
    for (const v of verdicts) expect(v).toEqual(["unrelated", "unrelated", "descendant", "ancestor"]);
  });

  test("get-tab-web-content keeps the shadowed form's links and text", async ({ page }) => {
    const res = await page.evaluate((src) => {
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return fn(document, { offset: 0 });
    }, CONTENT_SRC);
    expect(res.links.map((l: { text: string }) => l.text)).toContain("Form help");
    expect(res.fullText).toContain("Shadow button");
    expect(res.fullText).toContain("Form help");
  });
});

// Slots and display:contents elements have no box, and hidden content is 0x0,
// only under a real layout engine — so these textContains cases live here.
const TEXT_PAGE = `
  <x-save role="button" tabindex="0" id="role-host">Save draft</x-save>
  <x-publish id="plain-host">Publish now</x-publish>
  <amp-card id="card-host">Card body text</amp-card>
  <button id="contents-btn"><span style="display:contents">Duplicate</span></button>
  <button id="hidden-btn">Close<span style="display:none"> and archive</span></button>
  <select id="country" aria-label="Country"><option>Norway</option><option>Uruguay</option></select>
  <div class="modal" hidden><p>Delete account forever?</p></div>
  <script>var secretWord = "quarterlyfigures";</script>
  <script>
    document.getElementById("role-host").attachShadow({ mode: "open" }).innerHTML = '<div part="label"><slot></slot></div>';
    document.getElementById("plain-host").attachShadow({ mode: "open" }).innerHTML = '<button part="base"><span part="label"><slot></slot></span></button>';
    document.getElementById("card-host").attachShadow({ mode: "open" }).innerHTML = '<div class="body"><slot></slot></div>';
  </script>`;

test.describe("textContains under a real layout engine", () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(TEXT_PAGE);
  });

  // The element carrying `uid`, described by where it lives.
  function whoHas(page: Page, uid: string): Promise<string> {
    return page.evaluate((uid) => {
      const sel = '[data-bcmcp-uid="' + uid + '"]';
      const light = document.querySelector(sel);
      if (light) return "light:" + (light.id || light.localName);
      for (const h of Array.from(document.querySelectorAll("*"))) {
        const hit = h.shadowRoot && h.shadowRoot.querySelector(sel);
        if (hit) return "shadow(" + h.id + "):" + hit.localName;
      }
      return "none";
    }, uid);
  }
  function onlyUid(tree: string): string {
    const lines = tree.split("\n").filter(Boolean);
    expect(lines, tree).toHaveLength(1);
    return /\[uid=(e\d+)\]/.exec(lines[0])![1];
  }

  test("slotted text finds the component's role=button host", async ({ page }) => {
    const { tree } = await snapshot(page, { textContains: "save draft" });
    expect(tree).toMatch(/^button "Save draft"/);
    expect(await whoHas(page, onlyUid(tree))).toBe("light:role-host");
  });

  test("slotted text finds the button inside a component whose host is not a control", async ({ page }) => {
    const { tree } = await snapshot(page, { textContains: "publish now" });
    expect(tree).toMatch(/^button "Publish now"/);
    expect(await whoHas(page, onlyUid(tree))).toBe("shadow(plain-host):button");
  });

  test("slotted text with no control around it finds the nearest box", async ({ page }) => {
    const { tree } = await snapshot(page, { textContains: "card body" });
    expect(await whoHas(page, onlyUid(tree))).toBe("shadow(card-host):div");
  });

  test("text in a display:contents wrapper finds the button that renders it", async ({ page }) => {
    const { tree } = await snapshot(page, { textContains: "duplicate" });
    expect(await whoHas(page, onlyUid(tree))).toBe("light:contents-btn");
  });

  test("text hidden with CSS inside a control finds that control", async ({ page }) => {
    const { tree } = await snapshot(page, { textContains: "and archive" });
    expect(await whoHas(page, onlyUid(tree))).toBe("light:hidden-btn");
  });

  test("an option's text finds its select", async ({ page }) => {
    const { tree } = await snapshot(page, { textContains: "uruguay" });
    expect(tree).toMatch(/^combobox "Country"/);
    expect(await whoHas(page, onlyUid(tree))).toBe("light:country");
  });

  test("text that is hidden everywhere never lists a bare container", async ({ page }) => {
    for (const needle of ["delete account", "quarterlyfigures"]) {
      const res = await snapshot(page, { textContains: needle });
      expect(res.tree, needle).toBe("");
    }
  });
});

// The whole agent path through a real hostile form: take-snapshot hands out the
// menu item's uid, click-element unwraps the click onto the item's one button,
// and both walk up from the button through `<input type="hidden" name="...">`'s
// form. A page with such a form used to freeze both calls.
test.describe("snapshot → click through a real hostile form", () => {
  for (const prop of ["parentNode", "assignedSlot"]) {
    test(`the menu item's uid unwraps onto the button inside the form (form.${prop})`, async ({ page }) => {
      await page.setContent(
        `<ul role="menu" style="list-style:none;margin:0;padding:0">` +
          `<li role="menuitem" id="mi" aria-label="Rename file">` +
          `<form id="f" style="margin:0"><input type="hidden" name="${prop}">` +
          `<button type="button" id="go" style="display:block;width:100%">Rename</button></form></li></ul>` +
          `<script>window.__go = 0; document.getElementById("go").addEventListener("click", () => window.__go++);</script>`
      );
      expect(await page.evaluate((p) => (document.getElementById("f") as any)[p].localName, prop)).toBe("input");

      const { tree } = await snapshot(page);
      const row = rowsNamed(tree, "Rename file")[0];
      expect(row, tree).toBeTruthy();
      const uid = /\[uid=(e\d+)\]/.exec(row)![1];
      const res = await page.evaluate(
        ({ src, uid }) => {
          // eslint-disable-next-line no-eval
          const fn = (0, eval)("(" + src + ")");
          return fn(document, { action: "click", uid });
        },
        { src: ACTION_SRC, uid }
      );

      expect(res.ok).toBe(true);
      expect(await page.evaluate(() => (window as any).__go)).toBe(1);
    });
  }
});
