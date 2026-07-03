import {
  planFullPageSteps,
  stripDataUrlPrefix,
  mimeTypeForFormat,
  isValidCapture,
} from "../injected/screenshot-script";

/**
 * Pure-helper tests for the take-screenshot tool.
 *
 * jsdom has no canvas renderer, so the canvas-dependent compositing functions
 * (cropElementFromCapture / stitchFullPage) are NOT pixel-tested here; they run
 * only in a real browser. What IS unit-tested is the deterministic, layout-free
 * logic that decides WHAT to capture and how to parse the captured data URL:
 *   - planFullPageSteps: the scroll-offset plan for full-page stitching
 *   - stripDataUrlPrefix: splitting a data: URL into mime + base64
 *   - mimeTypeForFormat: png/jpeg mime mapping
 *   - isValidCapture: whether a captureVisibleTab readback is usable (Task 7)
 */
describe("planFullPageSteps", () => {
  it("tiles a page taller than the viewport into clientHeight steps", () => {
    expect(
      planFullPageSteps({ scrollHeight: 2500, clientHeight: 1000 })
    ).toEqual([0, 1000, 2000]);
  });

  it("does not emit a duplicate tail offset for an exact multiple", () => {
    // 2000 / 1000 covers [0,1000); [1000,2000) — the page is fully covered at
    // offset 1000, so 2000 must NOT be emitted.
    expect(
      planFullPageSteps({ scrollHeight: 2000, clientHeight: 1000 })
    ).toEqual([0, 1000]);
  });

  it("returns a single [0] when the page fits within the viewport", () => {
    expect(
      planFullPageSteps({ scrollHeight: 600, clientHeight: 1000 })
    ).toEqual([0]);
  });

  it("returns [0] for a page exactly one viewport tall", () => {
    expect(
      planFullPageSteps({ scrollHeight: 1000, clientHeight: 1000 })
    ).toEqual([0]);
  });

  it("returns [0] for a zero-height page", () => {
    expect(planFullPageSteps({ scrollHeight: 0, clientHeight: 1000 })).toEqual([
      0,
    ]);
  });

  it("returns [0] when the viewport height is degenerate (<= 0)", () => {
    expect(
      planFullPageSteps({ scrollHeight: 5000, clientHeight: 0 })
    ).toEqual([0]);
  });

  it("returns [0] for a non-finite scrollHeight (Infinity) without looping forever", () => {
    // A bogus Infinity scrollHeight must not produce an unbounded loop / RangeError.
    expect(
      planFullPageSteps({ scrollHeight: Infinity, clientHeight: 1000 })
    ).toEqual([0]);
  });

  it("returns [0] for a NaN scrollHeight", () => {
    expect(
      planFullPageSteps({ scrollHeight: NaN, clientHeight: 1000 })
    ).toEqual([0]);
  });
});

describe("stripDataUrlPrefix", () => {
  it("splits a png data URL into mime type and base64 payload", () => {
    expect(stripDataUrlPrefix("data:image/png;base64,AAAA")).toEqual({
      mimeType: "image/png",
      base64: "AAAA",
    });
  });

  it("splits a jpeg data URL into mime type and base64 payload", () => {
    expect(stripDataUrlPrefix("data:image/jpeg;base64,/9j/4AAQ")).toEqual({
      mimeType: "image/jpeg",
      base64: "/9j/4AAQ",
    });
  });

  it("falls back to empty mime and the raw string for a non-data-URL input", () => {
    expect(stripDataUrlPrefix("not-a-data-url")).toEqual({
      mimeType: "",
      base64: "not-a-data-url",
    });
  });
});

describe("mimeTypeForFormat", () => {
  it("maps png -> image/png", () => {
    expect(mimeTypeForFormat("png")).toBe("image/png");
  });

  it("maps jpeg -> image/jpeg", () => {
    expect(mimeTypeForFormat("jpeg")).toBe("image/jpeg");
  });
});

describe("isValidCapture (Task 7)", () => {
  it("accepts a real data URL", () => {
    expect(isValidCapture("data:image/png;base64,AAAA")).toBe(true);
  });
  it("rejects an empty string and a payload-less data URL", () => {
    expect(isValidCapture("")).toBe(false);
    expect(isValidCapture("data:image/png;base64,")).toBe(false);
    expect(isValidCapture(undefined)).toBe(false);
  });
});
