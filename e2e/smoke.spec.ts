import { test, expect } from "@playwright/test";

test("spa-widgets fixture loads with all four hazards present", async ({ page }) => {
  await page.goto("/");

  // (a) react-select-style combobox is present with its placeholder.
  await expect(page.locator("#country-select")).toBeVisible();
  await expect(page.locator("#country-select .rs__placeholder")).toHaveText("Select...");

  // (b) OneTrust-like consent overlay is mounted with a reject control.
  await expect(page.locator("#onetrust-banner-sdk")).toBeVisible();
  await expect(page.locator("#onetrust-reject-all-handler")).toBeVisible();

  // (c) Several identically-labelled "Use template" buttons in titled cards.
  const useTemplate = page.getByRole("button", { name: "Use template" });
  expect(await useTemplate.count()).toBeGreaterThan(1);

  // (d) pushState routing links exist.
  await expect(page.locator("#link-templates")).toBeVisible();
});
