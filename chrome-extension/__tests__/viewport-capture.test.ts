import { CAPTURE_MIN_GAP_MS, ViewportCapturer, type CaptureEnv } from "../viewport-capture";

// Why this module exists (measured 2026-11-15 in a throwaway Chromium, real
// chrome.tabs.captureVisibleTab):
//
//  - A MINIMIZED window (or a hidden browser app, another Space, a sleeping
//    display) makes the page document.visibilityState === "hidden". Chrome paints
//    no frames for it. If the tab has no retained frame (it navigated, or was
//    hidden a long time) EVERY captureVisibleTab fails with "Failed to capture tab:
//    image readback failed", for as long as the window stays hidden, so retrying
//    is pure latency. If it does have a retained frame, the call "succeeds" with
//    the last frame painted before the window was hidden, i.e. a stale picture.
//    A fully covered but not hidden window captured fine.
//  - Chrome allows only 2 captureVisibleTab calls per second
//    (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND), so retries at 100/300 ms intervals
//    burned the quota instead of retrying.

const IMG = "data:image/jpeg;base64,QUJD";

function makeEnv(over: Partial<CaptureEnv> = {}) {
  let t = 0;
  const callTimes: number[] = [];
  const env: CaptureEnv = {
    sleep: jest.fn(async (ms: number) => {
      t += ms;
    }),
    now: () => t,
    captureVisibleTab: jest.fn(async () => {
      callTimes.push(t);
      return IMG;
    }),
    readVisibility: jest.fn(async () => "visible"),
    readWindowState: jest.fn(async () => "normal"),
    cdpCapture: jest.fn(async () => "Q0RQ"),
    ...over,
  };
  return { env, callTimes, clock: () => t };
}

describe("ViewportCapturer.viewport on a visible window", () => {
  it("returns the captureVisibleTab image with no warning", async () => {
    const { env } = makeEnv();
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(r).toEqual({ mimeType: "image/jpeg", base64: "QUJD" });
    expect(env.cdpCapture).not.toHaveBeenCalled();
  });

  it("retries a transient failure and still returns the image without the debugger", async () => {
    let n = 0;
    const { env } = makeEnv({
      captureVisibleTab: jest.fn(async () => {
        if (++n === 1) throw new Error("Failed to capture tab: image readback failed");
        return IMG;
      }),
    });
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(r.base64).toBe("QUJD");
    expect(r.warning).toBeUndefined();
    expect(env.captureVisibleTab).toHaveBeenCalledTimes(2);
    expect(env.cdpCapture).not.toHaveBeenCalled();
  });

  it("treats an empty readback as a failure to retry", async () => {
    let n = 0;
    const { env } = makeEnv({
      captureVisibleTab: jest.fn(async () => (++n < 3 ? "data:image/jpeg;base64," : IMG)),
    });
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(r.base64).toBe("QUJD");
    expect(env.captureVisibleTab).toHaveBeenCalledTimes(3);
  });

  it("falls back to the debugger only after every attempt failed, and the warning names the real error", async () => {
    const { env } = makeEnv({
      captureVisibleTab: jest.fn(async () => {
        throw new Error("Failed to capture tab: image readback failed");
      }),
      readWindowState: jest.fn(async () => "normal"),
    });
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(env.captureVisibleTab).toHaveBeenCalledTimes(3);
    expect(r.base64).toBe("Q0RQ");
    expect(r.warning).toMatch(/CDP screenshot fallback/);
    expect(r.warning).toMatch(/image readback failed/);
    expect(r.warning).toMatch(/window state: normal/);
  });
});

describe("ViewportCapturer.viewport when captureVisibleTab is refused for lack of all-sites access", () => {
  // Real Chrome text, reproduced with a per-origin host grant on a visible window.
  const REFUSAL = "Either the '<all_urls>' or 'activeTab' permission is required.";

  it("does not retry a permission refusal: one call, then the debugger", async () => {
    const { env } = makeEnv({
      captureVisibleTab: jest.fn(async () => {
        throw new Error(REFUSAL);
      }),
    });
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(env.captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(env.cdpCapture).toHaveBeenCalledWith(7, "jpeg");
    expect(r.base64).toBe("Q0RQ");
  });

  it("names the real cause and the fix instead of calling it an empty readback", async () => {
    const { env } = makeEnv({
      captureVisibleTab: jest.fn(async () => {
        throw new Error(REFUSAL);
      }),
    });
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(r.warning).toMatch(/all-sites access/);
    expect(r.warning).toContain(REFUSAL);
    expect(r.warning).toMatch(/Automation Mode/);
    expect(r.warning).toMatch(/CDP screenshot fallback/);
    expect(r.warning).not.toMatch(/empty readback/);
  });

  it("also recognises the newer wording for a host Chrome will not let it capture", async () => {
    const { env } = makeEnv({
      captureVisibleTab: jest.fn(async () => {
        throw new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host.");
      }),
    });
    await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(env.captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it("captureWithRetry rethrows a permission refusal at once, tagged so callers can tell", async () => {
    const { env } = makeEnv({
      captureVisibleTab: jest.fn(async () => {
        throw new Error(REFUSAL);
      }),
    });
    const err = await new ViewportCapturer(env).captureWithRetry(1, "jpeg").catch((e) => e);
    expect(env.captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(err.kind).toBe("permission");
    expect(err.message).toContain(REFUSAL);
  });
});

describe("ViewportCapturer pacing: Chrome allows 2 captureVisibleTab calls per second", () => {
  it("never makes two calls closer together than the minimum gap", async () => {
    const failedAt: number[] = [];
    const { env, callTimes, clock } = makeEnv();
    env.captureVisibleTab = jest.fn(async () => {
      failedAt.push(clock());
      throw new Error("boom");
    });
    const cap = new ViewportCapturer(env);
    await cap.viewport(7, 1, "jpeg");
    callTimes.push(...failedAt);
    expect(callTimes.length).toBe(3);
    for (let i = 1; i < callTimes.length; i++) {
      expect(callTimes[i] - callTimes[i - 1]).toBeGreaterThanOrEqual(CAPTURE_MIN_GAP_MS);
    }
    // No 1-second window ever holds more than 2 calls.
    for (let i = 2; i < callTimes.length; i++) {
      expect(callTimes[i] - callTimes[i - 2]).toBeGreaterThanOrEqual(1000);
    }
  });

  it("spaces separate screenshots too (full-page tiles, back to back requests)", async () => {
    const { env, callTimes } = makeEnv();
    const cap = new ViewportCapturer(env);
    await cap.captureWithRetry(1, "jpeg");
    await cap.captureWithRetry(1, "jpeg");
    await cap.captureWithRetry(1, "jpeg");
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(CAPTURE_MIN_GAP_MS);
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(CAPTURE_MIN_GAP_MS);
  });

  it("keeps concurrent screenshots spaced as well", async () => {
    const { env, callTimes } = makeEnv();
    const cap = new ViewportCapturer(env);
    await Promise.all([
      cap.captureWithRetry(1, "jpeg"),
      cap.captureWithRetry(1, "jpeg"),
      cap.captureWithRetry(1, "jpeg"),
    ]);
    expect(callTimes).toHaveLength(3);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(CAPTURE_MIN_GAP_MS);
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(CAPTURE_MIN_GAP_MS);
  });

  it("does not wait at all for the first capture", async () => {
    const { env, clock } = makeEnv();
    await new ViewportCapturer(env).captureWithRetry(1, "jpeg");
    expect(clock()).toBe(0);
  });
});

describe("ViewportCapturer.viewport on a hidden window", () => {
  // Measured: with NO retained frame captureVisibleTab fails at once and the
  // debugger's Page.captureScreenshot never returns; with a retained frame
  // captureVisibleTab returns the STALE last frame and the debugger a FRESH one.
  // So one cheap captureVisibleTab probe tells the debugger is worth attaching.
  const hidden = (windowState: string, over: Partial<CaptureEnv> = {}) =>
    makeEnv({
      readVisibility: jest.fn(async () => "hidden"),
      readWindowState: jest.fn(async () => windowState),
      ...over,
    });
  const NO_FRAME = "Failed to capture tab: image readback failed";

  it("tab has a frame: probes once, then uses the debugger for a FRESH image (the probe's is stale)", async () => {
    const { env } = hidden("minimized");
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(env.captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(env.cdpCapture).toHaveBeenCalledWith(7, "jpeg");
    expect(r).toEqual(expect.objectContaining({ mimeType: "image/jpeg", base64: "Q0RQ" }));
  });

  it("says the window is minimized and still contains 'CDP screenshot fallback' (the server keys on it)", async () => {
    const { env } = hidden("minimized");
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(r.warning).toMatch(/minimized/);
    expect(r.warning).toMatch(/CDP screenshot fallback/);
    expect(r.warning).toMatch(/started debugging this browser/);
  });

  it("names the other ways a window gets hidden when it is not minimized", async () => {
    const { env } = hidden("normal");
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(r.warning).toMatch(/hidden/);
    expect(r.warning).toMatch(/Space|desktop/);
    expect(r.warning).toMatch(/CDP screenshot fallback/);
  });

  it("tab has NO frame: fails at once with the cause and never attaches the debugger", async () => {
    const { env } = hidden("minimized", {
      captureVisibleTab: jest.fn(async () => {
        throw new Error(NO_FRAME);
      }),
    });
    const err = await new ViewportCapturer(env).viewport(7, 1, "jpeg").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/minimized/);
    expect(err.message).toMatch(/no frame/);
    expect(err.message).toMatch(/take-snapshot/);
    expect(env.cdpCapture).not.toHaveBeenCalled();
    // One probe only: retrying a hidden window is pure latency.
    expect(env.captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it("tab has a frame but the debugger capture fails: returns the stale frame, clearly labelled", async () => {
    const { env } = hidden("minimized", {
      cdpCapture: jest.fn(async () => {
        throw new Error("CDP Page.captureScreenshot produced no frame within 6s");
      }),
    });
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(r.base64).toBe("QUJD");
    expect(r.warning).toMatch(/out of date|stale/i);
    expect(r.warning).toMatch(/minimized/);
  });

  it("a permission refusal on the probe says nothing about frames, so the debugger is still tried", async () => {
    const { env } = hidden("minimized", {
      captureVisibleTab: jest.fn(async () => {
        throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
      }),
    });
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(env.cdpCapture).toHaveBeenCalled();
    expect(r.base64).toBe("Q0RQ");
  });

  it("does not call a freshly activated tab hidden on the first read: it re-checks", async () => {
    const reads = ["hidden", "visible"];
    const { env } = makeEnv({ readVisibility: jest.fn(async () => reads.shift() ?? "visible") });
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(env.cdpCapture).not.toHaveBeenCalled();
    expect(env.captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(r.warning).toBeUndefined();
  });

  it("only calls it hidden when every re-check says hidden", async () => {
    const reads = ["hidden", "hidden", "visible"];
    const { env } = makeEnv({ readVisibility: jest.fn(async () => reads.shift() ?? "visible") });
    await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(env.cdpCapture).not.toHaveBeenCalled();
  });

  it("treats an unreadable page (restricted URL, no access) as visible, not hidden", async () => {
    const { env } = makeEnv({ readVisibility: jest.fn(async () => null) });
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(env.cdpCapture).not.toHaveBeenCalled();
    expect(r.base64).toBe("QUJD");
  });

  it("keeps the original error and adds the earlier cause when the debugger capture fails on a visible window", async () => {
    const { env } = makeEnv({
      captureVisibleTab: jest.fn(async () => {
        throw new Error("Failed to capture tab: image readback failed");
      }),
      cdpCapture: jest.fn(async () => {
        throw new Error("CDP Page.captureScreenshot returned no data.");
      }),
    });
    await expect(new ViewportCapturer(env).viewport(7, 1, "jpeg")).rejects.toThrow(/no data/);
    await expect(new ViewportCapturer(env).viewport(7, 1, "jpeg")).rejects.toThrow(/readback failed/);
  });

  it("copes with a window-state lookup that returns nothing", async () => {
    const { env } = hidden("normal", { readWindowState: jest.fn(async () => null) });
    const r = await new ViewportCapturer(env).viewport(7, 1, "jpeg");
    expect(r.warning).toMatch(/hidden/);
  });
});

describe("ViewportCapturer.requireVisible (full-page and element captures need a painted window)", () => {
  it("passes on a visible window", async () => {
    const { env } = makeEnv();
    await expect(new ViewportCapturer(env).requireVisible(7, 1, "full-page")).resolves.toBeUndefined();
  });

  it("passes when visibility cannot be read", async () => {
    const { env } = makeEnv({ readVisibility: jest.fn(async () => null) });
    await expect(new ViewportCapturer(env).requireVisible(7, 1, "element")).resolves.toBeUndefined();
  });

  it("throws a named, actionable error on a hidden window instead of a bare readback failure", async () => {
    const { env } = makeEnv({
      readVisibility: jest.fn(async () => "hidden"),
      readWindowState: jest.fn(async () => "minimized"),
    });
    const p = new ViewportCapturer(env).requireVisible(7, 1, "full-page");
    await expect(p).rejects.toThrow(/full-page screenshot/);
    await expect(new ViewportCapturer(env).requireVisible(7, 1, "full-page")).rejects.toThrow(/minimized/);
    await expect(new ViewportCapturer(env).requireVisible(7, 1, "full-page")).rejects.toThrow(
      /take-snapshot/
    );
  });
});
