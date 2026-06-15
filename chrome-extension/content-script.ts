/**
 * Content script that handles all page interaction for the Chrome extension.
 * Registered for all URLs via chrome.scripting.registerContentScripts.
 * The service worker sends messages to this script to execute page actions.
 */

import { buildSnapshot } from "./injected/snapshot-script";
import { performInputAction } from "./injected/action-script";
import { StepResult } from "./humanize/run-human-input";
import { dispatchMouseMoveStep, typeCharStep, readElementScreenRect } from "./injected/humanize-steps";
import { runHumanInput, HumanInputDeps } from "./humanize/run-human-input";
import { mousePath, typingPlan, Point } from "./humanize/motion-model";
import {
  buildEvalPageScript,
  buildDialogPageScript,
  buildEmulatePageScript,
} from "./injected/page-world";
import { performFileUpload } from "./injected/upload-script";

// Guard against duplicate injection in the same isolated world.
if ((window as any).__bcmcpContentScriptLoaded) {
  console.log("[FoxPilot] Content script already loaded, skipping duplicate");
} else {
  (window as any).__bcmcpContentScriptLoaded = true;

  // Helper to inject a script into the page's MAIN world and poll for a result.
  async function runInPageWorld(
    pageScript: string,
    resultAttr: string,
    timeoutMs: number
  ): Promise<{ ok: boolean; value?: any; error?: string }> {
    const script = document.createElement("script");
    script.textContent = pageScript;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();

    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const el = document.documentElement;
        const result = el.getAttribute(resultAttr);
        if (result) {
          el.removeAttribute(resultAttr);
          try {
            resolve(JSON.parse(result));
          } catch {
            resolve({ ok: false, error: "Failed to parse result" });
          }
          return;
        }
        if (Date.now() - start > timeoutMs) {
          resolve({ ok: false, error: "CSP hint: page may have blocked inline script injection" });
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  // Read element rect for screenshot cropping.
  function readElementRect(
    doc: Document,
    uid: string
  ): {
    x: number;
    y: number;
    width: number;
    height: number;
    dpr: number;
  } | null {
    const el = doc.querySelector('[data-bcmcp-uid="' + uid + '"]');
    if (!el) {
      return null;
    }
    try {
      (el as { scrollIntoView?: (opts?: unknown) => void }).scrollIntoView?.({
        block: "center",
        inline: "center",
      });
    } catch (e) {
      /* ignore */
    }
    const rect = (el as Element).getBoundingClientRect();
    const win = doc.defaultView as (Window & typeof globalThis) | null;
    const dpr = win && win.devicePixelRatio ? win.devicePixelRatio : 1;
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      dpr,
    };
  }

  // Read page dimensions for full-page screenshot.
  function readPageDimensions(doc: Document): {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
    dpr: number;
    originalScrollY: number;
  } {
    const win = doc.defaultView as (Window & typeof globalThis) | null;
    const body = doc.body;
    const docEl = doc.documentElement;
    const scrollWidth = Math.max(
      body ? body.scrollWidth : 0,
      docEl ? docEl.scrollWidth : 0
    );
    const scrollHeight = Math.max(
      body ? body.scrollHeight : 0,
      docEl ? docEl.scrollHeight : 0
    );
    const clientWidth = docEl ? docEl.clientWidth : win ? win.innerWidth : 0;
    const clientHeight = docEl ? docEl.clientHeight : win ? win.innerHeight : 0;
    const dpr = win && win.devicePixelRatio ? win.devicePixelRatio : 1;
    const originalScrollY = win ? win.scrollY : 0;
    return {
      scrollWidth,
      scrollHeight,
      clientWidth,
      clientHeight,
      dpr,
      originalScrollY,
    };
  }

  // Get tab content (links and text).
  function getTabContent(offset: number = 0): {
    links: { url: string; text: string }[];
    fullText: string;
    isTruncated: boolean;
    totalLength: number;
  } {
    const MAX_CONTENT_LENGTH = 50_000;
    const linkElements = document.querySelectorAll("a[href]");
    const links = Array.from(linkElements)
      .map((el) => ({
        url: (el as HTMLAnchorElement).href,
        text:
          (el as HTMLElement).innerText.trim() ||
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          "",
      }))
      .filter(
        (link) =>
          link.text !== "" &&
          link.url.startsWith("https://") &&
          !link.url.includes("#")
      );

    let isTruncated = false;
    let text = document.body.innerText.substring(offset);
    if (text.length > MAX_CONTENT_LENGTH) {
      text = text.substring(0, MAX_CONTENT_LENGTH);
      isTruncated = true;
    }

    return {
      links,
      fullText: text,
      isTruncated,
      totalLength: document.body.innerText.length,
    };
  }

  // Wait for text to appear on the page.
  async function waitForText(text: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (document.body && document.body.innerText && document.body.innerText.includes(text)) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Find and highlight text using window.find.
  function findAndHighlightText(queryPhrase: string): { count: number } {
    let count = 0;
    // window.find is non-standard but available in Chrome.
    // Keep searching until no more matches.
    while ((window as any).find(queryPhrase, false, false, true)) {
      count++;
    }
    // LIMITATION: window.find leaves only the LAST match selected/highlighted —
    // Chrome has no equivalent of Firefox's browser.find.highlightResults that
    // highlights every match. `count` is accurate (we iterate every match), but
    // visually only the final occurrence is highlighted. Approximating
    // "highlight all" would require wrapping matches in <mark> spans and
    // restoring the DOM afterward; deferred as low priority.
    return { count };
  }

  // Run humanized input action.
  async function runHumanInputAction(
    args: Parameters<typeof performInputAction>[1],
    startCursor: Point
  ): Promise<StepResult> {
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));
    let cursor = startCursor;

    const deps: HumanInputDeps = {
      rng: Math.random,
      sleep,
      getCursor: () => cursor,
      setCursor: (p) => {
        cursor = p;
      },
      readTargetInfo: async (uid) => {
        const info = readElementRect(document, uid);
        return info || null;
      },
      mouseMove: async (x, y) => {
        dispatchMouseMoveStep(document, x, y);
      },
      typeChar: async (ch) => {
        return typeCharStep(document, ch);
      },
      instant: async (a) => {
        return performInputAction(document, a);
      },
    };

    return runHumanInput(args, deps);
  }

  // Message listener
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message.type) {
          case "ping":
            sendResponse({ ok: true });
            break;

          case "buildSnapshot": {
            const { tree, isTruncated } = buildSnapshot(document, {
              verbose: !!message.options?.verbose,
              maxLength: 25000,
            });
            sendResponse({ tree, isTruncated });
            break;
          }

          case "performInputAction": {
            const result = performInputAction(document, message.args);
            sendResponse(result);
            break;
          }

          case "getTabContent": {
            sendResponse(getTabContent(message.offset));
            break;
          }

          case "readElementRect": {
            sendResponse(readElementRect(document, message.uid));
            break;
          }

          case "readPageDimensions": {
            sendResponse(readPageDimensions(document));
            break;
          }

          case "dispatchMouseMoveStep": {
            dispatchMouseMoveStep(document, message.x, message.y);
            sendResponse({ ok: true });
            break;
          }

          case "typeCharStep": {
            const result = typeCharStep(document, message.char);
            sendResponse(result);
            break;
          }

          case "readElementScreenRect": {
            sendResponse(readElementScreenRect(document, message.uid));
            break;
          }

          case "runHumanInput": {
            const result = await runHumanInputAction(message.args, message.cursor);
            sendResponse(result);
            break;
          }

          case "scrollTo": {
            window.scrollTo(0, message.y);
            sendResponse({ ok: true });
            break;
          }

          case "evaluateScript": {
            const result = await runInPageWorld(
              buildEvalPageScript(message.functionSource, message.args, message.resultAttr),
              message.resultAttr,
              message.timeoutMs
            );
            sendResponse(result);
            break;
          }

          case "uploadFile": {
            // Run the upload in THIS isolated content-script world — no page-world
            // <script> injection — so a strict page CSP can't block it. Resolves
            // the file input from the uid (input or its drop zone) and assigns it
            // via DataTransfer; events on the shared DOM node reach page listeners.
            const result = performFileUpload(document, {
              uid: message.uid,
              filename: message.filename,
              mimeType: message.mimeType,
              base64: message.base64,
            });
            sendResponse(result);
            break;
          }

          case "handleDialog": {
            const result = await runInPageWorld(
              buildDialogPageScript(message.action, message.promptText, message.resultAttr),
              message.resultAttr,
              message.timeoutMs
            );
            sendResponse(result);
            break;
          }

          case "emulate": {
            const result = await runInPageWorld(
              buildEmulatePageScript(
                message.geolocation,
                message.userAgent,
                message.resultAttr
              ),
              message.resultAttr,
              message.timeoutMs
            );
            sendResponse(result);
            break;
          }

          case "waitForText": {
            const found = await waitForText(message.text, message.timeoutMs);
            sendResponse({ found });
            break;
          }

          case "findHighlight": {
            const result = findAndHighlightText(message.queryPhrase);
            sendResponse(result);
            break;
          }

          default:
            sendResponse({ ok: false, error: "Unknown message type: " + message.type });
        }
      } catch (error) {
        console.error("[FoxPilot] Content script error:", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return true; // Keep channel open for async
  });

  console.log("[FoxPilot] Content script loaded");
}
