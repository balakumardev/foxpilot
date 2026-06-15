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
