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
 *     innerText for every subtree that holds no shadow host and no slot, with
 *     the line breaks it drops at that subtree's edges put back, and an
 *     explicit walk through hosts, slots and their ancestors that follows
 *     innerText's rules (block boundaries, <p> and <br> as newlines, table
 *     cells and rows; display:none, visibility:hidden, script/style/template,
 *     a closed <details> and content-visibility:hidden skipped; CSS white-space
 *     collapsing around atomic inline boxes; text-transform). Links are listed
 *     in flat-tree order with the same filters, so shadow and slotted links
 *     appear where they render, once each.
 * Open roots are always reachable; closed ones only through the extension-only
 * APIs, which exist in the content-script world and not in the page world.
 * SVG <a href> links are listed on both paths (text from textContent); the
 * original extraction threw on any page containing one.
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
    if (closedRootCache.has(el)) return closedRootCache.get(el) as ShadowRoot | null;
    let found: ShadowRoot | null = null;
    try { const ff = (el as any).openOrClosedShadowRoot; if (ff) found = ff as ShadowRoot; } catch (_) {}
    if (!found) {
      try {
        const dom = (globalThis as any).chrome && (globalThis as any).chrome.dom;
        if (dom && typeof dom.openOrClosedShadowRoot === "function") found = (dom.openOrClosedShadowRoot(el) as ShadowRoot) || null;
      } catch (_) {}
    }
    closedRootCache.set(el, found);
    return found;
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
      // An <svg><slot> is an SVG element named "slot" with no assignedElements — only real HTML slots.
      if (el.localName === "slot" && typeof (el as any).assignedElements === "function" && isInShadowTree(el)) return Array.from((el as HTMLSlotElement).assignedElements({ flatten: true }));
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
      } else if (
        root.nodeType === 11 &&
        all[i].localName === "slot" &&
        typeof (all[i] as any).assignedNodes === "function"
      ) {
        markMixed(all[i]);
      }
    }
  }

  // innerText's intermediate list: a string as rendered, a required line-break
  // count (a line boundary here), raw text from a text node the walk renders
  // itself ({ c }), whose spaces still collapse against its neighbours, or an
  // atomic inline box ({ a, l, t }: an input, an image, an inline-block...)
  // with its rendered text and the line breaks innerText puts at its inside
  // edges. The box is line content even when it renders no text, so the spaces
  // on either side of it stay, and its inside breaks are not line boundaries
  // for those spaces.
  type TextItem = string | number | { c: string } | { a: string; l: number; t: number };
  // Skipped even when a page overrides their display (jsdom also reports
  // display "" for noscript, which never renders with scripting enabled).
  const SKIP_TAGS: Record<string, true> = { script: true, style: true, template: true, noscript: true };
  // Block-level displays get a line break before and after.
  const BREAK_DISPLAYS: Record<string, true> = { block: true, "flow-root": true, "list-item": true,
    table: true, flex: true, grid: true, "-webkit-box": true, "table-caption": true };
  // Elements whose children never render as page text (a <textarea>'s value, a
  // <canvas> or <video> fallback, a <select>'s options, which Chrome's
  // innerText lists and Firefox's does not): innerText alone says what they add.
  const OPAQUE_TAGS: Record<string, true> = { select: true, textarea: true, canvas: true, video: true,
    audio: true, iframe: true, object: true, embed: true };
  // Atomic inline boxes other than those and the inline-block family.
  const ATOMIC_TAGS: Record<string, true> = { img: true, input: true, button: true, svg: true,
    math: true, meter: true, progress: true };
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";

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
    if (el.localName === "slot" && typeof (el as any).assignedNodes === "function" && isInShadowTree(el)) {
      return Array.from((el as HTMLSlotElement).assignedNodes({ flatten: true }));
    }
    return Array.from(el.childNodes);
  }
  // Has a box whose contents render. False for a display:none subtree, an
  // unslotted light child or an SVG <title> (no box), and — checkVisibility —
  // for anything inside a closed <details> or a content-visibility:hidden
  // (hidden=until-found) box, which keeps its box but renders nothing: innerText
  // skips it. Never asked of display:contents, which has no box of its own.
  function isRendered(el: Element): boolean {
    const check = (el as any).checkVisibility;
    if (typeof check === "function") {
      try {
        return !!check.call(el);
      } catch (e) {
        /* fall back to the box test */
      }
    }
    return !layoutActive || el.getClientRects().length > 0;
  }
  // A content-visibility:hidden box renders, but none of its contents.
  function rendersContents(cs: CSSStyleDeclaration | null): boolean {
    return !cs || cs.display === "contents" || cs.contentVisibility !== "hidden";
  }
  // Flat-tree child nodes that can render. A closed <details> shows only its
  // first <summary>; checkVisibility cannot rule out the loose text beside it.
  function renderedChildNodes(el: Element): Node[] {
    const kids = composedChildNodes(el);
    if (el.localName !== "details" || el.namespaceURI !== HTML_NS || el.hasAttribute("open")) return kids;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 1 && (kids[i] as Element).localName === "summary") return [kids[i]];
    }
    return [];
  }
  // innerText's required line break count for an element's own box.
  function breaksOf(el: Element, display: string, shown: boolean): number {
    if (!shown || display === "contents") return 0;
    if (el.localName === "p") return 2;
    return BREAK_DISPLAYS[display] || display.indexOf("block ") === 0 ? 1 : 0;
  }
  function pushText(data: string, cs: CSSStyleDeclaration | null, items: TextItem[]): void {
    if (!isShown(cs)) return;
    const tt = cs ? cs.textTransform : "";
    if (tt === "uppercase") data = data.toUpperCase();
    else if (tt === "lowercase") data = data.toLowerCase();
    else if (tt === "capitalize") {
      // A word starts after anything but a letter, digit or apostrophe (both
      // engines: "Cap It-All O'neil"), and a text node can continue the
      // previous one's word.
      let prev = "";
      for (let i = items.length - 1; i >= 0; i--) {
        const p = items[i];
        if (typeof p === "number") {
          if (p > 0) break;
        } else if (typeof p === "string") {
          if (p !== "") {
            prev = p.charAt(p.length - 1);
            break;
          }
        } else if ("a" in p) {
          break;
        } else if (p.c !== "") {
          prev = p.c.charAt(p.c.length - 1);
          break;
        }
      }
      data = (prev + data)
        .replace(/(^|[^\p{L}\p{N}\p{M}'’])(\p{Ll})/gu, (_m: string, b: string, c: string) => b + c.toUpperCase())
        .slice(prev.length);
    }
    const ws = cs ? cs.whiteSpace : "";
    if (ws === "pre" || ws === "pre-wrap" || ws === "break-spaces") {
      items.push(data);
    } else if (ws === "pre-line") {
      items.push({ c: data.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/[ \t]+/g, " ") });
    } else {
      items.push({ c: data.replace(/[ \t\n\r\f]+/g, " ") });
    }
  }
  // Whether a text node renders a string at all. Collapsible white space alone
  // does not where it matters here, next to a line break.
  function rendersText(data: string, cs: CSSStyleDeclaration | null): boolean {
    if (!isShown(cs)) return false;
    const ws = cs ? cs.whiteSpace : "";
    if (ws === "pre" || ws === "pre-wrap" || ws === "break-spaces") return data !== "";
    return (ws === "pre-line" ? /[^ \t\r\f]/ : /[^ \t\n\r\f]/).test(data);
  }
  function walkChildren(el: Element, cs: CSSStyleDeclaration | null, items: TextItem[]): void {
    if (!rendersContents(cs)) return;
    // SVG renders text only inside its text content elements.
    const svgText =
      el.namespaceURI !== SVG_NS ||
      /^(text|tspan|textPath)$/.test(el.localName) ||
      (el.localName === "a" && !!el.parentNode && /^(text|tspan|textPath)$/.test((el.parentNode as Element).localName));
    const kids = renderedChildNodes(el);
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k.nodeType === 3) {
        if (svgText) pushText((k as Text).data, cs, items);
      } else if (k.nodeType === 1) {
        walkElement(k as Element, items);
      }
    }
  }
  // An atomic inline box: the inline-block family, inline math (Chrome's
  // "math"), or a replaced or form element laid out inline (an <img>, an
  // <input>, an <svg>...). jsdom reports display "" for elements it has no
  // style for.
  function isAtomic(tag: string, display: string): boolean {
    if (display === "inline" || display === "") return !!(OPAQUE_TAGS[tag] || ATOMIC_TAGS[tag]);
    return display === "math" || display.indexOf("inline-") === 0 || display.indexOf("inline ") === 0;
  }
  // innerText ends a table row with "\n" unless no row follows it in its table —
  // in tree order, whatever the layout order of a <tfoot>.
  function isLastRow(row: Element): boolean {
    const displayOf = (e: Element): string => {
      const s = styleOf(e);
      return s ? s.display : "";
    };
    const isGroup = (d: string): boolean =>
      d === "table-row-group" || d === "table-header-group" || d === "table-footer-group";
    for (let s = row.nextElementSibling; s; s = s.nextElementSibling) {
      if (displayOf(s) === "table-row") return false;
    }
    const group = row.parentElement;
    if (!group || !isGroup(displayOf(group))) return true;
    for (let g = group.nextElementSibling; g; g = g.nextElementSibling) {
      const d = displayOf(g);
      if (d === "table-row") return false;
      if (!isGroup(d)) continue;
      for (let r = g.firstElementChild; r; r = r.nextElementSibling) {
        if (displayOf(r) === "table-row") return false;
      }
    }
    return true;
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
    if (!contents && !isRendered(el)) return;
    const breaks = breaksOf(el, display, shown);
    if (breaks) items.push(breaks);
    if (!mixed.has(el) && !contents && typeof (el as any).innerText === "string") {
      if (rendersContents(cs)) pushNative(el, display, breaks, items);
    } else if (!contents && isAtomic(tag, display)) {
      // An atomic box (a button holding a host, an <svg>) lays out its content
      // on lines of its own: join it on its own, then place it as one box.
      const sub: TextItem[] = [];
      walkChildren(el, cs, sub);
      const a = joinItems(sub);
      items.push({ a, l: runOf(sub, false), t: a === "" ? 0 : runOf(sub, true) });
    } else {
      walkChildren(el, cs, items);
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
    if (shown && display === "table-row" && !isLastRow(el)) items.push("\n");
    if (breaks) items.push(breaks);
  }
  // A box that renders no text but still counts as line content.
  const EMPTY_BOX: TextItem = { a: "", l: 0, t: 0 };
  // An element with no host and no slot under it: native innerText renders it
  // exactly, except that it drops the line breaks at its own inside edges —
  // "read" for <label style="display:inline-flex"><span>read</span></label>,
  // whose flex item puts a line break on either side — so put those back.
  function pushNative(el: Element, display: string, own: number, items: TextItem[]): void {
    const tag = el.localName;
    const a = (el as HTMLElement).innerText;
    if (OPAQUE_TAGS[tag]) {
      // innerText lists a <select>'s options as block-level boxes.
      const edge = tag === "select" && a !== "" ? 1 : 0;
      items.push({ a, l: edge, t: edge });
      return;
    }
    // A <p>'s own count of 2 already bounds its edges: nothing to put back.
    if (own >= 2) {
      items.push(a);
      return;
    }
    const head = edgeOf(el, false);
    if (isAtomic(tag, display)) {
      items.push({ a, l: head.breaks, t: a === "" ? 0 : edgeOf(el, true).breaks });
      return;
    }
    const tail = edgeOf(el, true);
    // An atomic box right at an edge of an inline keeps the space beside it.
    if (own === 0 && head.atom) items.push(EMPTY_BOX);
    items.push(head.breaks, a);
    if (a !== "") items.push(tail.breaks);
    if (own === 0 && tail.atom) items.push(EMPTY_BOX);
  }
  // What innerText drops at an inside edge of an element it is called on: the
  // largest required line break count before its first rendered string (fromEnd:
  // after its last one), found by walking in from that edge until a string would
  // be produced — with no string at all, the whole list is one run — and whether
  // an atomic box sits at that edge ahead of any line break.
  function edgeOf(root: Element, fromEnd: boolean): { breaks: number; atom: boolean } {
    let breaks = 0;
    let atom = false;
    const nodes: Node[] = [];
    const styles: Array<CSSStyleDeclaration | null> = [];
    const enter = (el: Element, cs: CSSStyleDeclaration | null): void => {
      const kids = renderedChildNodes(el);
      for (let i = 0; i < kids.length; i++) {
        nodes.push(kids[fromEnd ? i : kids.length - 1 - i]);
        styles.push(cs);
      }
    };
    enter(root, styleOf(root));
    while (nodes.length) {
      const n = nodes.pop() as Node;
      const parentCs = styles.pop() as CSSStyleDeclaration | null;
      if (n.nodeType === 3) {
        if (rendersText((n as Text).data, parentCs)) break;
        continue;
      }
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      const tag = el.localName;
      if (SKIP_TAGS[tag]) continue;
      const cs = styleOf(el);
      const display = cs ? cs.display : "";
      if (display === "none") continue;
      const shown = isShown(cs);
      if (tag === "br") {
        if (shown) break;
        continue;
      }
      if (display !== "contents" && !isRendered(el)) continue;
      if (breaks === 0 && isAtomic(tag, display)) atom = true;
      if (OPAQUE_TAGS[tag]) {
        if ((el as HTMLElement).innerText === "") continue;
        if (tag === "select" && breaks < 1) breaks = 1;
        break;
      }
      const b = breaksOf(el, display, shown);
      if (b > breaks) breaks = b;
      if (rendersContents(cs)) enter(el, cs);
    }
    return { breaks, atom };
  }
  // The same for a list the walk built: the largest line break count before its
  // first string (fromEnd: after its last), an empty box's breaks included.
  function runOf(items: TextItem[], fromEnd: boolean): number {
    let best = 0;
    for (let k = 0; k < items.length; k++) {
      const it = items[fromEnd ? items.length - 1 - k : k];
      if (typeof it === "number") {
        if (it > best) best = it;
      } else if (typeof it === "string") {
        if (it !== "") return best;
      } else if ("a" in it) {
        const near = fromEnd ? it.t : it.l;
        const far = fromEnd ? it.l : it.t;
        if (near > best) best = near;
        if (it.a !== "") return best;
        if (far > best) best = far;
      } else if (/[^ ]/.test(it.c)) {
        return best;
      }
    }
    return best;
  }
  // innerText's last step: drop empty strings and the line breaks at the start
  // and end, and turn each run of required line breaks into "\n" repeated the
  // run's largest count. Raw text ({ c }) also collapses the way CSS does: its
  // edge spaces are held back and written only between two things on one line,
  // never at a line start or end or next to other white space. An atomic box is
  // such a thing even when it renders no text; its inside breaks are written
  // but end no line for the spaces around it, and an empty box does not split a
  // run of line breaks. Linear: the output is only appended to.
  function joinItems(items: TextItem[]): string {
    let out = "";
    let pending = 0; // line breaks not written yet
    let boundary = false; // a line ends here, not only a box's inside edge
    let space = false; // a collapsible space held back
    let lastWs = true; // the output ends in white space or a line start
    let afterBox = false; // the last content on this line is an atomic box
    const flush = (): void => {
      if (pending > 0 && out !== "") {
        out += "\n".repeat(pending);
        lastWs = true;
      }
      pending = 0;
      boundary = false;
    };
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (typeof it === "number") {
        if (it > 0) {
          if (it > pending) pending = it;
          boundary = true;
        }
        continue;
      }
      if (typeof it !== "string" && "a" in it) {
        if (space && !boundary && (afterBox || !lastWs)) {
          flush();
          out += " ";
          lastWs = true;
        }
        space = false;
        if (it.l > pending) pending = it.l;
        if (it.a !== "") {
          flush();
          out += it.a;
          lastWs = /[ \n\t]$/.test(it.a);
          pending = it.t;
        } else if (it.t > pending) {
          pending = it.t;
        }
        boundary = false;
        afterBox = true;
        continue;
      }
      let s = typeof it === "string" ? it : it.c;
      let lead = false;
      let trail = false;
      if (typeof it !== "string") {
        if (s.charAt(0) === " ") {
          lead = true;
          s = s.slice(1);
        }
        if (s.charAt(s.length - 1) === " ") {
          trail = true;
          s = s.slice(0, -1);
        }
      }
      if (s === "") {
        if (lead || trail) space = true;
        continue;
      }
      const spaced = (space || lead) && !boundary && (afterBox || !lastWs) && !/^[ \n\t]/.test(s);
      flush();
      if (spaced) out += " ";
      out += s;
      lastWs = /[ \n\t]$/.test(s);
      afterBox = false;
      space = trail;
    }
    return out;
  }
  // Descendant text content over the flat tree: what innerText returns for an
  // element that is not being rendered. Without script/style/template text,
  // since every component root carries a <style>.
  function flatText(root: Element): string {
    let out = "";
    const stack: Node[] = composedChildNodes(root).slice().reverse();
    while (stack.length) {
      const n = stack.pop() as Node;
      if (n.nodeType === 3) {
        out += (n as Text).data;
      } else if (n.nodeType === 1 && !SKIP_TAGS[(n as Element).localName]) {
        const kids = composedChildNodes(n as Element);
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
    }
    return out;
  }
  function textOf(el: Element): string {
    if (!mixed.has(el)) return (el as HTMLElement).innerText;
    // Like innerText, an element that is not being rendered reads as its text.
    if (layoutActive && el.getClientRects().length === 0) return flatText(el);
    if (!isRendered(el)) return "";
    const items: TextItem[] = [];
    walkChildren(el, styleOf(el), items);
    return joinItems(items);
  }
  // An SVG <a href> matches a[href] too, but it is no HTMLElement: it has no
  // innerText, and its `href` is an SVGAnimatedString, not a URL string. The
  // a[href] match guarantees a plain href attribute (the value baseVal
  // reflects), so resolve that against the document base URL instead. For an
  // HTML link both helpers return exactly what they always did.
  function linkUrl(el: Element): string {
    const href = (el as any).href;
    if (typeof href === "string") return href;
    try {
      return new URL(el.getAttribute("href") || "", doc.baseURI).href;
    } catch (e) {
      return "";
    }
  }
  function linkText(el: Element): string {
    if (typeof (el as any).innerText === "string") return textOf(el).trim();
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  scan(doc);
  const hasShadow = mixed.size > 0;
  // Is a real layout engine active? jsdom has none (it reports no boxes), so the
  // box tests must be off there. Asks for <html>'s box rather than its height:
  // an app shell with body{margin:0} and a fixed-position root has a <html> of
  // height 0. Only the shadow path needs it.
  const layoutActive =
    hasShadow &&
    (function (): boolean {
      try {
        const de = doc.documentElement as Element | null;
        return !!de && typeof de.getClientRects === "function" && de.getClientRects().length > 0;
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
      url: linkUrl(el),
      text:
        linkText(el) ||
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
