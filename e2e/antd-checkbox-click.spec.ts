import { test, expect } from "@playwright/test";
import { performInputAction } from "../firefox-extension/injected/action-script";
import { performPointAction } from "../firefox-extension/injected/point-action-script";

/**
 * Synthetic click against REAL antd 4.x checkboxes (test-fixtures/antd4).
 *
 * antd renders a checkbox as a <label class="ant-checkbox-wrapper"> holding a
 * visually-hidden (opacity:0) <input type="checkbox"> under a painted
 * .ant-checkbox-inner span. A TRUSTED click anywhere in that label runs the
 * label's activation behavior and toggles the input. Firefox does not run that
 * forwarding for an UNTRUSTED, script-dispatched click, so clicking the label or
 * the painted span did nothing while still reporting ok:true. Chromium forwards
 * it, so this was invisible there — and Firefox is exactly where it hurts, since
 * engine:"cdp" is Chrome/Edge-only and the synthetic path is the only path.
 *
 * These run on BOTH projects on purpose: chromium is the regression guard
 * against double-activation (forwarding twice would toggle the box straight back
 * off), firefox is the proof of the fix.
 *
 * Every assertion is on PAGE STATE — input.checked and React's committed value
 * via #state-mirror — never on the tool's reply, which said ok:true throughout.
 */
const ANTD = `http://localhost:${Number(process.env.ANTD_FIXTURE_PORT || 8879)}/`;
const UID_ATTR = "data-bcmcp-uid";
const ACT_SRC = performInputAction.toString();
const PT_SRC = performPointAction.toString();

type Page = import("@playwright/test").Page;

// Click, via the real injected executor, whichever element `pick` returns.
function clickVia(page: Page, pick: "input" | "label" | "inner") {
  return page.evaluate(
    ({ src, uidAttr, pick }) => {
      const input = document.querySelector("#tos-checkbox") as HTMLInputElement;
      const target =
        pick === "input"
          ? (input as HTMLElement)
          : pick === "label"
          ? (input.closest("label") as HTMLElement)
          : (input.parentElement!.querySelector(
              ".ant-checkbox-inner"
            ) as HTMLElement);
      target.setAttribute(uidAttr, "e1");
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return fn(document, { action: "click", uid: "e1" });
    },
    { src: ACT_SRC, uidAttr: UID_ATTR, pick }
  );
}

const tosState = (page: Page) =>
  page.evaluate(() => ({
    checked: (document.querySelector("#tos-checkbox") as HTMLInputElement)
      .checked,
    committed: JSON.parse(document.querySelector("#state-mirror")!.textContent!)
      .acceptedTos,
  }));

test.describe("synthetic click on real antd 4.x checkboxes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(ANTD);
    await page.waitForSelector("#tos-checkbox");
  });

  test("clicking the .ant-checkbox-wrapper LABEL toggles the checkbox", async ({
    page,
  }) => {
    await clickVia(page, "label");
    await expect
      .poll(async () => await tosState(page))
      .toEqual({ checked: true, committed: true });
  });

  test("clicking the painted .ant-checkbox-inner SPAN toggles the checkbox", async ({
    page,
  }) => {
    await clickVia(page, "inner");
    await expect
      .poll(async () => await tosState(page))
      .toEqual({ checked: true, committed: true });
  });

  test("clicking the <input> itself still toggles exactly once", async ({
    page,
  }) => {
    // The no-double-activation guard: the input IS the label's control, so the
    // forwarding must not fire a second click here.
    await clickVia(page, "input");
    await expect
      .poll(async () => await tosState(page))
      .toEqual({ checked: true, committed: true });
  });

  test("a second label click toggles back off (no double activation)", async ({
    page,
  }) => {
    await clickVia(page, "label");
    await expect.poll(async () => (await tosState(page)).committed).toBe(true);

    await clickVia(page, "label");
    await expect
      .poll(async () => await tosState(page))
      .toEqual({ checked: false, committed: false });
  });

  test("click-at on the label TEXT toggles the checkbox", async ({ page }) => {
    // The coordinate path has its own activation, so it needs the same fix.
    // Aim at the label's text rather than the box: over the box itself the
    // hidden <input> is stacked on top, so elementFromPoint returns the input
    // and the label forwarding is never exercised. Over the text it returns the
    // <span>, which is the case that silently did nothing on Firefox.
    const hit = await page.evaluate(
      ({ src }) => {
        const input = document.querySelector(
          "#tos-checkbox"
        ) as HTMLInputElement;
        const label = input.closest("label") as HTMLElement;
        const textSpan = Array.from(label.querySelectorAll("span")).find((s) =>
          (s.textContent || "").includes("I accept")
        ) as HTMLElement;
        const r = textSpan.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        const at = document.elementFromPoint(x, y);
        // eslint-disable-next-line no-eval
        const fn = (0, eval)("(" + src + ")");
        fn(document, { action: "click-at", x, y });
        return { resolvedTag: at?.tagName, resolvedCls: (at as HTMLElement)?.className };
      },
      { src: PT_SRC }
    );

    // Guard the guard: if this ever resolves to the INPUT the test would pass
    // for the wrong reason, exactly as an earlier version of it did.
    expect(hit.resolvedTag).not.toBe("INPUT");

    await expect
      .poll(async () => await tosState(page))
      .toEqual({ checked: true, committed: true });
  });

  test("a group checkbox toggles without disturbing its checked sibling", async ({
    page,
  }) => {
    await page.evaluate(
      ({ src, uidAttr }) => {
        const write = Array.from(
          document.querySelectorAll(".ant-checkbox-group label")
        )[1] as HTMLElement;
        write.setAttribute(uidAttr, "g1");
        // eslint-disable-next-line no-eval
        const fn = (0, eval)("(" + src + ")");
        return fn(document, { action: "click", uid: "g1" });
      },
      { src: ACT_SRC, uidAttr: UID_ATTR }
    );

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            JSON.parse(document.querySelector("#state-mirror")!.textContent!)
              .permissions
        )
      )
      .toEqual(["read", "write"]);
  });
});
