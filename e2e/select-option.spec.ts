import { test, expect } from "@playwright/test";
import { selectOption } from "../firefox-extension/injected/select-option-script";

// selectOption is byte-identical between the two extensions; importing the
// Firefox copy exercises the shared body. Reuses the click-interception harness:
// stringify the fn, reconstruct it in the page via eval, and AWAIT it (selectOption
// is async). jsdom cannot model the react-select PORTAL menu (appended to <body>),
// so this real-browser pass is where the open→poll→click→re-read path is exercised.
const UID_ATTR = "data-bcmcp-uid";
const SRC = selectOption.toString();

test.describe("select-option (real react-select-style portal menu)", () => {
  test("opens the portal menu, picks India, and the displayed value updates", async ({
    page,
  }) => {
    await page.goto("/"); // Wave-0 webServer serves the spa-widgets fixture
    await expect(page.locator("#country-select")).toBeVisible();
    await expect(page.locator("#country-select .rs__placeholder")).toHaveText(
      "Select..."
    );

    // Stamp the combobox with a uid (snapshot would normally do this), then run
    // the injected selectOption against it in-page.
    const result = await page.evaluate(
      async ({ src, uidAttr }) => {
        const el = document.querySelector("#country-select") as HTMLElement | null;
        if (!el) throw new Error("fixture #country-select not found");
        el.setAttribute(uidAttr, "e1");
        // eslint-disable-next-line no-eval
        const fn = (0, eval)("(" + src + ")");
        return await fn(document, { uid: "e1", option: "India" });
      },
      { src: SRC, uidAttr: UID_ATTR }
    );

    expect(result.ok).toBe(true);
    expect(result.selected).toContain("India");
    // The fixture reveals the chosen value in .rs__single-value (react-select
    // shape; selectOption re-reads it via the [class*="single-value"] probe).
    await expect(page.locator("#country-select .rs__single-value")).toHaveText(
      /India/
    );
    // The portal menu closed after the pick.
    await expect(page.locator(".rs__menu")).toHaveCount(0);
  });
});
