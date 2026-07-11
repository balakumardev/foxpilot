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
  options: {
    verbose: boolean;
    maxLength: number;
    // Phase-1 additions (all optional; back-compatible):
    includePointer?: boolean; // default true — capture cursor:pointer elements
    maxInteractive?: number; // cap on the pointer pass (default 500)
    selector?: string; // CSS-selector query mode (Task 5)
    textContains?: string; // visible-text query mode (Task 6)
    rootSelector?: string; // region scoping (Task 7)
    offset?: number; // paging (Task 8)
    limit?: number; // paging (Task 8)
  }
): {
  tree: string;
  isTruncated: boolean;
  total?: number;
  hasMore?: boolean;
  error?: string;
} {
  const verbose = !!options.verbose;
  const maxLength = options.maxLength;
  const includePointer = options.includePointer !== false; // default true
  const maxInteractive =
    typeof options.maxInteractive === "number" ? options.maxInteractive : 500;

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

  // Roles whose accessible name is computed FROM the element's own text content
  // (ARIA "Name From: contents"). For these the visible text IS the label, so a
  // textContent fallback is correct and safe (they are leaf-ish, not large
  // containers). Lets unlabelled IDS widgets read as option "E2E" / tab
  // "Secrets" instead of option "" / tab "".
  function isNameFromContentsRole(role: string): boolean {
    switch (role) {
      case "option":
      case "tab":
      case "menuitem":
      case "menuitemcheckbox":
      case "menuitemradio":
      case "treeitem":
      case "radio":
      case "checkbox":
      case "switch":
      case "gridcell":
      case "cell":
      case "columnheader":
      case "rowheader":
      case "listitem":
        return true;
      default:
        return false;
    }
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

    // FIX 1: custom comboboxes (react-select) keep their label/value/placeholder
    // in CHILD nodes, not attributes — probe them for combobox/textbox roles.
    if (role === "combobox" || role === "textbox") {
      const childName = childValueText(el);
      if (collapseWhitespace(childName)) {
        return clip(childName);
      }
    }

    // Only fall back to raw textContent for roles where the text is the label
    // (avoid dumping the contents of large containers). FIX 2 widens this to
    // custom (explicit-role) combobox/textbox — but NEVER native
    // select/textarea/input, whose textContent is option/child noise. Plus the
    // ARIA "name from contents" roles (option/tab/menuitem/etc.), so IDS custom
    // widgets surface e.g. tab "Secrets" instead of tab "".
    const hasExplicitRole = !!el.getAttribute("role");
    if (
      role === "link" ||
      role === "button" ||
      role === "heading" ||
      isNameFromContentsRole(role) ||
      ((role === "combobox" || role === "textbox") && hasExplicitRole)
    ) {
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

  const VALUE_MAX = 80;
  const SECTION_MAX = 60;

  function formatSlot(s: string, max: number): string {
    // Collapse whitespace, neutralize the slot delimiter (a literal "|" inside a
    // slot would make the row ambiguous — collapse it to "/"), then clip to the
    // slot budget.
    const cleaned = collapseWhitespace(s).replace(/\|/g, "/");
    if (cleaned.length > max) {
      return cleaned.slice(0, max);
    }
    return cleaned;
  }

  function getCurrentValue(el: Element, role: string): string {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") {
      return (el as HTMLTextAreaElement).value || "";
    }
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      // Checkbox/radio carry their state in flags; button/file/hidden/image have
      // no displayable value; password is excluded so a typed/autofilled secret
      // never leaks into the snapshot value slot. Only text-entry inputs
      // contribute a value slot.
      if (
        type === "checkbox" ||
        type === "radio" ||
        type === "button" ||
        type === "submit" ||
        type === "reset" ||
        type === "hidden" ||
        type === "file" ||
        type === "image" ||
        type === "password"
      ) {
        return "";
      }
      return (el as HTMLInputElement).value || "";
    }
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const opts = sel.selectedOptions;
      if (opts && opts.length > 0 && opts[0].textContent) {
        return opts[0].textContent;
      }
      const idx = sel.selectedIndex;
      if (
        idx >= 0 &&
        sel.options &&
        sel.options[idx] &&
        sel.options[idx].textContent
      ) {
        return sel.options[idx].textContent as string;
      }
      return "";
    }
    // Custom combobox (react-select and similar): value in ARIA or child nodes.
    if (role === "combobox") {
      const valueText = el.getAttribute("aria-valuetext");
      if (valueText && collapseWhitespace(valueText)) {
        return valueText;
      }
      const valueNow = el.getAttribute("aria-valuenow");
      if (valueNow && collapseWhitespace(valueNow)) {
        return valueNow;
      }
      const single = el.querySelector(
        '[class*="singleValue"], [class*="single-value"]'
      );
      if (single && collapseWhitespace(single.textContent || "")) {
        return single.textContent || "";
      }
      // Nothing selected → the placeholder identifies the empty control.
      const ph = el.querySelector('[class*="placeholder"]');
      if (ph && collapseWhitespace(ph.textContent || "")) {
        return ph.textContent || "";
      }
      const phAttr = el.getAttribute("placeholder");
      if (phAttr && collapseWhitespace(phAttr)) {
        return phAttr;
      }
    }
    return "";
  }

  function childValueText(el: Element): string {
    // react-select / Downshift render the selected value or placeholder in CHILD
    // nodes rather than an attribute; surface them so a bare combobox is nameable.
    const single = el.querySelector(
      '[class*="singleValue"], [class*="single-value"]'
    );
    if (single && collapseWhitespace(single.textContent || "")) {
      return single.textContent || "";
    }
    const ph = el.querySelector('[class*="placeholder"]');
    if (ph && collapseWhitespace(ph.textContent || "")) {
      return ph.textContent || "";
    }
    return "";
  }

  function makeRow(
    el: Element,
    role: string,
    name: string,
    value: string,
    section: string,
    flags: string[],
    uid: string
  ): string {
    // el is part of the shared signature both the base and pointer passes call
    // through; every slot is precomputed by the caller, so el is not read here.
    const nameSlot = formatSlot(name, NAME_MAX);
    const valueClean = formatSlot(value, VALUE_MAX);
    const sectionSlot = formatSlot(section, SECTION_MAX);
    // Drop a value that merely repeats the name (a bare custom combobox whose
    // only signal is its placeholder ends up in both — show it once, as name).
    const valueSlot =
      valueClean && valueClean !== nameSlot ? '"' + valueClean + '"' : "";
    let line =
      role +
      ' "' +
      nameSlot +
      '" | ' +
      valueSlot +
      " | " +
      sectionSlot +
      " [uid=" +
      uid +
      "]";
    if (flags.length > 0) {
      line += " (" + flags.join(", ") + ")";
    }
    return line;
  }

  function isHeading(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      return true;
    }
    return el.getAttribute("role") === "heading";
  }

  function getSection(el: Element): string {
    // 1. fieldset > legend
    const fs = el.closest("fieldset");
    if (fs) {
      const legend = fs.querySelector("legend");
      if (legend && collapseWhitespace(legend.textContent || "")) {
        return legend.textContent || "";
      }
    }
    // 2. nearest titled container: section / role=group / *card* / labelledby.
    const container = el.closest(
      'section,[role="group"],[class*="card"],[aria-labelledby]'
    );
    if (container) {
      const labelled = nameFromLabelledBy(container);
      if (collapseWhitespace(labelled)) {
        return labelled;
      }
      const heading = container.querySelector(
        'h1,h2,h3,h4,h5,h6,[role="heading"]'
      );
      if (heading && collapseWhitespace(heading.textContent || "")) {
        return heading.textContent || "";
      }
    }
    // 3. ancestor + previousElementSibling walk for the nearest heading.
    let node: Element | null = el.parentElement;
    while (node) {
      let sib: Element | null = node.previousElementSibling;
      while (sib) {
        if (isHeading(sib) && collapseWhitespace(sib.textContent || "")) {
          return sib.textContent || "";
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
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
  const baseSelectorString = (verbose
    ? baseSelectors.concat(verboseSelectors)
    : baseSelectors
  ).join(",");

  // Query mode: an explicit CSS `selector` returns exactly its matches (fresh
  // uids), interactive or not, and is self-contained (no pointer pass).
  const selectorMode =
    typeof options.selector === "string" && options.selector.length > 0;

  const textMode =
    typeof options.textContains === "string" && options.textContains.length > 0;
  const textNeedle = textMode
    ? (options.textContains as string).toLowerCase()
    : "";
  function ownTextIncludesNeedle(el: Element): boolean {
    return (el.textContent || "").toLowerCase().indexOf(textNeedle) !== -1;
  }
  function isLeafTextMatch(el: Element): boolean {
    // Deepest-wins: reject if any DESCENDANT element also contains the needle.
    const kids = el.querySelectorAll("*");
    for (let k = 0; k < kids.length; k++) {
      if (ownTextIncludesNeedle(kids[k])) {
        return false;
      }
    }
    return true;
  }

  // Region scoping: restrict collection to the subtree of the first element
  // matching rootSelector. A miss is an explicit, recoverable error. Name
  // resolution (getElementById/querySelector for labels) still uses `doc`.
  let root: ParentNode = doc;
  if (
    typeof options.rootSelector === "string" &&
    options.rootSelector.length > 0
  ) {
    let scoped: Element | null = null;
    try {
      scoped = doc.querySelector(options.rootSelector);
    } catch (e) {
      return {
        tree: "",
        isTruncated: false,
        total: 0,
        hasMore: false,
        error: "Invalid rootSelector: " + options.rootSelector,
      };
    }
    if (!scoped) {
      return {
        tree: "",
        isTruncated: false,
        total: 0,
        hasMore: false,
        error: "rootSelector matched no element: " + options.rootSelector,
      };
    }
    root = scoped;
  }

  let candidates: Element[];
  if (selectorMode) {
    try {
      candidates = Array.prototype.slice.call(
        root.querySelectorAll(options.selector as string)
      );
    } catch (e) {
      return {
        tree: "",
        isTruncated: false,
        total: 0,
        hasMore: false,
        error: "Invalid CSS selector: " + options.selector,
      };
    }
  } else if (textMode) {
    // Text query mode with no selector scans all elements; the text filter and
    // leaf-preference below narrow it down.
    candidates = Array.prototype.slice.call(root.querySelectorAll("*"));
  } else {
    candidates = Array.prototype.slice.call(
      root.querySelectorAll(baseSelectorString)
    );
  }
  if (textMode) {
    candidates = candidates.filter(
      (el) => ownTextIncludesNeedle(el) && isLeafTextMatch(el)
    );
  }

  // --- 3..6. walk, compute, stamp, and build the output ---
  const lines: string[] = [];
  let uidCounter = 0;

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];

    if (isHidden(el)) {
      continue;
    }

    const role = getRole(el);
    let name = getAccessibleName(el, role);
    if (textMode && !name) {
      // Text query mode targets leaf elements matched purely by their visible
      // text (e.g. a role-less "Open" card), which the accessible-name rules
      // leave unnamed. Fall back to the leaf's own trimmed text (clip respects
      // NAME_MAX) so the match is identifiable. Strictly text-mode-local, so the
      // base / pointer / selector passes are unaffected.
      name = clip(el.textContent || "");
    }
    const flags = getStateFlags(el, role);

    uidCounter += 1;
    const uid = "e" + uidCounter;
    el.setAttribute(UID_ATTR, uid);

    lines.push(
      makeRow(el, role, name, getCurrentValue(el, role), getSection(el), flags, uid)
    );
  }

  // --- 6b. (default via includePointer) second pass: visually-clickable non-semantic
  // elements. Modern React apps build dialogs/menus from `<div onClick>`-style
  // controls that carry no role/tabindex/href/onclick attribute (the handler is
  // attached via addEventListener), so the base pass can't see them. They are
  // distinguishable only by `cursor: pointer`, which needs getComputedStyle.
  //
  // This pass runs by default (includePointer, on by default) so React `<div onClick>` cards appear in the default snapshot, and
  // it is feature-guarded so jsdom — which has no layout engine and returns
  // default styles — neither crashes nor alters existing behaviour. The
  // getComputedStyle call is wrapped in try/catch as a further safety net.
  const win = doc.defaultView;
  if (includePointer && !selectorMode && !textMode && win && typeof win.getComputedStyle === "function") {
    const MAX_CLICKABLES = maxInteractive;
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

    const allEls = root.querySelectorAll("*");
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

      lines.push(
        makeRow(
          el,
          "clickable",
          name,
          getCurrentValue(el, "clickable"),
          getSection(el),
          flags,
          uid
        )
      );
    }
  }

  // --- 6c. page over the collected candidate lines (before the char cut) ---
  const total = lines.length;
  const offset =
    typeof options.offset === "number" && options.offset > 0
      ? Math.floor(options.offset)
      : 0;
  const hasLimit = typeof options.limit === "number" && options.limit >= 0;
  const limit = hasLimit ? Math.floor(options.limit as number) : undefined;
  let pagedLines = lines;
  if (offset > 0 || limit !== undefined) {
    pagedLines = lines.slice(
      offset,
      limit !== undefined ? offset + limit : undefined
    );
  }
  const moreAfterPage = offset + pagedLines.length < total;

  // --- 7. join and truncate ---
  const full = pagedLines.join("\n");
  if (full.length > maxLength) {
    // Truncate to the last COMPLETE line so no `[uid=eN]` token is cut.
    const sliced = full.slice(0, maxLength);
    const lastNewline = sliced.lastIndexOf("\n");
    const tree = lastNewline >= 0 ? sliced.slice(0, lastNewline) : "";
    // The char cut dropped lines too, so more content exists either way.
    return { tree: tree, isTruncated: true, total: total, hasMore: true };
  }
  return { tree: full, isTruncated: false, total: total, hasMore: moreAfterPage };
}
