import { test, expect, type Page } from "@playwright/test";
import { buildSnapshot } from "../firefox-extension/injected/snapshot-script";
import { performInputAction } from "../firefox-extension/injected/action-script";
import { performPointAction } from "../firefox-extension/injected/point-action-script";

/**
 * Fields that take their value on blur, driven in a document without system
 * focus, against test-fixtures/blur-commit.
 *
 * Reported (PER-12): Google Play Console's "Invite new users" email field is an
 * AngularDart material-input[blurupdate], whose value reaches the form model
 * only on the input's blur. In a background tab, or a browser window behind
 * another app, the browser moves activeElement on focus() but fires no focus,
 * blur, focusin or focusout, so the email never committed and "Invite user"
 * stayed disabled whatever FoxPilot did. The fixture's #state oracle holds the
 * component's own model, so every verdict below is the page's, not the reply's.
 *
 * Each group runs in a focused document and in an unfocused one. The unfocused
 * one is the fixture's ?unfocused=1 mode (its first script stops every trusted
 * focus event at the window), because Playwright makes every page look focused,
 * on Firefox always. On Chromium the last group also runs against a REAL
 * unfocused window (headful, focus emulation off, another window in front).
 *
 * Same harness as composer.spec.ts: the REAL injected functions, stringified
 * and run in the page main world on both projects, uids read off the real
 * snapshot.
 */
const BLUR = `http://localhost:${Number(process.env.BLUR_FIXTURE_PORT || 8883)}/`;
const SNAPSHOT_SRC = buildSnapshot.toString();
const ACTION_SRC = performInputAction.toString();
const POINT_SRC = performPointAction.toString();
const EMAIL = "ember-play-publisher@example.com";
// The email field's accessible name: its aria-label, as on Play Console.
const EMAIL_FIELD = "user@example.com";

type ActionArgs = Parameters<typeof performInputAction>[1];
type PointArgs = Parameters<typeof performPointAction>[1];
type ActionResult = Awaited<ReturnType<typeof performInputAction>> & { disabled?: boolean };
type PointResult = Awaited<ReturnType<typeof performPointAction>>;
type FixtureState = {
  ready: boolean;
  unfocused: boolean;
  email: { text: string; committed: string | null; touched: boolean; focused: boolean; commits: number };
  dialogOpen: boolean;
  dialogFocusEvents: number;
  permissions: string[];
  inviteEnabled: boolean;
  invited: string | null;
  displayName: { committed: string | null; commits: number };
  city: { query: string; value: string | null; open: boolean };
  searched: string | null;
  events: string[];
};
type Row = { line: string; uid: string; name: string };

async function load(page: Page, unfocused: boolean): Promise<void> {
  await page.goto(BLUR + (unfocused ? "?unfocused=1" : ""));
  await page.waitForFunction(() => {
    const s = document.getElementById("state")?.textContent;
    return !!s && JSON.parse(s).ready === true;
  });
}

function snapshot(page: Page): Promise<string> {
  return page.evaluate(
    ({ src }) => {
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return fn(document, { verbose: false, maxLength: 25000 }).tree as string;
    },
    { src: SNAPSHOT_SRC }
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

const fixtureState = (page: Page): Promise<FixtureState> =>
  page.evaluate(() => JSON.parse(document.getElementById("state")!.textContent!));

// Lets the fixture's change detection (a microtask after each event) and any
// timer the page set run before a "did not change" assertion.
const settle = (page: Page): Promise<void> => page.waitForTimeout(150);

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

// The uid an agent would act on: the first row with that name, from a fresh
// snapshot.
async function uidFor(page: Page, name: string): Promise<string> {
  const tree = await snapshot(page);
  const hit = rows(tree).find((r) => r.name === name);
  expect(hit, `no snapshot row is named "${name}" in:\n${tree || "(empty tree)"}`).toBeTruthy();
  return hit!.uid;
}

async function ok(res: Promise<ActionResult | PointResult>): Promise<ActionResult | PointResult> {
  const r = await res;
  expect(r.ok, (r as { error?: string }).error).toBe(true);
  return r;
}

const fill = (page: Page, name: string, value: string, extra: Partial<{ commit: boolean }> = {}) =>
  uidFor(page, name).then((uid) => ok(act(page, { action: "fill", uid, value, ...extra } as ActionArgs)));

const click = (page: Page, name: string) =>
  uidFor(page, name).then((uid) => act(page, { action: "click", uid } as ActionArgs));

function centreOf(page: Page, css: string): Promise<{ x: number; y: number }> {
  return page.locator(css).evaluate((el) => {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

async function expectCommitted(page: Page, value: string | null): Promise<void> {
  await expect.poll(async () => (await fixtureState(page)).email.committed, { timeout: 2000 }).toBe(value);
}

// Grants one app permission through the dialog, the way an agent would.
async function grantPermission(page: Page): Promise<void> {
  expect((await click(page, "Add app")).ok).toBe(true);
  await expect.poll(async () => (await fixtureState(page)).dialogOpen).toBe(true);
  expect((await click(page, "Release apps to testing tracks")).ok).toBe(true);
  expect((await click(page, "Apply")).ok).toBe(true);
  await expect.poll(async () => (await fixtureState(page)).permissions).toEqual([
    "Release apps to testing tracks",
  ]);
}

for (const mode of ["focused", "unfocused"] as const) {
  test.describe(`${mode} document`, () => {
    test.beforeEach(async ({ page }) => {
      await load(page, mode === "unfocused");
      expect((await fixtureState(page)).unfocused).toBe(mode === "unfocused");
    });

    test("a filled email commits when the next click moves focus off it", async ({ page }) => {
      await fill(page, EMAIL_FIELD, EMAIL);
      await settle(page);
      // fill-element does not leave the field by itself.
      expect((await fixtureState(page)).email.committed).toBeNull();

      expect((await click(page, "Add app")).ok).toBe(true);
      await expectCommitted(page, EMAIL);
      // The dialog took focus from its click handler, and its control saw it.
      await expect.poll(async () => (await fixtureState(page)).dialogFocusEvents).toBeGreaterThan(0);
    });

    test("fill-element with commit:true commits the email at once", async ({ page }) => {
      await fill(page, EMAIL_FIELD, EMAIL, { commit: true });
      await expectCommitted(page, EMAIL);
      const s = await fixtureState(page);
      expect(s.email.focused).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.id || document.activeElement?.localName)).toBe(
        "body"
      );
    });

    test("the invite form completes: email, Add app, a permission, Apply, Invite user", async ({ page }) => {
      await fill(page, EMAIL_FIELD, EMAIL);
      await grantPermission(page);
      await expect.poll(async () => (await fixtureState(page)).inviteEnabled).toBe(true);

      const res = await click(page, "Invite user");
      expect(res.ok).toBe(true);
      expect(res.disabled).toBeUndefined();
      await expect.poll(async () => (await fixtureState(page)).invited).toBe(EMAIL);
    });

    test("permissions first: clicking the disabled Invite user commits the email and says the button was disabled", async ({
      page,
    }) => {
      await grantPermission(page);
      await fill(page, EMAIL_FIELD, EMAIL);
      await settle(page);
      expect((await fixtureState(page)).inviteEnabled).toBe(false);

      // A real click on the disabled button still takes focus off the field.
      const first = await click(page, "Invite user");
      expect(first.ok).toBe(true);
      expect(first.disabled).toBe(true);
      await expectCommitted(page, EMAIL);
      await expect.poll(async () => (await fixtureState(page)).inviteEnabled).toBe(true);
      expect((await fixtureState(page)).invited).toBeNull();

      const second = await click(page, "Invite user");
      expect(second.ok).toBe(true);
      expect(second.disabled).toBeUndefined();
      await expect.poll(async () => (await fixtureState(page)).invited).toBe(EMAIL);
    });

    test("click-at on plain text takes focus off the field, as a real click does", async ({ page }) => {
      await fill(page, EMAIL_FIELD, EMAIL);
      const at = await centreOf(page, "#invite-note");
      const res = await pointAction(page, { action: "click-at", x: at.x, y: at.y });
      expect(res.ok, (res as { error?: string }).error).toBe(true);
      expect(res.element?.tag).toBe("p");
      await expectCommitted(page, EMAIL);
      expect(await page.evaluate(() => document.activeElement?.localName)).toBe("body");
    });

    test("a field committed from a focusout listener commits when the next fill moves focus", async ({ page }) => {
      await fill(page, "Display name", "Ada");
      await settle(page);
      expect((await fixtureState(page)).displayName.committed).toBeNull();
      await fill(page, "Search", "x");
      await expect.poll(async () => (await fixtureState(page)).displayName.committed).toBe("Ada");
    });

    test("type-text with commit:true commits the typed email", async ({ page }) => {
      expect((await click(page, EMAIL_FIELD)).ok).toBe(true);
      await ok(act(page, { action: "type", text: EMAIL, commit: true } as ActionArgs));
      await expectCommitted(page, EMAIL);
    });

    test("type-at with commit:true commits the typed email", async ({ page }) => {
      const at = await centreOf(page, "#email");
      await ok(pointAction(page, { action: "type-at", x: at.x, y: at.y, text: EMAIL, commit: true } as PointArgs));
      await expectCommitted(page, EMAIL);
    });

    test("fill-form with commit:true commits every field, the last one too", async ({ page }) => {
      const tree = await snapshot(page);
      const uid = (name: string) => rows(tree).find((r) => r.name === name)!.uid;
      await ok(
        act(page, {
          action: "fill-form",
          fields: [
            { uid: uid(EMAIL_FIELD), value: EMAIL },
            { uid: uid("Display name"), value: "Ada" },
          ],
          commit: true,
        } as ActionArgs)
      );
      await expectCommitted(page, EMAIL);
      await expect.poll(async () => (await fixtureState(page)).displayName.committed).toBe("Ada");
    });

    test("fill-element does not leave a combobox: its suggestion is still there to click", async ({ page }) => {
      await fill(page, "City", "New");
      await expect.poll(async () => (await fixtureState(page)).city.open).toBe(true);
      // The option keeps focus in the input (mousedown preventDefault), so the
      // click does not blur it and the list is still there when it lands.
      expect((await click(page, "New York")).ok).toBe(true);
      await expect.poll(async () => (await fixtureState(page)).city.value).toBe("New York");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("city");
    });

    test("fill-element does not leave the field: Enter after it reaches the search box", async ({ page }) => {
      await fill(page, "Search", "blur events");
      await ok(act(page, { action: "press-key", key: "Enter" }));
      await expect.poll(async () => (await fixtureState(page)).searched).toBe("blur events");
    });
  });
}

test.describe("which focus events FoxPilot adds", () => {
  test("in a focused document the browser fires them all and FoxPilot adds none", async ({ page }) => {
    await load(page, false);
    await fill(page, EMAIL_FIELD, EMAIL);
    expect((await click(page, "Add app")).ok).toBe(true);
    await expectCommitted(page, EMAIL);
    const events = (await fixtureState(page)).events.filter((e) => e.includes(":email:"));
    expect(events).toEqual(["focus:email:t", "focusin:email:t", "blur:email:t", "focusout:email:t"]);
  });

  test("in an unfocused document FoxPilot fires the ones the browser dropped, once each", async ({ page }) => {
    await load(page, true);
    await fill(page, EMAIL_FIELD, EMAIL);
    expect((await click(page, "Add app")).ok).toBe(true);
    await expectCommitted(page, EMAIL);
    const events = (await fixtureState(page)).events.filter((e) => e.includes(":email:"));
    expect(events).toEqual(["focus:email:u", "focusin:email:u", "blur:email:u", "focusout:email:u"]);
  });
});

// Not a simulation: a headful Chromium window with Playwright's focus emulation
// turned off and another window brought in front of it, so document.hasFocus()
// is false and the browser itself drops the focus events, as in a background
// tab. Needs a display (macOS, or DISPLAY / xvfb-run on Linux).
test.describe("a real unfocused Chromium window", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Chromium only: Playwright's Firefox always reports focus");
  test.skip(
    process.platform !== "darwin" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
    "needs a display for a headful browser"
  );

  test("the invite form completes while the window does not have focus", async ({ playwright }) => {
    const browser = await playwright.chromium.launch({ headless: false });
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await (await ctx.newCDPSession(page)).send("Emulation.setFocusEmulationEnabled", { enabled: false });
      await load(page, false);
      const other = await ctx.newPage();
      await other.setContent("<p>Another window, in front.</p>");
      await other.bringToFront();
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
      // The premise: focus() moves activeElement and the browser fires nothing.
      expect(
        await page.evaluate(() => {
          let fired = 0;
          const count = () => fired++;
          document.addEventListener("focus", count, true);
          (document.getElementById("search") as HTMLInputElement).focus();
          (document.getElementById("search") as HTMLInputElement).blur();
          document.removeEventListener("focus", count, true);
          return fired;
        })
      ).toBe(0);

      await fill(page, EMAIL_FIELD, EMAIL);
      await grantPermission(page);
      await expectCommitted(page, EMAIL);
      await expect.poll(async () => (await fixtureState(page)).inviteEnabled).toBe(true);
      expect((await click(page, "Invite user")).ok).toBe(true);
      await expect.poll(async () => (await fixtureState(page)).invited).toBe(EMAIL);
      expect(await page.evaluate(() => document.hasFocus())).toBe(false);
    } finally {
      await browser.close();
    }
  });
});
