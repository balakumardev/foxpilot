/**
 * get-tab-web-content extractor (ISOLATED world, CSP-immune, synchronous).
 *
 * Returns the page's rendered text (from `offset`, capped at 50,000 chars) and
 * its https links. Used two ways like the other injected fns: imported and
 * unit-tested in jsdom (and called directly by Chrome's content script), and
 * stringified via `.toString()` into Firefox's executeScript. Fully
 * self-contained: inner helpers only, no module references (guarded by
 * self-containment.test.ts).
 *
 * Shadow DOM: `body.innerText` and `querySelectorAll("a[href]")` never enter a
 * shadow root. innerText also drops slot fallback content and lists slotted
 * light children at their light-DOM position rather than where they render, so
 * a page built from web components came back without its navigation, headings
 * and links. Hence two paths:
 *   - No reachable shadow root: the original extraction, unchanged (same output
 *     byte for byte).
 *   - Otherwise the text is assembled over the FLAT tree (what renders): native
 *     innerText for every subtree that holds no shadow host and no slot, and an
 *     explicit walk through hosts, slots and their ancestors that follows
 *     innerText's rules (block boundaries, <p> and <br> as newlines;
 *     display:none, visibility:hidden, script/style/template skipped; CSS
 *     whitespace collapsing). Links are listed in flat-tree order with the same
 *     filters, so shadow and slotted links appear where they render, once each.
 * Open roots are always reachable; closed ones only through the extension-only
 * APIs, which exist in the content-script world and not in the page world.
 */
export function extractPageContent(
  doc: Document,
  opts: { offset?: number }
): {
  links: { url: string; text: string }[];
  fullText: string;
  isTruncated: boolean;
  totalLength: number;
} {
  const MAX_CONTENT_LENGTH = 50000;
  const offset = Number(opts && opts.offset) || 0;

  // --- shared shadow-DOM helpers (same bodies as the other injected modules) ---

  // Elements allowed to host a shadow root (attachShadow's list) plus autonomous custom elements —
  // the closed-root APIs are only worth calling for these.
  const SHADOW_HOST_TAGS: Record<string, true> = { article: true, aside: true, blockquote: true, body: true,
    div: true, footer: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, header: true,
    main: true, nav: true, p: true, section: true, span: true };

  // Closed-root probe results for this call, null results included:
  // chrome.dom.openOrClosedShadowRoot costs microseconds per call and div/span are host
  // candidates, so every walk over the page would otherwise pay one call per element.
  const closedRootCache = new Map<Element, ShadowRoot | null>();
  // Open root, else a closed root via the extension-only APIs (content-script world only):
  // Firefox exposes a read-only `openOrClosedShadowRoot` PROPERTY (Fx 63+); Chrome exposes
  // `chrome.dom.openOrClosedShadowRoot(el)` (Chrome 88+, no permission). Neither exists in the page world.
  function shadowRootOf(el: Element): ShadowRoot | null {
    const open = (el as any).shadowRoot as ShadowRoot | null | undefined;
    if (open) return open;
    const tag = el.localName;
    if (tag.indexOf("-") < 0 && !SHADOW_HOST_TAGS[tag]) return null;
    const cached = closedRootCache.get(el);
    if (cached !== undefined) return cached;
    let closed: ShadowRoot | null = null;
    try { const ff = (el as any).openOrClosedShadowRoot; if (ff) closed = ff as ShadowRoot; } catch (_) {}
    if (!closed) {
      try {
        const dom = (globalThis as any).chrome && (globalThis as any).chrome.dom;
        if (dom && typeof dom.openOrClosedShadowRoot === "function") closed = (dom.openOrClosedShadowRoot(el) as ShadowRoot) || null;
      } catch (_) {}
    }
    closedRootCache.set(el, closed);
    return closed;
  }
  function isInShadowTree(n: Node): boolean {
    const r = n.getRootNode ? n.getRootNode() : null;
    return !!r && r.nodeType === 11 && !!(r as any).host;
  }
  // FLAT-TREE children: a host renders its shadow root's children (its light children only via slots);
  // a <slot> inside a shadow tree renders assignedElements({flatten:true}) (fallback content when nothing
  // is assigned). This is what guarantees nothing is listed twice and unassigned light children are skipped.
  function composedChildren(node: Document | ShadowRoot | Element): Element[] {
    if (node.nodeType === 1) {
      const el = node as Element;
      const sr = shadowRootOf(el);
      if (sr) return Array.from(sr.children);
      if (el.localName === "slot" && isInShadowTree(el)) return Array.from((el as HTMLSlotElement).assignedElements({ flatten: true }));
    }
    return Array.from(node.children);
  }
  // All elements under `root` (exclusive) in flat-tree pre-order. For a tree with no shadow roots this is
  // exactly document order, i.e. the same order root.querySelectorAll("*") gives. Iterative (no recursion).
  function collectComposed(root: Document | ShadowRoot | Element): Element[] {
    const out: Element[] = [];
    const stack = composedChildren(root).reverse();
    while (stack.length) {
      const el = stack.pop() as Element;
      out.push(el);
      const kids = composedChildren(el);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  }

  // --- flat-tree rendered text ---

  // Every shadow host with a reachable root and every slot inside a shadow
  // tree, plus all of their ancestors (crossing each shadow root to its host).
  // Native innerText is exact for any element outside this set. For one inside
  // it, innerText would miss shadow content or place slotted content wrongly —
  // and using it on a light ancestor of a host would also list that host's
  // slotted text a second time when the walk reaches the slot.
  const mixed = new Set<Element>();
  function markMixed(el: Element): void {
    let n: Node | null = el;
    while (n && n.nodeType === 1 && !mixed.has(n as Element)) {
      mixed.add(n as Element);
      const p: Node | null = n.parentNode;
      n = p && p.nodeType === 11 ? ((p as any).host as Node | null) || null : p;
    }
  }
  function scan(root: Document | ShadowRoot): void {
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      const sr = shadowRootOf(all[i]);
      if (sr) {
        markMixed(all[i]);
        scan(sr);
      } else if (root.nodeType === 11 && all[i].localName === "slot") {
        markMixed(all[i]);
      }
    }
  }

  // innerText's intermediate list: a string, a required line-break count, or
  // raw text from a text node the walk renders itself ({ c }), whose spaces
  // still collapse against its neighbours.
  type TextItem = string | number | { c: string };
  // Skipped even when a page overrides their display (jsdom also reports
  // display "" for noscript, which never renders with scripting enabled).
  const SKIP_TAGS: Record<string, true> = { script: true, style: true, template: true, noscript: true };
  // Block-level displays get a line break before and after. table-row is not
  // block-level, but innerText ends every row but the last with "\n", which a
  // line-break count reproduces.
  const BREAK_DISPLAYS: Record<string, true> = { block: true, "flow-root": true, "list-item": true,
    table: true, flex: true, grid: true, "-webkit-box": true, "table-caption": true, "table-row": true };

  const win = doc.defaultView as (Window & typeof globalThis) | null;
  function styleOf(el: Element): CSSStyleDeclaration | null {
    if (!win || typeof win.getComputedStyle !== "function") return null;
    try {
      return win.getComputedStyle(el);
    } catch (e) {
      return null;
    }
  }
  function isShown(cs: CSSStyleDeclaration | null): boolean {
    return !cs || (cs.visibility !== "hidden" && cs.visibility !== "collapse");
  }
  // Node-level twin of composedChildren (text nodes included): a slot's
  // assignedNodes({flatten:true}) carries slotted text nodes too.
  function composedChildNodes(el: Element): Node[] {
    const sr = shadowRootOf(el);
    if (sr) return Array.from(sr.childNodes);
    if (el.localName === "slot" && isInShadowTree(el)) {
      return Array.from((el as HTMLSlotElement).assignedNodes({ flatten: true }));
    }
    return Array.from(el.childNodes);
  }
  function pushText(data: string, cs: CSSStyleDeclaration | null, items: TextItem[]): void {
    if (!isShown(cs)) return;
    const ws = cs ? cs.whiteSpace : "";
    if (ws === "pre" || ws === "pre-wrap" || ws === "break-spaces") {
      items.push(data);
    } else if (ws === "pre-line") {
      items.push({ c: data.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/[ \t]+/g, " ") });
    } else {
      items.push({ c: data.replace(/[ \t\n\r\f]+/g, " ") });
    }
  }
  function walkChildren(el: Element, cs: CSSStyleDeclaration | null, items: TextItem[]): void {
    const kids = composedChildNodes(el);
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k.nodeType === 3) {
        pushText((k as Text).data, cs, items);
      } else if (k.nodeType === 1) {
        walkElement(k as Element, items);
      }
    }
  }
  function walkElement(el: Element, items: TextItem[]): void {
    const tag = el.localName;
    if (SKIP_TAGS[tag]) return;
    const cs = styleOf(el);
    const display = cs ? cs.display : "";
    if (display === "none") return;
    const shown = isShown(cs);
    if (tag === "br") {
      if (shown) items.push("\n");
      return;
    }
    const contents = display === "contents";
    // No layout box and not display:contents (e.g. an unassigned light child
    // of a closed host, an SVG <title>): none of it renders, and innerText on
    // it would return its raw textContent. Needs a real layout engine.
    if (!contents && layoutActive && el.getClientRects().length === 0) return;
    const breaks =
      !shown || contents
        ? 0
        : tag === "p"
          ? 2
          : BREAK_DISPLAYS[display] || display.indexOf("block ") === 0
            ? 1
            : 0;
    if (breaks) items.push(breaks);
    if (mixed.has(el) || contents || typeof (el as any).innerText !== "string") {
      walkChildren(el, cs, items);
    } else {
      items.push((el as HTMLElement).innerText);
    }
    if (shown && display === "table-cell") {
      for (let s = el.nextElementSibling; s; s = s.nextElementSibling) {
        const scs = styleOf(s);
        if (scs && scs.display === "table-cell") {
          items.push("\t");
          break;
        }
      }
    }
    if (breaks) items.push(breaks);
  }
  // innerText's last step: drop empty strings and leading/trailing line
  // breaks, and turn each run of required line breaks into "\n" repeated the
  // run's largest count. Raw text ({ c }) also collapses the way CSS does: its
  // edge spaces are held back and written only between two runs on one line,
  // never at a line start or end or next to other whitespace. Linear: the
  // output is only appended to, and its last character is tracked separately.
  function joinItems(items: TextItem[]): string {
    let out = "";
    let last = "";
    let pending = 0;
    let space = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (typeof it === "number") {
        if (it > pending) pending = it;
        continue;
      }
      let s: string;
      let trailing = false;
      if (typeof it === "string") {
        s = it;
      } else {
        s = it.c;
        if (s.charAt(0) === " ") {
          space = true;
          s = s.slice(1);
        }
        if (s.charAt(s.length - 1) === " ") {
          trailing = true;
          s = s.slice(0, -1);
        }
      }
      if (s === "") {
        if (trailing) space = true;
        continue;
      }
      if (pending > 0) {
        if (out !== "") {
          out += "\n".repeat(pending);
          last = "\n";
        }
        pending = 0;
      } else if (space && out !== "") {
        const first = s.charAt(0);
        if (last !== " " && last !== "\n" && last !== "\t" && first !== " " && first !== "\n" && first !== "\t") {
          out += " ";
        }
      }
      out += s;
      last = s.charAt(s.length - 1);
      space = trailing;
    }
    return out;
  }
  function textOf(el: Element): string {
    if (!mixed.has(el)) return (el as HTMLElement).innerText;
    const items: TextItem[] = [];
    walkChildren(el, styleOf(el), items);
    return joinItems(items);
  }

  scan(doc);
  const hasShadow = mixed.size > 0;
  // Is a real layout engine active? jsdom has none (every rect is 0x0), so the
  // no-layout-box check must be off there. Only the shadow path needs it.
  const layoutActive =
    hasShadow &&
    (function (): boolean {
      try {
        const de = doc.documentElement as Element | null;
        if (de && typeof de.getBoundingClientRect === "function") {
          const r = de.getBoundingClientRect();
          return !!(r && r.height > 0);
        }
      } catch (e) {
        /* no layout — treat as inactive */
      }
      return false;
    })();

  // With no shadow root, textOf is body.innerText and this is the original
  // document-order a[href] list.
  const bodyText = textOf(doc.body);
  const linkElements = hasShadow
    ? collectComposed(doc).filter((el) => el.matches("a[href]"))
    : Array.from(doc.querySelectorAll("a[href]"));
  const links = linkElements
    .map((el) => ({
      url: (el as HTMLAnchorElement).href,
      text:
        textOf(el).trim() ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        "",
    }))
    .filter(
      (link) =>
        link.text !== "" &&
        link.url.startsWith("https://") &&
        !link.url.includes("#")
    );

  let isTruncated = false;
  let text = bodyText.substring(offset);
  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.substring(0, MAX_CONTENT_LENGTH);
    isTruncated = true;
  }

  return {
    links,
    fullText: text,
    isTruncated,
    totalLength: bodyText.length,
  };
}
