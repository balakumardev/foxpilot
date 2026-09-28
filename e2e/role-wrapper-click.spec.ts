import { test, expect, type Page } from "@playwright/test";
import { buildSnapshot } from "../firefox-extension/injected/snapshot-script";
import { performInputAction } from "../firefox-extension/injected/action-script";
import { selectOption } from "../firefox-extension/injected/select-option-script";

/**
 * Role-wrapper clicks, end to end, against test-fixtures/role-wrapper.
 *
 * The shape that bit on a real admin console: `li[role=menuitem] > button > p`.
 * The WRAPPER carries the menuitem role and the same name as the button inside
 * it, but only the button has a handler. The snapshot lists both (two rows for
 * one item), and the first row — the wrapper, the one an agent picks — resolves
 * to the <li>: li.click() targets the <li>, the event never travels down to the
 * button's listener, so nothing happens while the tool reports ok:true.
 *
 * Same harness as shadow-dom.spec.ts: the REAL buildSnapshot, a uid read off the
 * returned tree by name, the REAL performInputAction / selectOption on that
 * uid, and the verdict from the fixture's #state oracle — never the tool's
 * reply. Only a row's quoted name and its `[uid=eN]` token are relied on; the
 * rest of the row may change (a wrapper row may point its uid at the control
 * inside it).
 *
 * The second group pins what a click-retargeting rule must NOT break, all of
 * which works today: a handler on the <li> itself, interception under a
 * covering overlay, an antd-shaped label checkbox, a radio, a submit button and
 * an anchor whose text is a <span>, a clickable card vs its inner buttons, and
 * a combobox.
 */
const ROLE_WRAPPER = `http://localhost:${Number(
  process.env.ROLE_WRAPPER_FIXTURE_PORT || 8881
)}/`;
const SNAPSHOT_SRC = buildSnapshot.toString();
const ACTION_SRC = performInputAction.toString();
const SELECT_SRC = selectOption.toString();

// A menu item's name runs on into its <p> subtitle ("…(1)Started by Jane…"), so
// menu items are matched by name PREFIX; everything else by exact name.
const MACOS = "Draft macOS Submission (1)";
const IOS = "Draft iOS Submission (2)";

type SnapshotOptions = Partial<Parameters<typeof buildSnapshot>[1]>;
type Snapshot = ReturnType<typeof buildSnapshot>;
type ActionArgs = Parameters<typeof performInputAction>[1];
type ActionResult = ReturnType<typeof performInputAction>;
type WrapperState = {
  clicks: Record<string, number>;
  dblclicks: Record<string, number>;
  notify: boolean;
  notifyChanges: number;
  plan: string;
  planChanges: number;
  submits: number;
  hash: string;
  fruit: string | null;
  overlay: boolean;
  lastClick: string | null;
};
type Row = { line: string; uid: string };

async function load(page: Page): Promise<void> {
  await page.goto(ROLE_WRAPPER);
  await page.waitForFunction(() => !!document.getElementById("state")?.textContent);
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

const pageState = (page: Page): Promise<WrapperState> =>
  page.evaluate(() => JSON.parse(document.getElementById("state")!.textContent!));

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

// Rows whose name (the quoted slot) is exactly `name`, or starts with it.
function rowsNamed(tree: string, name: string, prefix = false): Row[] {
  const needle = prefix ? `"${name}` : `"${name}"`;
  return rows(tree).filter((r) => r.line.includes(needle));
}

// The uid an agent would act on: the first row with that name.
function uidFor(tree: string, name: string, prefix = false): string {
  const hit = rowsNamed(tree, name, prefix)[0];
  expect(
    hit,
    `no snapshot row is named "${name}${prefix ? "…" : ""}" in:\n${tree || "(empty tree)"}`
  ).toBeTruthy();
  return hit.uid;
}

test.describe("menu item wrapping a button (li[role=menuitem] > button)", () => {
  test.beforeEach(async ({ page }) => {
    await load(page);
  });

  test("each menu item is listed exactly once", async ({ page }) => {
    const { tree } = await snapshot(page);
    const counts = {
      [MACOS]: rowsNamed(tree, MACOS, true).length,
      [IOS]: rowsNamed(tree, IOS, true).length,
    };
    expect(counts, `rows:\n${tree}`).toEqual({ [MACOS]: 1, [IOS]: 1 });
  });

  test("clicking the menu item's row fires the inner button's handler", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const before = (await pageState(page)).clicks;
    const res = await act(page, { action: "click", uid: uidFor(tree, MACOS, true) });
    expect(res.ok, res.error).toBe(true);
    expect(
      res.intercepted,
      "the item's own content must not count as covering it"
    ).toBeUndefined();
    const s = await pageState(page);
    expect(s.clicks, `the click landed on ${s.lastClick}`).toEqual({
      ...before,
      draftMacos: 1,
    });
  });

  test("double-clicking the menu item's row reaches the inner button (click + dblclick)", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, {
      action: "click",
      uid: uidFor(tree, MACOS, true),
      doubleClick: true,
    });
    expect(res.ok, res.error).toBe(true);
    const s = await pageState(page);
    expect(
      { click: s.clicks.draftMacos, dblclick: s.dblclicks.draftMacos },
      `the click landed on ${s.lastClick}`
    ).toEqual({ click: 1, dblclick: 1 });
  });

  test(`guard: textContains "${MACOS}" gives one row whose uid fires the item`, async ({
    page,
  }) => {
    const res = await snapshot(page, { textContains: MACOS });
    const found = rows(res.tree);
    expect(found, `textContains rows:\n${res.tree || "(empty tree)"}`).toHaveLength(1);
    const click = await act(page, { action: "click", uid: found[0].uid });
    expect(click.ok, click.error).toBe(true);
    expect((await pageState(page)).clicks.draftMacos).toBe(1);
  });
});

test.describe("controls a click-retargeting rule must not break", () => {
  test.beforeEach(async ({ page }) => {
    await load(page);
  });

  test("control: a menuitem whose handler is on the <li> itself still fires", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const before = (await pageState(page)).clicks;
    const res = await act(page, { action: "click", uid: uidFor(tree, "Delete draft") });
    expect(res.ok, res.error).toBe(true);
    const s = await pageState(page);
    expect(s.clicks, `the click landed on ${s.lastClick}`).toEqual({
      ...before,
      deleteDraft: 1,
    });
  });

  test("control: with the overlay up, failIfIntercepted refuses the click and fires nothing", async ({
    page,
  }) => {
    // A real (trusted) click raises the overlay, independent of the tool under test.
    await page.click("#overlay-toggle");
    await expect.poll(async () => (await pageState(page)).overlay).toBe(true);
    const { tree } = await snapshot(page);
    const res = await act(page, {
      action: "click",
      uid: uidFor(tree, MACOS, true),
      failIfIntercepted: true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("click intercepted by #menu-overlay");
    expect((await pageState(page)).clicks.draftMacos).toBe(0);
  });

  test("control: a label-wrapped, span-painted checkbox toggles exactly once per click", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const uid = uidFor(tree, "Email me when a build finishes");
    let res = await act(page, { action: "click", uid });
    expect(res.ok, res.error).toBe(true);
    let s = await pageState(page);
    // Counting change events catches a double activation (on, straight back
    // off) that the final checked state alone would hide.
    expect({ checked: s.notify, changes: s.notifyChanges }).toEqual({
      checked: true,
      changes: 1,
    });
    res = await act(page, { action: "click", uid });
    expect(res.ok, res.error).toBe(true);
    s = await pageState(page);
    expect({ checked: s.notify, changes: s.notifyChanges }).toEqual({
      checked: false,
      changes: 2,
    });
  });

  test("control: a label-wrapped radio is selected", async ({ page }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, { action: "click", uid: uidFor(tree, "Pro plan") });
    expect(res.ok, res.error).toBe(true);
    const s = await pageState(page);
    expect({ plan: s.plan, changes: s.planChanges }).toEqual({ plan: "pro", changes: 1 });
  });

  test("control: a submit button whose text is a <span> submits its form exactly once", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, { action: "click", uid: uidFor(tree, "Save") });
    expect(res.ok, res.error).toBe(true);
    const s = await pageState(page);
    expect({ submits: s.submits, saveClicks: s.clicks.save }).toEqual({
      submits: 1,
      saveClicks: 1,
    });
  });

  test("control: a link whose text is a <span> follows its #hash exactly once", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, { action: "click", uid: uidFor(tree, "Anchor") });
    expect(res.ok, res.error).toBe(true);
    // hashchange fires asynchronously.
    await expect.poll(async () => (await pageState(page)).hash).toBe("#anchored");
    expect((await pageState(page)).clicks.anchor).toBe(1);
  });

  test("control: a clickable card and its two inner buttons each fire only their own handler", async ({
    page,
  }) => {
    // Guard the guard: the card's centre must be on the card itself, not on an
    // inner button — else a click on the card would rightly land on that button
    // (as a real mouse click would) and this test would assert the wrong thing.
    const centreOnInnerButton = await page.evaluate(() => {
      const card = document.getElementById("project-card") as HTMLElement;
      card.scrollIntoView({ block: "center" });
      const r = card.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit ? !!hit.closest("#card-edit, #card-share") : null;
    });
    expect(centreOnInnerButton, "hit-test at the card's centre").toBe(false);

    const { tree } = await snapshot(page);
    const before = (await pageState(page)).clicks;
    const clickAndExpect = async (name: string, delta: Record<string, number>) => {
      const res = await act(page, { action: "click", uid: uidFor(tree, name) });
      expect(res.ok, res.error).toBe(true);
      const s = await pageState(page);
      expect(s.clicks, `"${name}" landed on ${s.lastClick}`).toEqual({ ...before, ...delta });
    };
    await clickAndExpect("Open Project Apollo", { card: 1 });
    await clickAndExpect("Edit", { card: 1, cardEdit: 1 });
    await clickAndExpect("Share", { card: 1, cardEdit: 1, cardShare: 1 });
  });

  test("control: select-option still picks from a combobox/listbox", async ({ page }) => {
    const { tree } = await snapshot(page);
    const res = await selectVia(page, uidFor(tree, "Fruit"), "Banana");
    expect(res.ok, res.error).toBe(true);
    expect((await pageState(page)).fruit).toBe("Banana");
  });
});

test.describe("textContains matches accessible names", () => {
  test.beforeEach(async ({ page }) => {
    await load(page);
  });

  test('textContains "Toggle overlay" finds the icon-only button by its aria-label', async ({
    page,
  }) => {
    // Light DOM on purpose: this isolates name matching from shadow traversal.
    const res = await snapshot(page, { textContains: "Toggle overlay" });
    const found = rows(res.tree);
    expect(found, `textContains rows:\n${res.tree || "(empty tree)"}`).toHaveLength(1);
    expect(found[0].line).toContain('"Toggle overlay"');
    const click = await act(page, { action: "click", uid: found[0].uid });
    expect(click.ok, click.error).toBe(true);
    expect((await pageState(page)).overlay).toBe(true);
  });
});
