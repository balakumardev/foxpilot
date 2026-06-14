/**
 * Accessibility-style snapshot builder.
 *
 * CRITICAL: `buildSnapshot` is used in TWO ways:
 *   (a) Imported and unit-tested directly in jsdom.
 *   (b) Injected into the page world via `chrome.scripting.executeScript`
 *       (func/args), where it runs with no access to this module.
 *
 * Because of (b) the function MUST be fully self-contained: it may NOT
 * reference any imports, module-scope variables, or sibling functions. Every
 * helper it needs is defined as an inner function. It operates ONLY on the
 * `doc` argument passed to it.
 *
 * It also avoids any layout-dependent APIs (`offsetParent`, `getClientRects`,
 * `getComputedStyle`) because jsdom has no layout engine — relying on those
 * would filter out every element. Visibility is judged purely from explicit
 * markup signals.
 */
export function buildSnapshot(
  doc: Document,
  options: { verbose: boolean; maxLength: number }
): { tree: string; isTruncated: boolean } {
  const verbose = !!options.verbose;
  const maxLength = options.maxLength;

  const UID_ATTR = "data-bcmcp-uid";
  const NAME_MAX = 120;

  // --- inner helpers (must stay inside this function body) ---

  function collapseWhitespace(s: string): string {
    return s.replace(/\s+/g, " ").trim();
  }

  function clip(s: string): string {
    const collapsed = collapseWhitespace(s);
    if (collapsed.length > NAME_MAX) {
      return collapsed.slice(0, NAME_MAX);
    }
    return collapsed;
  }

  function getInlineStyle(el: Element): string {
    return (el.getAttribute("style") || "").toLowerCase();
  }

  function isHidden(el: Element): boolean {
    if (el.hasAttribute("hidden")) {
      return true;
    }
    if (el.getAttribute("aria-hidden") === "true") {
      return true;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && el.getAttribute("type") === "hidden") {
      return true;
    }
    const style = getInlineStyle(el);
    // Match `display:none` / `visibility:hidden` allowing optional whitespace.
    if (/display\s*:\s*none/.test(style)) {
      return true;
    }
    if (/visibility\s*:\s*hidden/.test(style)) {
      return true;
    }
    return false;
  }

  function getRole(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) {
      return explicit.trim();
    }
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();

    if (tag === "a" && el.hasAttribute("href")) {
      return "link";
    }
    if (tag === "summary") {
      return "button";
    }
    if (tag === "button") {
      return "button";
    }
    if (tag === "input") {
      if (type === "button" || type === "submit" || type === "reset") {
        return "button";
      }
      if (type === "checkbox") {
        return "checkbox";
      }
      if (type === "radio") {
        return "radio";
      }
      if (type === "search") {
        return "searchbox";
      }
      return "textbox";
    }
    if (tag === "textarea") {
      return "textbox";
    }
    if (tag === "select") {
      return "combobox";
    }
    if (el.hasAttribute("contenteditable")) {
      const ce = (el.getAttribute("contenteditable") || "").toLowerCase();
      if (ce !== "false") {
        return "textbox";
      }
    }
    if (/^h[1-6]$/.test(tag)) {
      return "heading";
    }
    return "clickable";
  }

  function labelFromFor(el: Element): string {
    const id = el.getAttribute("id");
    if (!id) {
      return "";
    }
    // Escape the id for use in a CSS attribute selector.
    let selectorId = id;
    try {
      const anyWin = doc.defaultView as unknown as {
        CSS?: { escape?: (v: string) => string };
      } | null;
      if (anyWin && anyWin.CSS && typeof anyWin.CSS.escape === "function") {
        selectorId = anyWin.CSS.escape(id);
      }
    } catch (e) {
      selectorId = id;
    }
    let labelEl: Element | null = null;
    try {
      labelEl = doc.querySelector('label[for="' + selectorId + '"]');
    } catch (e) {
      labelEl = null;
    }
    if (labelEl && labelEl.textContent) {
      return labelEl.textContent;
    }
    return "";
  }

  function labelFromAncestor(el: Element): string {
    let node: Element | null = el.parentElement;
    while (node) {
      if (node.tagName.toLowerCase() === "label") {
        // The label's accessible name is its OWN text, excluding any embedded
        // form controls (the wrapped input/select/etc. and its value). Clone the
        // label, strip descendant controls, then read the remaining text.
        const clone = node.cloneNode(true) as Element;
        const controls = clone.querySelectorAll(
          "input, select, textarea, button"
        );
        for (let i = 0; i < controls.length; i++) {
          controls[i].remove();
        }
        return clone.textContent || "";
      }
      node = node.parentElement;
    }
    return "";
  }

  function nameFromLabelledBy(el: Element): string {
    const ref = el.getAttribute("aria-labelledby");
    if (!ref) {
      return "";
    }
    const ids = ref.split(/\s+/);
    const parts: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) {
        continue;
      }
      let target: Element | null = null;
      try {
        target = doc.getElementById(id);
      } catch (e) {
        target = null;
      }
      if (target && target.textContent) {
        parts.push(target.textContent);
      }
    }
    return parts.join(" ");
  }

  function getAccessibleName(el: Element, role: string): string {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && collapseWhitespace(ariaLabel)) {
      return clip(ariaLabel);
    }

    const labelledBy = nameFromLabelledBy(el);
    if (collapseWhitespace(labelledBy)) {
      return clip(labelledBy);
    }

    const forLabel = labelFromFor(el);
    if (collapseWhitespace(forLabel)) {
      return clip(forLabel);
    }

    const ancestorLabel = labelFromAncestor(el);
    if (collapseWhitespace(ancestorLabel)) {
      return clip(ancestorLabel);
    }

    const tag = el.tagName.toLowerCase();
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt && collapseWhitespace(alt)) {
        return clip(alt);
      }
    }

    const title = el.getAttribute("title");
    if (title && collapseWhitespace(title)) {
      return clip(title);
    }

    const placeholder = el.getAttribute("placeholder");
    if (placeholder && collapseWhitespace(placeholder)) {
      return clip(placeholder);
    }

    // Only fall back to raw textContent for roles where the text is the label
    // (avoid dumping the contents of large containers).
    if (role === "link" || role === "button" || role === "heading") {
      const text = el.textContent || "";
      if (collapseWhitespace(text)) {
        return clip(text);
      }
    }

    return "";
  }

  function getStateFlags(el: Element, role: string): string[] {
    const flags: string[] = [];

    const disabledAttr =
      (el as { disabled?: boolean }).disabled === true ||
      el.hasAttribute("disabled");
    if (disabledAttr || el.getAttribute("aria-disabled") === "true") {
      flags.push("disabled");
    }

    if (role === "checkbox" || role === "radio") {
      const checked =
        (el as { checked?: boolean }).checked === true ||
        el.hasAttribute("checked") ||
        el.getAttribute("aria-checked") === "true";
      if (checked) {
        flags.push("checked");
      }
    }

    const required =
      (el as { required?: boolean }).required === true ||
      el.hasAttribute("required") ||
      el.getAttribute("aria-required") === "true";
    if (required) {
      flags.push("required");
    }

    const expanded = el.getAttribute("aria-expanded");
    if (expanded === "true") {
      flags.push("expanded");
    } else if (expanded === "false") {
      flags.push("collapsed");
    }

    if (el.getAttribute("aria-selected") === "true") {
      flags.push("selected");
    }

    return flags;
  }

  // --- 1. clear stale uids from prior runs ---
  const stale = doc.querySelectorAll("[" + UID_ATTR + "]");
  for (let i = 0; i < stale.length; i++) {
    stale[i].removeAttribute(UID_ATTR);
  }

  // --- 2. select candidate elements ---
  const baseSelectors = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "[role]",
    "[tabindex]",
    "[onclick]",
    "summary",
    '[contenteditable]:not([contenteditable="false"])',
  ];
  const verboseSelectors = ["h1", "h2", "h3", "h4", "h5", "h6", "[aria-label]"];
  const selector = (verbose
    ? baseSelectors.concat(verboseSelectors)
    : baseSelectors
  ).join(",");

  const candidates = doc.querySelectorAll(selector);

  // --- 3..6. walk, compute, stamp, and build the output ---
  const lines: string[] = [];
  let uidCounter = 0;

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];

    if (isHidden(el)) {
      continue;
    }

    const role = getRole(el);
    const name = getAccessibleName(el, role);
    const flags = getStateFlags(el, role);

    uidCounter += 1;
    const uid = "e" + uidCounter;
    el.setAttribute(UID_ATTR, uid);

    let line = role + ' "' + name + '" [uid=' + uid + "]";
    if (flags.length > 0) {
      line += " (" + flags.join(", ") + ")";
    }
    lines.push(line);
  }

  // --- 6b. (verbose only) second pass: visually-clickable non-semantic
  // elements. Modern React apps build dialogs/menus from `<div onClick>`-style
  // controls that carry no role/tabindex/href/onclick attribute (the handler is
  // attached via addEventListener), so the base pass can't see them. They are
  // distinguishable only by `cursor: pointer`, which needs getComputedStyle.
  //
  // This pass is opt-in (verbose) so the default snapshot stays unchanged, and
  // it is feature-guarded so jsdom — which has no layout engine and returns
  // default styles — neither crashes nor alters existing behaviour. The
  // getComputedStyle call is wrapped in try/catch as a further safety net.
  const win = doc.defaultView;
  if (verbose && win && typeof win.getComputedStyle === "function") {
    const MAX_CLICKABLES = 300;
    let added = 0;

    function ownDirectText(el: Element): string {
      // Build the name from the element's IMMEDIATE text only (its direct child
      // text nodes), never the deep textContent of a large container.
      const parts: string[] = [];
      const kids = el.childNodes;
      for (let k = 0; k < kids.length; k++) {
        const node = kids[k];
        if (node.nodeType === 3) {
          parts.push(node.textContent || "");
        }
      }
      return parts.join(" ");
    }

    const allEls = doc.querySelectorAll("*");
    for (let i = 0; i < allEls.length && added < MAX_CLICKABLES; i++) {
      const el = allEls[i];

      // Already captured by the base pass.
      if (el.hasAttribute(UID_ATTR)) {
        continue;
      }
      if (isHidden(el)) {
        continue;
      }

      let cursor = "";
      try {
        cursor = win.getComputedStyle(el).cursor || "";
      } catch (e) {
        cursor = "";
      }
      if (cursor !== "pointer") {
        continue;
      }

      // Prefer leaf-ish clickables: if this element already contains a stamped
      // descendant, it is a wrapper around a real control — skip it to avoid
      // duplicating a bigger target.
      if (el.querySelector("[" + UID_ATTR + "]")) {
        continue;
      }

      // Name: aria-label/title, else the element's OWN direct text. A clickable
      // with no derivable label is noise — skip it.
      const ariaLabel = el.getAttribute("aria-label");
      let name = "";
      if (ariaLabel && collapseWhitespace(ariaLabel)) {
        name = clip(ariaLabel);
      } else {
        const direct = ownDirectText(el);
        if (collapseWhitespace(direct)) {
          name = clip(direct);
        } else {
          const title = el.getAttribute("title");
          if (title && collapseWhitespace(title)) {
            name = clip(title);
          }
        }
      }
      if (!name) {
        continue;
      }

      const flags = getStateFlags(el, "clickable");

      uidCounter += 1;
      const uid = "e" + uidCounter;
      el.setAttribute(UID_ATTR, uid);
      added += 1;

      let line = 'clickable "' + name + '" [uid=' + uid + "]";
      if (flags.length > 0) {
        line += " (" + flags.join(", ") + ")";
      }
      lines.push(line);
    }
  }

  // --- 7. join and truncate ---
  const full = lines.join("\n");
  if (full.length > maxLength) {
    // Truncate to the last COMPLETE line so every emitted line (including the
    // last) is whole — downstream tools parse `[uid=eN]` and must never see a
    // dangling token like `[uid=e`. Cut at the last newline at or before
    // maxLength; if there is none, emit nothing.
    const sliced = full.slice(0, maxLength);
    const lastNewline = sliced.lastIndexOf("\n");
    const tree = lastNewline >= 0 ? sliced.slice(0, lastNewline) : "";
    return { tree: tree, isTruncated: true };
  }
  return { tree: full, isTruncated: false };
}
