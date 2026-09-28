import { performFileUpload } from "../injected/upload-script";

// jsdom has no functional DataTransfer, and `input.files` is read-only. Provide a
// minimal DataTransfer mock and make the input's `files` settable so the direct
// (non-Firefox) branch can run — `window.wrappedJSObject` is undefined in jsdom,
// so performFileUpload takes that branch (the Chrome path).
class MockDataTransfer {
  private _files: File[] = [];
  items = { add: (f: File) => this._files.push(f) };
  get files(): FileList {
    const arr = this._files;
    return {
      length: arr.length,
      item: (i: number) => arr[i] ?? null,
      0: arr[0],
    } as unknown as FileList;
  }
}

function makeFilesSettable(input: HTMLInputElement): void {
  let stored: FileList | null = null;
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => stored,
    set: (v: FileList) => {
      stored = v;
    },
  });
}

const args = (uid: string) => ({
  uid,
  filename: "icon.png",
  mimeType: "image/png",
  base64: "QQ==", // "A"
});

describe("performFileUpload", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    (global as unknown as { DataTransfer: unknown }).DataTransfer =
      MockDataTransfer;
  });

  it("returns ok:false when the uid is not found", () => {
    const r = performFileUpload(document, args("missing"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it("returns ok:false when no file input is near the target", () => {
    document.body.innerHTML = `<div data-bcmcp-uid="e1"><span>Drop here</span></div>`;
    const r = performFileUpload(document, args("e1"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No file <input> found/);
  });

  it("uploads when the uid points directly at a file input", () => {
    document.body.innerHTML = `<input type="file" data-bcmcp-uid="e1">`;
    const input = document.querySelector("input") as HTMLInputElement;
    makeFilesSettable(input);
    const changed = jest.fn();
    input.addEventListener("change", changed);

    const r = performFileUpload(document, args("e1"));

    expect(r.ok).toBe(true);
    expect(input.files?.length).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("resolves a hidden file input from its drop-zone wrapper", () => {
    document.body.innerHTML = `
      <div class="dropzone">
        <button data-bcmcp-uid="e5">Drop icon here</button>
        <input type="file" style="display:none">
      </div>`;
    const input = document.querySelector("input") as HTMLInputElement;
    makeFilesSettable(input);

    const r = performFileUpload(document, args("e5"));

    expect(r.ok).toBe(true);
    expect(input.files?.length).toBe(1);
  });
});

/**
 * upload-file through shadow roots: the uid resolves inside a shadow root, a
 * drop-zone host's file input may live in its own shadow root, and the
 * drop-zone ancestor walk climbs out of a shadow root to its host. Identical
 * block in the Firefox and Chrome suites.
 */
describe("performFileUpload pierces shadow roots", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    (global as unknown as { DataTransfer: unknown }).DataTransfer = MockDataTransfer;
  });

  function openHost(tag: string, html: string, parent: Element = document.body): ShadowRoot {
    const host = document.createElement(tag);
    parent.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = html;
    return root;
  }

  it("uploads when the uid points at a file input inside a shadow root", () => {
    const root = openHost("amp-upload", `<input type="file" data-bcmcp-uid="e1">`);
    const input = root.querySelector("input") as HTMLInputElement;
    makeFilesSettable(input);
    const changed = jest.fn();
    input.addEventListener("change", changed);

    const r = performFileUpload(document, args("e1"));

    expect(r.ok).toBe(true);
    expect(input.files?.length).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("finds the file input inside a drop-zone host's own shadow root", () => {
    const root = openHost("file-drop", `<div class="zone">Drop here<input type="file" hidden></div>`);
    root.host.setAttribute("data-bcmcp-uid", "e2");
    const input = root.querySelector("input") as HTMLInputElement;
    makeFilesSettable(input);

    const r = performFileUpload(document, args("e2"));

    expect(r.ok).toBe(true);
    expect(input.files?.length).toBe(1);
  });

  it("climbs from a shadow button to the light-DOM drop zone that holds the input", () => {
    document.body.innerHTML = `<div class="dropzone"><input type="file" style="display:none"></div>`;
    const zone = document.querySelector(".dropzone")!;
    openHost("x-button", `<button data-bcmcp-uid="e3">Choose file</button>`, zone);
    const input = zone.querySelector("input") as HTMLInputElement;
    makeFilesSettable(input);

    const r = performFileUpload(document, args("e3"));

    expect(r.ok).toBe(true);
    expect(input.files?.length).toBe(1);
  });
});
