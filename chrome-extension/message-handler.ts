import type { ServerMessageRequest } from "@foxpilot/common";
import { ExtensionTransport } from "./transport";
import {
  isCommandAllowed,
  isDomainInDenyList,
  COMMAND_TO_TOOL_ID,
  addAuditLogEntry,
  requiresAutomationMode,
  isAutomationModeEnabled,
  getInputRealismMode,
  getSidecarPort,
  getSecret,
} from "./extension-config";
import { applyUserAgentRule, clearUserAgentRule } from "./emulate";
import {
  getCookies,
  browserFetch,
  startStream,
  pollStream,
  closeStream,
  type BrowserFetchParams,
  type StreamStartParams,
} from "./browser-http";
import { NativeInputClient } from "./native-input-client";
import { NativeGesture, NativeWaypoint, NativeInputResponse } from "@foxpilot/common";
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
  attachDebugger,
  detachDebugger,
  isDebuggerAttached,
} from "./network-capture";
import { Point, mousePath, typingPlan } from "./humanize/motion-model";

type InputActionArgs =
  | { action: "click"; uid: string; doubleClick?: boolean }
  | { action: "hover"; uid: string }
  | { action: "fill"; uid: string; value: string }
  | { action: "fill-form"; fields: { uid: string; value: string }[] }
  | { action: "type"; text: string; submit?: boolean }
  | { action: "press-key"; key: string; modifiers?: string[] }
  | { action: "drag"; fromUid: string; toUid: string };

// @types/chrome on this version exposes the enum as chrome.tabGroups.Color and
// types color as a template-literal union rather than a `ColorEnum` alias, so we
// pin the accepted values with an explicit literal union here.
type TabGroupColor =
  | "grey" | "blue" | "red" | "yellow" | "green"
  | "pink" | "purple" | "cyan" | "orange";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let evalKeyCounter = 0;
const EVAL_TIMEOUT_MS = 10000;
const UPLOAD_TIMEOUT_MS = 15000;
const PAGE_SETUP_TIMEOUT_MS = 5000;

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

// Ensure content script is loaded in a tab, then send a message.
async function sendMessageToTab(tabId: number, message: any): Promise<any> {
  const checkResult = (result: any): any => {
    if (result && typeof result === "object" && result.error && result.ok === false) {
      throw new Error(result.error);
    }
    return result;
  };
  try {
    const result = await browser.tabs.sendMessage(tabId, message);
    return checkResult(result);
  } catch (e: any) {
    // If the content script is not loaded, inject it and retry.
    if (e.message && (e.message.includes("Receiving end does not exist") || e.message.includes("Could not establish connection"))) {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ["dist/content-script.js"],
      });
      await sleep(100);
      const result = await browser.tabs.sendMessage(tabId, message);
      return checkResult(result);
    }
    throw e;
  }
}

// Offscreen document for screenshot canvas operations.
//
// MV3 service workers have no DOM, so canvas/Image compositing is delegated to
// an offscreen document. We gate creation on chrome.offscreen.hasDocument()
// (the supported way to avoid the "Only one document may be created" error).
// After a service-worker restart the document may be gone; recreation is handled
// transparently by the hasDocument() gate in ensureOffscreen() on the next call.
let creatingOffscreen: Promise<void> | null = null;

const OFFSCREEN_BLOBS_REASON: string =
  (chrome as any).offscreen?.Reason?.BLOBS ?? "BLOBS";

export async function ensureOffscreen(): Promise<void> {
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = (async () => {
    if (await (chrome as any).offscreen.hasDocument()) {
      return;
    }
    await (chrome as any).offscreen.createDocument({
      url: browser.runtime.getURL("offscreen.html"),
      reasons: [OFFSCREEN_BLOBS_REASON],
      justification:
        "Screenshot compositing requires canvas and Image DOM APIs not available in a service worker.",
    });
  })();
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

// Exported teardown helper. Safe to call at any time; it is a no-op when no
// offscreen document exists. This is NOT invoked automatically (MV3 service
// workers do not reliably fire onSuspend) — it is provided for callers that
// want to explicitly tear the document down, e.g. when automation is turned off.
export async function closeOffscreen(): Promise<void> {
  if (await (chrome as any).offscreen.hasDocument()) {
    await (chrome as any).offscreen.closeDocument();
  }
}

export class MessageHandler {
  private client: ExtensionTransport;
  private cursorByTab: Map<number, Point> = new Map();
  private nativeCursorByTab: Map<number, Point> = new Map();
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
        await this.findAndHighlightText(req.correlationId, req.tabId, req.queryPhrase);
        break;
      case "group-tabs":
        await this.groupTabs(
          req.correlationId,
          req.tabIds,
          req.isCollapsed,
          req.groupColor as any,
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
      case "get-cookies":
        await this.getCookiesForServer(req.correlationId, {
          url: req.url,
          domain: req.domain,
          name: req.name,
          names: req.names,
        });
        break;
      case "browser-fetch":
        await this.browserFetchForServer(req.correlationId, req);
        break;
      case "stream-start":
        await this.streamStartForServer(req.correlationId, req);
        break;
      case "stream-poll":
        await this.streamPollForServer(
          req.correlationId,
          req.streamId,
          req.sinceIndex
        );
        break;
      case "stream-close":
        await this.streamCloseForServer(req.correlationId, req.streamId);
        break;
      case "capture-response-bodies":
        await this.setResponseBodyCapture(req.correlationId, req);
        break;
      default:
        const _exhaustiveCheck: never = req;
        console.error("Invalid message received:", req);
    }
  }

  private async addAuditLogForReq(req: ServerMessageRequest) {
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
      url: contextUrl,
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

    const tab = await browser.tabs.create({ url, active: false });
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
      text: searchQuery ?? "",
      maxResults: 200,
      startTime: 0,
    });
    const filteredHistoryItems = historyItems.filter((item) => !!item.url);
    await this.client.sendResourceToServer({
      resource: "history",
      correlationId,
      historyItems: filteredHistoryItems,
    });
  }

  private async checkForUrlPermission(url: string | undefined): Promise<void> {
    if (url) {
      const origin = new URL(url).origin;
      const granted = await browser.permissions.contains({
        origins: [`${origin}/*`],
      });
      if (!granted) {
        const optionsUrl = browser.runtime.getURL("options.html");
        const urlWithParams = `${optionsUrl}?requestUrl=${encodeURIComponent(url)}`;
        await browser.tabs.create({ url: urlWithParams });
        throw new Error(
          `The user has not yet granted permission to access the domain "${origin}". A dialog is now being opened to request permission. If the user grants permission, you can try the request again.`
        );
      }
    }
  }

  private async checkForGlobalPermission(permissions: string[]): Promise<void> {
    const granted = await browser.permissions.contains({ permissions });
    if (!granted) {
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

    const result = await sendMessageToTab(tabId, {
      type: "getTabContent",
      offset: Number(offset) || 0,
    });

    await this.client.sendResourceToServer({
      resource: "tab-content",
      tabId,
      correlationId,
      isTruncated: result.isTruncated,
      fullText: result.fullText,
      links: result.links,
      totalLength: result.totalLength,
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

    const result = await sendMessageToTab(tabId, {
      type: "buildSnapshot",
      options: opts,
    });

    await this.client.sendResourceToServer({
      resource: "snapshot",
      correlationId,
      tabId,
      snapshot: result.tree,
      isTruncated: result.isTruncated,
      ...(result.total !== undefined ? { total: result.total } : {}),
      ...(result.hasMore !== undefined ? { hasMore: result.hasMore } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
  }

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
    let result: any;
    if (mode === "off") {
      result = await sendMessageToTab(tabId, {
        type: "performInputAction",
        args,
      });
    } else if (mode === "native") {
      result = await this.runNativeInputAction(tabId, args);
    } else {
      result = await this.runHumanInputAction(tabId, args);
    }

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: result.ok,
      error: result.error,
    });
  }

  private async runHumanInputAction(tabId: number, args: InputActionArgs): Promise<any> {
    const cursor = this.cursorByTab.get(tabId) || { x: 100, y: 100 };
    const result = await sendMessageToTab(tabId, {
      type: "runHumanInput",
      args,
      cursor,
    });
    if (result.ok && result.cursor) {
      this.cursorByTab.set(tabId, result.cursor);
    }
    return result;
  }

  private async runNativeInputAction(tabId: number, args: InputActionArgs): Promise<any> {
    if (args.action === "fill" || args.action === "fill-form") {
      return this.runHumanInputAction(tabId, args);
    }

    const rng = Math.random;
    const screenRect = async (uid: string) => {
      const info = await sendMessageToTab(tabId, {
        type: "readElementScreenRect",
        uid,
      });
      return info;
    };
    const getCursor = (): Point => this.nativeCursorByTab.get(tabId) || { x: 200, y: 200 };
    const pathFrom = (from: Point, to: Point): NativeWaypoint[] =>
      mousePath(from, to, rng).map((s) => ({ x: s.x, y: s.y, delayMs: s.delayMs }));

    let gesture: NativeGesture;
    let landing: Point | null = null;

    if (args.action === "click" || args.action === "hover") {
      const info = await screenRect(args.uid);
      if (!info) return this.runHumanInputAction(tabId, args);
      const center: Point = {
        x: info.screenX + info.width / 2,
        y: info.screenY + info.height / 2,
      };
      const waypoints = pathFrom(getCursor(), center);
      landing = center;
      gesture =
        args.action === "click"
          ? { kind: "move-click", waypoints, button: "left", doubleClick: args.doubleClick }
          : { kind: "move", waypoints };
    } else if (args.action === "drag") {
      const fromInfo = await screenRect(args.fromUid);
      const toInfo = await screenRect(args.toUid);
      if (!fromInfo || !toInfo) return this.runHumanInputAction(tabId, args);
      const fromC: Point = {
        x: fromInfo.screenX + fromInfo.width / 2,
        y: fromInfo.screenY + fromInfo.height / 2,
      };
      const toC: Point = {
        x: toInfo.screenX + toInfo.width / 2,
        y: toInfo.screenY + toInfo.height / 2,
      };
      const from = pathFrom(getCursor(), fromC);
      const to = pathFrom(fromC, toC);
      landing = toC;
      gesture = { kind: "drag", from, to };
    } else if (args.action === "type") {
      const keys = typingPlan(args.text, rng).map((k) => ({
        char: k.char,
        delayMs: k.delayMs,
      }));
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
      return this.runHumanInputAction(tabId, args);
    }

    if (landing) this.nativeCursorByTab.set(tabId, landing);

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

  private async getNativeClient(): Promise<NativeInputClient> {
    if (!this.nativeClient) {
      const port = await getSidecarPort();
      const secret = await getSecret();
      this.nativeClient = new NativeInputClient(port, secret);
    }
    return this.nativeClient;
  }

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
    const result = await sendMessageToTab(tabId, {
      type: "evaluateScript",
      functionSource,
      args: args ?? [],
      resultAttr,
      timeoutMs: EVAL_TIMEOUT_MS,
    });

    await this.client.sendResourceToServer({
      resource: "eval-result",
      correlationId,
      ok: result.ok,
      value: result.value,
      error: result.error,
    });
  }

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
    const result = await sendMessageToTab(tabId, {
      type: "uploadFile",
      uid,
      filename,
      mimeType,
      base64,
      resultAttr,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: result.ok,
      error: result.error,
    });
  }

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
    const result = await sendMessageToTab(tabId, {
      type: "handleDialog",
      action,
      promptText,
      resultAttr,
      timeoutMs: PAGE_SETUP_TIMEOUT_MS,
    });

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: result.ok,
      error: result.error,
    });
  }

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

    if (opts.userAgent !== undefined) {
      if (opts.userAgent === "") {
        await clearUserAgentRule(tabId);
      } else {
        await applyUserAgentRule(tabId, opts.userAgent);
      }
    }

    const resultAttr = `data-bcmcp-result-${Date.now()}-${++evalKeyCounter}`;
    const result = await sendMessageToTab(tabId, {
      type: "emulate",
      geolocation: opts.geolocation,
      userAgent: opts.userAgent,
      resultAttr,
      timeoutMs: PAGE_SETUP_TIMEOUT_MS,
    });

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: result.ok,
      error: result.error,
    });
  }

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

    let result: { mimeType: string; base64: string };
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
    });
  }

  private async captureViewport(
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<{ mimeType: string; base64: string }> {
    const dataUrl = await this.captureWindow(windowId, format);
    const { base64 } = stripDataUrlPrefix(dataUrl);
    return { mimeType: mimeTypeForFormat(format), base64 };
  }

  private async captureElement(
    tabId: number,
    windowId: number | undefined,
    uid: string,
    format: ImageFormat
  ): Promise<{ mimeType: string; base64: string }> {
    const rect = await sendMessageToTab(tabId, {
      type: "readElementRect",
      uid,
    });
    if (!rect) {
      throw new Error(
        `Element uid '${uid}' not found — take a fresh snapshot (uids are reassigned each snapshot).`
      );
    }
    await sleep(100);
    const dataUrl = await this.captureWindow(windowId, format);
    await ensureOffscreen();
    const result = await browser.runtime.sendMessage({
      type: "cropElement",
      dataUrl,
      rect,
      format,
    });
    return result as { mimeType: string; base64: string };
  }

  private async captureFullPage(
    tabId: number,
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<{ mimeType: string; base64: string }> {
    const dims = await sendMessageToTab(tabId, {
      type: "readPageDimensions",
    });
    const offsets = planFullPageSteps(dims);
    const captures: { offsetY: number; dataUrl: string }[] = [];
    try {
      for (const y of offsets) {
        await sendMessageToTab(tabId, { type: "scrollTo", y });
        await sleep(100);
        const dataUrl = await this.captureWindow(windowId, format);
        captures.push({ offsetY: y, dataUrl });
      }
    } finally {
      await sendMessageToTab(tabId, {
        type: "scrollTo",
        y: dims.originalScrollY,
      });
    }
    await ensureOffscreen();
    const result = await browser.runtime.sendMessage({
      type: "stitchFullPage",
      captures,
      dims: {
        scrollWidth: dims.scrollWidth,
        scrollHeight: dims.scrollHeight,
        dpr: dims.dpr,
      },
      format,
    });
    return result as { mimeType: string; base64: string };
  }

  private async captureWindow(
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<string> {
    const options = { format, quality: 90 } as any;
    if (windowId != null) {
      return await browser.tabs.captureVisibleTab(windowId, options);
    }
    return await browser.tabs.captureVisibleTab(options);
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

  private async getNetworkRequestsForTab(
    correlationId: string,
    tabId: number,
    opts: { filter?: string; limit?: number; includeBody?: boolean }
  ): Promise<void> {
    // `includeBody` toggles best-effort REQUEST-body capture (covert, via the
    // onBeforeRequest `requestBody` extraInfoSpec). Bodies are captured at
    // request time, so this only affects FUTURE requests.
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
      // RESPONSE-body capture needs the opt-in chrome.debugger path. When the
      // caller asked for bodies, report whether that tab is currently attached so
      // the tool can be honest about whether `body` will be populated (request
      // bodies ride along covertly regardless).
      ...(opts.includeBody
        ? { bodyCaptureSupported: isDebuggerAttached(tabId) }
        : {}),
    });
  }

  // Opt-in DEEP response-body capture via chrome.debugger (Chrome/Edge). Attaches
  // the debugger to the tab (shows the "started debugging" banner, detectable by
  // the site) so RESPONSE bodies land in the same per-tab buffer the covert
  // webRequest path uses; `enabled:false` detaches. The deny-list + host-permission
  // gate throws propagate (opening the grant UI); an attach/detach failure is
  // reported as ok:false rather than thrown.
  private async setResponseBodyCapture(
    correlationId: string,
    req: { tabId: number; enabled: boolean }
  ): Promise<void> {
    const tab = await browser.tabs.get(req.tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);

    try {
      if (req.enabled) {
        await attachDebugger(req.tabId);
      } else {
        await detachDebugger(req.tabId);
      }
      await this.client.sendResourceToServer({
        resource: "response-body-capture",
        correlationId,
        ok: true,
        enabled: req.enabled,
        supported: true,
      });
    } catch (error) {
      await this.client.sendResourceToServer({
        resource: "response-body-capture",
        correlationId,
        ok: false,
        enabled: false,
        supported: true,
        error: String((error as any)?.message ?? error),
      });
    }
  }

  // --- Privileged background-context HTTP + cookie tools ---
  // These run in the service worker (not the page world), so they are immune to
  // the visited page's CSP and use the real cookie jar. They gate on a URL when
  // one is derivable (deny-list + host permission); the gate throws propagate so
  // the permission-grant UI opens. Operational failures from the browser-http
  // helper are reported as `ok:false` rather than thrown.

  private async getCookiesForServer(
    correlationId: string,
    opts: { url?: string; domain?: string; name?: string; names?: string[] }
  ): Promise<void> {
    const gateUrl =
      opts.url ?? (opts.domain ? `https://${opts.domain}/` : undefined);
    if (gateUrl) {
      if (await isDomainInDenyList(gateUrl)) {
        throw new Error("Domain in user defined deny list");
      }
      await this.checkForUrlPermission(gateUrl);
    }

    try {
      const cookies = await getCookies(opts);
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
        error: String((error as any)?.message ?? error),
      });
    }
  }

  private async browserFetchForServer(
    correlationId: string,
    params: BrowserFetchParams
  ): Promise<void> {
    if (await isDomainInDenyList(params.url)) {
      throw new Error("Domain in user defined deny list");
    }
    await this.checkForUrlPermission(params.url);

    try {
      const result = await browserFetch(params);
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
        error: String((error as any)?.message ?? error),
      });
    }
  }

  private async streamStartForServer(
    correlationId: string,
    params: StreamStartParams
  ): Promise<void> {
    if (await isDomainInDenyList(params.url)) {
      throw new Error("Domain in user defined deny list");
    }
    await this.checkForUrlPermission(params.url);

    try {
      const result = await startStream(params);
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
        error: String((error as any)?.message ?? error),
      });
    }
  }

  private async streamPollForServer(
    correlationId: string,
    streamId: string,
    sinceIndex?: number
  ): Promise<void> {
    try {
      const result = await pollStream(streamId, sinceIndex ?? 0);
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
        streamId,
        frames: [],
        nextIndex: sinceIndex ?? 0,
        done: true,
        error: String((error as any)?.message ?? error),
      });
    }
  }

  private async streamCloseForServer(
    correlationId: string,
    streamId: string
  ): Promise<void> {
    await closeStream(streamId);
    await this.client.sendResourceToServer({
      resource: "stream-closed",
      correlationId,
      ok: true,
    });
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
    const deadline = Date.now() + (timeoutMs ?? 30000);
    let found = false;
    let matched: string | undefined;
    while (true) {
      const result = await sendMessageToTab(tabId, {
        type: "waitForText",
        text,
        timeoutMs: 500, // short per-check; the loop owns the overall deadline
      });
      if (result.found) {
        found = true;
        if (Array.isArray(text)) {
          matched = result.matched;
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
    await this.checkForGlobalPermission(["activeTab"]);

    const result = await sendMessageToTab(tabId, {
      type: "findHighlight",
      queryPhrase,
    });

    await this.client.sendResourceToServer({
      resource: "find-highlight-result",
      correlationId,
      noOfResults: result.count,
    });
  }

  private async groupTabs(
    correlationId: string,
    tabIds: number[],
    isCollapsed: boolean,
    groupColor: TabGroupColor,
    groupTitle: string
  ): Promise<void> {
    const groupId = await browser.tabs.group({ tabIds });
    const tabGroup = await browser.tabGroups.update(groupId, {
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
