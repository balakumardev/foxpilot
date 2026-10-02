import { test, expect, type Page } from "@playwright/test";
import { buildSnapshot } from "../firefox-extension/injected/snapshot-script";
import { performInputAction } from "../firefox-extension/injected/action-script";
import { performPointAction } from "../firefox-extension/injected/point-action-script";

/**
 * A post composer and a header full of "Create post" buttons, end to end,
 * against test-fixtures/composer. Each group guards a reported failure.
 *
 * A. The snapshot lists the title <textarea> inside a component's shadow root,
 *    and fill-element and type-at reach it and the Markdown <textarea> behind
 *    "Switch to Markdown". Reported: the title was missing, type-at called the
 *    custom-element host "not typable", and a selector snapshot found nothing
 *    after the switch.
 * B. fill-element on the rich-text editor (a contenteditable div) is refused
 *    with a plain explanation and leaves the editor alone. Reported: a raw
 *    TypeError from the HTMLInputElement value setter.
 * C. When typing into a contenteditable editor says ok:true, the application
 *    kept the text, and an editor that refuses synthetic input gets an honest
 *    ok:false. Reported: type-at said "Typed" while the Lexical editor stayed
 *    empty.
 * D. A control whose centre is its own label span is not "intercepted" by it,
 *    while a real cover (a toast, a scrim drawn over a slotted button) still
 *    is. Reported: failIfIntercepted answered "click intercepted by span.flex"
 *    on "Create post".
 *
 * Same harness as shadow-dom.spec.ts: the REAL injected functions, stringified
 * and run in the page main world on both projects, uids read off the real
 * snapshot, and every verdict taken from the fixture's #state oracle (Lexical's
 * own model text, each component's value, each control's click count). A
 * tool's reply is checked too, never trusted alone. Only a row's quoted name and
 * its `[uid=eN]` token are relied on.
 */
const COMPOSER = `http://localhost:${Number(process.env.COMPOSER_FIXTURE_PORT || 8882)}/`;
const INTERCEPTION = COMPOSER + "interception.html";
const SNAPSHOT_SRC = buildSnapshot.toString();
const ACTION_SRC = performInputAction.toString();
const POINT_SRC = performPointAction.toString();

type SnapshotOptions = Partial<Parameters<typeof buildSnapshot>[1]>;
type Snapshot = ReturnType<typeof buildSnapshot>;
type ActionArgs = Parameters<typeof performInputAction>[1];
type PointArgs = Parameters<typeof performPointAction>[1];
// Awaited: typing into an editor may resolve later (once it has checked that
// the editor kept the text). page.evaluate awaits either shape.
type ActionResult = Awaited<ReturnType<typeof performInputAction>>;
type PointResult = Awaited<ReturnType<typeof performPointAction>>;
type Point = { x: number; y: number };
type ComposerState = {
  ready: boolean;
  mode: "rich" | "markdown";
  title: string;
  body: string; // Lexical's own model text, not the DOM
  markdown: string;
  plain: string;
  locked: string;
  lexicalError: string | null;
};
type InterceptionState = {
  clicks: Record<string, number>;
  tooltipOpen: boolean;
  lastClick: string | null;
};
type Row = { line: string; uid: string; name: string };

async function loadComposer(page: Page): Promise<void> {
  await page.goto(COMPOSER);
  // Lexical is up and has rendered its first, empty paragraph.
  await page.waitForFunction(() => {
    const s = document.getElementById("state")?.textContent;
    return !!s && JSON.parse(s).ready === true && !!document.querySelector("#rte > p");
  });
}

async function loadInterception(page: Page): Promise<void> {
  await page.goto(INTERCEPTION);
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
    async ({ src, args }) => {
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return await fn(document, args);
    },
    { src: ACTION_SRC, args }
  );
}

function pointAction(page: Page, args: PointArgs): Promise<PointResult> {
  return page.evaluate(
    async ({ src, args }) => {
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return await fn(document, args);
    },
    { src: POINT_SRC, args }
  );
}

const typeAt = (page: Page, at: Point, text: string): Promise<PointResult> =>
  pointAction(page, { action: "type-at", x: at.x, y: at.y, text });

const composerState = (page: Page): Promise<ComposerState> =>
  page.evaluate(() => JSON.parse(document.getElementById("state")!.textContent!));

const interceptionState = (page: Page): Promise<InterceptionState> =>
  page.evaluate(() => JSON.parse(document.getElementById("state")!.textContent!));

// Before asserting that something did NOT change, give the page's async work
// (Lexical's update listener, a MutationObserver undoing an edit) time to run.
const settle = (page: Page): Promise<void> => page.waitForTimeout(300);

// Every line carrying a `[uid=eN]` token, with its quoted name.
function rows(tree: string): Row[] {
  const out: Row[] = [];
  for (const line of tree.split("\n")) {
    const uid = /\[uid=(e\d+)\]/.exec(line);
    if (uid) {
      const name = /"([^"]*)"/.exec(line);
      out.push({ line, uid: uid[1], name: name ? name[1] : "" });
    }
  }
  return out;
}

const named = (row: Row, name: string | RegExp): boolean =>
  typeof name === "string" ? row.name === name : name.test(row.name);

// The uid an agent would act on: the first row with that name.
function uidFor(tree: string, name: string | RegExp): string {
  const hit = rows(tree).find((r) => named(r, name));
  expect(hit, `no snapshot row is named ${name} in:\n${tree || "(empty tree)"}`).toBeTruthy();
  return hit!.uid;
}

// The names in `wanted` that no row carries.
const unlisted = (tree: string, wanted: (string | RegExp)[]): (string | RegExp)[] =>
  wanted.filter((name) => !rows(tree).some((r) => named(r, name)));

// The visible centre of the element `css` matches (Playwright's CSS pierces
// open shadow roots), after scrolling it to the middle of the viewport.
function centreOf(page: Page, css: string): Promise<Point> {
  return page.locator(css).evaluate((el) => {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

// Flip the body to Markdown the way an agent would: the button's uid from a
// fresh snapshot, clicked by the real performInputAction.
async function switchToMarkdown(page: Page): Promise<void> {
  const { tree } = await snapshot(page);
  const res = await act(page, { action: "click", uid: uidFor(tree, "Switch to Markdown") });
  expect(res.ok, res.error).toBe(true);
  expect((await composerState(page)).mode).toBe("markdown");
}

// Two points in the Lexical editor: the centre of its first line (the <p> it
// renders) and a point lower down, on the editor root itself. `hit` says what
// the page's own hit-test finds there, so a test can check its premise.
function editorPoints(
  page: Page
): Promise<{ firstLine: Point; lower: Point; hit: { firstLine: string; lower: string } }> {
  return page.evaluate(() => {
    const rte = document.getElementById("rte")!;
    const p = rte.firstElementChild!;
    rte.scrollIntoView({ block: "center" });
    const r = rte.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    const firstLine = { x: pr.left + pr.width / 2, y: pr.top + pr.height / 2 };
    const lower = { x: r.left + r.width / 2, y: (pr.bottom + r.bottom) / 2 };
    const at = (pt: { x: number; y: number }) => {
      const h = document.elementFromPoint(pt.x, pt.y);
      return h ? h.localName + (h.id ? "#" + h.id : "") : "nothing";
    };
    return { firstLine, lower, hit: { firstLine: at(firstLine), lower: at(lower) } };
  });
}

// Polls the oracle until the editor holds `text`.
async function expectKept(
  page: Page,
  key: "body" | "plain",
  text: string,
  reply: unknown
): Promise<void> {
  await expect
    .poll(async () => (await composerState(page))[key], {
      timeout: 2000,
      message: `the reply was ${JSON.stringify(reply)}, so #state.${key} must hold "${text}"`,
    })
    .toContain(text);
}

// The uid the snapshot stamped on the element `css` matches, checked to be a
// listed row whose name carries `label`. Picked by element rather than by name:
// the snapshot also lists a link's inner label spans as rows of their own ("+",
// "Create Post"), and clicking one of those hits the span itself, so it would
// never test a control whose centre is its own descendant.
async function uidOn(page: Page, tree: string, css: string, label: string): Promise<string> {
  const uid = await page.locator(css).getAttribute("data-bcmcp-uid");
  const row = rows(tree).find((r) => r.uid === uid);
  expect(row?.name, `${css} (uid ${uid}) is not a listed row in:\n${tree}`).toContain(label);
  return uid!;
}

// Where a real pointer at the element's centre lands, judged by the page: the
// element ("self"), something rendered inside it through slots and shadow roots
// ("inside"), or something laid over it ("outside"). Scrolls first, as a click
// does.
function centreHit(page: Page, css: string): Promise<{ hit: string; relation: string }> {
  return page.locator(css).evaluate((target) => {
    target.scrollIntoView({ block: "center" });
    const r = target.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit || inner.getRootNode() !== hit.shadowRoot) break;
      hit = inner;
    }
    let relation = "outside";
    for (
      let n: Node | null = hit;
      n;
      n = (n as Element).assignedSlot || n.parentNode || (n as ShadowRoot).host || null
    ) {
      if (n === target) {
        relation = n === hit ? "self" : "inside";
        break;
      }
    }
    const cls = hit ? (hit.getAttribute("class") || "").trim().split(/\s+/)[0] : "";
    return { hit: hit ? hit.localName + (cls ? "." + cls : "") : "nothing", relation };
  });
}

test.describe("A. shadow-DOM fields in the composer", () => {
  test.beforeEach(async ({ page }) => {
    await loadComposer(page);
  });

  test("the default snapshot lists the title textarea, and fill-element sets it", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, { action: "fill", uid: uidFor(tree, /Title/), value: "Hello fill" });
    expect(res.ok, res.error).toBe(true);
    expect((await composerState(page)).title).toBe("Hello fill");
  });

  test('a selector snapshot finds the title and the editor, then the Markdown textarea after "Switch to Markdown"', async ({
    page,
  }) => {
    const selector = "textarea,[contenteditable]";
    const before = await snapshot(page, { selector });
    expect(
      unlisted(before.tree, [/Title/, "Post body"]),
      `selector rows:\n${before.tree || before.error || "(empty tree)"}`
    ).toEqual([]);

    await switchToMarkdown(page);
    const after = await snapshot(page, { selector });
    expect(
      unlisted(after.tree, [/Title/, "Markdown body"]),
      `selector rows after the switch:\n${after.tree || after.error || "(empty tree)"}`
    ).toEqual([]);
  });

  test("type-at types into the title textarea inside a shadow root", async ({ page }) => {
    const res = await typeAt(page, await centreOf(page, "#post-title textarea"), "Hello title");
    expect(res.ok, res.error).toBe(true);
    expect(res.element?.tag).toBe("textarea");
    expect((await composerState(page)).title).toBe("Hello title");
  });

  test("type-at types into the Markdown textarea three shadow roots deep", async ({ page }) => {
    await switchToMarkdown(page);
    const res = await typeAt(page, await centreOf(page, "#post-body textarea"), "Hello markdown");
    expect(res.ok, res.error).toBe(true);
    expect(res.element?.tag).toBe("textarea");
    expect((await composerState(page)).markdown).toBe("Hello markdown");
  });
});

test.describe("B. fill-element on the rich-text editor", () => {
  test.beforeEach(async ({ page }) => {
    await loadComposer(page);
  });

  test("is refused with a plain explanation, not a TypeError, and the editor is untouched", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const res = await act(page, {
      action: "fill",
      uid: uidFor(tree, "Post body"),
      value: "Hello fill",
    });
    expect(res.ok, "fill-element cannot set a contenteditable editor").toBe(false);
    expect(res.error ?? "").not.toContain("TypeError");
    expect(res.error ?? "").toMatch(/not (a )?fillable/i);
    await settle(page);
    expect((await composerState(page)).body, "Lexical's model changed").toBe("");
  });
});

test.describe("C. typing into contenteditable editors keeps the text, or says it did not", () => {
  test.beforeEach(async ({ page }) => {
    await loadComposer(page);
  });

  test("type-at on the first line of the Lexical editor: ok:true and Lexical holds the text", async ({
    page,
  }) => {
    const pts = await editorPoints(page);
    expect(pts.hit.firstLine, "premise: the point is on the editor's first <p>").toBe("p");
    const res = await typeAt(page, pts.firstLine, "Hello first line");
    expect(res.ok, res.error).toBe(true);
    await expectKept(page, "body", "Hello first line", res);
  });

  test("type-at lower down in the Lexical editor: ok:true and Lexical holds the text", async ({
    page,
  }) => {
    const pts = await editorPoints(page);
    expect(pts.hit.lower, "premise: the point is on the editor root").toBe("div#rte");
    const res = await typeAt(page, pts.lower, "Hello lower");
    expect(res.ok, res.error).toBe(true);
    await expectKept(page, "body", "Hello lower", res);
  });

  test("type-at on a plain contenteditable: ok:true and it holds the text", async ({ page }) => {
    const res = await typeAt(page, await centreOf(page, "#plain-ce"), "Hello plain");
    expect(res.ok, res.error).toBe(true);
    await expectKept(page, "plain", "Hello plain", res);
  });

  test("type-at on an editor that refuses synthetic input: an honest ok:false, and the editor stays empty", async ({
    page,
  }) => {
    const res = await typeAt(page, await centreOf(page, "#locked-ce"), "Hello locked");
    await settle(page);
    expect((await composerState(page)).locked, "the locked editor took synthetic input").toBe("");
    expect(res.ok, `the editor kept nothing, yet type-at replied ${JSON.stringify(res)}`).toBe(
      false
    );
  });

  test("click-element then type-text into the Lexical editor: never ok:true with the editor empty", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const click = await act(page, { action: "click", uid: uidFor(tree, "Post body") });
    expect(click.ok, click.error).toBe(true);
    const res = await act(page, { action: "type", text: "Hello typed" });
    if (res.ok) {
      await expectKept(page, "body", "Hello typed", res);
    }
    const { body } = await composerState(page);
    expect(
      { ok: res.ok, kept: body.includes("Hello typed") },
      `type-text replied ${JSON.stringify(res)} while Lexical holds ${JSON.stringify(body)}`
    ).not.toEqual({ ok: true, kept: false });
  });

  test("click-element then type-text into an editor that refuses synthetic input: an honest ok:false", async ({
    page,
  }) => {
    const { tree } = await snapshot(page);
    const click = await act(page, { action: "click", uid: uidFor(tree, "Locked notes") });
    expect(click.ok, click.error).toBe(true);
    const res = await act(page, { action: "type", text: "Hello locked" });
    await settle(page);
    expect((await composerState(page)).locked, "the locked editor took synthetic input").toBe("");
    expect(res.ok, `the editor kept nothing, yet type-text replied ${JSON.stringify(res)}`).toBe(
      false
    );
  });
});

// Controls whose centre is their own content: a span.flex label inside the
// control, or the light-DOM span slotted into a component's button. "Join" is
// the plain case, its centre is the button's own text.
const OWN_CENTRE = [
  { label: "Create Post (light)", css: "#create-post-light", counter: "createPostLight", centre: "inside", where: "light-DOM link" },
  { label: "Create Post", css: "cx-header-buttons #create-post", counter: "createPost", centre: "inside", where: "link in a shadow root" },
  { label: "Create", css: "#header-create", counter: "headerCreate", centre: "inside", where: "link inside a tooltip component" },
  { label: "Create Post (slotted)", css: "#cx-create button", counter: "cxCreate", centre: "inside", where: "component button with a slotted label" },
  { label: "Join", css: "cx-join-button button", counter: "join", centre: "self", where: "button in a nested shadow root" },
];
// Genuine covers: something else is laid over the control's centre.
const COVERED = [
  { label: "Save draft", css: "#covered-btn", counter: "coveredBtn", where: "under a light-DOM toast" },
  { label: "Publish", css: "#scrim-btn", counter: "scrimBtn", where: "under a scrim drawn in its component's shadow root" },
];

test.describe("D. click-element failIfIntercepted on controls with label spans", () => {
  test.beforeEach(async ({ page }) => {
    await loadInterception(page);
  });

  for (const t of OWN_CENTRE) {
    test(`"${t.label}" (${t.where}) is clicked, not reported as intercepted by its own content`, async ({
      page,
    }) => {
      const { tree } = await snapshot(page);
      const uid = await uidOn(page, tree, t.css, t.label);
      const at = await centreHit(page, t.css);
      expect(at.relation, `premise: the centre lands on ${at.hit}`).toBe(t.centre);
      if (t.centre === "inside") {
        expect(at.hit, "premise: the centre is a span.flex").toBe("span.flex");
      }
      const before = (await interceptionState(page)).clicks;
      const res = await act(page, { action: "click", uid, failIfIntercepted: true });
      expect(res.intercepted, `reported as covered by ${JSON.stringify(res.intercepted)}`).toBeUndefined();
      expect(res.ok, res.error).toBe(true);
      const s = await interceptionState(page);
      expect(s.clicks, `the click landed on ${s.lastClick}`).toEqual({ ...before, [t.counter]: 1 });
    });
  }

  for (const t of COVERED) {
    test(`"${t.label}" (${t.where}) is reported as intercepted and not clicked`, async ({
      page,
    }) => {
      const { tree } = await snapshot(page);
      const uid = await uidOn(page, tree, t.css, t.label);
      expect(await centreHit(page, t.css), "premise: a span.flex covers the centre").toEqual({
        hit: "span.flex",
        relation: "outside",
      });
      const res = await act(page, { action: "click", uid, failIfIntercepted: true });
      expect(res.ok, "a covered control must not report a click").toBe(false);
      expect(res.intercepted?.tag, JSON.stringify(res)).toBe("span");
      const s = await interceptionState(page);
      expect(s.clicks[t.counter]).toBe(0);
      expect(s.lastClick, "failIfIntercepted must not dispatch a click anywhere").toBeNull();
    });
  }
});
