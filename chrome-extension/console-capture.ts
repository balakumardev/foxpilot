/**
 * Background-side console capture for Chrome MV3.
 *
 * Uses chrome.scripting.registerContentScripts to inject a document_start
 * content script that wraps console.* in the page world. The content script
 * sends messages back to the background via chrome.runtime.sendMessage.
 */

import type { ConsoleEntry } from "@foxpilot/common";
import { isAutomationModeEnabled } from "./extension-config";

export type { ConsoleEntry };

// Legacy export for backward compatibility with tests. In Chrome MV3, the
// capture script is a separate file (console-capture-content.ts) registered via
// chrome.scripting.registerContentScripts.
export const CAPTURE_CONTENT_SCRIPT = "";

export const CONSOLE_BUFFER_CAP = 200;
const MAX_ENTRY_TEXT = 2000;
const CONSOLE_MESSAGE_TYPE = "bcmcp-console-entry";

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

export async function registerCaptureScript(): Promise<void> {
  desiredRegistered = true;
  if (captureId || registering) {
    return;
  }
  registering = true;
  try {
    const id = "bcmcp-console-capture";
    await browser.scripting.registerContentScripts([
      {
        id,
        matches: ["<all_urls>"],
        runAt: "document_start",
        js: ["dist/console-capture-content.js"],
        allFrames: true,
      },
    ]);
    captureId = id;
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
    await browser.scripting.unregisterContentScripts({ ids: [id] });
  } catch (error) {
    console.error("console-capture: failed to unregister capture script:", error);
  }
}

export function initConsoleCapture(): void {
  browser.runtime.onMessage.addListener((message: unknown, sender: unknown) => {
    const msg = message as { type?: string; entry?: Partial<ConsoleEntry> } | null;
    if (!msg || msg.type !== CONSOLE_MESSAGE_TYPE || !msg.entry) {
      return;
    }
    const tabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id;
    if (typeof tabId !== "number") {
      return;
    }
    const raw = msg.entry;
    const entry: ConsoleEntry = {
      level: typeof raw.level === "string" ? raw.level : "log",
      text:
        typeof raw.text === "string"
          ? raw.text.slice(0, MAX_ENTRY_TEXT)
          : String(raw.text ?? ""),
      timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
    };
    addConsoleEntry(tabId, entry);
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
