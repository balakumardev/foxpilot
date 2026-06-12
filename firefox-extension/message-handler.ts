import type { ServerMessageRequest } from "@browser-control-mcp/common";
import { ExtensionTransport } from "./transport";
import { isCommandAllowed, isDomainInDenyList, COMMAND_TO_TOOL_ID, addAuditLogEntry, requiresAutomationMode, isAutomationModeEnabled } from "./extension-config";
import { buildSnapshot } from "./injected/snapshot-script";
import { performInputAction } from "./injected/action-script";
import {
  buildEvalPageScript,
  buildUploadPageScript,
  buildDialogPageScript,
  buildEmulatePageScript,
  runInPageWorld,
} from "./injected/page-world";
import { setTabUserAgent } from "./emulate";
import {
  cropElementFromCapture,
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

// The argument shape accepted by the injected `performInputAction` function.
type InputActionArgs = Parameters<typeof performInputAction>[1];

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

// upload-file uses the same inject/poll page-world machinery. Its page script is
// synchronous (File/DataTransfer assignment), so the result attribute appears on
// the first poll — but larger files take a moment to decode, so we allow a
// slightly higher ceiling than eval. The broker's upload-file response timeout
// (30s) is comfortably larger than this.
const UPLOAD_TIMEOUT_MS = 15000;

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

  constructor(client: ExtensionTransport) {
    this.client = client;
  }

  public async handleDecodedMessage(req: ServerMessageRequest): Promise<void> {
    if (requiresAutomationMode(req.cmd) && !(await isAutomationModeEnabled())) {
      throw new Error(
        `Command '${req.cmd}' requires Automation Mode, which is currently disabled. ` +
          `Ask the user to enable Automation Mode in the Browser Control MCP extension's options page, then try again.`
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
        await this.takeSnapshot(req.correlationId, req.tabId, req.verbose);
        break;
      case "navigate-tab":
        await this.navigateTab(req.correlationId, req.tabId, req.url);
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
          req.args
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
    verbose?: boolean
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForUrlPermission(tab.url);

    // `buildSnapshot` is fully self-contained, so stringifying it yields a
    // function expression that runs standalone in the page's JS world.
    const snapshotOptions = { verbose: !!verbose, maxLength: 25000 };
    const results = await browser.tabs.executeScript(tabId, {
      code: `(${buildSnapshot.toString()})(document, ${JSON.stringify(
        snapshotOptions
      )})`,
    });

    const { tree, isTruncated } = results[0];
    await this.client.sendResourceToServer({
      resource: "snapshot",
      correlationId,
      tabId,
      snapshot: tree,
      isTruncated,
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

    const results = await browser.tabs.executeScript(tabId, {
      code: `(${performInputAction.toString()})(document, ${JSON.stringify(
        args
      )})`,
    });

    const result = results[0] as { ok: boolean; error?: string };
    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: result.ok,
      error: result.error,
    });
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
    args?: unknown[]
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForUrlPermission(tab.url);

    const resultAttr = `data-bcmcp-result-${Date.now()}-${++evalKeyCounter}`;
    const pageScript = buildEvalPageScript(functionSource, args ?? [], resultAttr);

    const result = await runInPageWorld(
      (code) => browser.tabs.executeScript(tabId, { code }),
      pageScript,
      resultAttr,
      EVAL_TIMEOUT_MS,
      sleep
    );

    await this.client.sendResourceToServer({
      resource: "eval-result",
      correlationId,
      ok: result.ok,
      value: result.value,
      error: result.error,
    });
  }

  // Uploads a file into a file <input> identified by a snapshot uid. Browsers
  // forbid setting an input's value from JS, so the only way to populate a file
  // input is the DataTransfer technique, which must run in the page's REAL world
  // (frameworks listen there). The MCP server has already read the file off disk
  // and passed its bytes as base64 — the extension never sees a path. We build a
  // page-world script that reconstructs the File and assigns it via DataTransfer,
  // then use the shared inject/poll helper to run it and read the {ok,error}
  // result. A stale uid is reported as ok:false; CSP-strict pages time out with a
  // CSP hint (also surfaced as ok:false) rather than throwing.
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

    const resultAttr = `data-bcmcp-result-${Date.now()}-${++evalKeyCounter}`;
    const pageScript = buildUploadPageScript(
      uid,
      filename,
      mimeType,
      base64,
      resultAttr
    );

    const result = await runInPageWorld(
      (code) => browser.tabs.executeScript(tabId, { code }),
      pageScript,
      resultAttr,
      UPLOAD_TIMEOUT_MS,
      sleep
    );

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
    // the target tab first.
    await browser.tabs.update(tabId, { active: true });

    let result: { mimeType: string; base64: string };
    if (opts.uid) {
      result = await this.captureElement(tabId, tab.windowId, opts.uid, format);
    } else if (opts.fullPage) {
      result = await this.captureFullPage(tabId, tab.windowId, format);
    } else {
      result = await this.captureViewport(tab.windowId, format);
    }

    await this.client.sendResourceToServer({
      resource: "screenshot",
      correlationId,
      mimeType: result.mimeType,
      base64: result.base64,
    });
  }

  // Single capture of the visible viewport. windowId may be undefined, in which
  // case captureVisibleTab targets the current window.
  private async captureViewport(
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<{ mimeType: string; base64: string }> {
    const dataUrl = await this.captureWindow(windowId, format);
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

    const dataUrl = await this.captureWindow(windowId, format);
    return await cropElementFromCapture(dataUrl, rect, format);
  }

  // Full-page mode: read the page dimensions, then scroll through the page one
  // viewport at a time, capturing each frame, and stitch them onto a tall canvas.
  // The original scroll position is restored when done.
  private async captureFullPage(
    tabId: number,
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<{ mimeType: string; base64: string }> {
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
    try {
      for (const y of offsets) {
        await browser.tabs.executeScript(tabId, {
          code: `window.scrollTo(0, ${y})`,
        });
        // Wait for the browser to repaint at the new scroll position. Firefox also
        // throttles captureVisibleTab to ~once per second, so this delay doubles as
        // rate-limit breathing room.
        await sleep(100);
        const dataUrl = await this.captureWindow(windowId, format);
        captures.push({ offsetY: y, dataUrl });
      }
    } finally {
      // Restore the original scroll position even if a capture/scroll mid-loop
      // throws, so we never leave the page scrolled away from where the user was.
      await browser.tabs.executeScript(tabId, {
        code: `window.scrollTo(0, ${dims.originalScrollY})`,
      });
    }

    return await stitchFullPage(
      captures,
      {
        scrollWidth: dims.scrollWidth,
        scrollHeight: dims.scrollHeight,
        dpr: dims.dpr,
      },
      format
    );
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
    url: string
  ): Promise<void> {
    if (!isNavigableUrl(url)) {
      throw new Error("Invalid URL (must be https, or http for localhost)");
    }

    if (await isDomainInDenyList(url)) {
      throw new Error("Domain in user defined deny list");
    }

    await browser.tabs.update(tabId, { url });

    await this.client.sendResourceToServer({
      resource: "navigated",
      correlationId,
      tabId,
      url,
    });
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

  private async waitForText(
    correlationId: string,
    tabId: number,
    text: string,
    timeoutMs?: number
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    const deadline = Date.now() + (timeoutMs ?? 30000);
    let found = false;

    while (true) {
      const results = await browser.tabs.executeScript(tabId, {
        code: `!!(document.body && document.body.innerText && document.body.innerText.includes(${JSON.stringify(
          text
        )}))`,
      });
      if (results && results[0]) {
        found = true;
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
