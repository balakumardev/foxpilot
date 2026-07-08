import { test, expect } from "@playwright/test";
import { performInputAction } from "../firefox-extension/injected/action-script";

// performInputAction is byte-identical between the two extensions; importing the
// Firefox copy exercises the shared body. UID attr must match the injected code.
const UID_ATTR = "data-bcmcp-uid";
const SRC = performInputAction.toString();

// The Wave-0 spa-widgets fixture renders the identically-labelled "Use template"
// buttons as bare `<button>` inside `<section class="card">` (no `.use-template`
// class), so the interception target is the FIRST `section.card button`. The
// `#onetrust-banner-sdk` full-screen overlay (position:fixed; inset:0; z-index)
// covers those cards — the real interception geometry under test.
const TEMPLATE_BTN = "section.card button";

// Stamp `selector`'s first match with uid e1, then run performInputAction in-page.
async function clickInPage(
  page: import("@playwright/test").Page,
  selector: string,
  args: Record<string, unknown>
) {
  return page.evaluate(
    ({ src, uidAttr, selector, args }) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) throw new Error("fixture selector not found: " + selector);
      el.setAttribute(uidAttr, "e1");
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return fn(document, { action: "click", uid: "e1", ...args });
    },
    { src: SRC, uidAttr: UID_ATTR, selector, args }
  );
}

test.describe("click-element interception (real-browser hit-test)", () => {
  test("flags the foreign overlay covering a button (ok:true, still clicks)", async ({ page }) => {
    await page.goto("/"); // Wave-0 webServer serves the spa-widgets fixture
    await expect(page.locator("#onetrust-banner-sdk")).toBeVisible();

    const res = await clickInPage(page, TEMPLATE_BTN, {});
    expect(res.ok).toBe(true);
    expect(res.intercepted).toBeTruthy();
    expect(res.intercepted.id).toBe("onetrust-banner-sdk");
  });

  test("failIfIntercepted returns ok:false naming the covering selector", async ({ page }) => {
    await page.goto("/");
    const res = await clickInPage(page, TEMPLATE_BTN, { failIfIntercepted: true });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("click intercepted by #onetrust-banner-sdk");
  });

  test("no interception once the overlay is removed", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => document.querySelector("#onetrust-banner-sdk")?.remove());
    const res = await clickInPage(page, TEMPLATE_BTN, {});
    expect(res.ok).toBe(true);
    expect(res.intercepted).toBeFalsy();
  });
});
