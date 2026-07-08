/**
 * select-option injected executor (ISOLATED world, CSP-immune, async).
 *
 * Drives BOTH a native <select> and a custom combobox (react-select / Downshift /
 * Radix-shaped: a role="combobox"/button trigger that opens a role="listbox" of
 * role="option" items, often in a portal appended to <body>). Used two ways like
 * the other injected fns: (a) imported + unit-tested in jsdom; (b) run in the
 * isolated content-script world — Firefox stringifies it via `.toString()` and
 * injects it with executeScript (native Firefox executeScript awaits the returned
 * Promise). MUST stay fully self-contained: inner helpers only, no imports /
 * module refs (guarded by self-containment.test.ts). Async is preserved by
 * esbuild(esnext) and the ES2022 tsconfig — no __awaiter/__generator helper
 * appears in .toString().
 */
export async function selectOption(
  doc: Document,
  args: { uid: string; option: string; exact?: boolean }
): Promise<{ ok: boolean; selected?: string; error?: string }> {
  const UID_ATTR = "data-bcmcp-uid";
  const wantExact = args.exact === true;
  const rawWant = args.option == null ? "" : String(args.option);
  const want = rawWant.replace(/\s+/g, " ").trim().toLowerCase();

  function norm(s: string | null | undefined): string {
    return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  }
  function textMatches(candidate: string): boolean {
    const c = norm(candidate).toLowerCase();
    if (c.length === 0) {
      return false;
    }
    return wantExact ? c === want : c.indexOf(want) !== -1;
  }
  // Deepest-wins option match (option-scoped variant of snapshot-script.ts
  // isLeafTextMatch): the element contains the needle AND no DESCENDANT OPTION
  // row also contains it. Scoping the descendant check to option rows (not every
  // element) means a plain option whose label is wrapped in <span>/<small> still
  // matches, while a genuinely nested option group still resolves to the deepest.
  function isLeafTextMatch(el: Element): boolean {
    if (!textMatches(el.textContent || "")) {
      return false;
    }
    const kids = el.querySelectorAll(
      '[role="option"], [role="listbox"] li, li[role="option"], .select__option'
    );
    for (let k = 0; k < kids.length; k++) {
      if (textMatches(kids[k].textContent || "")) {
        return false;
      }
    }
    return true;
  }
  function sleep(ms: number): Promise<void> {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  try {
    const win = doc.defaultView as (Window & typeof globalThis) | null;
    const el = doc.querySelector("[" + UID_ATTR + '="' + args.uid + '"]');
    if (!el) {
      return {
        ok: false,
        error:
          "Element uid '" +
          args.uid +
          "' not found — take a fresh snapshot (uids are reassigned each snapshot).",
      };
    }

    try {
      (el as { scrollIntoView?: (opts?: unknown) => void }).scrollIntoView?.({
        block: "center",
      });
    } catch (e) {
      /* jsdom lacks a layout engine — never throw on scroll */
    }

    function mouseEvt(type: string): Event {
      return new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: win as Window,
      });
    }
    function activate(node: Element): void {
      node.dispatchEvent(mouseEvt("pointerdown"));
      node.dispatchEvent(mouseEvt("mousedown"));
      node.dispatchEvent(mouseEvt("mouseup"));
      try {
        (node as { focus?: () => void }).focus?.();
      } catch (e) {
        /* not focusable */
      }
      try {
        (node as { click?: () => void }).click?.();
      } catch (e) {
        /* ignore activation errors */
      }
    }

    // --- native <select> ---
    if (el.tagName === "SELECT") {
      const opts = (el as HTMLSelectElement).options;
      let chosen: HTMLOptionElement | null = null;
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i];
        if (textMatches(o.textContent || "") || textMatches(o.value || "")) {
          chosen = o;
          break;
        }
      }
      if (!chosen) {
        return {
          ok: false,
          error:
            'No <option> matching "' +
            rawWant +
            '" in the native <select> uid ' +
            args.uid +
            ".",
        };
      }
      (el as HTMLSelectElement).value = chosen.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, selected: norm(chosen.textContent || chosen.value) };
    }

    // --- custom combobox ---
    // 1. Open the menu.
    activate(el);

    // 2. If a search <input> appears (react-select/Downshift render one), type
    //    the wanted text to filter (framework-safe native setter + input event,
    //    the type-at pattern). The menu is often portaled, so look inside the
    //    control first, then across the document.
    function findSearchInput(control: Element): HTMLInputElement | null {
      const local = control.querySelector(
        'input:not([type="hidden"])'
      ) as HTMLInputElement | null;
      if (local) {
        return local;
      }
      const globals = doc.querySelectorAll(
        'input[role="combobox"], input[aria-autocomplete="list"], input[type="search"], .select__input input'
      );
      for (let i = 0; i < globals.length; i++) {
        const gi = globals[i] as HTMLInputElement;
        if ((gi as HTMLElement).offsetParent !== null || gi.value === "") {
          return gi;
        }
      }
      return (globals[0] as HTMLInputElement) || null;
    }
    const search = findSearchInput(el);
    if (search) {
      try {
        (search as { focus?: () => void }).focus?.();
      } catch (e) {
        /* ignore */
      }
      const proto = win!.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = descriptor && descriptor.set;
      if (setter) {
        setter.call(search, rawWant);
      } else {
        (search as { value?: string }).value = rawWant;
      }
      search.dispatchEvent(new Event("input", { bubbles: true }));
      for (let i = 0; i < rawWant.length; i++) {
        const ch = rawWant.charAt(i);
        search.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
        search.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      }
    }

    // 3. Poll for a matching option to render (portal menus mount async). Bounded:
    //    ≤ 15 iterations × 300ms. First check is at iter 0 (no sleep) so an
    //    already-open menu resolves immediately.
    function findOption(): Element | null {
      const nodes = doc.querySelectorAll(
        '[role="option"], [role="listbox"] li, li[role="option"], .select__option'
      );
      for (let i = 0; i < nodes.length; i++) {
        if (isLeafTextMatch(nodes[i])) {
          return nodes[i];
        }
      }
      return null;
    }
    let optionEl: Element | null = null;
    for (let iter = 0; iter < 15; iter++) {
      optionEl = findOption();
      if (optionEl) {
        break;
      }
      await sleep(300);
    }
    if (!optionEl) {
      return {
        ok: false,
        error:
          'No option matching "' +
          rawWant +
          '" appeared in the dropdown for uid ' +
          args.uid +
          " (opened the menu but the option never rendered — it may be a virtualized list, or the trigger is not a supported combobox).",
      };
    }

    // 4. Click the option.
    try {
      (optionEl as { scrollIntoView?: (o?: unknown) => void }).scrollIntoView?.({
        block: "center",
      });
    } catch (e) {
      /* ignore */
    }
    activate(optionEl);

    // 5. Re-read the control's displayed value: react-select shows it in a
    //    [class*="singleValue"] child; else aria-valuetext; else trigger text.
    await sleep(60);
    function readDisplayed(control: Element): string {
      const single = control.querySelector(
        '[class*="singleValue"], [class*="single-value"]'
      );
      if (single && norm(single.textContent || "")) {
        return norm(single.textContent || "");
      }
      const vt = control.getAttribute("aria-valuetext");
      if (vt && norm(vt)) {
        return norm(vt);
      }
      return norm(control.textContent || "");
    }
    const shown = readDisplayed(el);
    return { ok: true, selected: shown || norm(optionEl.textContent || "") };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
