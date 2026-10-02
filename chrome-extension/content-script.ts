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
  evalInIsolatedWorld,
} from "./injected/page-world";
import { performFileUpload } from "./injected/upload-script";
import {
  performPointAction,
  scrollWindowTo,
  scrollElementIntoView,
} from "./injected/point-action-script";
import { selectOption } from "./injected/select-option-script";
import { dismissOverlays } from "./injected/dismiss-overlays-script";
import { extractPageContent } from "./injected/page-content-script";

// Guard against duplicate injection in the same isolated world.
if ((window as any).__bcmcpContentScriptLoaded) {
  console.log("[FoxPilot] Content script already loaded, skipping duplicate");
} else {
  (window as any).__bcmcpContentScriptLoaded = true;

  // Helper to inject a script into the page's MAIN world and poll for a result.
  async function runInPageWorld(
    pageScript: string,
    resultAttr: string,
    timeoutMs: number,
    startedAttr?: string
  ): Promise<{ ok: boolean; value?: any; error?: string; cspBlocked?: boolean }> {
    const script = document.createElement("script");
    script.textContent = pageScript;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();

    // Definitive CSP detection: an ALLOWED inline <script> executes
    // synchronously during appendChild, so its `startedAttr` marker is already
    // present here. If the caller asked for a marker and it is absent, the page
    // CSP blocked the injection — fail instantly instead of waiting out the 10s
    // timeout (which must stay long for legitimately-slow async evals).
    if (startedAttr) {
      if (document.documentElement.getAttribute(startedAttr) === null) {
        return {
          ok: false,
          cspBlocked: true,
          error:
            'CSP blocked the injected script (the page forbids inline script execution). On Chrome/Edge retry with engine:"cdp" (runs via the debugger, bypasses page CSP), or read state with the CSP-immune take-snapshot / take-screenshot / coordinate tools / get-cookies.',
        };
      }
      document.documentElement.removeAttribute(startedAttr);
    }

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
          resolve({ ok: false, error: "Timed out waiting for the script result (the function may be hanging or awaiting a promise that never resolves)." });
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  // Read element rect for screenshot cropping; also the humanized cursor path's
  // target and the CDP engine's resolveUidCenter. The uid may be stamped inside
  // a shadow root (open, or closed via chrome.dom) — the same deep lookup the
  // injected actions use, and the same body as firefox-extension's
  // (stringified) readElementRect.
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
    // Elements allowed to host a shadow root (attachShadow's list) plus autonomous custom elements —
    // the closed-root APIs are only worth calling for these.
    const SHADOW_HOST_TAGS: Record<string, true> = { article: true, aside: true, blockquote: true, body: true,
      div: true, footer: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, header: true,
      main: true, nav: true, p: true, section: true, span: true };

    // Open root, else a closed root via the extension-only APIs (content-script world only):
    // Firefox exposes a read-only `openOrClosedShadowRoot` PROPERTY (Fx 63+); Chrome exposes
    // `chrome.dom.openOrClosedShadowRoot(el)` (Chrome 88+, no permission). Neither exists in the page world.
    // PERF (measured): chrome.dom.openOrClosedShadowRoot costs 2.5-8.6 µs per call and div/span are host
    // candidates, so walks memoize the closed-root probe PER INJECTED-FUNCTION CALL. The cache is declared
    // inside the exported function (never module scope). Async selectOption must not reuse it across awaits.
    const closedRootCache = new Map<Element, ShadowRoot | null>();
    function shadowRootOf(el: Element): ShadowRoot | null {
      const open = (el as any).shadowRoot as ShadowRoot | null | undefined;
      if (open) return open;
      const tag = el.localName;
      if (tag.indexOf("-") < 0 && !SHADOW_HOST_TAGS[tag]) return null;
      if (closedRootCache.has(el)) return closedRootCache.get(el) as ShadowRoot | null;
      let found: ShadowRoot | null = null;
      try { const ff = (el as any).openOrClosedShadowRoot; if (ff) found = ff as ShadowRoot; } catch (_) {}
      if (!found) {
        try {
          const dom = (globalThis as any).chrome && (globalThis as any).chrome.dom;
          if (dom && typeof dom.openOrClosedShadowRoot === "function") found = (dom.openOrClosedShadowRoot(el) as ShadowRoot) || null;
        } catch (_) {}
      }
      closedRootCache.set(el, found);
      return found;
    }
    // Tree-of-trees search (document tree + every reachable shadow tree, incl. unassigned light nodes'
    // roots). Use for uid resolution and for clearing stale uids — NOT for listing (listing is flat-tree).
    // Two passes: OPEN roots first (a plain .shadowRoot read, no extension call), then — only on a miss —
    // closed roots too, so a light-DOM or open-root match never pays for the closed-root probe.
    function deepQuery(root: Document | ShadowRoot, sel: string): Element | null {
      function walk(r: Document | ShadowRoot, closed: boolean): Element | null {
        const hit = r.querySelector(sel);
        if (hit) return hit;
        const all = r.querySelectorAll("*");
        for (let i = 0; i < all.length; i++) {
          const sr = closed ? shadowRootOf(all[i]) : ((all[i] as any).shadowRoot as ShadowRoot | null);
          if (sr) { const h = walk(sr, closed); if (h) return h; }
        }
        return null;
      }
      return walk(root, false) || walk(root, true);
    }

    const el = deepQuery(doc, '[data-bcmcp-uid="' + uid + '"]');
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

  // Wait for any of the given needles to appear on the page. Returns which one
  // matched. Runs in the ISOLATED content-script world (CSP-immune).
  async function waitForText(
    text: string | string[],
    timeoutMs: number
  ): Promise<{ found: boolean; matched?: string }> {
    const needles = Array.isArray(text) ? text : [text];
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const body = document.body && document.body.innerText;
      if (body) {
        for (const n of needles) {
          if (body.includes(n)) {
            return { found: true, matched: n };
          }
        }
      }
      if (Date.now() >= deadline) {
        return { found: false };
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
      // Typing into a contenteditable resolves later (the editor is checked
      // for the text), so both of these can hand back a Promise.
      typeChar: async (ch) => {
        return await typeCharStep(document, ch);
      },
      instant: async (a) => {
        return await performInputAction(document, a);
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
            const o = message.options || {};
            const { tree, isTruncated, total, hasMore, error, docState } =
              buildSnapshot(document, {
                verbose: !!o.verbose,
                maxLength: 25000,
                includePointer: o.includePointer,
                maxInteractive: o.maxInteractive,
                selector: o.selector,
                textContains: o.textContains,
                rootSelector: o.rootSelector,
                offset: o.offset,
                limit: o.limit,
              });
            sendResponse({ tree, isTruncated, total, hasMore, error, docState });
            break;
          }

          // type / type-at into a contenteditable resolve asynchronously;
          // sendResponse(promise) would reach the background as {}.
          case "performInputAction": {
            const result = await performInputAction(document, message.args);
            sendResponse(result);
            break;
          }

          case "performPointAction": {
            const result = await performPointAction(document, message.args);
            sendResponse(result);
            break;
          }

          case "selectOption": {
            const result = await selectOption(document, message.args);
            sendResponse(result);
            break;
          }

          case "dismissOverlays": {
            const result = dismissOverlays(document);
            sendResponse(result);
            break;
          }

          case "getTabContent": {
            sendResponse(extractPageContent(document, { offset: message.offset }));
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
            const result = await typeCharStep(document, message.char);
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

          case "scrollWindowTo": {
            const result = scrollWindowTo(document, message.x, message.y);
            sendResponse(result);
            break;
          }

          case "scrollElementIntoView": {
            const result = scrollElementIntoView(document, message.uid);
            sendResponse(result);
            break;
          }

          case "evaluateScript": {
            const startedAttr = message.resultAttr + "-started";
            const result = await runInPageWorld(
              buildEvalPageScript(message.functionSource, message.args, message.resultAttr, startedAttr),
              message.resultAttr,
              message.timeoutMs,
              startedAttr
            );
            sendResponse(result);
            break;
          }

          case "evaluateScriptIsolated": {
            const result = evalInIsolatedWorld(message.functionSource, message.args);
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
            const result = await waitForText(message.text, message.timeoutMs);
            sendResponse(result);
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
