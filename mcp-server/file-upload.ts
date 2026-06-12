/**
 * Server-side file reader for the robust `upload-file` tool.
 *
 * The key insight behind upload-file: a browser forbids JavaScript from setting
 * a file `<input>`'s value from a path, but the MCP SERVER is a Node process
 * with filesystem access. So the server reads the file bytes here, base64-encodes
 * them, and ships them to the extension; a page-world script reconstructs a
 * `File` via `DataTransfer` and assigns it to the input. The extension therefore
 * never sees a filesystem path — only `{ filename, mimeType, base64 }`.
 *
 * This module is deliberately tiny and pure (no I/O beyond reading the named
 * file) so it is unit-testable without a browser or the broker.
 */

import * as fs from "fs";
import * as path from "path";

// Default upper bound on upload size. base64 inflates payloads ~33% and the
// bytes traverse the broker WebSocket, so we keep this conservative.
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

// Minimal extension → MIME map covering the file types most likely to be
// uploaded via a web form. Anything not listed falls back to
// "application/octet-stream", which is a safe generic binary type.
const EXTENSION_MIME_TYPES: Record<string, string> = {
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  // documents
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  md: "text/markdown",
  rtf: "application/rtf",
  // office
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // archives
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  // audio / video
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

const FALLBACK_MIME_TYPE = "application/octet-stream";

/**
 * Infers a MIME type from a file path's extension (case-insensitive), falling
 * back to "application/octet-stream" for unknown or extension-less names.
 */
export function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return EXTENSION_MIME_TYPES[ext] ?? FALLBACK_MIME_TYPE;
}

/**
 * Reads a local file for upload and packages it for the extension.
 *
 * @param filePath Absolute or relative path to the file on the MCP server host.
 * @param maxBytes Maximum allowed file size (default 25 MB). Files larger than
 *   this throw rather than being shipped, since base64 over the broker socket
 *   is the bottleneck.
 * @returns `{ filename, mimeType, base64 }` — the basename, the inferred MIME
 *   type, and the file's bytes base64-encoded.
 * @throws If the file is missing/unreadable (the `fs` error propagates) or is
 *   larger than `maxBytes` (a clear "File too large" error naming the path).
 */
export function readFileForUpload(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_BYTES
): { filename: string; mimeType: string; base64: string } {
  // statSync throws ENOENT for a missing file, which we deliberately let
  // propagate — the tool layer surfaces it as a clear error content item.
  const stats = fs.statSync(filePath);
  if (stats.size > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    throw new Error(
      `File too large for upload (max ${maxMb} MB): ${filePath}`
    );
  }

  const filename = path.basename(filePath);
  const mimeType = mimeTypeForPath(filePath);
  const base64 = fs.readFileSync(filePath).toString("base64");

  return { filename, mimeType, base64 };
}
