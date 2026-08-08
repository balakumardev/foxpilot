/**
 * Background-side console capture for Chrome MV3.
 *
 * Uses chrome.scripting.registerContentScripts to inject two document_start
 * scripts: a MAIN-world wrapper (console-capture-main.js) that overrides
 * console.* and posts entries to the page via window.postMessage, and an
 * isolated-world bridge (console-capture-bridge.js) that relays those entries to
 * the background via chrome.runtime.sendMessage. The MAIN/bridge split is needed
 * because only a MAIN-world script can see the page's real console, while only an
 * isolated-world script can reach chrome.runtime.
 *
 * Registration is gated on BOTH Automation Mode and the separate console-capture
 * opt-in, and that opt-in defaults to OFF (see shouldCaptureConsole). The gate is
 * two-flag because this registration is the broadest injection the API permits —
 * MAIN world, <all_urls>, allFrames, document_start — and the MAIN-world script
 * replaces console.log/info/warn/error/debug. A page can see that replacement,
 * and bot-detection challenges probe exactly those five methods, so injecting it
 * into every page the user browses breaks those challenges site-wide. Capture is
 * therefore something the user turns on for a debugging session, not a standing
 * consequence of leaving Automation Mode enabled.
 */

import type { ConsoleEntry } from "@foxpilot/common";
import {
  isAutomationModeEnabled,
  isConsoleCaptureEnabled,
  shouldCaptureConsole,
} from "./extension-config";

export type { ConsoleEntry };

export const CONSOLE_BUFFER_CAP = 200;
const MAX_ENTRY_TEXT = 2000;
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

const buffers = new Map<number, ConsoleEntry[]>();

export function addConsoleEntry(tabId: number, entry: ConsoleEntry): void {
  let buf = buffers.get(tabId);
  if (!buf) {
    buf = [];
    buffers.set(tabId, buf);
  }
  buf.push(entry);
  if (buf.length > CONSOLE_BUFFER_CAP) {
    buf.splice(0, buf.length - CONSOLE_BUFFER_CAP);
  }
}

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

export function clearConsoleEntries(tabId: number): void {
  buffers.delete(tabId);
}

export function clearAllConsoleState(): void {
  buffers.clear();
}

let captureId: string | null = null;
let registering = false;
let desiredRegistered = false;

const MAIN_ID = "bcmcp-console-capture-main";
const BRIDGE_ID = "bcmcp-console-capture-bridge";

/**
 * Drop any capture registration currently installed under our IDs, regardless of
 * this service worker's in-memory state.
 *
 * Registrations made without `persistAcrossSessions: false` persist across
 * service-worker restarts, browser restarts, AND extension updates — while the
 * module-level `captureId` resets to null on every SW boot. So the on-disk
 * registration and our idea of it can disagree in both directions, and only a
 * query can settle it. Used for two things: avoiding "Duplicate script ID" on
 * re-registration, and sweeping a registration a previous session left behind.
 * Never throws — `getRegisteredContentScripts` may be unsupported.
 */
async function clearPersistedRegistration(): Promise<void> {
  try {
    const existing = await (
      browser.scripting as any
    ).getRegisteredContentScripts({ ids: [MAIN_ID, BRIDGE_ID] });
    if (existing && existing.length > 0) {
      await browser.scripting.unregisterContentScripts({
        ids: existing.map((s: { id: string }) => s.id),
      });
    }
  } catch (e) {
    /* getRegisteredContentScripts unsupported or failed — fall through */
  }
}

export async function registerCaptureScript(): Promise<void> {
  desiredRegistered = true;
  if (captureId || registering) {
    return;
  }
  registering = true;
  try {
    // Idempotent registration: a prior registration can persist across
    // service-worker restarts, and re-registering the same IDs throws
    // "Duplicate script ID". Clear any stale registration first.
    await clearPersistedRegistration();
    // Capture all frames, including iframes. The per-frame batching (one
    // coalesced message per flush interval) plus the source-side rate limit
    // bound IPC per frame, so all-frames capture no longer floods the IO thread
    // the way the old unbatched per-line IPC did.
    await browser.scripting.registerContentScripts([
      {
        id: MAIN_ID,
        matches: ["<all_urls>"],
        runAt: "document_start",
        js: ["dist/console-capture-main.js"],
        allFrames: true,
        world: "MAIN",
      },
      {
        id: BRIDGE_ID,
        matches: ["<all_urls>"],
        runAt: "document_start",
        js: ["dist/console-capture-bridge.js"],
        allFrames: true,
      },
    ]);
    captureId = MAIN_ID;
    // If automation mode flipped OFF while we were awaiting registration, undo
    // it now so we don't leave the scripts injected (parity with Firefox).
    if (!desiredRegistered) {
      void unregisterCaptureScript();
    }
  } catch (error) {
    console.error("console-capture: failed to register capture script:", error);
  } finally {
    registering = false;
  }
}

export async function unregisterCaptureScript(): Promise<void> {
  desiredRegistered = false;
  const id = captureId;
  captureId = null;
  if (!id) {
    return;
  }
  try {
    await browser.scripting.unregisterContentScripts({
      ids: [MAIN_ID, BRIDGE_ID],
    });
  } catch (error) {
    console.error("console-capture: failed to unregister capture script:", error);
  }
}

export function initConsoleCapture(): void {
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

  browser.tabs.onRemoved.addListener((tabId: number) => {
    clearConsoleEntries(tabId);
  });

  // Re-evaluate the combined gate on every config write, so EITHER flag going
  // false tears the capture scripts down (and drops the buffers, so a later
  // re-enable cannot surface stale prior-session output).
  browser.storage.onChanged.addListener(
    (changes: { [key: string]: { oldValue?: unknown; newValue?: unknown } }, areaName: string) => {
      if (areaName !== "local" || !changes.config) {
        return;
      }
      const newConfig = changes.config.newValue as
        | { automationMode?: boolean; consoleCapture?: boolean }
        | undefined;
      const enabled = shouldCaptureConsole(
        newConfig?.automationMode === true,
        newConfig?.consoleCapture === true
      );
      if (enabled) {
        void registerCaptureScript();
      } else {
        void unregisterCaptureScript();
        clearAllConsoleState();
      }
    }
  );

  // Boot probe: the service worker re-arms registration on every restart, so
  // this must apply the same combined gate — otherwise leaving Automation Mode
  // on would silently re-inject the console patch into every page forever.
  //
  // When the gate is OFF we must actively sweep, not just decline to register.
  // Registrations persist across browser restarts and extension updates, so an
  // install that registered capture under the old Automation-Mode-only gate is
  // still injecting after updating to this build; and unregisterCaptureScript()
  // cannot clear it, because its in-memory handle is null on a fresh SW boot.
  void Promise.all([
    isAutomationModeEnabled(),
    isConsoleCaptureEnabled(),
  ]).then(([automationMode, consoleCapture]) => {
    if (shouldCaptureConsole(automationMode, consoleCapture)) {
      void registerCaptureScript();
    } else {
      void clearPersistedRegistration();
    }
  });
}
