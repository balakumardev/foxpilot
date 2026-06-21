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
 */

import type { ConsoleEntry } from "@foxpilot/common";
import { isAutomationModeEnabled } from "./extension-config";

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
        clearAllConsoleState();
      }
    }
  );

  void isAutomationModeEnabled().then((enabled) => {
    if (enabled) {
      void registerCaptureScript();
    }
  });
}
