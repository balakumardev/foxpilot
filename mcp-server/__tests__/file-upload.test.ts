import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileForUpload } from "../file-upload";

/**
 * `readFileForUpload` is the server-side half of the robust upload-file tool: it
 * reads an arbitrary local path off disk and packages it (filename, mimeType,
 * base64) for the extension. These tests write real temp files and assert the
 * round-trip, the extension→mime mapping, and the size guard.
 */
describe("readFileForUpload", () => {
  const tmpFiles: string[] = [];

  function makeTempFile(name: string, contents: Buffer | string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bcmcp-upload-"));
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, contents);
    tmpFiles.push(filePath);
    return filePath;
  }

  afterAll(() => {
    for (const f of tmpFiles) {
      try {
        fs.rmSync(path.dirname(f), { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it("returns the basename as filename and base64 that round-trips to the original bytes", () => {
    // Use bytes that are not valid UTF-8 to prove a true binary round-trip.
    const original = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x42, 0x10]);
    const filePath = makeTempFile("payload.bin", original);

    const result = readFileForUpload(filePath);

    expect(result.filename).toBe("payload.bin");
    expect(Buffer.from(result.base64, "base64")).toEqual(original);
  });

  it("infers image/png from a .png extension", () => {
    const filePath = makeTempFile("pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(readFileForUpload(filePath).mimeType).toBe("image/png");
  });

  it("infers common types (jpg, pdf, csv, json) from the extension, case-insensitively", () => {
    expect(readFileForUpload(makeTempFile("a.JPG", "x")).mimeType).toBe(
      "image/jpeg"
    );
    expect(readFileForUpload(makeTempFile("a.jpeg", "x")).mimeType).toBe(
      "image/jpeg"
    );
    expect(readFileForUpload(makeTempFile("doc.pdf", "x")).mimeType).toBe(
      "application/pdf"
    );
    expect(readFileForUpload(makeTempFile("data.csv", "a,b")).mimeType).toBe(
      "text/csv"
    );
    expect(readFileForUpload(makeTempFile("data.json", "{}")).mimeType).toBe(
      "application/json"
    );
  });

  it("falls back to application/octet-stream for an unknown extension", () => {
    const filePath = makeTempFile("mystery.zzz", "data");
    expect(readFileForUpload(filePath).mimeType).toBe("application/octet-stream");
  });

  it("throws a clear 'File too large' error when the file exceeds maxBytes", () => {
    const filePath = makeTempFile("big.bin", Buffer.alloc(100));
    expect(() => readFileForUpload(filePath, 10)).toThrow(
      /File too large for upload/
    );
    // The error mentions the offending path so the model can report it.
    expect(() => readFileForUpload(filePath, 10)).toThrow(filePath);
  });

  it("accepts a file at exactly maxBytes", () => {
    const filePath = makeTempFile("exact.bin", Buffer.alloc(8));
    expect(() => readFileForUpload(filePath, 8)).not.toThrow();
  });

  it("throws when the file does not exist", () => {
    const missing = path.join(os.tmpdir(), "bcmcp-does-not-exist-xyz.bin");
    expect(() => readFileForUpload(missing)).toThrow();
  });
});
