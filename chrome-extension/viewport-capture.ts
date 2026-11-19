/**
 * Viewport screenshots for the Chrome extension: pacing, hidden-window
 * detection and honest failure reporting around `chrome.tabs.captureVisibleTab`.
 *
 * Measured 2026-11-15 in a throwaway Chromium with the real API:
 *
 *  - A MINIMIZED window (or a hidden browser app, another Space, a sleeping
 *    display) makes the page `document.visibilityState === "hidden"`. Chrome paints
 *    no frames for it. If the tab has no retained frame (it navigated, or sat hidden
 *    a long time), every captureVisibleTab fails with "Failed to capture tab: image
 *    readback failed" for as long as the window stays hidden, so retrying only adds
 *    latency. If it does have a retained frame, the call "succeeds" with the last
 *    frame painted before the window was hidden: a stale picture that looks right.
 *    Restoring the window fixed it at once. A window that is merely covered by
 *    another window stays "visible" and captures fine.
 *  - A hidden window also defeats the debugger when the tab has no frame:
 *    Page.captureScreenshot never returns, so it needs its own timeout. With a
 *    retained frame it returns a FRESH render (checked against a live clock on the
 *    page), whereas captureVisibleTab returns the stale one. The two agree on
 *    "has a frame": captureVisibleTab fails at once exactly when the debugger would
 *    hang, so one captureVisibleTab call is a free probe for whether attaching the
 *    debugger can work at all.
 *  - captureVisibleTab needs "all sites" (`<all_urls>`) or activeTab. A grant for
 *    the page's own origin is NOT enough: it fails with "Either the '<all_urls>' or
 *    'activeTab' permission is required." on a visible, healthy window, every time,
 *    while snapshots and clicks keep working (they only need the origin). The
 *    debugger needs no host grant, so the old fallback "worked" and hid the cause.
 *  - Chrome allows only 2 captureVisibleTab calls per second
 *    (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). The old retries at ~100/300 ms
 *    intervals hit that quota error instead of retrying anything, and a full-page
 *    capture of 3+ tiles hit it on every run.
 *
 * So: pace every call, check visibility once, and for a hidden window skip
 * captureVisibleTab entirely (the debugger capture is the only way to get fresh
 * pixels). Everything chrome.* is injected so the logic is unit-testable and can
 * run unchanged in a real browser harness.
 */

import { redactAccessMessage } from "@foxpilot/common";
import {
  isValidCapture,
  mimeTypeForFormat,
  stripDataUrlPrefix,
  type ImageFormat,
} from "./injected/screenshot-script";

/** Two calls per second is Chrome's limit; 550 ms keeps any 1 s window at or under 2. */
export const CAPTURE_MIN_GAP_MS = 550;

const CAPTURE_ATTEMPTS = 3;
/** A tab that was activated a moment ago can still report "hidden" for a frame or two. */
const HIDDEN_CONFIRM_READS = 3;
const HIDDEN_CONFIRM_GAP_MS = 120;

export interface CaptureEnv {
  sleep(ms: number): Promise<void>;
  now(): number;
  /** One raw chrome.tabs.captureVisibleTab call (data URL). */
  captureVisibleTab(windowId: number | undefined, format: ImageFormat): Promise<string>;
  /** `document.visibilityState` of the tab's page, or null when it cannot be read. */
  readVisibility(tabId: number): Promise<string | null>;
  /** chrome.windows.get(...).state, or null when it cannot be read. */
  readWindowState(windowId: number | undefined): Promise<string | null>;
  /** Page.captureScreenshot through the debugger; returns bare base64. */
  cdpCapture(tabId: number, format: ImageFormat): Promise<string>;
}

export interface ViewportResult {
  mimeType: string;
  base64: string;
  warning?: string;
}

/** Refusals no retry can fix: the extension lacks the host access captureVisibleTab needs. */
const PERMISSION_ERROR =
  /permission is required|must request permission to access|Cannot access contents of (the page|url)/i;

const isPermissionError = (message: string): boolean => PERMISSION_ERROR.test(message);

/** Marks a failure so callers can tell a permanent refusal from a transient one. */
function failure(message: string, kind: "permission" | "transient", detail?: string): Error {
  return Object.assign(new Error(message), { kind, detail });
}
const failureKind = (e: unknown): string | undefined => (e as { kind?: string })?.kind;
const failureDetail = (e: unknown): string | undefined => (e as { detail?: string })?.detail;

const BANNER_NOTE =
  "(a 'started debugging this browser' banner may have appeared)";

// The browser's refusal text embeds the WHOLE tab URL (query string, fragment),
// and these messages reach the agent as warnings and errors: redact it here.
const errText = (e: unknown): string =>
  redactAccessMessage(String((e as { message?: unknown })?.message ?? e));

/** Why a hidden window cannot be captured, worded for the agent that reads it. */
function describeHidden(windowState: string | null): string {
  return windowState === "minimized"
    ? "The browser window is minimized"
    : "The browser window is hidden (on another desktop or Space, the browser app is hidden, or the display is asleep)";
}

export class ViewportCapturer {
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly env: CaptureEnv,
    private readonly minGapMs: number = CAPTURE_MIN_GAP_MS
  ) {}

  /** One captureVisibleTab call, never closer than the gap to the previous one. */
  captureOnce(windowId: number | undefined, format: ImageFormat): Promise<string> {
    const run = this.queue.then(async () => {
      const wait = this.lastCallAt + this.minGapMs - this.env.now();
      if (wait > 0) await this.env.sleep(wait);
      this.lastCallAt = this.env.now();
      return this.env.captureVisibleTab(windowId, format);
    });
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Up to three paced attempts; a rejection or an empty readback counts as a failure. */
  async captureWithRetry(windowId: number | undefined, format: ImageFormat): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
      try {
        const dataUrl = await this.captureOnce(windowId, format);
        if (isValidCapture(dataUrl)) return dataUrl;
        lastErr = new Error("empty capture readback");
      } catch (e) {
        // A permission refusal is the same on every attempt: do not spend three.
        if (isPermissionError(errText(e))) {
          throw failure(`captureVisibleTab was refused: ${errText(e)}`, "permission", errText(e));
        }
        lastErr = e;
      }
    }
    throw failure(
      `captureVisibleTab failed after ${CAPTURE_ATTEMPTS} attempts: ${errText(lastErr)}`,
      "transient"
    );
  }

  /** True only when every one of several reads says the page is hidden. */
  private async isHidden(tabId: number): Promise<boolean> {
    for (let i = 0; i < HIDDEN_CONFIRM_READS; i++) {
      if ((await this.env.readVisibility(tabId)) !== "hidden") return false;
      if (i < HIDDEN_CONFIRM_READS - 1) await this.env.sleep(HIDDEN_CONFIRM_GAP_MS);
    }
    return true;
  }

  /** Viewport capture: captureVisibleTab when the window paints, the debugger when it cannot. */
  async viewport(
    tabId: number,
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<ViewportResult> {
    if (await this.isHidden(tabId)) {
      return this.hiddenViewport(tabId, windowId, format);
    }

    let cause = "returned no image";
    try {
      const dataUrl = await this.captureWithRetry(windowId, format);
      const { base64 } = stripDataUrlPrefix(dataUrl);
      if (base64) return { mimeType: mimeTypeForFormat(format), base64 };
    } catch (e) {
      cause = errText(e);
      if (failureKind(e) === "permission") {
        return this.viaDebugger(
          tabId,
          format,
          `captureVisibleTab is refused because FoxPilot does not have all-sites access in this browser ` +
            `(a grant for just this site is not enough for screenshots; Chrome said: ${failureDetail(e) ?? cause}); ` +
            `used the CDP screenshot fallback ${BANNER_NOTE}. For normal screenshots without the debugger, ` +
            `the user can turn Automation Mode on in the FoxPilot options and accept the all-sites prompt, ` +
            `or set the extension's Site access to "On all sites" on the browser's extensions page.`,
          cause
        );
      }
    }
    const state = await this.env.readWindowState(windowId);
    return this.viaDebugger(
      tabId,
      format,
      `captureVisibleTab failed on a window the page reports as visible (${cause}; window state: ${state ?? "unknown"}); ` +
        `used the CDP screenshot fallback ${BANNER_NOTE}.`,
      cause
    );
  }

  /**
   * A hidden window paints no frames. captureVisibleTab either fails (the tab has
   * no frame) or returns the last frame painted, which is stale. The debugger
   * renders fresh, but only when a frame exists. So: probe once, then attach the
   * debugger only if it can work, and never wait on one that cannot.
   */
  private async hiddenViewport(
    tabId: number,
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<ViewportResult> {
    const state = await this.env.readWindowState(windowId);
    const why = describeHidden(state);
    let stale: string | null = null;
    try {
      const probe = await this.captureOnce(windowId, format);
      if (!isValidCapture(probe)) throw new Error("empty capture readback");
      stale = stripDataUrlPrefix(probe).base64;
    } catch (e) {
      // A permission refusal says nothing about frames: let the debugger try.
      if (!isPermissionError(errText(e))) {
        throw new Error(
          `${why} and this tab has no frame to capture, so no screenshot is possible until the window is ` +
            `restored (Chrome said: ${errText(e)}). Ask the user to restore the window, or use ` +
            `take-snapshot / get-tab-web-content for the page state.`
        );
      }
    }

    try {
      const base64 = await this.env.cdpCapture(tabId, format);
      return {
        mimeType: mimeTypeForFormat(format),
        base64,
        warning:
          `${why}, so captureVisibleTab cannot capture it; used the CDP screenshot fallback ${BANNER_NOTE}. ` +
          `Restore the window for a normal capture.`,
      };
    } catch (e) {
      if (stale === null) {
        throw new Error(`${errText(e)} (${why}, and no earlier frame exists for this tab)`);
      }
      return {
        mimeType: mimeTypeForFormat(format),
        base64: stale,
        warning:
          `${why}, and the debugger capture failed (${errText(e)}), so this is the last frame painted ` +
          `before the window was hidden and may be out of date. Restore the window for a live capture, ` +
          `or use take-snapshot / get-tab-web-content for the current state.`,
      };
    }
  }

  private async viaDebugger(
    tabId: number,
    format: ImageFormat,
    warning: string,
    why: string
  ): Promise<ViewportResult> {
    let base64: string;
    try {
      base64 = await this.env.cdpCapture(tabId, format);
    } catch (e) {
      throw new Error(`${errText(e)} (the normal capture was not possible: ${why})`);
    }
    return { mimeType: mimeTypeForFormat(format), base64, warning };
  }

  /**
   * Full-page and element captures stitch or crop captureVisibleTab frames, so
   * a hidden window (no frames, or a stale one) cannot work for them. Fail at once
   * with the cause, rather than after retries with a bare "image readback failed".
   */
  async requireVisible(
    tabId: number,
    windowId: number | undefined,
    what: "full-page" | "element"
  ): Promise<void> {
    if (!(await this.isHidden(tabId))) return;
    const state = await this.env.readWindowState(windowId);
    throw new Error(
      `Cannot take a ${what} screenshot: ${describeHidden(state).toLowerCase()}, so Chrome paints no frames. ` +
        `Ask the user to restore the window, use take-snapshot / get-tab-web-content for the page state, ` +
        `or take a plain viewport screenshot (it falls back to the debugger).`
    );
  }
}
