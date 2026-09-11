import { test, expect } from "@playwright/test";
import { selectOption } from "../firefox-extension/injected/select-option-script";

/**
 * select-option against REAL antd 4.x (test-fixtures/antd4).
 *
 * antd/rc-select is the shape that broke the option lookup: its REAL option rows
 * are `.ant-select-item-option` inside an rc-virtual-list and carry NO role
 * attribute, while the only `role="option"` nodes on the page live in a
 * 0x0 overflow:hidden listbox that exists purely to back aria-activedescendant.
 * The old selector matched exactly those mirror rows, clicked one, and reported
 * ok:true with the mirror row's text — a textbook false success.
 *
 * Every assertion here is on PAGE STATE (#state-mirror is React's committed
 * value, and the rendered tags), never on selectOption's own reply. Asserting
 * the reply is what let this ship: the reply said "India" the whole time.
 */
const ANTD_PORT = Number(process.env.ANTD_FIXTURE_PORT || 8879);
const ANTD = `http://localhost:${ANTD_PORT}/`;
const UID_ATTR = "data-bcmcp-uid";
const SRC = selectOption.toString();

async function runSelectOption(
  page: import("@playwright/test").Page,
  controlSelector: string,
  option: string
) {
  return page.evaluate(
    async ({ src, uidAttr, controlSelector, option }) => {
      const el = document.querySelector(controlSelector) as HTMLElement | null;
      if (!el) throw new Error(`control ${controlSelector} not found`);
      el.setAttribute(uidAttr, "e1");
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return await fn(document, { uid: "e1", option });
    },
    { src: SRC, uidAttr: UID_ATTR, controlSelector, option }
  );
}

const mirror = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    JSON.parse(document.querySelector("#state-mirror")!.textContent!)
  );

test.describe("select-option on real antd 4.x", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(ANTD);
    await page.waitForSelector(".ant-select-multiple");
  });

  test("multi-select with the dropdown ALREADY OPEN commits the value", async ({
    page,
  }) => {
    // Open it the way a user would, so the "menu already open" precondition is
    // genuine rather than simulated.
    await page.locator(".ant-select-multiple").click();
    await expect(page.locator(".ant-select-item-option").first()).toBeVisible();

    await runSelectOption(page, ".ant-select-multiple", "India");

    // React actually committed the value — this is the assertion the old code
    // failed while still returning ok:true.
    await expect
      .poll(async () => (await mirror(page)).multiSelect)
      .toEqual(["India"]);
    await expect(
      page.locator(".ant-select-multiple .ant-select-selection-item")
    ).toHaveText(["India"]);
  });

  test("multi-select with the dropdown CLOSED opens it and commits the value", async ({
    page,
  }) => {
    // Same defect, reached the other way: selectOption opens the menu itself.
    await runSelectOption(page, ".ant-select-multiple", "Japan");

    await expect
      .poll(async () => (await mirror(page)).multiSelect)
      .toEqual(["Japan"]);
  });

  test("multi-select accumulates a second value rather than replacing", async ({
    page,
  }) => {
    await runSelectOption(page, ".ant-select-multiple", "India");
    await expect
      .poll(async () => (await mirror(page)).multiSelect)
      .toEqual(["India"]);

    await runSelectOption(page, ".ant-select-multiple", "Japan");
    await expect
      .poll(async () => (await mirror(page)).multiSelect)
      .toEqual(["India", "Japan"]);
  });

  test("single antd select still commits its value", async ({ page }) => {
    // antd's single select has the same aria-mirror shape, so it was broken by
    // the same root cause; this pins that the fix covers it and that the single
    // path is not regressed.
    await runSelectOption(page, "#single-select", "Kenya");

    await expect.poll(async () => (await mirror(page)).singleSelect).toBe(
      "Kenya"
    );
    await expect(
      page.locator(".ant-select:not(.ant-select-multiple) .ant-select-selection-item")
    ).toHaveText("Kenya");
  });

  test("the reported `selected` reflects the committed value, not the clicked row", async ({
    page,
  }) => {
    // The false success was doubly misleading: it echoed the text of the hidden
    // mirror row it had clicked. `selected` must now come from the control.
    const result = (await runSelectOption(
      page,
      ".ant-select-multiple",
      "India"
    )) as { ok: boolean; selected?: string };

    await expect
      .poll(async () => (await mirror(page)).multiSelect)
      .toEqual(["India"]);
    expect(result.ok).toBe(true);
    expect(result.selected).toBe("India");
  });

  test("a genuinely absent option still fails instead of reporting success", async ({
    page,
  }) => {
    const result = (await runSelectOption(
      page,
      ".ant-select-multiple",
      "Atlantis"
    )) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    await expect.poll(async () => (await mirror(page)).multiSelect).toEqual([]);
  });
});
