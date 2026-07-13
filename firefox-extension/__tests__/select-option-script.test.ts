import { selectOption } from "../injected/select-option-script";
import { buildSnapshot } from "../injected/snapshot-script";

function mount(html: string): void {
  document.body.innerHTML = html;
}

test("native <select>: matches option by visible text, fires change, returns selected", async () => {
  mount(`<select data-bcmcp-uid="e1">
    <option value="us">United States</option>
    <option value="in">India</option>
  </select>`);
  const sel = document.querySelector("select")!;
  let changed = false;
  sel.addEventListener("change", () => { changed = true; });
  const r = await selectOption(document, { uid: "e1", option: "india" });
  expect(r.ok).toBe(true);
  expect((sel as HTMLSelectElement).value).toBe("in");
  expect(r.selected).toBe("India");
  expect(changed).toBe(true);
});

test("native <select>: matches by option value too", async () => {
  mount(`<select data-bcmcp-uid="e1"><option value="us">United States</option></select>`);
  const r = await selectOption(document, { uid: "e1", option: "us", exact: true });
  expect(r.ok).toBe(true);
  expect((document.querySelector("select") as HTMLSelectElement).value).toBe("us");
});

test("native <select>: no matching option → ok:false naming the control", async () => {
  mount(`<select data-bcmcp-uid="e1"><option value="us">United States</option></select>`);
  const r = await selectOption(document, { uid: "e1", option: "Zimbabwe" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("e1");
});

test("stale/missing uid → recoverable ok:false", async () => {
  mount(`<div></div>`);
  const r = await selectOption(document, { uid: "nope", option: "x" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("take a fresh snapshot");
});

test("custom combobox: clicks the leaf-matching [role=option] already in the DOM and re-reads value", async () => {
  // Trigger + an already-open portal listbox (option present at iter 0 → no sleep).
  mount(`
    <div data-bcmcp-uid="e1" role="combobox"><span class="select__singleValue"></span></div>
    <div role="listbox">
      <div role="option"><span>United States</span></div>
      <div role="option"><span>India</span></div>
    </div>`);
  const india = Array.from(document.querySelectorAll('[role="option"]'))
    .find((o) => (o.textContent || "").includes("India"))!;
  let clicked = false;
  india.addEventListener("click", () => {
    clicked = true;
    // Simulate the widget writing the chosen value into the singleValue child.
    (document.querySelector(".select__singleValue") as HTMLElement).textContent = "India";
  });
  const r = await selectOption(document, { uid: "e1", option: "India" });
  expect(clicked).toBe(true);
  expect(r.ok).toBe(true);
  expect(r.selected).toBe("India");
});

test("custom combobox with no in-scope search input does NOT type into an unrelated page-level search box", async () => {
  // The combobox control has no local/owned search input. A document-wide
  // input[type=search] must NOT be typed into (it could be the site's own search).
  mount(`
    <input type="search" id="site-search" aria-label="Search site" />
    <div data-bcmcp-uid="e1" role="combobox"><span class="select__singleValue"></span></div>
    <div role="listbox">
      <div role="option">United States</div>
      <div role="option">India</div>
    </div>`);
  const siteSearch = document.getElementById("site-search") as HTMLInputElement;
  let siteTyped = false;
  siteSearch.addEventListener("input", () => { siteTyped = true; });
  const india = Array.from(document.querySelectorAll('[role="option"]'))
    .find((o) => (o.textContent || "").includes("India"))!;
  india.addEventListener("click", () => {
    (document.querySelector(".select__singleValue") as HTMLElement).textContent = "India";
  });
  const r = await selectOption(document, { uid: "e1", option: "India" });
  expect(r.ok).toBe(true);
  expect(r.selected).toBe("India");
  // The unrelated site search box must be untouched.
  expect(siteTyped).toBe(false);
  expect(siteSearch.value).toBe("");
});

test("custom combobox: deepest-wins — a parent listbox row containing the needle is NOT matched over its leaf", async () => {
  mount(`
    <div data-bcmcp-uid="e1" role="combobox"></div>
    <ul role="listbox">
      <li role="option"><span>India</span><small>region</small></li>
    </ul>`);
  const leafClicks: string[] = [];
  document.querySelectorAll('[role="option"]').forEach((o) =>
    o.addEventListener("click", () => leafClicks.push("li"))
  );
  const r = await selectOption(document, { uid: "e1", option: "India" });
  expect(r.ok).toBe(true);
  expect(leafClicks).toEqual(["li"]); // the <li role=option> leaf (no descendant option) is the match
});

describe("B10: selectOption rejects a recycled uid (identity guard)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves while identity matches, then notFound once the identity changes", async () => {
    document.body.innerHTML = `
      <select aria-label="Country">
        <option value="us">United States</option>
        <option value="ca">Canada</option>
      </select>`;
    const sel = document.querySelector("select")!;
    buildSnapshot(document, { verbose: false, maxLength: 25000 });
    const uid = sel.getAttribute("data-bcmcp-uid")!;

    const ok = await selectOption(document, { uid, option: "Canada" });
    expect(ok.ok).toBe(true);
    expect((sel as HTMLSelectElement).value).toBe("ca");

    // Recycle the node under the same uid but a new identity.
    sel.setAttribute("aria-label", "Region");
    const stale = await selectOption(document, { uid, option: "Canada" });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/fresh snapshot/);
  });

  it("skips the identity check for a uid with no sig (older snapshot, back-compat)", async () => {
    document.body.innerHTML = `<select data-bcmcp-uid="e1"><option value="us">United States</option></select>`;
    const res = await selectOption(document, { uid: "e1", option: "United States" });
    expect(res.ok).toBe(true);
    expect(res.selected).toMatch(/United States/);
  });
});
