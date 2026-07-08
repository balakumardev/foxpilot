import type { ServerMessageRequest } from "@foxpilot/common";
import { ExtensionTransport } from "./transport";
import { isCommandAllowed, isDomainInDenyList, COMMAND_TO_TOOL_ID, addAuditLogEntry, requiresAutomationMode, isAutomationModeEnabled, getInputRealismMode, getSidecarPort, getSecret } from "./extension-config";
import { buildSnapshot } from "./injected/snapshot-script";
import { performInputAction } from "./injected/action-script";
import {
  performPointAction,
  scrollWindowTo,
  scrollElementIntoView,
} from "./injected/point-action-script";
import { dispatchMouseMoveStep, typeCharStep, readElementScreenRect } from "./injected/humanize-steps";
import { runHumanInput, HumanInputDeps, StepResult } from "./humanize/run-human-input";
import { mousePath, typingPlan, Point } from "./humanize/motion-model";
import { NativeInputClient } from "./native-input-client";
import { NativeGesture, NativeWaypoint, NativeInputResponse } from "@foxpilot/common";
import {
  buildEvalPageScript,
  buildDialogPageScript,
  buildEmulatePageScript,
  runInPageWorld,
  buildIsolatedEvalCode,
} from "./injected/page-world";
import { raceInputAgainstNavigation } from "./nav-race";
import { waitForTabReady, execWithReadyRetry } from "./nav-ready";
import { performFileUpload, FileUploadResult } from "./injected/upload-script";
import { setTabUserAgent } from "./emulate";
import {
  cropElementFromCapture,
  isValidCapture,
  mimeTypeForFormat,
  planFullPageSteps,
  stitchFullPage,
  stripDataUrlPrefix,
  type ImageFormat,
} from "./injected/screenshot-script";
import { getConsoleEntries } from "./console-capture";
import {
  getNetworkRequests,
  setBodyCaptureEnabled,
} from "./network-capture";
import {
  getCookies,
  browserFetch,
  startStream,
  pollStream,
  closeStream,
} from "./browser-http";
import type {
  GetCookiesServerMessage,
  BrowserFetchServerMessage,
  StreamStartServerMessage,
  StreamPollServerMessage,
  StreamCloseServerMessage,
} from "@foxpilot/common";

// The argument shape accepted by the injected `performInputAction` function.
type InputActionArgs = Parameters<typeof performInputAction>[1];

// The argument shape accepted by the injected `performPointAction` function.
type PointActionArgs = Parameters<typeof performPointAction>[1];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Monotonic counter combined with Date.now() to build a unique per-call result
// attribute key (data-bcmcp-result-<key>), so concurrent evaluate-script calls
// against the same tab never read each other's results.
let evalKeyCounter = 0;

// How long to wait for the in-page result attribute to appear before giving up
// (and reporting a likely-CSP timeout). The broker's evaluate-script response
// timeout (30s) is comfortably larger than this.
const EVAL_TIMEOUT_MS = 10000;

// handle-dialog and emulate inject a SYNCHRONOUS page-world script (it just
// installs overrides/shims and writes the result attribute), so the result
// appears on the first poll. A short ceiling is plenty; a CSP-blocked page times
// out with a CSP hint (surfaced as ok:false) rather than throwing.
const PAGE_SETUP_TIMEOUT_MS = 5000;

/**
 * Returns whether a URL is allowed for in-tab navigation: https:// always, and
 * http:// only for loopback hosts — localhost, 127.0.0.1, and the IPv6
 * loopback [::1] (convenient for local dev). The WHATWG URL parser reports the
 * IPv6 loopback host as the bracketed literal "[::1]".
 */
function isNavigableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  if (parsed.protocol === "http:") {
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]"
    );
  }
  return false;
}

/**
 * Injected (via executeScript) to measure an element identified by a snapshot
 * uid for the element-crop screenshot mode. Scrolls the element into view, then
 * returns its viewport-relative bounding rect plus the device pixel ratio (so
 * the compositor can convert CSS px to the device px of the captured bitmap).
 * Returns null if the uid no longer resolves.
 *
 * MUST be self-contained: it is stringified and runs in the page's JS world with
 * no access to this module.
 */
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
    /* ignore — capture whatever is visible */
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

/**
 * Injected (via executeScript) to read the full document dimensions, current
 * viewport size, device pixel ratio, and current scroll position for the
 * full-page stitch mode.
 *
 * MUST be self-contained: it is stringified and runs in the page's JS world.
 */
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

export class MessageHandler {
  private client: ExtensionTransport;

  // Per-tab virtual cursor position for continuous human-like mouse paths.
  private cursorByTab: Map<number, Point> = new Map();

  // Per-tab REAL (screen-coordinate) cursor position for the native executor, so
  // successive native gestures start from where the OS cursor last landed.
  private nativeCursorByTab: Map<number, Point> = new Map();

  // Lazily-built native-input sidecar client (built on first native use).
  private nativeClient: NativeInputClient | null = null;

  constructor(client: ExtensionTransport) {
    this.client = client;
  }

  public async handleDecodedMessage(req: ServerMessageRequest): Promise<void> {
    if (requiresAutomationMode(req.cmd) && !(await isAutomationModeEnabled())) {
      throw new Error(
        `Command '${req.cmd}' requires Automation Mode, which is currently disabled. ` +
          `Ask the user to enable Automation Mode in the FoxPilot extension's options page, then try again.`
      );
    }

    const isAllowed = await isCommandAllowed(req.cmd);
    if (!isAllowed) {
      throw new Error(`Command '${req.cmd}' is disabled in extension settings`);
    }

    this.addAuditLogForReq(req).catch((error) => {
      console.error("Failed to add audit log entry:", error);
    });

    switch (req.cmd) {
      case "open-tab":
        await this.openUrl(req.correlationId, req.url);
        break;
      case "close-tabs":
        await this.closeTabs(req.correlationId, req.tabIds);
        break;
      case "get-tab-list":
        await this.sendTabs(req.correlationId);
        break;
      case "get-browser-recent-history":
        await this.sendRecentHistory(req.correlationId, req.searchQuery);
        break;
      case "get-tab-content":
        await this.sendTabsContent(req.correlationId, req.tabId, req.offset);
        break;
      case "reorder-tabs":
        await this.reorderTabs(req.correlationId, req.tabOrder);
        break;
      case "find-highlight":
        await this.findAndHighlightText(
          req.correlationId,
          req.tabId,
          req.queryPhrase
        );
        break;
      case "group-tabs":
        await this.groupTabs(
          req.correlationId,
          req.tabIds,
          req.isCollapsed,
          req.groupColor as browser.tabGroups.Color,
          req.groupTitle
        );
        break;
      case "take-snapshot":
        await this.takeSnapshot(req.correlationId, req.tabId, {
          verbose: req.verbose,
          includePointer: req.includePointer,
          maxInteractive: req.maxInteractive,
          selector: req.selector,
          textContains: req.textContains,
          rootSelector: req.rootSelector,
          offset: req.offset,
          limit: req.limit,
        });
        break;
      case "navigate-tab":
        await this.navigateTab(req.correlationId, req.tabId, req.url, {
          waitUntil: req.waitUntil,
          waitForSelector: req.waitForSelector,
          waitForText: req.waitForText,
          waitForUrl: req.waitForUrl,
          forceLoad: req.forceLoad,
          timeoutMs: req.timeoutMs,
        });
        break;
      case "navigate-page-history":
        await this.navigatePageHistory(
          req.correlationId,
          req.tabId,
          req.direction,
          req.bypassCache
        );
        break;
      case "select-tab":
        await this.selectTab(req.correlationId, req.tabId);
        break;
      case "get-active-tab":
        await this.getActiveTab(req.correlationId);
        break;
      case "wait-for-text":
        await this.waitForText(
          req.correlationId,
          req.tabId,
          req.text,
          req.timeoutMs
        );
        break;
      case "click-element":
        await this.runInputAction(req.correlationId, req.tabId, {
          action: "click",
          uid: req.uid,
          doubleClick: req.doubleClick,
          failIfIntercepted: req.failIfIntercepted,
        });
        break;
      case "hover-element":
        await this.runInputAction(req.correlationId, req.tabId, {
          action: "hover",
          uid: req.uid,
        });
        break;
      case "fill-element":
        await this.runInputAction(req.correlationId, req.tabId, {
          action: "fill",
          uid: req.uid,
          value: req.value,
        });
        break;
      case "fill-form":
        await this.runInputAction(req.correlationId, req.tabId, {
          action: "fill-form",
          fields: req.fields,
        });
        break;
      case "type-text":
        await this.runInputAction(req.correlationId, req.tabId, {
          action: "type",
          text: req.text,
          submit: req.submit,
        });
        break;
      case "press-key":
        await this.runInputAction(req.correlationId, req.tabId, {
          action: "press-key",
          key: req.key,
          modifiers: req.modifiers,
        });
        break;
      case "drag-element":
        await this.runInputAction(req.correlationId, req.tabId, {
          action: "drag",
          fromUid: req.fromUid,
          toUid: req.toUid,
        });
        break;
      case "click-at":
        await this.runPointAction(
          req.correlationId,
          req.tabId,
          {
            action: "click-at",
            x: req.x,
            y: req.y,
            doubleClick: req.doubleClick,
            button: req.button,
          },
          req.engine
        );
        break;
      case "type-at":
        await this.runPointAction(
          req.correlationId,
          req.tabId,
          {
            action: "type-at",
            x: req.x,
            y: req.y,
            text: req.text,
            submit: req.submit,
          },
          req.engine
        );
        break;
      case "hover-at":
        await this.runPointAction(
          req.correlationId,
          req.tabId,
          {
            action: "hover-at",
            x: req.x,
            y: req.y,
          },
          req.engine
        );
        break;
      case "scroll-at":
        await this.runPointAction(
          req.correlationId,
          req.tabId,
          {
            action: "scroll-at",
            x: req.x,
            y: req.y,
            dx: req.dx,
            dy: req.dy,
          },
          req.engine
        );
        break;
      case "scroll-to":
        await this.scrollWindow(req.correlationId, req.tabId, req.x, req.y);
        break;
      case "scroll-into-view":
        await this.scrollIntoViewByUid(req.correlationId, req.tabId, req.uid);
        break;
      case "resize-window":
        await this.resizeWindow(
          req.correlationId,
          req.tabId,
          req.width,
          req.height
        );
        break;
      case "evaluate-script":
        await this.evaluateScript(
          req.correlationId,
          req.tabId,
          req.function,
          req.args,
          req.world,
          req.engine
        );
        break;
      case "upload-file":
        await this.uploadFile(
          req.correlationId,
          req.tabId,
          req.uid,
          req.filename,
          req.mimeType,
          req.base64
        );
        break;
      case "take-screenshot":
        await this.takeScreenshot(req.correlationId, req.tabId, {
          fullPage: req.fullPage,
          uid: req.uid,
          format: req.format,
        });
        break;
      case "handle-dialog":
        await this.handleDialog(
          req.correlationId,
          req.tabId,
          req.action,
          req.promptText
        );
        break;
      case "emulate":
        await this.emulate(req.correlationId, req.tabId, {
          geolocation: req.geolocation,
          userAgent: req.userAgent,
        });
        break;
      case "get-console-messages":
        await this.getConsoleMessages(req.correlationId, req.tabId, req.limit);
        break;
      case "get-network-requests":
        await this.getNetworkRequestsForTab(req.correlationId, req.tabId, {
          filter: req.filter,
          limit: req.limit,
          includeBody: req.includeBody,
        });
        break;
      case "get-cookies":
        await this.handleGetCookies(req.correlationId, req);
        break;
      case "browser-fetch":
        await this.handleBrowserFetch(req.correlationId, req);
        break;
      case "stream-start":
        await this.handleStreamStart(req.correlationId, req);
        break;
      case "stream-poll":
        await this.handleStreamPoll(req.correlationId, req);
        break;
      case "stream-close":
        await this.handleStreamClose(req.correlationId, req);
        break;
      case "capture-response-bodies":
        // Firefox has no chrome.debugger; response bodies are already captured
        // covertly via get-network-requests includeBody (filterResponseData).
        // Report unsupported so the model knows to just use includeBody here.
        await this.client.sendResourceToServer({
          resource: "response-body-capture",
          correlationId: req.correlationId,
          ok: true,
          enabled: false,
          supported: false,
        });
        break;
      default:
        const _exhaustiveCheck: never = req;
        console.error("Invalid message received:", req);
    }
  }

  private async addAuditLogForReq(req: ServerMessageRequest) {
    // Get the URL in context (either from param or from the tab)
    let contextUrl: string | undefined;
    if ("url" in req && req.url) {
      contextUrl = req.url;
    }
    if ("tabId" in req) {
      try {
        const tab = await browser.tabs.get(req.tabId);
        contextUrl = tab.url;
      } catch (error) {
        console.error("Failed to get tab URL for audit log:", error);
      }
    }

    const toolId = COMMAND_TO_TOOL_ID[req.cmd];
    const auditEntry = {
      toolId,
      command: req.cmd,
      timestamp: Date.now(),
      url: contextUrl
    };
    
    await addAuditLogEntry(auditEntry);
  }

  private async openUrl(correlationId: string, url: string): Promise<void> {
    if (!url.startsWith("https://")) {
      console.error("Invalid URL:", url);
      throw new Error("Invalid URL");
    }

    if (await isDomainInDenyList(url)) {
      throw new Error("Domain in user defined deny list");
    }

    const tab = await browser.tabs.create({
      url,
      active: false,
    });

    await this.client.sendResourceToServer({
      resource: "opened-tab-id",
      correlationId,
      tabId: tab.id,
    });
  }

  private async closeTabs(
    correlationId: string,
    tabIds: number[]
  ): Promise<void> {
    await browser.tabs.remove(tabIds);
    await this.client.sendResourceToServer({
      resource: "tabs-closed",
      correlationId,
    });
  }

  private async sendTabs(correlationId: string): Promise<void> {
    const tabs = await browser.tabs.query({});
    await this.client.sendResourceToServer({
      resource: "tabs",
      correlationId,
      tabs,
    });
  }

  private async sendRecentHistory(
    correlationId: string,
    searchQuery: string | null = null
  ): Promise<void> {
    const historyItems = await browser.history.search({
      text: searchQuery ?? "", // Search for all URLs (empty string matches everything)
      maxResults: 200, // Limit to 200 results
      startTime: 0, // Search from the beginning of time
    });
    const filteredHistoryItems = historyItems.filter((item) => {
      return !!item.url;
    });
    await this.client.sendResourceToServer({
      resource: "history",
      correlationId,
      historyItems: filteredHistoryItems,
    });
  }

  // Check that the user has granted permission to access the URL's domain.
  // This will open the options page with a URL parameter to request permission
  // and throw an error to indicate that the request cannot proceed until permission is granted.
  private async checkForUrlPermission(url: string | undefined): Promise<void> {
    if (url) {
      const origin = new URL(url).origin;
      const granted = await browser.permissions.contains({
        origins: [`${origin}/*`],
      });

      if (!granted) {
        // Open the options page with a URL parameter to request permission:
        const optionsUrl = browser.runtime.getURL("options.html");
        const urlWithParams = `${optionsUrl}?requestUrl=${encodeURIComponent(
          url
        )}`;

        await browser.tabs.create({ url: urlWithParams });
        throw new Error(
          `The user has not yet granted permission to access the domain "${origin}". A dialog is now being opened to request permission. If the user grants permission, you can try the request again.`
        );
      }
    }
  }

  private async checkForGlobalPermission(permissions: string[]): Promise<void> {
    const granted = await browser.permissions.contains({
      permissions,
    });

    if (!granted) {
      // Open the options page with a URL parameter to request permission:
      const optionsUrl = browser.runtime.getURL("options.html");
      const urlWithParams = `${optionsUrl}?requestPermissions=${encodeURIComponent(
        JSON.stringify(permissions)
      )}`;

      await browser.tabs.create({ url: urlWithParams });
      throw new Error(
        `The user has not yet granted permission for the following operations: ${permissions.join(
          ", "
        )}. A dialog is now being opened to request permission. If the user grants permission, you can try the request again.`
      );
    }
  }

  private async sendTabsContent(
    correlationId: string,
    tabId: number,
    offset?: number
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForUrlPermission(tab.url);

    const MAX_CONTENT_LENGTH = 50_000;
    const results = await browser.tabs.executeScript(tabId, {
      code: `
      (function () {
        function getLinks() {
          const linkElements = document.querySelectorAll('a[href]');
          return Array.from(linkElements).map(el => ({
            url: el.href,
            text: el.innerText.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || ''
          })).filter(link => link.text !== '' && link.url.startsWith('https://') && !link.url.includes('#'));
        }

        function getTextContent() {
          let isTruncated = false;
          let text = document.body.innerText.substring(${Number(offset) || 0});
          if (text.length > ${MAX_CONTENT_LENGTH}) {
            text = text.substring(0, ${MAX_CONTENT_LENGTH});
            isTruncated = true;
          }
          return {
            text, isTruncated
          }
        }

        const textContent = getTextContent();

        return {
          links: getLinks(),
          fullText: textContent.text,
          isTruncated: textContent.isTruncated,
          totalLength: document.body.innerText.length
        };
      })();
    `,
    });
    const { isTruncated, fullText, links, totalLength } = results[0];
    await this.client.sendResourceToServer({
      resource: "tab-content",
      tabId,
      correlationId,
      isTruncated,
      fullText,
      links,
      totalLength,
    });
  }

  private async takeSnapshot(
    correlationId: string,
    tabId: number,
    opts: {
      verbose?: boolean;
      includePointer?: boolean;
      maxInteractive?: number;
      selector?: string;
      textContains?: string;
      rootSelector?: string;
      offset?: number;
      limit?: number;
    }
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForUrlPermission(tab.url);

    const snapshotOptions = {
      verbose: !!opts.verbose,
      maxLength: 25000,
      includePointer: opts.includePointer,
      maxInteractive: opts.maxInteractive,
      selector: opts.selector,
      textContains: opts.textContains,
      rootSelector: opts.rootSelector,
      offset: opts.offset,
      limit: opts.limit,
    };
    const results = await browser.tabs.executeScript(tabId, {
      code: `(${buildSnapshot.toString()})(document, ${JSON.stringify(
        snapshotOptions
      )})`,
    });

    const { tree, isTruncated, total, hasMore, error } = results[0];
    await this.client.sendResourceToServer({
      resource: "snapshot",
      correlationId,
      tabId,
      snapshot: tree,
      isTruncated,
      ...(total !== undefined ? { total } : {}),
      ...(hasMore !== undefined ? { hasMore } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }

  // Shared executor for the input-automation tools (click, hover, fill,
  // fill-form, type-text, press-key). Each runs the self-contained
  // `performInputAction` in the page's JS world against the snapshot uids and
  // replies with a uniform `action-result`. A failed action (e.g. a stale uid)
  // is reported as `ok: false` with the error so the MCP layer can surface it.
  private async runInputAction(
    correlationId: string,
    tabId: number,
    args: InputActionArgs
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForUrlPermission(tab.url);

    const mode = await getInputRealismMode();
    // Build the ONE dispatch promise for the active mode, then race it once
    // against tab navigation. A navigating click tears the page/content-script
    // world down before its ack can return — hanging the reply even though the
    // click WORKED — so a nav that wins reports {ok:true,navigated:true} instead
    // of timing out. The native path is raced too: it FALLS BACK to the
    // synthetic content-script dispatch (fill/fill-form, a missing screen-rect,
    // an unsupported action, or an unreachable sidecar), and those fallbacks hang
    // on a navigating click just the same. A normally-resolving dispatch still
    // wins the race unchanged.
    let dispatchPromise: Promise<{
      ok: boolean;
      error?: string;
      navigated?: boolean;
      intercepted?: {
        tag: string;
        id?: string;
        classes?: string;
        role?: string;
        name?: string;
      };
    }>;
    if (mode === "off") {
      dispatchPromise = browser.tabs
        .executeScript(tabId, {
          code: `(${performInputAction.toString()})(document, ${JSON.stringify(
            args
          )})`,
        })
        .then((results) => results[0] as StepResult);
    } else if (mode === "native") {
      dispatchPromise = this.runNativeInputAction(tabId, args);
    } else {
      dispatchPromise = this.runHumanInputAction(tabId, args);
    }
    const result: {
      ok: boolean;
      error?: string;
      navigated?: boolean;
      intercepted?: {
        tag: string;
        id?: string;
        classes?: string;
        role?: string;
        name?: string;
      };
    } = await raceInputAgainstNavigation(tabId, dispatchPromise);

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: result.ok,
      error: result.error,
      ...(result.navigated !== undefined
        ? { navigated: result.navigated }
        : {}),
      ...(result.intercepted !== undefined
        ? { intercepted: result.intercepted }
        : {}),
    });
  }

  // Coordinate (synthetic) executor for the -at tools (click-at, type-at).
  // Injects the self-contained performPointAction into the ISOLATED world
  // (executeScript compiles it — no eval, no page-world <script>) and replies
  // with point-action-result. An off-point miss (either action) or a
  // not-typable target (type-at) is a legitimate ok:false RESULT, not a thrown
  // error.
  private async runPointAction(
    correlationId: string,
    tabId: number,
    args: PointActionArgs,
    engine?: "synthetic" | "cdp"
  ): Promise<void> {
    if (engine === "cdp") {
      // Firefox has no chrome.debugger / CDP — the trusted engine is Chrome-only.
      await this.client.sendResourceToServer({
        resource: "point-action-result",
        correlationId,
        ok: false,
        error:
          'CDP engine not supported on Firefox — use the default synthetic engine (omit engine, or pass engine:"synthetic").',
      });
      return;
    }
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);

    // Race the isolated-world dispatch against tab navigation: a synthetic click
    // that triggers a page navigation tears the content-script world down before
    // its ack returns, so report success with navigated:true instead of hanging.
    const dispatch = browser.tabs
      .executeScript(tabId, {
        code: `(${performPointAction.toString()})(document, ${JSON.stringify(
          args
        )})`,
      })
      .then(
        (results) =>
          (results && results[0]) || {
            ok: false,
            error:
              "point action produced no result (the content script may not be loaded in this tab — reload the page and retry).",
          }
      );
    const result = await raceInputAgainstNavigation(tabId, dispatch);
    await this.client.sendResourceToServer({
      resource: "point-action-result",
      correlationId,
      ok: !!result.ok,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.element !== undefined ? { element: result.element } : {}),
      ...(result.navigated !== undefined
        ? { navigated: result.navigated }
        : {}),
    });
  }

  // Absolute page scroll (window.scrollTo). Injects the self-contained
  // scrollWindowTo into the ISOLATED world via executeScript and replies with
  // the shared action-result — there is no element to describe. Omitting x/y
  // leaves that axis unchanged: `JSON.stringify(x ?? null) ?? undefined` emits
  // `null ?? undefined` (→ undefined) when the coord was omitted, else the value.
  private async scrollWindow(
    correlationId: string,
    tabId: number,
    x?: number,
    y?: number
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);
    const results = await browser.tabs.executeScript(tabId, {
      code: `(${scrollWindowTo.toString()})(document, ${JSON.stringify(
        x ?? null
      )} ?? undefined, ${JSON.stringify(y ?? null)} ?? undefined)`,
    });
    const result = (results && results[0]) || { ok: false, error: "no result" };
    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: !!result.ok,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
  }

  // Scroll a snapshot uid's element into view (centered) in the ISOLATED world.
  // A stale/missing uid comes back as a legitimate ok:false action-result (with
  // the "take a fresh snapshot" hint), not a throw.
  private async scrollIntoViewByUid(
    correlationId: string,
    tabId: number,
    uid: string
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);
    const results = await browser.tabs.executeScript(tabId, {
      code: `(${scrollElementIntoView.toString()})(document, ${JSON.stringify(uid)})`,
    });
    const result = (results && results[0]) || {
      ok: false,
      error:
        "scroll-into-view produced no result (content script not loaded — reload and retry).",
    };
    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: !!result.ok,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
  }

  // Inject a stringified function into a tab and return its first result. Shared
  // by the synthetic and native executors.
  private async exec<T>(tabId: number, code: string): Promise<T | undefined> {
    const r = await browser.tabs.executeScript(tabId, { code });
    return (r && r[0]) as T | undefined;
  }

  // Builds the real injected-effect deps and runs the pure orchestrator. Each
  // step is one `executeScript`; the background paces them with `sleep`. Every
  // authoritative mutation still goes through `performInputAction`.
  private async runHumanInputAction(
    tabId: number,
    args: InputActionArgs
  ): Promise<StepResult> {
    const exec = <T>(code: string): Promise<T | undefined> =>
      this.exec<T>(tabId, code);

    const deps: HumanInputDeps = {
      rng: Math.random,
      sleep,
      getCursor: () => this.cursorByTab.get(tabId) || { x: 100, y: 100 },
      setCursor: (p) => {
        this.cursorByTab.set(tabId, p);
      },
      readTargetInfo: async (uid) => {
        const info = await exec<{
          x: number;
          y: number;
          width: number;
          height: number;
          dpr: number;
        }>(`(${readElementRect.toString()})(document, ${JSON.stringify(uid)})`);
        return info || null;
      },
      mouseMove: async (x, y) => {
        await exec(`(${dispatchMouseMoveStep.toString()})(document, ${x}, ${y})`);
      },
      typeChar: async (ch) => {
        const r = await exec<StepResult>(
          `(${typeCharStep.toString()})(document, ${JSON.stringify(ch)})`
        );
        return r || { ok: false, error: "type step returned no result" };
      },
      instant: async (a) => {
        const r = await exec<StepResult>(
          `(${performInputAction.toString()})(document, ${JSON.stringify(a)})`
        );
        return r || { ok: false, error: "instant step returned no result" };
      },
    };

    return runHumanInput(args, deps);
  }

  // Native (Tier 2) executor: composes a screen-coordinate gesture and sends it
  // to the sidecar for REAL OS input. On any sidecar miss it falls back to the
  // synthetic executor (which falls back to instant), so outcomes stay safe.
  // Residual limitation: a rare mid-gesture throw in the sidecar AFTER partial
  // native typing could, on fallback, re-type; pre-input failures (unreachable /
  // no OS permission, the common cases) fall back cleanly with nothing typed.
  private async runNativeInputAction(
    tabId: number,
    args: InputActionArgs
  ): Promise<StepResult> {
    // Native typed-fill lacks a reliable transactional clear; use the synthetic
    // value-set path for fill/fill-form even in native mode.
    if (args.action === "fill" || args.action === "fill-form") {
      return this.runHumanInputAction(tabId, args);
    }

    const rng = Math.random;
    const exec = <T>(code: string): Promise<T | undefined> =>
      this.exec<T>(tabId, code);
    const screenRect = (uid: string) =>
      exec<{ screenX: number; screenY: number; width: number; height: number; dpr: number }>(
        `(${readElementScreenRect.toString()})(document, ${JSON.stringify(uid)})`
      );
    const getCursor = (): Point => this.nativeCursorByTab.get(tabId) || { x: 200, y: 200 };
    const pathFrom = (from: Point, to: Point): NativeWaypoint[] =>
      mousePath(from, to, rng).map((s) => ({ x: s.x, y: s.y, delayMs: s.delayMs }));

    let gesture: NativeGesture;
    let landing: Point | null = null;

    if (args.action === "click" || args.action === "hover") {
      const info = await screenRect(args.uid);
      if (!info) return this.runHumanInputAction(tabId, args);
      const center: Point = { x: info.screenX + info.width / 2, y: info.screenY + info.height / 2 };
      const waypoints = pathFrom(getCursor(), center);
      landing = center;
      gesture = args.action === "click"
        ? { kind: "move-click", waypoints, button: "left", doubleClick: args.doubleClick }
        : { kind: "move", waypoints };
    } else if (args.action === "drag") {
      const fromInfo = await screenRect(args.fromUid);
      const toInfo = await screenRect(args.toUid);
      if (!fromInfo || !toInfo) return this.runHumanInputAction(tabId, args);
      const fromC: Point = { x: fromInfo.screenX + fromInfo.width / 2, y: fromInfo.screenY + fromInfo.height / 2 };
      const toC: Point = { x: toInfo.screenX + toInfo.width / 2, y: toInfo.screenY + toInfo.height / 2 };
      const from = pathFrom(getCursor(), fromC);
      const to = pathFrom(fromC, toC);
      landing = toC;
      gesture = { kind: "drag", from, to };
    } else if (args.action === "type") {
      const keys = typingPlan(args.text, rng).map((k) => ({ char: k.char, delayMs: k.delayMs }));
      gesture = { kind: "type", keys };
    } else if (args.action === "press-key") {
      gesture = { kind: "key", key: args.key, modifiers: args.modifiers };
    } else {
      return this.runHumanInputAction(tabId, args);
    }

    let res: NativeInputResponse;
    try {
      const client = await this.getNativeClient();
      res = await client.sendGesture(gesture);
    } catch (e) {
      res = { id: "", ok: false, error: String(e) };
    }

    if (!res.ok) {
      // Sidecar unreachable / no OS permission / error -> synthetic (then instant).
      return this.runHumanInputAction(tabId, args);
    }

    if (landing) this.nativeCursorByTab.set(tabId, landing);

    // type+submit: trailing Enter is best-effort (value already landed natively).
    if (args.action === "type" && args.submit) {
      try {
        const client = await this.getNativeClient();
        await client.sendGesture({ kind: "key", key: "Enter" });
      } catch (e) {
        /* submit best-effort */
      }
    }

    return { ok: true };
  }

  // Lazily builds the sidecar client, snapshotting the port/secret on first
  // native use. If the sidecar port changes (or the secret rotates) mid-session,
  // the cached client keeps dialing the old port and native gestures fall back to
  // synthetic — restart the extension to pick up the new value.
  private async getNativeClient(): Promise<NativeInputClient> {
    if (!this.nativeClient) {
      const port = await getSidecarPort();
      const secret = await getSecret();
      this.nativeClient = new NativeInputClient(port, secret);
    }
    return this.nativeClient;
  }

  // Runs a JS function expression in the page's REAL world and returns its
  // (awaited, JSON-serialized) result. `executeScript` runs only in the
  // isolated content-script world and cannot await, so we use the shared
  // page-world helper: inject a page-world <script> that writes its result to a
  // unique attribute, then poll that attribute. CSP-strict pages may block the
  // injected script, in which case the poll times out and we reply ok:false
  // with a CSP hint instead of throwing.
  private async evaluateScript(
    correlationId: string,
    tabId: number,
    functionSource: string,
    args?: unknown[],
    world?: "main" | "isolated" | "auto",
    engine?: "auto" | "cdp"
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForUrlPermission(tab.url);

    // engine:"cdp" runs the eval through chrome.debugger (CSP-immune) on
    // Chrome/Edge; Firefox has no debugger API, so reject with an actionable
    // message pointing at the CSP-immune Firefox alternatives.
    if (engine === "cdp") {
      await this.client.sendResourceToServer({
        resource: "eval-result",
        correlationId,
        ok: false,
        error:
          'engine:"cdp" is only available on Chrome/Edge (no debugger API on Firefox). On Firefox use world:"isolated" (CSP-immune) or world:"auto".',
      });
      return;
    }

    const argv = args ?? [];
    let result: {
      ok: boolean;
      value?: unknown;
      error?: string;
      cspBlocked?: boolean;
    };

    if (world === "isolated") {
      result = await this.evalInIsolatedWorld(tabId, functionSource, argv);
    } else {
      // "main" and "auto" both inject the page's REAL world. buildEvalPageScript
      // sets a synchronous started-marker (startedAttr) as its first statement, so
      // runInPageWorld can detect a strict-CSP block FAST (marker never appears →
      // cspBlocked) instead of waiting out the full EVAL_TIMEOUT_MS.
      const resultAttr = `data-bcmcp-result-${Date.now()}-${++evalKeyCounter}`;
      const startedAttr = resultAttr + "-started";
      const pageScript = buildEvalPageScript(
        functionSource,
        argv,
        resultAttr,
        startedAttr
      );
      result = await runInPageWorld(
        (code) => browser.tabs.executeScript(tabId, { code }),
        pageScript,
        resultAttr,
        EVAL_TIMEOUT_MS,
        sleep,
        startedAttr
      );

      // world:"auto" (the default): the page CSP blocked the main-world <script>,
      // so transparently retry in the isolated content-script world, which is
      // genuinely CSP-immune on Firefox (executeScript compiles the source).
      // world:"main" opts out of the fallback (no retry).
      if (world !== "main" && result.cspBlocked) {
        result = await this.evalInIsolatedWorld(tabId, functionSource, argv);
      }
    }

    await this.client.sendResourceToServer({
      resource: "eval-result",
      correlationId,
      ok: result.ok,
      value: result.value,
      error: result.error,
    });
  }

  // Runs a JS function expression in the ISOLATED content-script world via
  // executeScript, which COMPILES the source (no runtime eval) — CSP-immune,
  // exactly like the snapshot injection. Backs world:"isolated" and the
  // world:"auto" CSP fallback. A compile/syntax error rejects executeScript and
  // is surfaced as ok:false. SYNCHRONOUS: a returned Promise is reported ok:false
  // (buildIsolatedEvalCode) — use world:"main"/"auto" for async results.
  private async evalInIsolatedWorld(
    tabId: number,
    functionSource: string,
    args: unknown[]
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    try {
      const results = await browser.tabs.executeScript(tabId, {
        code: buildIsolatedEvalCode(functionSource, args),
      });
      return (
        (results &&
          (results[0] as {
            ok: boolean;
            value?: unknown;
            error?: string;
          })) || {
          ok: false,
          error: "isolated evaluation produced no result.",
        }
      );
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // Uploads a file into a file <input> identified by a snapshot uid (the input
  // itself OR a drop zone wrapping it). Browsers forbid setting an input's value
  // from JS, so the only way to populate a file input is the DataTransfer
  // technique. We run it in the ISOLATED content-script world via executeScript
  // (`performFileUpload`) — NOT a page-world <script> — so a strict page CSP
  // (e.g. the Chrome Web Store dashboard) cannot block it. The MCP server has
  // already read the file off disk and passed its bytes as base64 — the
  // extension never sees a path. A stale/unresolved uid is reported as ok:false.
  private async uploadFile(
    correlationId: string,
    tabId: number,
    uid: string,
    filename: string,
    mimeType: string,
    base64: string
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForUrlPermission(tab.url);

    const results = await browser.tabs.executeScript(tabId, {
      code: `(${performFileUpload.toString()})(document, ${JSON.stringify({
        uid,
        filename,
        mimeType,
        base64,
      })})`,
    });
    const result: FileUploadResult = (results &&
      (results[0] as FileUploadResult)) || {
      ok: false,
      error:
        "upload-file produced no result (the content script may not be loaded in this tab — reload the page and retry).",
    };

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: result.ok,
      error: result.error,
    });
  }

  // Arms a tab so FUTURE native JS dialogs (alert/confirm/prompt) are
  // auto-accepted or auto-dismissed. The override must run in the page's REAL
  // world (where window.alert/confirm/prompt live), so we use the shared
  // inject/poll page-world helper. The injected script is synchronous, so the
  // result attribute appears on the first poll. CSP-strict pages time out with a
  // CSP hint (surfaced as ok:false) rather than throwing. Caveat: this cannot
  // intercept a dialog that is already open (it blocks the page's JS thread),
  // and the override is reset on navigation — re-arm afterwards.
  private async handleDialog(
    correlationId: string,
    tabId: number,
    action: "accept" | "dismiss",
    promptText?: string
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForUrlPermission(tab.url);

    const resultAttr = `data-bcmcp-result-${Date.now()}-${++evalKeyCounter}`;
    const pageScript = buildDialogPageScript(action, promptText, resultAttr);

    const result = await runInPageWorld(
      (code) => browser.tabs.executeScript(tabId, { code }),
      pageScript,
      resultAttr,
      PAGE_SETUP_TIMEOUT_MS,
      sleep
    );

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: result.ok,
      error: result.error,
    });
  }

  // Emulates device conditions for a tab: geolocation and/or userAgent. The
  // navigator shims (navigator.geolocation, navigator.userAgent) run in the
  // page's REAL world via the shared inject/poll helper. For userAgent we ALSO
  // record a per-tab override (setTabUserAgent) so the background
  // onBeforeSendHeaders listener rewrites the User-Agent request header — that
  // makes the SERVER-visible UA change too, not just what the page reads.
  // CSP-strict pages time out with a CSP hint (surfaced as ok:false). Only
  // geolocation + userAgent are supported; CPU/network/colorScheme are not
  // feasible from a WebExtension.
  private async emulate(
    correlationId: string,
    tabId: number,
    opts: {
      geolocation?: { latitude: number; longitude: number; accuracy?: number };
      userAgent?: string;
    }
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForUrlPermission(tab.url);

    // Record the UA override so the background header-rewrite listener applies
    // it to outgoing requests (the page-world shim alone only changes what the
    // page reads). Done after the deny-list/permission checks so a rejected
    // request leaves no override behind.
    if (opts.userAgent !== undefined) {
      setTabUserAgent(tabId, opts.userAgent);
    }

    const resultAttr = `data-bcmcp-result-${Date.now()}-${++evalKeyCounter}`;
    const pageScript = buildEmulatePageScript(
      opts.geolocation,
      opts.userAgent,
      resultAttr
    );

    const result = await runInPageWorld(
      (code) => browser.tabs.executeScript(tabId, { code }),
      pageScript,
      resultAttr,
      PAGE_SETUP_TIMEOUT_MS,
      sleep
    );

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: result.ok,
      error: result.error,
    });
  }

  // Captures a screenshot of a tab in one of three modes:
  //   - viewport (default): a single capture of the visible area.
  //   - element (uid given): scrolls the element into view, reads its rect, then
  //     crops the capture to just that element.
  //   - fullPage (fullPage:true): scroll-and-stitch the entire scrollable page.
  // `captureVisibleTab` can only grab the active tab of a window, so the tab is
  // activated first. The cropping/stitching modes composite on a <canvas> in the
  // background page (a real DOM document in Firefox), which jsdom cannot render —
  // so only the viewport path is unit-tested.
  private async takeScreenshot(
    correlationId: string,
    tabId: number,
    opts: { fullPage?: boolean; uid?: string; format?: "png" | "jpeg" }
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForUrlPermission(tab.url);

    const format: ImageFormat = opts.format === "jpeg" ? "jpeg" : "png";

    // captureVisibleTab only captures the active tab of the window, so activate
    // the target tab first. Record the currently-active tab so we can restore the
    // user's foreground tab after the capture (and even if it throws).
    const [prevActive] = await browser.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
    await browser.tabs.update(tabId, { active: true });

    let result: { mimeType: string; base64: string; warning?: string };
    try {
      if (opts.uid) {
        result = await this.captureElement(tabId, tab.windowId, opts.uid, format);
      } else if (opts.fullPage) {
        result = await this.captureFullPage(tabId, tab.windowId, format);
      } else {
        result = await this.captureViewport(tab.windowId, format);
      }
    } finally {
      // Restore the previously-active tab so automation never steals the user's
      // foreground tab. Skip if the target was already the active tab.
      if (prevActive?.id != null && prevActive.id !== tabId) {
        await browser.tabs.update(prevActive.id, { active: true });
      }
    }

    await this.client.sendResourceToServer({
      resource: "screenshot",
      correlationId,
      mimeType: result.mimeType,
      base64: result.base64,
      ...(result.warning !== undefined ? { warning: result.warning } : {}),
    });
  }

  // Single capture of the visible viewport. windowId may be undefined, in which
  // case captureVisibleTab targets the current window.
  private async captureViewport(
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<{ mimeType: string; base64: string }> {
    // Route through the bounded retry so a transient post-activation GPU readback
    // failure (or Firefox's ~1/s captureVisibleTab throttle) is absorbed instead
    // of surfacing as a hard "image readback failed".
    const dataUrl = await this.captureWindowWithRetry(windowId, format);
    const { base64 } = stripDataUrlPrefix(dataUrl);
    return { mimeType: mimeTypeForFormat(format), base64 };
  }

  // Element-crop mode: scroll the element into view, measure its viewport rect
  // and the device pixel ratio, then crop the capture to that rect.
  private async captureElement(
    tabId: number,
    windowId: number | undefined,
    uid: string,
    format: ImageFormat
  ): Promise<{ mimeType: string; base64: string }> {
    const rectResults = await browser.tabs.executeScript(tabId, {
      code: `(${readElementRect.toString()})(document, ${JSON.stringify(uid)})`,
    });
    const rect = rectResults[0] as {
      x: number;
      y: number;
      width: number;
      height: number;
      dpr: number;
    } | null;
    if (!rect) {
      throw new Error(
        `Element uid '${uid}' not found — take a fresh snapshot (uids are reassigned each snapshot).`
      );
    }

    // Give the browser a moment to settle after scrollIntoView before capturing.
    await sleep(100);

    // Retry the capture so a transient post-scroll readback failure (or Firefox's
    // ~1/s captureVisibleTab throttle) doesn't fail the element crop outright.
    const dataUrl = await this.captureWindowWithRetry(windowId, format);
    return await cropElementFromCapture(dataUrl, rect, format);
  }

  // Capture the visible window with bounded retry + backoff. A failed
  // captureVisibleTab (rejection) OR an empty/payload-less readback is treated as
  // a transient failure and retried (the backoff also absorbs Firefox's
  // ~once-per-second captureVisibleTab throttling). Throws only after all
  // attempts are exhausted.
  private async captureWindowWithRetry(
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<string> {
    const backoffs = [100, 300, 600];
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await sleep(backoffs[attempt - 1]);
      }
      try {
        const dataUrl = await this.captureWindow(windowId, format);
        if (isValidCapture(dataUrl)) {
          return dataUrl;
        }
        lastErr = new Error("empty capture readback");
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(
      `captureVisibleTab failed after 3 attempts: ${String(
        (lastErr as any)?.message ?? lastErr
      )}`
    );
  }

  // Full-page mode: read the page dimensions, then scroll through the page one
  // viewport at a time, capturing each frame (with retry), and stitch them onto a
  // tall canvas. If a tile ultimately fails or the stitch throws / yields an empty
  // readback, fall back to a single viewport capture flagged with a warning; only
  // surface a hard error when even that fallback comes back empty. The original
  // scroll position is restored when done.
  private async captureFullPage(
    tabId: number,
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<{ mimeType: string; base64: string; warning?: string }> {
    const dimsResults = await browser.tabs.executeScript(tabId, {
      code: `(${readPageDimensions.toString()})(document)`,
    });
    const dims = dimsResults[0] as {
      scrollWidth: number;
      scrollHeight: number;
      clientWidth: number;
      clientHeight: number;
      dpr: number;
      originalScrollY: number;
    };

    const offsets = planFullPageSteps(dims);
    const captures: { offsetY: number; dataUrl: string }[] = [];
    let tileError = false;
    try {
      for (const y of offsets) {
        await browser.tabs.executeScript(tabId, {
          code: `window.scrollTo(0, ${y})`,
        });
        // Wait for the browser to repaint at the new scroll position. Firefox also
        // throttles captureVisibleTab to ~once per second, so this delay doubles as
        // rate-limit breathing room.
        await sleep(100);
        const dataUrl = await this.captureWindowWithRetry(windowId, format);
        captures.push({ offsetY: y, dataUrl });
      }
    } catch (e) {
      // A tile ultimately failed even after retries — abandon stitching and try
      // the single-viewport fallback below.
      tileError = true;
    } finally {
      // Restore the original scroll position even if a capture/scroll mid-loop
      // throws, so we never leave the page scrolled away from where the user was.
      await browser.tabs.executeScript(tabId, {
        code: `window.scrollTo(0, ${dims.originalScrollY})`,
      });
    }

    // Stitch on the background canvas. Treat a throw (jsdom / canvas failure) OR
    // an empty readback as a stitch failure and fall through to the fallback.
    let stitched: { mimeType: string; base64: string } | null = null;
    if (!tileError) {
      try {
        const result = await stitchFullPage(
          captures,
          {
            scrollWidth: dims.scrollWidth,
            scrollHeight: dims.scrollHeight,
            dpr: dims.dpr,
          },
          format
        );
        if (result && result.base64 && result.base64.length > 0) {
          stitched = result;
        }
      } catch (e) {
        stitched = null;
      }
    }
    if (stitched) {
      return stitched;
    }

    // Fallback: a single validated viewport capture, flagged with a warning.
    let fallbackUrl: string;
    try {
      fallbackUrl = await this.captureWindowWithRetry(windowId, format);
    } catch (e) {
      throw new Error(
        "image readback failed: " +
          ((e as { message?: string })?.message ?? String(e))
      );
    }
    const { base64 } = stripDataUrlPrefix(fallbackUrl);
    if (!base64) {
      throw new Error("image readback failed");
    }
    return {
      mimeType: mimeTypeForFormat(format),
      base64,
      warning:
        "Full-page stitch failed; returning a single viewport capture instead.",
    };
  }

  // Thin wrapper over captureVisibleTab so the mode helpers don't repeat the
  // format/quality options. quality is ignored for png by the browser.
  private async captureWindow(
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<string> {
    if (windowId != null) {
      return await browser.tabs.captureVisibleTab(windowId, {
        format,
        quality: 90,
      });
    }
    return await browser.tabs.captureVisibleTab({ format, quality: 90 });
  }

  private async navigateTab(
    correlationId: string,
    tabId: number,
    url: string,
    opts?: {
      waitUntil?: "complete" | "none";
      waitForSelector?: string;
      waitForText?: string;
      waitForUrl?: string;
      forceLoad?: boolean;
      timeoutMs?: number;
    }
  ): Promise<void> {
    if (!isNavigableUrl(url)) {
      throw new Error("Invalid URL (must be https, or http for localhost)");
    }

    if (await isDomainInDenyList(url)) {
      throw new Error("Domain in user defined deny list");
    }

    if (opts?.forceLoad) {
      let current: { url?: string } | undefined;
      try {
        current = await browser.tabs.get(tabId);
      } catch {
        current = undefined;
      }
      if (current && current.url === url) {
        await browser.tabs.reload(tabId, {});
      } else {
        await browser.tabs.update(tabId, { url });
      }
    } else {
      await browser.tabs.update(tabId, { url });
    }

    if (opts?.waitUntil === "none") {
      await this.client.sendResourceToServer({
        resource: "navigated",
        correlationId,
        tabId,
        url,
      });
      return;
    }

    const budget = Math.min(Math.max(opts?.timeoutMs ?? 15000, 0), 29000);
    await waitForTabReady(tabId, { timeoutMs: Math.min(budget, 8000) });
    const mismatch = await this.awaitNavConditions(tabId, opts, budget);

    let finalUrl = url;
    try {
      const finalTab = await browser.tabs.get(tabId);
      if (finalTab && finalTab.url) finalUrl = finalTab.url;
    } catch {
      /* keep the requested url as a best-effort fallback */
    }

    await this.client.sendResourceToServer({
      resource: "navigated",
      correlationId,
      tabId,
      url: mismatch ? `${finalUrl} — ${mismatch}` : finalUrl,
    });
  }

  // Post-settle wait conditions. DOM predicates run in the ISOLATED world via
  // execWithReadyRetry (executeScript compiles the source — CSP-immune, and it
  // self-heals once if the frame is briefly not injectable after the nav).
  // waitForUrl is a pure background tabs.get substring match.
  private async awaitNavConditions(
    tabId: number,
    opts:
      | { waitForSelector?: string; waitForText?: string; waitForUrl?: string }
      | undefined,
    timeoutMs: number
  ): Promise<string | undefined> {
    if (!opts) return undefined;
    const { waitForSelector, waitForText, waitForUrl } = opts;
    if (!waitForSelector && !waitForText && !waitForUrl) return undefined;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      let selOk = true;
      let textOk = true;
      let urlOk = true;
      if (waitForUrl) {
        try {
          const t = await browser.tabs.get(tabId);
          urlOk = !!(t && t.url && t.url.includes(waitForUrl));
        } catch {
          urlOk = false;
        }
      }
      if (waitForSelector) {
        try {
          const r = await execWithReadyRetry(tabId, {
            code: `!!document.querySelector(${JSON.stringify(waitForSelector)})`,
          });
          selOk = !!(r && r[0]);
        } catch {
          selOk = false;
        }
      }
      if (waitForText) {
        try {
          const r = await execWithReadyRetry(tabId, {
            code: `((document.body&&document.body.innerText)||"").indexOf(${JSON.stringify(
              waitForText
            )})!==-1`,
          });
          textOk = !!(r && r[0]);
        } catch {
          textOk = false;
        }
      }
      if (selOk && textOk && urlOk) return undefined;
      if (Date.now() >= deadline) {
        if (!urlOk) return `expected url "${waitForUrl}" not found`;
        if (!selOk) return `expected selector "${waitForSelector}" not found`;
        return `expected text "${waitForText}" not found`;
      }
      await sleep(200);
    }
  }

  private async navigatePageHistory(
    correlationId: string,
    tabId: number,
    direction: "back" | "forward" | "reload",
    bypassCache?: boolean
  ): Promise<void> {
    switch (direction) {
      case "back":
        await browser.tabs.goBack(tabId);
        break;
      case "forward":
        await browser.tabs.goForward(tabId);
        break;
      case "reload":
        await browser.tabs.reload(tabId, { bypassCache: !!bypassCache });
        break;
    }

    await this.client.sendResourceToServer({
      resource: "navigated",
      correlationId,
      tabId,
    });
  }

  private async selectTab(
    correlationId: string,
    tabId: number
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    await browser.tabs.update(tabId, { active: true });
    if (tab.windowId != null) {
      await browser.windows.update(tab.windowId, { focused: true });
    }

    await this.client.sendResourceToServer({
      resource: "tab-selected",
      correlationId,
      tabId,
    });
  }

  // Resizes the BROWSER WINDOW that hosts the given tab — NOT the page viewport.
  // This is a plain window operation (no page injection), so it replies with the
  // shared action-result resource. If the tab has no resolvable windowId we skip
  // the resize but still report success (the tab simply isn't in a normal
  // window).
  private async resizeWindow(
    correlationId: string,
    tabId: number,
    width: number,
    height: number
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.windowId != null) {
      await browser.windows.update(tab.windowId, { width, height });
    }

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: true,
    });
  }

  private async getActiveTab(correlationId: string): Promise<void> {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    await this.client.sendResourceToServer({
      resource: "active-tab",
      correlationId,
      tab: tabs[0] ?? null,
    });
  }

  // Reads the per-tab console ring buffer populated by the document_start
  // capture script (registered while Automation Mode is on). This is a pure
  // in-memory read — no page scripting, no permission prompt. If nothing was
  // captured (e.g. the page loaded before Automation Mode was enabled), the
  // buffer is empty and an empty list is returned.
  private async getConsoleMessages(
    correlationId: string,
    tabId: number,
    limit?: number
  ): Promise<void> {
    const entries = getConsoleEntries(tabId, limit);
    await this.client.sendResourceToServer({
      resource: "console-messages",
      correlationId,
      entries,
    });
  }

  // Reads the per-tab network ring buffer populated by the webRequest listeners
  // (registered while Automation Mode is on). This is a pure in-memory read — no
  // page scripting, no permission prompt. If nothing was captured (e.g. the page
  // loaded before Automation Mode was enabled), an empty list is returned.
  //
  // `includeBody` toggles best-effort response-body capture (Firefox-specific).
  // Bodies are captured at request time, not read time, so enabling it here only
  // affects FUTURE requests — the bodies already attached to captured records
  // are returned as-is.
  private async getNetworkRequestsForTab(
    correlationId: string,
    tabId: number,
    opts: { filter?: string; limit?: number; includeBody?: boolean }
  ): Promise<void> {
    if (opts.includeBody !== undefined) {
      setBodyCaptureEnabled(opts.includeBody);
    }
    const requests = getNetworkRequests(tabId, {
      filter: opts.filter,
      limit: opts.limit,
    });
    await this.client.sendResourceToServer({
      resource: "network-requests",
      correlationId,
      requests,
    });
  }

  // --- Privileged background-context HTTP + cookie handlers ---
  // These run in the background page (not the page world), so they are immune to
  // the visited page's CSP and can use the real cookie jar. They act on a
  // URL/origin (no tabId). The gate mirrors the other handlers: deny-list and
  // missing-permission THROW (propagating so the outer handler surfaces the
  // grant UI / error); only operational failures come back as an `ok:false`
  // resource. Cookie values and response bodies are never logged.

  // Derive the host-gating URL for a get-cookies request: an explicit `url`,
  // else a synthetic https origin from `domain`, else none (a jar-wide read).
  private async gateHttpUrl(url: string | undefined): Promise<void> {
    if (url) {
      if (await isDomainInDenyList(url)) {
        throw new Error(`Domain in URL "${url}" is in the deny list`);
      }
      await this.checkForUrlPermission(url);
    }
  }

  private async handleGetCookies(
    correlationId: string,
    req: GetCookiesServerMessage
  ): Promise<void> {
    const gateUrl =
      req.url ?? (req.domain ? `https://${req.domain}/` : undefined);
    await this.gateHttpUrl(gateUrl);
    try {
      const cookies = await getCookies({
        url: req.url,
        domain: req.domain,
        name: req.name,
        names: req.names,
      });
      await this.client.sendResourceToServer({
        resource: "cookies",
        correlationId,
        ok: true,
        cookies,
      });
    } catch (error) {
      await this.client.sendResourceToServer({
        resource: "cookies",
        correlationId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleBrowserFetch(
    correlationId: string,
    req: BrowserFetchServerMessage
  ): Promise<void> {
    await this.gateHttpUrl(req.url);
    try {
      const result = await browserFetch({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        bodyBase64: req.bodyBase64,
        credentials: req.credentials,
        useSessionCookies: req.useSessionCookies,
        redirect: req.redirect,
        timeoutMs: req.timeoutMs,
        maxBytes: req.maxBytes,
      });
      await this.client.sendResourceToServer({
        resource: "browser-fetch-result",
        correlationId,
        ...result,
      });
    } catch (error) {
      await this.client.sendResourceToServer({
        resource: "browser-fetch-result",
        correlationId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleStreamStart(
    correlationId: string,
    req: StreamStartServerMessage
  ): Promise<void> {
    await this.gateHttpUrl(req.url);
    try {
      const result = await startStream({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        bodyBase64: req.bodyBase64,
        credentials: req.credentials,
        useSessionCookies: req.useSessionCookies,
        redirect: req.redirect,
        maxFrames: req.maxFrames,
        maxBytes: req.maxBytes,
        idleTimeoutMs: req.idleTimeoutMs,
        totalTimeoutMs: req.totalTimeoutMs,
      });
      await this.client.sendResourceToServer({
        resource: "stream-started",
        correlationId,
        ...result,
      });
    } catch (error) {
      await this.client.sendResourceToServer({
        resource: "stream-started",
        correlationId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleStreamPoll(
    correlationId: string,
    req: StreamPollServerMessage
  ): Promise<void> {
    try {
      const result = await pollStream(req.streamId, req.sinceIndex);
      await this.client.sendResourceToServer({
        resource: "stream-frames",
        correlationId,
        ...result,
      });
    } catch (error) {
      await this.client.sendResourceToServer({
        resource: "stream-frames",
        correlationId,
        ok: false,
        streamId: req.streamId,
        frames: [],
        nextIndex: req.sinceIndex ?? 0,
        done: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleStreamClose(
    correlationId: string,
    req: StreamCloseServerMessage
  ): Promise<void> {
    try {
      const result = closeStream(req.streamId);
      await this.client.sendResourceToServer({
        resource: "stream-closed",
        correlationId,
        ...result,
      });
    } catch (error) {
      await this.client.sendResourceToServer({
        resource: "stream-closed",
        correlationId,
        ok: false,
      });
    }
  }

  private async waitForText(
    correlationId: string,
    tabId: number,
    text: string | string[],
    timeoutMs?: number
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    const needles = Array.isArray(text) ? text : [text];
    const deadline = Date.now() + (timeoutMs ?? 30000);
    let found = false;
    let matched: string | undefined;

    while (true) {
      // Isolated-world probe: return the FIRST needle present in innerText, else
      // null. CSP-immune (no page-world <script>).
      const results = await browser.tabs.executeScript(tabId, {
        code: `(function(){var ns=${JSON.stringify(
          needles
        )};var b=document.body&&document.body.innerText;if(!b)return null;for(var i=0;i<ns.length;i++){if(b.indexOf(ns[i])!==-1)return ns[i];}return null;})()`,
      });
      const hit = results && results[0];
      // The probe returns the matched needle string (possibly "") or null when
      // absent. Gate on `!= null`, not truthiness, so an empty-string needle
      // (text:"" or an array containing "") counts as found — matching Chrome,
      // whose content-script probe returns an explicit boolean. The plain-string
      // reply omits `matched`, so byte-for-byte back-compat holds.
      if (hit != null) {
        found = true;
        // Only surface `matched` when the caller asked with an array (the
        // string case stays byte-for-byte back-compatible).
        if (Array.isArray(text)) {
          matched = String(hit);
        }
        break;
      }
      if (Date.now() >= deadline) {
        break;
      }
      await sleep(300);
    }

    await this.client.sendResourceToServer({
      resource: "wait-for-text-result",
      correlationId,
      found,
      ...(matched !== undefined ? { matched } : {}),
    });
  }

  private async reorderTabs(
    correlationId: string,
    tabOrder: number[]
  ): Promise<void> {
    // Reorder the tabs sequentially
    for (let newIndex = 0; newIndex < tabOrder.length; newIndex++) {
      const tabId = tabOrder[newIndex];
      await browser.tabs.move(tabId, { index: newIndex });
    }
    await this.client.sendResourceToServer({
      resource: "tabs-reordered",
      correlationId,
      tabOrder,
    });
  }

  private async findAndHighlightText(
    correlationId: string,
    tabId: number,
    queryPhrase: string
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);

    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForGlobalPermission(["find"]);

    const findResults = await browser.find.find(queryPhrase, {
      tabId,
      caseSensitive: true,
    });

    // If there are results, highlight them
    if (findResults.count > 0) {
      // But first, activate the tab. In firefox, this would also enable
      // auto-scrolling to the highlighted result.
      await browser.tabs.update(tabId, { active: true });
      browser.find.highlightResults({
        tabId,
      });
    }

    await this.client.sendResourceToServer({
      resource: "find-highlight-result",
      correlationId,
      noOfResults: findResults.count,
    });
  }

  private async groupTabs(
    correlationId: string,
    tabIds: number[],
    isCollapsed: boolean,
    groupColor: browser.tabGroups.Color,
    groupTitle: string
  ): Promise<void> {
    const groupId = await browser.tabs.group({
      tabIds,
    });

    let tabGroup = await browser.tabGroups.update(groupId, {
      collapsed: isCollapsed,
      color: groupColor,
      title: groupTitle,
    });

    await this.client.sendResourceToServer({
      resource: "new-tab-group",
      correlationId,
      groupId: tabGroup.id,
    });
  }
}
