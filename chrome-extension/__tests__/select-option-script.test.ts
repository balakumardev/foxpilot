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

/**
 * select-option through shadow roots: the uid, the aria-controls popup lookup
 * (IDs are scoped per tree) and the option-row search all pierce shadow roots
 * (open, and closed via BOTH extension API shapes). Identical block in the
 * Firefox and Chrome suites.
 */
describe("select-option pierces shadow roots", () => {
  const closedRoots = new Map<Element, ShadowRoot>();
  let restoreClosed: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    if (restoreClosed) {
      restoreClosed();
      restoreClosed = null;
    }
    closedRoots.clear();
    document.body.innerHTML = "";
  });

  function openHost(tag: string, html: string): ShadowRoot {
    const host = document.createElement(tag);
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = html;
    return root;
  }
  function closedHost(tag: string, html: string): ShadowRoot {
    const host = document.createElement(tag);
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = html;
    closedRoots.set(host, root);
    return root;
  }
  function exposeClosedViaProperty(): void {
    Object.defineProperty(Element.prototype, "openOrClosedShadowRoot", {
      configurable: true,
      get(this: Element) {
        return closedRoots.get(this) || this.shadowRoot || null;
      },
    });
    restoreClosed = () => {
      delete (Element.prototype as any).openOrClosedShadowRoot;
    };
  }
  function exposeClosedViaChromeDom(): void {
    const g = globalThis as any;
    const hadChrome = typeof g.chrome !== "undefined";
    if (!hadChrome) {
      g.chrome = {};
    }
    g.chrome.dom = {
      openOrClosedShadowRoot: (el: Element) => closedRoots.get(el) || el.shadowRoot || null,
    };
    restoreClosed = () => {
      delete g.chrome.dom;
      if (!hadChrome) {
        delete g.chrome;
      }
    };
  }
  const PLATFORM_SELECT = `<select data-bcmcp-uid="e1"><option value="ios">iOS</option><option value="macos">macOS</option><option value="tvos">tvOS</option></select>`;

  it("picks an option in a native <select> inside an open shadow root", async () => {
    const root = openHost("amp-search", PLATFORM_SELECT);
    const sel = root.querySelector("select") as HTMLSelectElement;
    let changed = 0;
    sel.addEventListener("change", () => changed++);

    const r = await selectOption(document, { uid: "e1", option: "tvOS" });

    expect(r.ok).toBe(true);
    expect(sel.value).toBe("tvos");
    expect(r.selected).toBe("tvOS");
    expect(changed).toBe(1);
  });

  it("picks an option in a native <select> inside a CLOSED root via the Firefox property", async () => {
    const root = closedHost("amp-search", PLATFORM_SELECT);
    exposeClosedViaProperty();
    const r = await selectOption(document, { uid: "e1", option: "macOS" });
    expect(r.ok).toBe(true);
    expect((root.querySelector("select") as HTMLSelectElement).value).toBe("macos");
  });

  it("picks an option in a native <select> inside a CLOSED root via chrome.dom", async () => {
    const root = closedHost("amp-search", PLATFORM_SELECT);
    exposeClosedViaChromeDom();
    const r = await selectOption(document, { uid: "e1", option: "macOS" });
    expect(r.ok).toBe(true);
    expect((root.querySelector("select") as HTMLSelectElement).value).toBe("macos");
  });

  it("drives a custom combobox whose aria-controls popup and options live in the same shadow root", async () => {
    const root = openHost(
      "amp-picker",
      `<div role="combobox" data-bcmcp-uid="e1" aria-controls="lb"><span class="select__singleValue"></span></div>
       <div id="lb" role="listbox">
         <input type="text" class="filter" />
         <div role="option">United States</div>
         <div role="option">India</div>
       </div>`
    );
    const filter = root.querySelector(".filter") as HTMLInputElement;
    const india = Array.from(root.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent === "India"
    )!;
    let clicked = 0;
    india.addEventListener("click", () => {
      clicked++;
      (root.querySelector(".select__singleValue") as HTMLElement).textContent = "India";
    });

    const r = await selectOption(document, { uid: "e1", option: "India" });

    expect(r.ok).toBe(true);
    expect(clicked).toBe(1);
    expect(r.selected).toBe("India");
    expect(filter.value).toBe("India"); // the root-aware aria-controls lookup found the filter
  });

  it("still resolves an aria-controls popup portaled to the document from a shadow-root control", async () => {
    const root = openHost(
      "amp-picker",
      `<div role="combobox" data-bcmcp-uid="e1" aria-controls="portal"><span class="select__singleValue"></span></div>`
    );
    const portal = document.createElement("div");
    portal.id = "portal";
    portal.setAttribute("role", "listbox");
    portal.innerHTML = `<input type="text" class="filter" /><div role="option">Japan</div>`;
    document.body.appendChild(portal);
    portal.querySelector('[role="option"]')!.addEventListener("click", () => {
      (root.querySelector(".select__singleValue") as HTMLElement).textContent = "Japan";
    });

    const r = await selectOption(document, { uid: "e1", option: "Japan" });

    expect(r.ok).toBe(true);
    expect(r.selected).toBe("Japan");
    expect((portal.querySelector(".filter") as HTMLInputElement).value).toBe("Japan");
  });

  it("B10: a recycled <select> inside a shadow root is rejected as stale", async () => {
    document.body.innerHTML = `<select aria-label="Platform"><option value="ios">iOS</option><option value="tvos">tvOS</option></select>`;
    const sel = document.querySelector("select") as HTMLSelectElement;
    buildSnapshot(document, { verbose: false, maxLength: 25000 });
    const uid = sel.getAttribute("data-bcmcp-uid")!;
    const root = openHost("amp-search", "");
    root.appendChild(sel);

    expect((await selectOption(document, { uid, option: "tvOS" })).ok).toBe(true);
    sel.setAttribute("aria-label", "Region");
    const stale = await selectOption(document, { uid, option: "iOS" });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/fresh snapshot/);
  });
});

/**
 * select-option polls across awaits and opens the menu by running the page's
 * own handlers, either of which can attach a new shadow root mid-call. The
 * closed-root probe cache must therefore never be reused across an await (or
 * across the activation). Option rows are searched in the light DOM first, then
 * in open shadow roots (a plain .shadowRoot read, no extension call), then in
 * the closed shadow tree the control itself lives in or hosts — so a page with
 * no shadow roots pays nothing for the shadow search. Identical block in the
 * Firefox and Chrome suites.
 */
describe("select-option never reuses the closed-root cache across an await", () => {
  const closedRoots = new Map<Element, ShadowRoot>();
  const probe = { calls: 0 };
  let hadChrome = false;

  beforeEach(() => {
    document.body.innerHTML = "";
    probe.calls = 0;
    const g = globalThis as any;
    hadChrome = typeof g.chrome !== "undefined";
    if (!hadChrome) {
      g.chrome = {};
    }
    g.chrome.dom = {
      openOrClosedShadowRoot: (el: Element) => {
        probe.calls++;
        return closedRoots.get(el) || null;
      },
    };
  });
  afterEach(() => {
    const g = globalThis as any;
    delete g.chrome.dom;
    if (!hadChrome) {
      delete g.chrome;
    }
    closedRoots.clear();
    document.body.innerHTML = "";
  });

  function openRoot(tag: string, html: string): ShadowRoot {
    const host = document.createElement(tag);
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = html;
    return root;
  }

  it("finds options in a listbox that attaches its closed root after the click, inside the control's own closed root", async () => {
    // A closed-root select component: its trigger (the uid) and an <x-listbox>
    // child live in its closed root, and the listbox attaches ITS closed root
    // only once the trigger is clicked. The first poll probes <x-listbox> before
    // that; reusing that cached "no root" after the await would never find it.
    const select = document.createElement("my-select");
    document.body.appendChild(select);
    const sroot = select.attachShadow({ mode: "closed" });
    closedRoots.set(select, sroot);
    sroot.innerHTML = `<div role="combobox" data-bcmcp-uid="e1"><span class="select__singleValue"></span></div><x-listbox></x-listbox>`;
    const lb = sroot.querySelector("x-listbox")!;
    let picked = 0;
    sroot.querySelector('[role="combobox"]')!.addEventListener("click", () => {
      setTimeout(() => {
        const root = lb.attachShadow({ mode: "closed" });
        root.innerHTML = `<div role="listbox"><div role="option">India</div></div>`;
        closedRoots.set(lb, root);
        root.querySelector('[role="option"]')!.addEventListener("click", () => {
          picked++;
          (sroot.querySelector(".select__singleValue") as HTMLElement).textContent = "India";
        });
      }, 50);
    });

    const r = await selectOption(document, { uid: "e1", option: "India" });

    expect(r.ok).toBe(true);
    expect(picked).toBe(1);
    expect(r.selected).toBe("India");
  });

  it("finds a light-DOM option without probing any closed root", async () => {
    document.body.innerHTML = `<div><span>a</span><span>b</span></div>
      <div data-bcmcp-uid="e1" role="combobox"><span class="select__singleValue"></span></div>
      <div role="listbox"><div role="option">United States</div><div role="option">India</div></div>`;

    const r = await selectOption(document, { uid: "e1", option: "India" });

    expect(r.ok).toBe(true);
    expect(probe.calls).toBe(0);
  });

  it("finds an option in an open shadow root without probing any closed root", async () => {
    document.body.innerHTML = `<div><span>a</span></div><div data-bcmcp-uid="e1" role="combobox"><span class="select__singleValue"></span></div>`;
    openRoot("x-listbox", `<div role="listbox"><div role="option">India</div></div>`);

    const r = await selectOption(document, { uid: "e1", option: "India" });

    expect(r.ok).toBe(true);
    expect(probe.calls).toBe(0);
  });

  it("an option that never renders, on a page without shadow roots, probes at most the control itself per poll", async () => {
    jest.useFakeTimers();
    try {
      document.body.innerHTML = `<div><span>a</span><span>b</span><section><p>c</p></section></div><div data-bcmcp-uid="e1" role="combobox">Pick</div>`;

      const pending = selectOption(document, { uid: "e1", option: "Nope" });
      await jest.advanceTimersByTimeAsync(10000);
      const r = await pending;

      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/No option matching "Nope"/);
      expect(probe.calls).toBeLessThanOrEqual(15);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a native <select> inside a shadow root fires a composed input (the host sees it) and a non-composed change", async () => {
    const root = openRoot(
      "x-field",
      `<select data-bcmcp-uid="e1"><option value="ios">iOS</option><option value="tvos">tvOS</option></select>`
    );
    const seen: string[] = [];
    root.host.addEventListener("input", () => seen.push("input"));
    root.host.addEventListener("change", () => seen.push("change"));

    const r = await selectOption(document, { uid: "e1", option: "tvOS" });

    expect(r.ok).toBe(true);
    expect((root.querySelector("select") as HTMLSelectElement).value).toBe("tvos");
    expect(seen).toEqual(["input"]);
  });

  it("typing into a combobox's own filter input inside a shadow root fires a composed input", async () => {
    const root = openRoot(
      "x-picker",
      `<div role="combobox" data-bcmcp-uid="e1"><input class="filter" /><span class="select__singleValue"></span></div><div role="listbox"><div role="option">India</div></div>`
    );
    const seen: string[] = [];
    root.host.addEventListener("input", () => seen.push("input"));

    await selectOption(document, { uid: "e1", option: "India" });

    expect(seen).toContain("input");
  });
});
