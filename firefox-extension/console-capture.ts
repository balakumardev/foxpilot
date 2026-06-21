/**
 * Background-side console capture.
 *
 * A page's `console.*` output and uncaught errors are NOT visible to a
 * WebExtension. To make them available to the `get-console-messages` tool we,
 * while Automation Mode is ON, register a `document_start` content script that
 * injects a PAGE-WORLD wrapper over `console.*` and `window.onerror` /
 * `unhandledrejection`. Captured entries are posted (via `window.postMessage`)
 * to the isolated content-script world, which forwards them to this background
 * script with `runtime.sendMessage`. Here we keep a bounded per-tab ring buffer
 * that the tool reads.
 *
 * Known caveats (documented for callers):
 *   - Only pages that load AFTER the capture script is registered are captured
 *     (registration happens when Automation Mode turns on). A page already open
 *     must be reloaded to start capturing.
 *   - Only app-level console output is captured — output the browser itself
 *     emits (CSP violations, network errors logged by the engine, messages from
 *     other extensions) does not flow through the page's `console` object and is
 *     not seen here.
 *   - The page-world wrapper is best-effort: a page can overwrite `console`
 *     again after us, and CSP `script-src` without our injected inline script's
 *     nonce could block injection (we log and ignore such failures).
 */

import type { ConsoleEntry } from "@foxpilot/common";
import { isAutomationModeEnabled } from "./extension-config";

export type { ConsoleEntry };

// Max entries retained per tab. Oldest are dropped once exceeded so a chatty
// page cannot grow the buffer without bound.
export const CONSOLE_BUFFER_CAP = 200;

// Maximum length of a single captured entry's text (also enforced page-side, but
// re-clamped here as defense in depth against a forged content-script message).
const MAX_ENTRY_TEXT = 2000;

// The runtime message types used by the content-script bridge.
const CONSOLE_MESSAGE_TYPE = "bcmcp-console-entry";
const CONSOLE_BATCH_TYPE = "bcmcp-console-batch";

function normalizeEntry(raw: Partial<ConsoleEntry> | undefined): ConsoleEntry {
  return {
    level: raw && typeof raw.level === "string" ? raw.level : "log",
    text:
      raw && typeof raw.text === "string"
        ? raw.text.slice(0, MAX_ENTRY_TEXT)
        : String(raw?.text ?? ""),
    timestamp:
      raw && typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
  };
}

// Per-tab ring buffer. Keyed by tabId.
const buffers = new Map<number, ConsoleEntry[]>();

/**
 * Append a console entry to a tab's ring buffer, dropping the oldest entry once
 * the per-tab cap is exceeded.
 */
export function addConsoleEntry(tabId: number, entry: ConsoleEntry): void {
  let buf = buffers.get(tabId);
  if (!buf) {
    buf = [];
    buffers.set(tabId, buf);
  }
  buf.push(entry);
  if (buf.length > CONSOLE_BUFFER_CAP) {
    // Drop the oldest overflow entries (usually exactly one).
    buf.splice(0, buf.length - CONSOLE_BUFFER_CAP);
  }
}

/**
 * Return a tab's buffered console entries. With `limit`, returns the most-recent
 * `limit` entries (oldest-to-newest order preserved); without it, returns all
 * buffered entries (up to the cap). Always returns a fresh array.
 */
export function getConsoleEntries(
  tabId: number,
  limit?: number
): ConsoleEntry[] {
  const buf = buffers.get(tabId);
  if (!buf || buf.length === 0) {
    return [];
  }
  if (limit !== undefined && limit >= 0 && limit < buf.length) {
    return buf.slice(buf.length - limit);
  }
  return buf.slice();
}

/**
 * Clear a tab's buffer (called on tab removal).
 */
export function clearConsoleEntries(tabId: number): void {
  buffers.delete(tabId);
}

/**
 * Drop ALL accumulated console buffers across every tab. Called when Automation
 * Mode turns off: once we stop capturing, retained entries are a stale
 * prior-session snapshot and must not resurface if Automation Mode is later
 * turned back on. Clearing here prevents a re-enable from leaking old output.
 */
export function clearAllConsoleState(): void {
  buffers.clear();
}

// ---- capture-script registration ----

// The handle returned by `contentScripts.register`, kept so we can unregister.
// `null` means not currently registered. Registration is idempotent.
let captureHandle: { unregister: () => void } | null = null;
// Guards against overlapping async registrations producing two handles.
let registering = false;
// The state we WANT (set synchronously by register/unregister callers). Used to
// resolve the flip-while-awaiting race: if automation mode is turned back off
// while a register() is mid-await, we drop the handle as soon as it resolves.
let desiredRegistered = false;

/**
 * Register the page-world capture content script for all URLs at
 * document_start. Idempotent: a no-op if already registered. Wrapped in
 * try/catch because it needs the all-URLs host permission (the optional
 * all-origins permission, granted by enabling Automation Mode); on failure we
 * log and ignore so the rest of the extension keeps working.
 */
export async function registerCaptureScript(): Promise<void> {
  desiredRegistered = true;
  if (captureHandle || registering) {
    return;
  }
  registering = true;
  try {
    const handle = (await browser.contentScripts.register({
      matches: ["<all_urls>"],
      runAt: "document_start",
      js: [{ code: CAPTURE_CONTENT_SCRIPT }],
      // Capture all frames, including iframes. Per-frame batching + the
      // source-side rate limit bound IPC per frame, so iframe-heavy pages no
      // longer flood the messaging channel.
      allFrames: true,
    })) as unknown as { unregister: () => void };
    if (!desiredRegistered) {
      // Automation mode was turned back off while we awaited — drop it again.
      try {
        handle.unregister();
      } catch {
        /* ignore */
      }
    } else {
      captureHandle = handle;
    }
  } catch (error) {
    console.error("console-capture: failed to register capture script:", error);
  } finally {
    registering = false;
  }
}

/**
 * Unregister the capture content script if registered. Idempotent.
 */
export async function unregisterCaptureScript(): Promise<void> {
  desiredRegistered = false;
  const handle = captureHandle;
  captureHandle = null;
  if (handle) {
    try {
      handle.unregister();
    } catch (error) {
      console.error(
        "console-capture: failed to unregister capture script:",
        error
      );
    }
  }
}

/**
 * Initialize background console capture. Call ONCE from background.ts after the
 * config is loaded. Importing this module must NOT trigger any browser API call
 * (so tests can import the buffer helpers freely) — all listener registration
 * happens here.
 */
export function initConsoleCapture(): void {
  // 1) Receive entries forwarded by the content-script bridge.
  browser.runtime.onMessage.addListener((message: unknown, sender: unknown) => {
    const msg = message as
      | {
          type?: string;
          entry?: Partial<ConsoleEntry>;
          entries?: Array<Partial<ConsoleEntry>>;
        }
      | null;
    if (!msg) {
      return;
    }
    const tabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id;
    if (typeof tabId !== "number") {
      return;
    }
    if (msg.type === CONSOLE_BATCH_TYPE && Array.isArray(msg.entries)) {
      for (const raw of msg.entries) {
        addConsoleEntry(tabId, normalizeEntry(raw));
      }
      return;
    }
    if (msg.type === CONSOLE_MESSAGE_TYPE && msg.entry) {
      addConsoleEntry(tabId, normalizeEntry(msg.entry));
    }
  });

  // 2) Drop a tab's buffer when the tab goes away.
  browser.tabs.onRemoved.addListener((tabId: number) => {
    clearConsoleEntries(tabId);
  });

  // 3) Register/unregister the capture script as Automation Mode flips.
  browser.storage.onChanged.addListener(
    (changes: { [key: string]: { oldValue?: unknown; newValue?: unknown } }, areaName: string) => {
      if (areaName !== "local" || !changes.config) {
        return;
      }
      const newConfig = changes.config.newValue as
        | { automationMode?: boolean }
        | undefined;
      const enabled = newConfig?.automationMode === true;
      if (enabled) {
        void registerCaptureScript();
      } else {
        void unregisterCaptureScript();
        // Stop capturing AND drop every buffered entry, so a later re-enable
        // starts clean instead of surfacing stale prior-session output.
        clearAllConsoleState();
      }
    }
  );

  // 4) If Automation Mode is already on at startup, register immediately.
  void isAutomationModeEnabled().then((enabled) => {
    if (enabled) {
      void registerCaptureScript();
    }
  });
}

/**
 * The capture content script (isolated world), as a string injected via
 * `contentScripts.register`. It:
 *   (a) injects a self-contained page-world <script> that wraps console.* and
 *       installs error/unhandledrejection handlers; each captured event is
 *       relayed via window.postMessage({ __bcmcp_console: { level, text } });
 *   (b) listens for those page-world messages and forwards them to the
 *       background with runtime.sendMessage as { type, entry } envelopes.
 *
 * The page-world wrapper is kept self-contained (it has no access to this
 * module) and call-through (originals are invoked first so the page's own
 * logging/devtools are unaffected).
 */
export const CAPTURE_CONTENT_SCRIPT = String.raw`
(function () {
  try {
    // (a) Inject the page-world console/error wrapper.
    var pageWorld = function () {
      if (window.__bcmcpConsoleHooked) { return; }
      window.__bcmcpConsoleHooked = true;

      var MAX = 2000;
      var RATE_MAX_PER_SEC = 300;
      var RATE_WINDOW_MS = 1000;
      var winStart = Date.now();
      var winCount = 0;
      var winDropped = 0;
      function rawPost(level, text) {
        try {
          window.postMessage({ __bcmcp_console: { level: level, text: text } }, "*");
        } catch (e) { /* ignore */ }
      }
      function stringifyArg(a) {
        try {
          if (typeof a === "string") { return a; }
          if (a instanceof Error) { return (a.stack || (a.name + ": " + a.message)); }
          if (a === undefined) { return "undefined"; }
          return JSON.stringify(a);
        } catch (e) {
          try { return String(a); } catch (e2) { return "[unserializable]"; }
        }
      }
      function post(level, args) {
        var now = Date.now();
        if (now - winStart >= RATE_WINDOW_MS) {
          if (winDropped > 0) {
            rawPost("warn", "[FoxPilot] dropped " + winDropped + " console entries (rate limit)");
            winDropped = 0;
          }
          winStart = now;
          winCount = 0;
        }
        if (winCount >= RATE_MAX_PER_SEC) { winDropped++; return; }
        winCount++;
        var parts = [];
        for (var i = 0; i < args.length; i++) { parts.push(stringifyArg(args[i])); }
        var text = parts.join(" ");
        if (text.length > MAX) { text = text.slice(0, MAX); }
        rawPost(level, text);
      }

      var levels = ["log", "info", "warn", "error", "debug"];
      for (var j = 0; j < levels.length; j++) {
        (function (level) {
          var original = console[level];
          console[level] = function () {
            try { post(level, arguments); } catch (e) { /* ignore */ }
            if (typeof original === "function") {
              return original.apply(console, arguments);
            }
          };
        })(levels[j]);
      }

      window.addEventListener("error", function (event) {
        var msg = event && event.message ? event.message : "Uncaught error";
        if (event && event.filename) {
          msg += " (" + event.filename + ":" + event.lineno + ":" + event.colno + ")";
        }
        post("error", [msg]);
      });

      window.addEventListener("unhandledrejection", function (event) {
        var reason = event ? event.reason : undefined;
        var text;
        try {
          text = reason instanceof Error
            ? (reason.stack || (reason.name + ": " + reason.message))
            : "Unhandled promise rejection: " + (typeof reason === "string" ? reason : JSON.stringify(reason));
        } catch (e) { text = "Unhandled promise rejection"; }
        post("error", [text]);
      });
    };

    var s = document.createElement("script");
    s.textContent = "(" + pageWorld.toString() + ")();";
    (document.documentElement || document.head || document.body).appendChild(s);
    s.remove();

    // (b) Bridge page-world messages to the background, COALESCED into batches
    //     on a short timer. One runtime.sendMessage per console line across
    //     <all_urls> floods the IO thread on chatty pages (and can crash the
    //     browser); batching caps outgoing IPC at ~one message per
    //     FLUSH_INTERVAL_MS for this frame, however much the page logs.
    var FLUSH_INTERVAL_MS = 250;
    var BUFFER_CAP = 500;
    var pending = [];
    var droppedSinceFlush = 0;
    var flushTimer = null;
    function flushBatch() {
      flushTimer = null;
      if (pending.length === 0 && droppedSinceFlush === 0) { return; }
      var entries = pending;
      pending = [];
      if (droppedSinceFlush > 0) {
        entries.push({ level: "warn", text: "[FoxPilot] dropped " + droppedSinceFlush + " console entries (buffer cap)", timestamp: Date.now() });
        droppedSinceFlush = 0;
      }
      try {
        browser.runtime.sendMessage({ type: "bcmcp-console-batch", entries: entries });
      } catch (err) { /* ignore */ }
    }
    function scheduleFlush() {
      if (flushTimer === null) { flushTimer = setTimeout(flushBatch, FLUSH_INTERVAL_MS); }
    }
    window.addEventListener("message", function (e) {
      if (e.source === window && e.data && e.data.__bcmcp_console) {
        if (pending.length >= BUFFER_CAP) { pending.shift(); droppedSinceFlush++; }
        pending.push({
          level: e.data.__bcmcp_console.level,
          text: e.data.__bcmcp_console.text,
          timestamp: Date.now()
        });
        scheduleFlush();
      }
    });
    window.addEventListener("pagehide", flushBatch);
  } catch (err) {
    // Never throw out of an injected content script.
  }
})();
`;
