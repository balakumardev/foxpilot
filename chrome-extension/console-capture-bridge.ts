/**
 * Isolated-world bridge for console capture (Chrome MV3).
 *
 * Buffers the entries the MAIN-world wrapper posts and forwards them to the
 * background in COALESCED BATCHES on a short timer, rather than one
 * chrome.runtime.sendMessage per console line. Unbatched per-line IPC across
 * <all_urls> floods the browser-process IO thread on chatty pages (and can
 * crash the browser); batching caps outgoing IPC at ~one message per
 * FLUSH_INTERVAL_MS for this frame, regardless of how much the page logs.
 *
 * The `e.source === window` guard only forwards messages that originated in THIS
 * same window/frame. It does NOT prevent same-page forgery: a page's own script
 * shares this `window`, so it can post a crafted { __bcmcp_console } message we
 * forward. Captured console output is therefore page-influenced data, not a
 * trusted channel — treat it accordingly.
 */

const FLUSH_INTERVAL_MS = 250;
// Safety net only: the MAIN-world wrapper already rate-limits at the source, so
// the buffer should never approach this. If it does (pathological page), drop
// the oldest and report the count.
const BUFFER_CAP = 500;
const BATCH_MESSAGE_TYPE = "bcmcp-console-batch";

interface PendingEntry {
  level: string;
  text: string;
  timestamp: number;
}

let pending: PendingEntry[] = [];
let droppedSinceFlush = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (timer === null) {
    timer = setTimeout(flushConsoleBatch, FLUSH_INTERVAL_MS);
  }
}

/**
 * Coalesce all buffered entries into a single runtime.sendMessage. Exported for
 * tests and called on the flush timer and on pagehide.
 */
export function flushConsoleBatch(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.length === 0 && droppedSinceFlush === 0) {
    return;
  }
  const entries = pending;
  pending = [];
  if (droppedSinceFlush > 0) {
    entries.push({
      level: "warn",
      text:
        "[FoxPilot] dropped " +
        droppedSinceFlush +
        " console entr" +
        (droppedSinceFlush === 1 ? "y" : "ies") +
        " (buffer cap)",
      timestamp: Date.now(),
    });
    droppedSinceFlush = 0;
  }
  try {
    chrome.runtime.sendMessage({ type: BATCH_MESSAGE_TYPE, entries });
  } catch (err) {
    /* service worker may be gone; entries are best-effort */
  }
}

/** Buffer one entry from the MAIN-world wrapper. Exported for tests. */
export function enqueueConsoleEntry(d: {
  level?: unknown;
  text?: unknown;
}): void {
  if (pending.length >= BUFFER_CAP) {
    pending.shift();
    droppedSinceFlush++;
  }
  pending.push({
    level: typeof d.level === "string" ? d.level : "log",
    text:
      typeof d.text === "string"
        ? d.text
        : String(d.text === undefined || d.text === null ? "" : d.text),
    timestamp: Date.now(),
  });
  scheduleFlush();
}

/** Test-only: reset module buffer/timer between cases. */
export function _resetForTest(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  pending = [];
  droppedSinceFlush = 0;
}

window.addEventListener("message", function (e) {
  if (e.source === window && e.data && (e.data as any).__bcmcp_console) {
    enqueueConsoleEntry((e.data as any).__bcmcp_console);
  }
});

// Best-effort flush so the last lines before a navigation aren't lost.
window.addEventListener("pagehide", flushConsoleBatch);
