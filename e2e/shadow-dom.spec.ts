import { test, expect, type Page } from "@playwright/test";
import { buildSnapshot } from "../firefox-extension/injected/snapshot-script";
import { performInputAction } from "../firefox-extension/injected/action-script";
import { selectOption } from "../firefox-extension/injected/select-option-script";
import { scrollElementIntoView } from "../firefox-extension/injected/point-action-script";

/**
 * Shadow DOM, end to end, against test-fixtures/shadow-dom.
 *
 * Every test drives the path an agent drives: run the REAL buildSnapshot, pick a
 * `[uid=eN]` off the returned tree by the control's name, then hand that uid to
 * the REAL performInputAction / selectOption / scrollElementIntoView. The
 * verdict comes from the fixture's light-DOM #state oracle, which listeners
 * inside the shadow roots feed — never from a tool's own reply, and never from
 * exact row formatting. Only a row's quoted name and its `[uid=eN]` token are
 * relied on; the rest of the row is expected to change shape.
 *
 * Like the other specs, the injected functions are stringified and eval'd in
 * the page MAIN world, where neither closed-root API exists (Firefox's
 * openOrClosedShadowRoot property, Chrome's chrome.dom.openOrClosedShadowRoot).
 * So this covers OPEN roots. The closed <amp-secret> is only checked to be
 * honestly unreachable from here; its extension-world path is covered by jest.
 */
const SHADOW = `http://localhost:${Number(process.env.SHADOW_FIXTURE_PORT || 8880)}/`;
const SNAPSHOT_SRC = buildSnapshot.toString();
const ACTION_SRC = performInputAction.toString();
const SELECT_SRC = selectOption.toString();
const SCROLL_SRC = scrollElementIntoView.toString();

type SnapshotOptions = Partial<Parameters<typeof buildSnapshot>[1]>;
type Snapshot = ReturnType<typeof buildSnapshot>;
type ActionArgs = Parameters<typeof performInputAction>[1];
type ActionResult = ReturnType<typeof performInputAction>;
type ShadowState = {
  clicks: Record<string, number>;
  hovers: Record<string, number>;
  search: string;
  lastKey: string;
  platform: string;
  resultsScrollTop: number;
  loadMoreVisible: boolean;
  lastClick: string | null;
};
type Row = { line: string; uid: string };

// Controls inside OPEN shadow roots that the default snapshot must list.
const SHADOW_CONTROLS = [
  // <amp-nav>: two links, a text button, an icon-only aria-label button.
  "Apps",
  "Business",
  "Users and Access",
  "Account menu",
  // <amp-account-menu>, a root nested inside <amp-nav>'s root.
  "Sign Out",
  // <amp-card>: a slot's rendered fallback content, and the root's own button.
  "Fallback button",
  "Card action",
  // <amp-search>: a native <select>, a button at the bottom of a scroller.
  "Platform",
  "Load more results",
  // <amp-footer>.
  "Privacy",
  "Terms",
];
// Light-DOM controls, listed today (the link is projected through a slot).
const LIGHT_CONTROLS = ["Light Button", "Slotted link"];

async function load(page: Page): Promise<void> {
  await page.goto(SHADOW);
  await page.waitForFunction(
    () =>
      !!document.querySelector("amp-nav")?.shadowRoot &&
      !!document.getElementById("state")?.textContent
  );
}

// Same fixed options the extension passes (message-handler.ts), plus overrides.
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

function act(page: Page, args: ActionArgs): Promise<ActionResult> {
  return page.evaluate(
    ({ src, args }) => {
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return fn(document, args);
    },
    { src: ACTION_SRC, args }
  );
}

function selectVia(
  page: Page,
  uid: string,
  option: string
): Promise<{ ok: boolean; selected?: string; error?: string }> {
  return page.evaluate(
    async ({ src, args }) => {
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return await fn(document, args);
    },
    { src: SELECT_SRC, args: { uid, option } }
  );
}

function scrollIntoViewVia(
  page: Page,
  uid: string
): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(
    ({ src, uid }) => {
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return fn(document, uid);
    },
    { src: SCROLL_SRC, uid }
  );
}

const pageState = (page: Page): Promise<ShadowState> =>
  page.evaluate(() => JSON.parse(document.getElementById("state")!.textContent!));

// Every element carrying a snapshot uid, across the document AND every open
// shadow root (the only roots the page world can open).
function uidCensus(
  page: Page
): Promise<{ uid: string; inShadow: boolean; tag: string }[]> {
  return page.evaluate(() => {
    const out: { uid: string; inShadow: boolean; tag: string }[] = [];
    const walk = (root: Document | ShadowRoot, inShadow: boolean) => {
      root.querySelectorAll("*").forEach((el) => {
        const uid = el.getAttribute("data-bcmcp-uid");
        if (uid) {
          out.push({ uid, inShadow, tag: el.localName });
        }
        if (el.shadowRoot) {
          walk(el.shadowRoot, true);
        }
      });
    };
    walk(document, false);
    return out;
  });
}

// Every line carrying a `[uid=eN]` token — the one part of a row's format that
// agents (and these tests) rely on staying byte-stable.
function rows(tree: string): Row[] {
  const out: Row[] = [];
  for (const line of tree.split("\n")) {
    const m = /\[uid=(e\d+)\]/.exec(line);
    if (m) {
      out.push({ line, uid: m[1] });
    }
  }
  return out;
}

// Rows whose name is exactly `name` (a row's name is its quoted slot).
function rowsNamed(tree: string, name: string): Row[] {
  return rows(tree).filter((r) => r.line.includes(`"${name}"`));
}

// The uid an agent would act on: the first row with that name.
function uidFor(tree: string, name: string): string {
  const hit = rowsNamed(tree, name)[0];
  expect(
    hit,
    `no snapshot row is named "${name}" in:\n${tree || "(empty tree)"}`
  ).toBeTruthy();
  return hit.uid;
}

test.describe("take-snapshot through shadow roots", () => {
  test.beforeEach(async ({ page }) => {
    await load(page);
  });

  test("control: light-DOM controls are listed", async ({ page }) => {
    const { tree } = await snapshot(page);
    const missing = LIGHT_CONTROLS.filter((n) => rowsNamed(tree, n).length === 0);
    expect(missing, `light-DOM controls missing from:\n${tree}`).toEqual([]);
  });

  test("the default snapshot lists the controls inside open shadow roots", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const missing = SHADOW_CONTROLS.filter((n) => rowsNamed(tree, n).length === 0);
    expect(missing, `shadow-DOM controls missing from:\n${tree}`).toEqual([]);
  });

  test("a shadow input is named by the <label for> inside its own shadow root", async ({
    page,
  }) => {
    // label[for="q"] lives in <amp-search>'s root; the input has no other name.
    const { tree } = await snapshot(page);
    expect(rowsNamed(tree, "Search apps"), `in:\n${tree}`).toHaveLength(1);
  });

  test("a verbose snapshot lists the heading inside a shadow root", async ({
    page,
  }) => {
    const plain = await snapshot(page);
    const verbose = await snapshot(page, { verbose: true });
    // Control: verbose adds the light-DOM <h1>Apps</h1> (on top of whatever a
    // default snapshot names "Apps"), so verbose headings are on at all.
    expect(rowsNamed(verbose.tree, "Apps").length).toBe(
      rowsNamed(plain.tree, "Apps").length + 1
    );
    // The <h2> inside <amp-nav>'s root.
    expect(
      rowsNamed(verbose.tree, "Developer Portal"),
      `in:\n${verbose.tree}`
    ).toHaveLength(1);
  });

  test('textContains "Users and Access" finds the shadow button and nothing around it', async ({
    page,
  }) => {
    // Deepest match wins: the <nav>, the host and the page chrome above it all
    // "contain" the text too, but only the button itself is the match.
    const res = await snapshot(page, { textContains: "Users and Access" });
    const found = rows(res.tree);
    expect(found, `textContains rows:\n${res.tree || "(empty tree)"}`).toHaveLength(1);
    expect(found[0].line).toContain('"Users and Access"');
  });

  test('textContains "Account menu" finds the icon-only shadow button by its aria-label', async ({
    page,
  }) => {
    // The button has no text at all, only aria-label — and it is in a shadow root.
    const res = await snapshot(page, { textContains: "Account menu" });
    const found = rows(res.tree);
    expect(found, `textContains rows:\n${res.tree || "(empty tree)"}`).toHaveLength(1);
    expect(found[0].line).toContain('"Account menu"');
  });

  for (const [rootSelector, what] of [
    ["amp-nav", "the host"],
    ["nav", "an element inside the host's shadow root"],
  ]) {
    test(`rootSelector "${rootSelector}" (${what}) scopes the snapshot to <amp-nav>'s shadow content`, async ({
      page,
    }) => {
      const res = await snapshot(page, { rootSelector });
      expect(res.error, "rootSelector must resolve").toBeUndefined();
      const inside = ["Apps", "Business", "Users and Access", "Account menu", "Sign Out"];
      const missing = inside.filter((n) => rowsNamed(res.tree, n).length === 0);
      expect(missing, `missing from the scoped snapshot:\n${res.tree}`).toEqual([]);
      const leaked = ["Light Button", "Slotted link", "Card action", "Privacy"].filter(
        (n) => rowsNamed(res.tree, n).length > 0
      );
      expect(leaked, `outside <amp-nav> but listed:\n${res.tree}`).toEqual([]);
    });
  }

  test("guard: no control is listed twice, and each row's uid is on exactly one element", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const twice = [...LIGHT_CONTROLS, ...SHADOW_CONTROLS, "Search apps"].filter(
      (n) => rowsNamed(tree, n).length > 1
    );
    expect(twice, `listed more than once in:\n${tree}`).toEqual([]);

    const census = await uidCensus(page);
    const perUid = new Map<string, number>();
    for (const c of census) {
      perUid.set(c.uid, (perUid.get(c.uid) || 0) + 1);
    }
    const bad = rows(tree)
      .map((r) => r.uid)
      .filter((uid) => perUid.get(uid) !== 1);
    expect(bad, "row uids not stamped on exactly one element (document + open roots)").toEqual([]);
    expect(census.length, "stamped elements vs rows").toBe(rows(tree).length);
  });

  test("control: unassigned slot content, a display:none host and a closed root are not listed", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const listed = ["Unassigned", "Hidden Host Button", "Closed Button"].filter(
      (n) => rowsNamed(tree, n).length > 0
    );
    expect(listed, `must not be listed:\n${tree}`).toEqual([]);
    const byText = await snapshot(page, { textContains: "Closed Button" });
    expect(rows(byText.tree), "closed-root text leaked into textContains").toEqual([]);

    // The closed root is real and rendered — the page world just cannot open it.
    const secret = await page.evaluate(() => {
      const host = document.querySelector("amp-secret") as HTMLElement;
      return {
        shadowRootIsNull: host.shadowRoot === null,
        height: host.getBoundingClientRect().height,
      };
    });
    expect(secret.shadowRootIsNull).toBe(true);
    expect(secret.height).toBeGreaterThan(0);
  });

  test("a later snapshot clears the uids an earlier one stamped inside shadow roots", async ({
    page,
  }) => {
    await snapshot(page);
    const first = await uidCensus(page);
    expect(
      first.filter((c) => c.inShadow).length,
      "the first snapshot stamped no uid inside any shadow root"
    ).toBeGreaterThan(0);

    // A narrower snapshot (just <main>) must still clear EVERY earlier uid,
    // including those inside shadow roots — a survivor would share its uid with
    // a freshly stamped element.
    const second = await snapshot(page, { rootSelector: "main" });
    const after = await uidCensus(page);
    expect(
      after.filter((c) => c.inShadow),
      "stale uids left inside shadow roots"
    ).toEqual([]);
    expect(after.map((c) => c.uid).sort()).toEqual(
      rows(second.tree)
        .map((r) => r.uid)
        .sort()
    );
  });
});

test.describe("uid actions on shadow-DOM controls", () => {
  test.beforeEach(async ({ page }) => {
    await load(page);
  });

  test("control: a light-DOM button is listed and clickable", async ({ page }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, { action: "click", uid: uidFor(tree, "Light Button") });
    expect(res.ok, res.error).toBe(true);
    expect((await pageState(page)).clicks.lightButton).toBe(1);
  });

  test("control: a light-DOM link projected through a slot is clickable and not intercepted", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, {
      action: "click",
      uid: uidFor(tree, "Slotted link"),
      failIfIntercepted: true,
    });
    expect(res.intercepted).toBeUndefined();
    expect(res.ok, res.error).toBe(true);
    expect((await pageState(page)).clicks.slottedLink).toBe(1);
  });

  test("click-element fires a shadow-DOM button's handler", async ({ page }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, { action: "click", uid: uidFor(tree, "Users and Access") });
    expect(res.ok, res.error).toBe(true);
    const s = await pageState(page);
    expect(s.clicks.usersAccess, `the click landed on ${s.lastClick}`).toBe(1);
  });

  test("click-element on a shadow-DOM button is not reported as intercepted by its host", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, {
      action: "click",
      uid: uidFor(tree, "Users and Access"),
      failIfIntercepted: true,
    });
    expect(
      res.intercepted,
      "a shadow-DOM target must not count as covered by its own host"
    ).toBeUndefined();
    expect(res.ok, res.error).toBe(true);
    expect((await pageState(page)).clicks.usersAccess).toBe(1);
  });

  test("click-element runs a shadow-DOM link's handler", async ({ page }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, { action: "click", uid: uidFor(tree, "Apps") });
    expect(res.ok, res.error).toBe(true);
    const s = await pageState(page);
    expect(s.clicks.appsLink, `the click landed on ${s.lastClick}`).toBe(1);
    // The router handler kept the page in place.
    expect(page.url()).toBe(SHADOW);
  });

  test("click-element reaches a button in a nested shadow root", async ({ page }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, { action: "click", uid: uidFor(tree, "Sign Out") });
    expect(res.ok, res.error).toBe(true);
    const s = await pageState(page);
    expect(s.clicks.signOut, `the click landed on ${s.lastClick}`).toBe(1);
  });

  test("fill-element sets a shadow-DOM input", async ({ page }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, {
      action: "fill",
      uid: uidFor(tree, "Search apps"),
      value: "mac",
    });
    expect(res.ok, res.error).toBe(true);
    expect((await pageState(page)).search).toBe("mac");
  });

  test("type-text types into a shadow-DOM input focused by click-element", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const focus = await act(page, { action: "click", uid: uidFor(tree, "Search apps") });
    expect(focus.ok, focus.error).toBe(true);
    const res = await act(page, { action: "type", text: "tv" });
    expect(res.ok, res.error).toBe(true);
    expect((await pageState(page)).search).toBe("tv");
  });

  test("press-key reaches a shadow-DOM input focused by click-element", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const focus = await act(page, { action: "click", uid: uidFor(tree, "Search apps") });
    expect(focus.ok, focus.error).toBe(true);
    const res = await act(page, { action: "press-key", key: "Enter" });
    expect(res.ok, res.error).toBe(true);
    expect((await pageState(page)).lastKey).toBe("Enter");
  });

  test("hover-element reaches a shadow-DOM button", async ({ page }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, { action: "hover", uid: uidFor(tree, "Account menu") });
    expect(res.ok, res.error).toBe(true);
    expect((await pageState(page)).hovers.accountMenu).toBeGreaterThanOrEqual(1);
  });

  test("select-option drives a native <select> inside a shadow root", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const res = await selectVia(page, uidFor(tree, "Platform"), "tvOS");
    expect(res.ok, res.error).toBe(true);
    expect((await pageState(page)).platform).toBe("tvos");
  });

  test("scroll-into-view scrolls a shadow-DOM scroller to the uid", async ({ page }) => {
    expect(
      (await pageState(page)).loadMoreVisible,
      "precondition: the button starts below the scroller's fold"
    ).toBe(false);
    const { tree } = await snapshot(page);
    const res = await scrollIntoViewVia(page, uidFor(tree, "Load more results"));
    expect(res.ok, res.error).toBe(true);
    // The container's scroll listener re-measures asynchronously.
    await expect
      .poll(async () => (await pageState(page)).loadMoreVisible)
      .toBe(true);
  });
});
