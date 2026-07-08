import { selectOption } from "../injected/select-option-script";

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
