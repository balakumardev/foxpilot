import { dismissOverlays } from "../injected/dismiss-overlays-script";

afterEach(() => { document.body.innerHTML = ""; document.documentElement.style.overflow = ""; });

test("OneTrust: prefers the reject-all control (method:reject), does not remove nodes", () => {
  document.body.innerHTML = `
    <div id="onetrust-consent-sdk">
      <div id="onetrust-banner-sdk">
        <button id="onetrust-reject-all-handler">Reject All</button>
      </div>
    </div>`;
  let clicked = false;
  document.querySelector("#onetrust-reject-all-handler")!
    .addEventListener("click", () => { clicked = true; });
  const r = dismissOverlays(document);
  expect(clicked).toBe(true);
  expect(r.ok).toBe(true);
  expect(r.method).toBe("reject");
  expect(r.dismissed).toContain("OneTrust");
  expect(document.querySelector("#onetrust-consent-sdk")).not.toBeNull(); // reject, not removed
});

test("text-based reject inside a known container when no id button exists", () => {
  document.body.innerHTML = `
    <div id="truste-consent-track">
      <button>Accept All</button>
      <button aria-label="Decline">No thanks</button>
    </div>`;
  let declined = false;
  document.querySelectorAll("button")[1].addEventListener("click", () => { declined = true; });
  const r = dismissOverlays(document);
  expect(declined).toBe(true);
  expect(r.method).toBe("reject");
});

test("no reject control → removes the overlay node(s) and restores scroll (method:remove)", () => {
  document.documentElement.style.overflow = "hidden";
  document.body.classList.add("ot-overflow-hidden");
  document.body.innerHTML = `<div class="onetrust-pc-dark-filter"></div><div id="onetrust-consent-sdk"><p>cookies</p></div>`;
  const r = dismissOverlays(document);
  expect(r.method).toBe("remove");
  expect(document.querySelector("#onetrust-consent-sdk")).toBeNull();
  expect(document.querySelector(".onetrust-pc-dark-filter")).toBeNull();
  expect(document.documentElement.style.overflow).toBe("");
  expect(document.body.classList.contains("ot-overflow-hidden")).toBe(false);
});

test("generic aria-modal dialog with no reject → removed", () => {
  document.body.innerHTML = `<div role="dialog" aria-modal="true"><p>Subscribe</p></div>`;
  const r = dismissOverlays(document);
  expect(r.ok).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("idempotent: a second call after everything is gone returns dismissed:[]", () => {
  document.body.innerHTML = `<div id="onetrust-consent-sdk"><p>x</p></div>`;
  dismissOverlays(document);
  const r2 = dismissOverlays(document);
  expect(r2.ok).toBe(true);
  expect(r2.dismissed).toEqual([]);
  expect(r2.method).toBeUndefined();
});

test("nothing present → ok:true, empty dismissed, no method", () => {
  const r = dismissOverlays(document);
  expect(r).toEqual({ ok: true, dismissed: [], method: undefined });
});
