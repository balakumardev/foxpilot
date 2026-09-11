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

describe("antd 4 / rc-select shape", () => {
  // antd's REAL option rows are `.ant-select-item-option` and carry NO role
  // attribute, so the old selector — which only knew role="option", <li>s and
  // react-select's .select__option — could not see them at all. The only
  // role="option" nodes antd renders live in a 0x0 overflow:hidden listbox that
  // backs aria-activedescendant, so the old code clicked THAT and reported
  // success while the value never changed.
  //
  // Scope note: rejecting the aria mirror depends on it having zero width, which
  // needs a layout engine. jsdom has none (every rect is 0x0, so the geometry
  // guard is deliberately disabled there), and jsdom also does not inherit a
  // parent's display:none to descendants. That half of the fix is therefore
  // proven in e2e/antd-select-option.spec.ts against real antd in a real
  // browser. What jsdom CAN prove is asserted here: the real antd row is now
  // matched at all, a row hidden in its own right is skipped, and `selected` is
  // read from the control rather than echoed back from the clicked row.
  it("clicks the real .ant-select-item-option row (it was previously invisible to the selector)", async () => {
    document.body.innerHTML = `
      <div class="ant-select ant-select-multiple" data-bcmcp-uid="e1">
        <div class="ant-select-selector">
          <div class="ant-select-selection-overflow"></div>
        </div>
      </div>
      <div class="ant-select-dropdown">
        <div class="rc-virtual-list-holder-inner">
          <div class="ant-select-item ant-select-item-option" title="India">
            <div class="ant-select-item-option-content">India</div>
          </div>
          <div class="ant-select-item ant-select-item-option" title="Japan">
            <div class="ant-select-item-option-content">Japan</div>
          </div>
        </div>
      </div>`;
    const india = document.querySelector(
      '.ant-select-item-option[title="India"]'
    ) as HTMLElement;
    const japan = document.querySelector(
      '.ant-select-item-option[title="Japan"]'
    ) as HTMLElement;
    let indiaClicks = 0;
    let japanClicks = 0;
    india.addEventListener("click", () => {
      indiaClicks++;
    });
    japan.addEventListener("click", () => {
      japanClicks++;
    });

    const r = await selectOption(document, { uid: "e1", option: "India" });

    expect(r.ok).toBe(true);
    expect(indiaClicks).toBe(1);
    expect(japanClicks).toBe(0);
  });

  it("skips an option row that is hidden in its own right", async () => {
    document.body.innerHTML = `
      <div class="ant-select ant-select-multiple" data-bcmcp-uid="e1">
        <div class="ant-select-selector"></div>
      </div>
      <div class="ant-select-dropdown">
        <div class="rc-virtual-list-holder-inner">
          <div class="ant-select-item ant-select-item-option" title="India"
               style="display:none">India</div>
          <div class="ant-select-item ant-select-item-option" title="India (live)">India</div>
        </div>
      </div>`;
    const hidden = document.querySelector(
      '.ant-select-item-option[title="India"]'
    ) as HTMLElement;
    const live = document.querySelector(
      '.ant-select-item-option[title="India (live)"]'
    ) as HTMLElement;
    let hiddenClicks = 0;
    let liveClicks = 0;
    hidden.addEventListener("click", () => {
      hiddenClicks++;
    });
    live.addEventListener("click", () => {
      liveClicks++;
    });

    await selectOption(document, { uid: "e1", option: "India" });

    expect(hiddenClicks).toBe(0);
    expect(liveClicks).toBe(1);
  });

  it("reports the committed value from the control, not the row it clicked", async () => {
    document.body.innerHTML = `
      <div class="ant-select ant-select-multiple" data-bcmcp-uid="e1">
        <div class="ant-select-selector">
          <div class="ant-select-selection-overflow"></div>
        </div>
      </div>
      <div class="ant-select-dropdown">
        <div class="rc-virtual-list-holder-inner">
          <div class="ant-select-item ant-select-item-option" title="India">
            <div class="ant-select-item-option-content">India</div>
          </div>
        </div>
      </div>`;
    const control = document.querySelector(".ant-select-multiple") as HTMLElement;
    // Stand in for antd committing the pick: the tag the control renders is what
    // `selected` must be read from. The remove button inside the tag carries a
    // different class token, so it must not leak into the reported value.
    (
      document.querySelector('.ant-select-item-option[title="India"]') as HTMLElement
    ).addEventListener("click", () => {
      control.querySelector(".ant-select-selection-overflow")!.innerHTML =
        '<span class="ant-select-selection-item" title="India">India' +
        '<span class="ant-select-selection-item-remove">x</span></span>';
    });

    const r = await selectOption(document, { uid: "e1", option: "India" });
    expect(r.ok).toBe(true);
    expect(r.selected).toBe("India");
  });
});
