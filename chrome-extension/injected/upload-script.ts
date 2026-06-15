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
    const target = doc.querySelector('[data-bcmcp-uid="' + args.uid + '"]');
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

    let input: HTMLInputElement | null = isFileInput(target)
      ? (target as HTMLInputElement)
      : target.querySelector('input[type="file"]');
    if (!input) {
      let ancestor: Element | null = target;
      for (let i = 0; i < 4 && ancestor && !input; i++) {
        ancestor = ancestor.parentElement;
        if (ancestor) input = ancestor.querySelector('input[type="file"]');
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
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
