import { test, expect } from "@playwright/test";
import { dismissOverlays } from "../firefox-extension/injected/dismiss-overlays-script";

// dismissOverlays is byte-identical between the two extensions; importing the
// Firefox copy exercises the shared body. Same eval harness as the other specs.
// The fixture RE-MOUNTS #onetrust-banner-sdk on every pushState route render, so
// this proves the "stays gone across a route change" idempotency property that
// jsdom (no pushState re-mount / no real layout) cannot.
const SRC = dismissOverlays.toString();

async function dismissInPage(page: import("@playwright/test").Page) {
  return page.evaluate((src) => {
    // eslint-disable-next-line no-eval
    const fn = (0, eval)("(" + src + ")");
    return fn(document);
  }, SRC);
}

test.describe("dismiss-overlays (re-mounting consent overlay across pushState)", () => {
  test("clears the consent overlay and it stays gone after a pushState re-mount", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#onetrust-banner-sdk")).toBeVisible();

    // 1. Prefer the Reject control → the fixture removes the overlay.
    const r1 = await dismissInPage(page);
    expect(r1.ok).toBe(true);
    expect(r1.dismissed.length).toBeGreaterThan(0);
    expect(r1.method).toBe("reject");
    await expect(page.locator("#onetrust-banner-sdk")).toHaveCount(0);

    // 2. An SPA route change re-mounts the banner (the Cloudflare-dashboard hazard).
    await page.click("#link-templates");
    await expect(page.locator("#onetrust-banner-sdk")).toBeVisible();

    // 3. Dismiss again — it stays gone (idempotent, safe to re-run after re-mount).
    const r2 = await dismissInPage(page);
    expect(r2.ok).toBe(true);
    expect(r2.dismissed.length).toBeGreaterThan(0);
    await expect(page.locator("#onetrust-banner-sdk")).toHaveCount(0);
  });
});
