/**
 * File-upload that runs in the extension's ISOLATED content-script world.
 *
 * Browsers forbid setting a file <input>'s value from JS, so the only way to
 * populate one programmatically is the DataTransfer technique. The PREVIOUS
 * implementation built that DataTransfer inside a page-world <script> element the
 * content script injected — which a strict page Content-Security-Policy (e.g. the
 * Chrome Web Store dashboard) blocks, so the upload silently timed out.
 *
 * This version needs no page-world <script>: it runs entirely in the isolated
 * content-script world, which the page CSP cannot restrict (the same world in
 * which click/fill already work). Events dispatched on the shared DOM node are
 * still observed by the page's own listeners, so frameworks react as expected.
 *
 * Drop-zone resolution: many upload widgets hide the real <input type=file>
 * (display:none / 0×0) behind a styled "drop here" button or div. Hidden inputs
 * are excluded from snapshots, so the only targetable element is the drop zone.
 * We therefore resolve the input from the targeted element, a descendant, or a
 * nearby ancestor.
 *
 * The `wrappedJSObject` / `cloneInto` branch only fires on Firefox (Xray); on
 * Chrome the direct constructors work and the content script can assign
 * `input.files` straight away. The MCP server has already read the file off disk
 * and passed its bytes here as base64 — the extension never sees a path.
 */

export interface FileUploadArgs {
  uid: string;
  filename: string;
  mimeType: string;
  base64: string;
}

export interface FileUploadResult {
  ok: boolean;
  error?: string;
}

// Provided by the Firefox content-script sandbox; undefined on Chrome / in tests.
declare const cloneInto: (<T>(obj: T, target: unknown) => T) | undefined;

export function performFileUpload(
  doc: Document,
  args: FileUploadArgs
): FileUploadResult {
  try {
    // --- shadow-DOM helpers. The same bodies are inlined in every injected
    //     module that walks shadow roots; keep the copies identical. ---

    // Elements allowed to host a shadow root (attachShadow's list) plus autonomous custom elements —
    // the closed-root APIs are only worth calling for these.
    const SHADOW_HOST_TAGS: Record<string, true> = { article: true, aside: true, blockquote: true, body: true,
      div: true, footer: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, header: true,
      main: true, nav: true, p: true, section: true, span: true };

    // Open root, else a closed root via the extension-only APIs (content-script world only):
    // Firefox exposes a read-only `openOrClosedShadowRoot` PROPERTY (Fx 63+); Chrome exposes
    // `chrome.dom.openOrClosedShadowRoot(el)` (Chrome 88+, no permission). Neither exists in the page world.
    // PERF (measured): chrome.dom.openOrClosedShadowRoot costs 2.5-8.6 µs per call and div/span are host
    // candidates, so walks memoize the closed-root probe PER INJECTED-FUNCTION CALL. The cache is declared
    // inside the exported function (never module scope). Async selectOption must not reuse it across awaits.
    const closedRootCache = new Map<Element, ShadowRoot | null>();
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
    // Tree-of-trees search (document tree + every reachable shadow tree, incl. unassigned light nodes'
    // roots). Use for uid resolution and for clearing stale uids — NOT for listing (listing is flat-tree).
    // Two passes: OPEN roots first (a plain .shadowRoot read, no extension call), then — only on a miss —
    // closed roots too, so a light-DOM or open-root match never pays for the closed-root probe.
    function deepQuery(root: Document | ShadowRoot, sel: string): Element | null {
      function walk(r: Document | ShadowRoot, closed: boolean): Element | null {
        const hit = r.querySelector(sel);
        if (hit) return hit;
        const all = r.querySelectorAll("*");
        for (let i = 0; i < all.length; i++) {
          const sr = closed ? shadowRootOf(all[i]) : ((all[i] as any).shadowRoot as ShadowRoot | null);
          if (sr) { const h = walk(sr, closed); if (h) return h; }
        }
        return null;
      }
      return walk(root, false) || walk(root, true);
    }

    // deepQuery: the uid may be stamped inside a shadow root.
    const target = deepQuery(doc, '[data-bcmcp-uid="' + args.uid + '"]');
    if (!target) {
      return {
        ok: false,
        error:
          "Element uid '" +
          args.uid +
          "' not found — take a fresh snapshot (uids are reassigned each snapshot).",
      };
    }

    // Resolve the actual file input: the target itself, a descendant, or a file
    // input inside a nearby ancestor (drop-zone wrappers hide the real input).
    const isFileInput = (n: Element | null): n is HTMLInputElement =>
      !!n && n.tagName === "INPUT" && (n as HTMLInputElement).type === "file";

    // A file input under `el`: light descendants first (the old lookup), then
    // el's own shadow root and the shadow roots below it — drop-zone widgets
    // built as web components keep the real <input type=file> in there.
    const fileInputUnder = (el: Element): HTMLInputElement | null => {
      const direct = el.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (direct) return direct;
      const own = shadowRootOf(el);
      const inOwn = own ? deepQuery(own, 'input[type="file"]') : null;
      if (inOwn) return inOwn as HTMLInputElement;
      const all = el.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const sr = shadowRootOf(all[i]);
        const h = sr ? deepQuery(sr, 'input[type="file"]') : null;
        if (h) return h as HTMLInputElement;
      }
      return null;
    };
    // The DOM parent, stepping out of a shadow root to its host. (Not the
    // flat-tree parent: a slotted trigger keeps climbing its host's light tree,
    // exactly as parentElement did.) Read through the native getter: a form
    // control named "parentNode" shadows the form's own.
    const nodeParent = Object.getOwnPropertyDescriptor(Node.prototype, "parentNode")!.get!;
    const parentOrHost = (n: Element): Element | null => {
      const p = nodeParent.call(n) as Node | null;
      if (p && p.nodeType === 11 && (p as any).host) return (p as any).host as Element;
      return p && p.nodeType === 1 ? (p as Element) : null;
    };

    let input: HTMLInputElement | null = isFileInput(target)
      ? (target as HTMLInputElement)
      : fileInputUnder(target);
    if (!input) {
      let ancestor: Element | null = target;
      for (let i = 0; i < 4 && ancestor && !input; i++) {
        ancestor = parentOrHost(ancestor);
        if (ancestor) input = fileInputUnder(ancestor);
      }
    }
    if (!input) {
      return {
        ok: false,
        error:
          "No file <input> found for uid '" +
          args.uid +
          "' (target the file input or its drop zone).",
      };
    }

    // Decode base64 -> bytes.
    const bin = atob(args.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    // Build the File/DataTransfer. On Firefox (isolated world with Xray vision),
    // create them in the page realm via wrappedJSObject + cloneInto so the
    // FileList is one the input accepts; on Chrome the direct constructors work.
    const pageWin: any = (window as any).wrappedJSObject;
    let files: FileList;
    if (pageWin && typeof cloneInto === "function") {
      const blobParts = cloneInto([bytes], pageWin);
      const opts = cloneInto({ type: args.mimeType }, pageWin);
      const file = new pageWin.File(blobParts, args.filename, opts);
      const dt = new pageWin.DataTransfer();
      dt.items.add(file);
      files = dt.files;
    } else {
      const file = new File([bytes], args.filename, { type: args.mimeType });
      const dt = new DataTransfer();
      dt.items.add(file);
      files = dt.files;
    }

    input.files = files;
    // input is composed (it crosses shadow boundaries, as the browser's own
    // does); change is not.
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
