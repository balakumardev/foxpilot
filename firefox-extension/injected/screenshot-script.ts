/**
 * Screenshot helpers for the take-screenshot tool.
 *
 * This module is bundled into the extension background page (a real DOM
 * document, so `document.createElement("canvas")` and `Image` work in Firefox).
 * The element-crop and full-page-stitch modes draw onto a `<canvas>`, which has
 * NO renderer in jsdom — so the pure planning/parsing helpers are extracted and
 * unit-tested directly, while the canvas compositing is exercised only in a real
 * browser. Every canvas access is guarded so importing this module never throws
 * in a headless/jsdom environment.
 *
 * Unlike the snapshot/action injected scripts, the functions here are NOT
 * stringified into the page world: `captureVisibleTab` and canvas work happen in
 * the privileged background page, while the small per-page measurement reads are
 * injected separately as code strings by the message handler.
 */

export type ImageFormat = "png" | "jpeg";

/**
 * Splits a `data:<mime>;base64,<data>` URL into its mime type and raw base64
 * payload. `captureVisibleTab` always returns a base64 data URL, so this is how
 * we strip the prefix before sending the bytes to the server.
 *
 * Falls back gracefully if the input is not a recognizable data URL: returns the
 * whole string as `base64` and an empty `mimeType`.
 */
export function stripDataUrlPrefix(dataUrl: string): {
  mimeType: string;
  base64: string;
} {
  const match = /^data:([^;,]*)(?:;[^,]*)?,(.*)$/s.exec(dataUrl);
  if (!match) {
    return { mimeType: "", base64: dataUrl };
  }
  return { mimeType: match[1] || "", base64: match[2] || "" };
}

/**
 * Plans the list of vertical scroll offsets needed to tile a full page of
 * `scrollHeight` using a viewport of `clientHeight`, capturing the visible area
 * at each offset.
 *
 * - Advances by `clientHeight` until the whole page height is covered.
 * - Never emits a duplicate tail offset when the page is an exact multiple of
 *   the viewport height (e.g. 2000 / 1000 -> [0, 1000], not [0, 1000, 2000]).
 * - Always returns at least [0] (a page that fits in the viewport).
 *
 * Note: the final tile may overlap the previous one when the page is not an
 * exact multiple; the compositor draws each capture at its true y offset so the
 * overlap simply overwrites identical pixels.
 */
export function planFullPageSteps(dims: {
  scrollHeight: number;
  clientHeight: number;
}): number[] {
  const scrollHeight = Math.max(0, Math.floor(dims.scrollHeight));
  const clientHeight = Math.floor(dims.clientHeight);

  // Degenerate viewport — capture a single frame at the top.
  if (!Number.isFinite(clientHeight) || clientHeight <= 0) {
    return [0];
  }

  const steps: number[] = [];
  for (let y = 0; y < scrollHeight; y += clientHeight) {
    steps.push(y);
  }
  // A page that fits entirely in the viewport still needs one capture.
  if (steps.length === 0) {
    steps.push(0);
  }
  return steps;
}

/**
 * Loads a (data) URL into an HTMLImageElement, resolving once it has decoded.
 * Used to turn each `captureVisibleTab` data URL into a drawable image for the
 * canvas compositor. Browser-only: jsdom does not decode images.
 */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("Failed to load captured image into an Image element"));
    img.src = url;
  });
}

/**
 * Returns the canvas mime type string for an image format.
 */
export function mimeTypeForFormat(format: ImageFormat): string {
  return format === "jpeg" ? "image/jpeg" : "image/png";
}

/**
 * Crops a single captured viewport data URL to an element's rectangle.
 *
 * `rect` is in CSS pixels relative to the current viewport; `dpr` is
 * `window.devicePixelRatio`. The captured bitmap is in device pixels, so the
 * source region is `rect * dpr`. Returns a base64 (no data-url prefix) PNG/JPEG
 * of just the element.
 *
 * Browser-only: relies on a real 2D canvas context. Throws a clear error if no
 * canvas renderer is available (e.g. running under jsdom).
 */
export async function cropElementFromCapture(
  captureDataUrl: string,
  rect: { x: number; y: number; width: number; height: number; dpr: number },
  format: ImageFormat
): Promise<{ mimeType: string; base64: string }> {
  const mimeType = mimeTypeForFormat(format);
  const dpr = rect.dpr > 0 ? rect.dpr : 1;

  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for element crop");
  }

  const img = await loadImage(captureDataUrl);
  ctx.drawImage(img, sx, sy, width, height, 0, 0, width, height);

  const out = canvas.toDataURL(mimeType, 0.9);
  return stripDataUrlPrefix(out);
}

/**
 * Composites a sequence of captured viewport data URLs (one per scroll offset
 * from `planFullPageSteps`) into a single tall image of the whole page.
 *
 * `dims.scrollWidth` / `dims.scrollHeight` are the full document size in CSS
 * pixels; `dpr` scales to device pixels to match the captured bitmaps. Each
 * capture is drawn at `offsetY * dpr` so tiles line up.
 *
 * KNOWN ARTIFACT: sticky/fixed-position headers, footers, or banners are
 * re-painted in every viewport capture, so they appear duplicated down the
 * stitched image (once per tile). This is inherent to scroll-and-stitch capture
 * and cannot be avoided without per-site knowledge.
 *
 * Browser-only: relies on a real 2D canvas context. Throws a clear error if no
 * canvas renderer is available (e.g. running under jsdom).
 */
export async function stitchFullPage(
  captures: { offsetY: number; dataUrl: string }[],
  dims: { scrollWidth: number; scrollHeight: number; dpr: number },
  format: ImageFormat
): Promise<{ mimeType: string; base64: string }> {
  const mimeType = mimeTypeForFormat(format);
  const dpr = dims.dpr > 0 ? dims.dpr : 1;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(dims.scrollWidth * dpr));
  canvas.height = Math.max(1, Math.round(dims.scrollHeight * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for full-page stitch");
  }

  for (const capture of captures) {
    const img = await loadImage(capture.dataUrl);
    ctx.drawImage(img, 0, Math.round(capture.offsetY * dpr));
  }

  const out = canvas.toDataURL(mimeType, 0.9);
  return stripDataUrlPrefix(out);
}
