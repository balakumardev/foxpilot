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
  attachDebugger,
  detachDebugger,
  isDebuggerAttached,
} from "./network-capture";
import { Point, mousePath, typingPlan } from "./humanize/motion-model";
import { performPointAction, type PointElementDescriptor } from "./injected/point-action-script";
import { cdpInputClick, cdpInputType, cdpInputHover, cdpInputScroll } from "./cdp-input";
import { cdpEval } from "./cdp-eval";
import { raceInputAgainstNavigation } from "./nav-race";
import { waitForTabReady } from "./nav-ready";

type InputActionArgs =
  | { action: "click"; uid: string; doubleClick?: boolean; failIfIntercepted?: boolean }
  | { action: "hover"; uid: string }
  | { action: "fill"; uid: string; value: string }
  | { action: "fill-form"; fields: { uid: string; value: string }[] }
  | { action: "type"; text: string; submit?: boolean }
  | { action: "press-key"; key: string; modifiers?: string[] }
  | { action: "drag"; fromUid: string; toUid: string };

// The argument shape accepted by the injected `performPointAction` function.
type PointActionArgs = Parameters<typeof performPointAction>[1];

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

// Ensure content script is loaded in a tab, then send a message. Exported for a
// focused unit test (send-message-to-tab.test.ts). On an injection OR permission
// failure — both of which appear right after a navigation / SPA route change,
// when the content script is gone AND the tab may have moved to a new origin
// before <all_urls> coverage is confirmed — self-heal ONCE: re-read the LIVE
// url, re-check host permission against the CURRENT origin (the pre-dispatch
// check may have validated a stale mid-nav url), wait for readiness, re-inject,
// and retry.
export async function sendMessageToTab(tabId: number, message: any): Promise<any> {
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
    const msg = (e && e.message) || "";
    const isConnErr =
      msg.includes("Receiving end does not exist") ||
      msg.includes("Could not establish connection");
    const isPermErr = msg.includes("Missing host permission");
    if (!isConnErr && !isPermErr) {
      throw e;
    }
    // Re-check host permission for the CURRENT origin.
    const live = await browser.tabs.get(tabId);
    if (live && live.url) {
      const origin = new URL(live.url).origin;
      const granted = await browser.permissions.contains({
        origins: [`${origin}/*`],
      });
      if (!granted) {
        throw new Error(
          `Missing host permission for "${origin}" after navigation. Ask the user to grant access to this domain, then retry.`
        );
      }
    }
    // Wait for the tab to be ready, re-inject the content script, retry ONCE.
    await waitForTabReady(tabId, { timeoutMs: 8000 });
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["dist/content-script.js"],
    });
    const result = await browser.tabs.sendMessage(tabId, message);
    return checkResult(result);
  }
}

// Like sendMessageToTab but returns the raw content-script reply WITHOUT
// throwing on an {ok:false,error} payload — for tools whose ok:false is a
// legitimate result to report, not a thrown tool-error.
async function sendMessageToTabRaw(tabId: number, message: any): Promise<any> {
  try {
    return await browser.tabs.sendMessage(tabId, message);
  } catch (e: any) {
    if (
      e.message &&
      (e.message.includes("Receiving end does not exist") ||
        e.message.includes("Could not establish connection"))
    ) {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ["dist/content-script.js"],
      });
      await sleep(100);
      return await browser.tabs.sendMessage(tabId, message);
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

    // Opt-in: for a tab-scoped command with activateTab:true, foreground the
    // target tab for the duration of the command, then restore the user's
    // previous tab. Recovers background tabs frozen by Chrome Memory Saver /
    // Edge Sleeping Tabs (empty snapshots / timeouts) without stealing focus.
    if (
      "activateTab" in req &&
      (req as { activateTab?: boolean }).activateTab === true &&
      "tabId" in req
    ) {
      await this.withTabActivated((req as { tabId: number }).tabId, () =>
        this.routeCommand(req)
      );
    } else {
      await this.routeCommand(req);
    }
  }

  // Foreground `tabId` for the duration of `fn`, then restore whatever tab was
  // active before (unless it was already the target). captureVisibleTab and
  // background-frozen tabs require the target tab to be foregrounded; this makes
  // that behavior opt-in and non-destructive to the user's current tab.
  private async withTabActivated<T>(
    tabId: number,
    fn: () => Promise<T>
  ): Promise<T> {
    const tab = await browser.tabs.get(tabId);
    const [prevActive] = await browser.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
    await browser.tabs.update(tabId, { active: true });
    try {
      return await fn();
    } finally {
      if (prevActive?.id != null && prevActive.id !== tabId) {
        await browser.tabs.update(prevActive.id, { active: true });
      }
    }
  }

  private async routeCommand(req: ServerMessageRequest): Promise<void> {
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
      case "select-option":
        await this.runSelectOption(req.correlationId, req.tabId, {
          uid: req.uid,
          option: req.option,
          exact: req.exact,
        });
        break;
      case "dismiss-overlays":
        await this.runDismissOverlays(req.correlationId, req.tabId);
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
    // Build the ONE dispatch promise for the active mode, then race it once
    // against tab navigation. A click whose handler navigates tears the
    // content-script world down before its ack can return — hanging the reply
    // even though the click WORKED — so the background nav watcher lets a nav
    // that wins report {ok:true,navigated:true} instead of timing out. The
    // native path is raced too: it FALLS BACK to the synthetic content-script
    // dispatch (fill/fill-form, a missing screen-rect, an unsupported action, or
    // an unreachable sidecar), and those fallbacks hang on a navigating click
    // just the same. A normally-resolving dispatch still wins the race unchanged.
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
      // Covert content-script dispatch.
      dispatchPromise = sendMessageToTab(tabId, {
        type: "performInputAction",
        args,
      });
    } else if (mode === "native") {
      // Native OS input from the sidecar, with synthetic content-script fallbacks.
      dispatchPromise = this.runNativeInputAction(tabId, args);
    } else {
      // Synthetic (default) routes through the content-script world.
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
      ...((result as { navigated?: boolean }).navigated !== undefined
        ? { navigated: (result as { navigated?: boolean }).navigated }
        : {}),
      ...(result.intercepted !== undefined
        ? { intercepted: result.intercepted }
        : {}),
    });
  }

  // Coordinate (synthetic) executor. Forwards the {x,y} action to the ISOLATED
  // content-script world (performPointAction runs elementFromPoint → the click
  // event sequence) and replies with point-action-result. An off-point / stale
  // hit is a legitimate ok:false RESULT, not a thrown error — so it uses the raw
  // sender that does not throw on an {ok:false} payload.
  private async runPointAction(
    correlationId: string,
    tabId: number,
    args: PointActionArgs,
    engine?: "synthetic" | "cdp"
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);

    const result =
      engine === "cdp"
        ? await this.dispatchCdpPointAction(tabId, args)
        : // Synthetic dispatch routes through the isolated content-script world,
          // which a navigating click tears down before the ack — race it against
          // tab navigation. The CDP path fires from the background (survives
          // navigation) and is left unwrapped.
          await raceInputAgainstNavigation(
            tabId,
            sendMessageToTabRaw(tabId, { type: "performPointAction", args })
          );

    await this.client.sendResourceToServer({
      resource: "point-action-result",
      correlationId,
      ok: !!(result && result.ok),
      ...(result && result.error !== undefined ? { error: result.error } : {}),
      ...(result && result.element !== undefined ? { element: result.element } : {}),
      ...(result && (result as { navigated?: boolean }).navigated !== undefined
        ? { navigated: (result as { navigated?: boolean }).navigated }
        : {}),
    });
  }

  // select-option executor. Forwards to the ISOLATED content-script world
  // (content-script.ts awaits selectOption) and races against tab navigation.
  private async runSelectOption(
    correlationId: string,
    tabId: number,
    args: { uid: string; option: string; exact?: boolean }
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);

    const result =
      (await raceInputAgainstNavigation(
        tabId,
        sendMessageToTabRaw(tabId, { type: "selectOption", args })
      )) || { ok: false, error: "select-option produced no result." };

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: !!(result && result.ok),
      ...(result && result.error !== undefined ? { error: result.error } : {}),
      ...(result && (result as { selected?: string }).selected !== undefined
        ? { selected: (result as { selected?: string }).selected }
        : {}),
      ...(result && (result as { navigated?: boolean }).navigated !== undefined
        ? { navigated: (result as { navigated?: boolean }).navigated }
        : {}),
    });
  }

  // dismiss-overlays executor. Forwards to the ISOLATED content-script world
  // (content-script.ts calls dismissOverlays). No nav-race (synchronous; a
  // reject click stays on the page).
  private async runDismissOverlays(
    correlationId: string,
    tabId: number
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);

    const result = (await sendMessageToTabRaw(tabId, {
      type: "dismissOverlays",
    })) || { ok: false, dismissed: [], error: "dismiss-overlays produced no result." };

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: !!(result && result.ok),
      ...(result && result.error !== undefined ? { error: result.error } : {}),
      ...(result && result.dismissed !== undefined
        ? { dismissed: result.dismissed }
        : {}),
      ...(result && result.method !== undefined ? { method: result.method } : {}),
    });
  }

  // engine:"cdp" (Chrome/Edge only): mirror the synthetic path's
  // resolve→act→describe order. FIRST describe the element under the point in
  // the isolated world — this both VALIDATES the point and captures the TRUE
  // target descriptor BEFORE the trusted Input.* dispatch mutates/navigates the
  // DOM. If nothing is under the point we return the off-point error and do NOT
  // fire a trusted event into empty space (mirrors the synthetic offPoint).
  // Reading the descriptor AFTER dispatch was wrong: a click/type that mutates
  // or navigates could leave a different (or no) element under the point, so a
  // post-dispatch describe-at MISS was reported as the action's own ok:false —
  // a FALSE failure for a trusted action that actually succeeded (double-submit
  // risk). We now report ok:true on a successful dispatch and hand back the
  // descriptor captured up front. A debugger-attach failure (DevTools already
  // open) is still a reported ok:false, not a thrown tool-error.
  private async dispatchCdpPointAction(
    tabId: number,
    args: PointActionArgs
  ): Promise<{ ok: boolean; error?: string; element?: PointElementDescriptor }> {
    // 1. Resolve + validate the point (read-only describe-at, isolated world),
    //    capturing the descriptor as it is BEFORE the trusted dispatch.
    const desc = await sendMessageToTabRaw(tabId, {
      type: "performPointAction",
      args: { action: "describe-at", x: args.x, y: args.y },
    });
    // 2. No element at the point → off-point: report ok:false and do NOT
    //    dispatch a trusted event into empty space (synthetic offPoint parity).
    if (desc && desc.ok === false) {
      return {
        ok: false,
        ...(desc.error !== undefined ? { error: desc.error } : {}),
      };
    }
    // 3. Dispatch the action as TRUSTED CDP Input events (refcounted "input"
    //    debugger attach — coexists with response-body capture).
    try {
      switch (args.action) {
        case "click-at":
          await cdpInputClick(
            tabId,
            args.x,
            args.y,
            args.button ?? "left",
            !!args.doubleClick
          );
          break;
        case "type-at":
          await cdpInputType(tabId, args.x, args.y, args.text, !!args.submit);
          break;
        case "hover-at":
          await cdpInputHover(tabId, args.x, args.y);
          break;
        case "scroll-at":
          await cdpInputScroll(tabId, args.x, args.y, args.dx, args.dy);
          break;
        default:
          return {
            ok: false,
            error: `The CDP engine does not support "${args.action}" yet.`,
          };
      }
    } catch (e) {
      return {
        ok: false,
        error:
          "CDP input dispatch failed — could not attach the debugger (is DevTools open on this tab, or another debugger already attached?): " +
          String((e as { message?: unknown })?.message ?? e),
      };
    }
    // 4. Trusted dispatch succeeded — return the descriptor captured in step 1
    //    (same shape the synthetic path returns), never a post-dispatch re-read.
    return {
      ok: true,
      ...(desc && desc.element !== undefined ? { element: desc.element } : {}),
    };
  }

  // Absolute page scroll (window.scrollTo). Routes to the ISOLATED content-script
  // world (scrollWindowTo) and replies with the shared action-result — there is
  // no element to describe. Omitting x/y leaves that axis unchanged.
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
    const result = await sendMessageToTabRaw(tabId, {
      type: "scrollWindowTo",
      x,
      y,
    });
    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: !!(result && result.ok),
      ...(result && result.error !== undefined ? { error: result.error } : {}),
    });
  }

  // Scroll a snapshot uid's element into view (centered) in the ISOLATED
  // content-script world. A stale/missing uid comes back as a legitimate
  // ok:false action-result (with the "take a fresh snapshot" hint), not a throw.
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
    const result = await sendMessageToTabRaw(tabId, {
      type: "scrollElementIntoView",
      uid,
    });
    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: !!(result && result.ok),
      ...(result && result.error !== undefined ? { error: result.error } : {}),
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
    args?: unknown[],
    world?: "main" | "isolated" | "auto",
    engine?: "auto" | "cdp"
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);

    const argv = args ?? [];
    let result: { ok: boolean; value?: unknown; error?: string };
    if (engine === "cdp") {
      // CSP-immune eval via chrome.debugger Runtime.evaluate (Chrome/Edge only).
      // Bypasses the page CSP entirely at the cost of the "started debugging this
      // browser" banner — opt-in, same tradeoff as capture-response-bodies.
      // engine:"cdp" overrides `world`.
      result = await cdpEval(tabId, functionSource, argv);
    } else if (world === "isolated") {
      // Isolated content-script world (CSP-immune DOM reads). Uses the raw
      // sender so a Chrome-CSP eval degrade comes back as eval-result ok:false
      // rather than a thrown tool-error. Guard the empty reply (no content
      // script in the tab) so it can never throw a raw TypeError reading
      // result.ok — mirrors the Firefox isolated branch.
      result = (await sendMessageToTabRaw(tabId, {
        type: "evaluateScriptIsolated",
        functionSource,
        args: argv,
      })) ?? { ok: false, error: "isolated evaluation produced no result." };
    } else {
      // "main" and "auto" both inject the page world. On Chrome the isolated
      // world cannot eval either, so "auto" does NOT retry isolated — the
      // content-script started-marker probe returns a fast {ok:false,cspBlocked}
      // with an actionable error (naming engine:"cdp"), which we forward as the
      // eval-result. Uses the RAW sender so that cspBlocked (and any genuine
      // eval error) flows through as a reported eval-result instead of being
      // thrown as a tool-error.
      const resultAttr = `data-bcmcp-result-${Date.now()}-${++evalKeyCounter}`;
      result = (await sendMessageToTabRaw(tabId, {
        type: "evaluateScript",
        functionSource,
        args: argv,
        resultAttr,
        timeoutMs: EVAL_TIMEOUT_MS,
      })) ?? { ok: false, error: "evaluation produced no result." };
    }

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
    // the target tab first and restore the user's foreground tab afterward (even
    // on throw) via the shared helper.
    const result = await this.withTabActivated<{
      mimeType: string;
      base64: string;
      warning?: string;
    }>(tabId, async () => {
      if (opts.uid) {
        return await this.captureElement(tabId, tab.windowId, opts.uid, format);
      } else if (opts.fullPage) {
        return await this.captureFullPage(tabId, tab.windowId, format);
      }
      return await this.captureViewport(tabId, tab.windowId, format);
    });

    await this.client.sendResourceToServer({
      resource: "screenshot",
      correlationId,
      mimeType: result.mimeType,
      base64: result.base64,
      ...(result.warning !== undefined ? { warning: result.warning } : {}),
    });
  }

  private async captureViewport(
    tabId: number,
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<{ mimeType: string; base64: string; warning?: string }> {
    // Retry a transient post-activation GPU readback failure (same helper the
    // full-page tiler uses) instead of failing the whole screenshot.
    try {
      const dataUrl = await this.captureWindowWithRetry(windowId, format);
      const { base64 } = stripDataUrlPrefix(dataUrl);
      if (base64) {
        return { mimeType: mimeTypeForFormat(format), base64 };
      }
    } catch (e) {
      // captureVisibleTab failed on every attempt (e.g. the persistent
      // "image readback failed" / empty-readback path some GPU/compositor
      // configs hit). Fall through to the CDP capture below.
    }

    // Fallback: CDP Page.captureScreenshot. Runs through the compositor's own
    // capture path, which succeeds on machines where captureVisibleTab returns
    // an empty readback every time. Chrome/Edge only; shows the "started
    // debugging this browser" banner (opt-in cost, only on the failure path).
    const base64 = await this.captureViewportCdp(tabId, format);
    return {
      mimeType: mimeTypeForFormat(format),
      base64,
      warning:
        "captureVisibleTab returned an empty readback; used the CDP screenshot fallback (a 'started debugging this browser' banner may have appeared).",
    };
  }

  // CDP viewport capture via the refcounted debugger ("input" purpose, matching
  // cdp-input.ts so it coexists with response-body capture). Returns raw base64
  // (Page.captureScreenshot already returns bare base64, no data: prefix).
  private async captureViewportCdp(
    tabId: number,
    format: ImageFormat
  ): Promise<string> {
    const dbg = (chrome as any).debugger;
    if (!dbg) {
      throw new Error(
        "image readback failed and the CDP screenshot fallback is unavailable (chrome.debugger not present)."
      );
    }
    await attachDebugger(tabId, "input");
    try {
      const res = (await dbg.sendCommand({ tabId }, "Page.captureScreenshot", {
        format,
        ...(format === "jpeg" ? { quality: 90 } : {}),
      })) as { data?: string };
      if (!res || !res.data) {
        throw new Error("CDP Page.captureScreenshot returned no data.");
      }
      return res.data;
    } finally {
      await detachDebugger(tabId, "input");
    }
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
    const dataUrl = await this.captureWindowWithRetry(windowId, format);
    await ensureOffscreen();
    const result = await browser.runtime.sendMessage({
      type: "cropElement",
      dataUrl,
      rect,
      format,
    });
    return result as { mimeType: string; base64: string };
  }

  // Capture the visible window with bounded retry + backoff. A failed
  // captureVisibleTab (rejection) OR an empty/payload-less readback is treated as
  // a transient failure and retried (the backoff also absorbs captureVisibleTab
  // rate-limiting). Throws only after all attempts are exhausted.
  private async captureWindowWithRetry(
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<string> {
    const backoffs = [100, 300, 600]; // slept BETWEEN attempts (not after the last)
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

  private async captureFullPage(
    tabId: number,
    windowId: number | undefined,
    format: ImageFormat
  ): Promise<{ mimeType: string; base64: string; warning?: string }> {
    const dims = await sendMessageToTab(tabId, { type: "readPageDimensions" });
    const offsets = planFullPageSteps(dims);
    const captures: { offsetY: number; dataUrl: string }[] = [];
    let tileError = false;
    try {
      for (const y of offsets) {
        await sendMessageToTab(tabId, { type: "scrollTo", y });
        await sleep(100);
        const dataUrl = await this.captureWindowWithRetry(windowId, format);
        captures.push({ offsetY: y, dataUrl });
      }
    } catch (e) {
      // A tile ultimately failed even after retries — abandon stitching and try
      // the single-viewport fallback below.
      tileError = true;
    } finally {
      await sendMessageToTab(tabId, { type: "scrollTo", y: dims.originalScrollY });
    }

    // Stitch on the offscreen document. Treat a throw OR an empty readback as a
    // stitch failure and fall through to the viewport fallback.
    let stitched: { mimeType: string; base64: string } | null = null;
    if (!tileError) {
      try {
        await ensureOffscreen();
        const result = (await browser.runtime.sendMessage({
          type: "stitchFullPage",
          captures,
          dims: {
            scrollWidth: dims.scrollWidth,
            scrollHeight: dims.scrollHeight,
            dpr: dims.dpr,
          },
          format,
        })) as { mimeType: string; base64: string };
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

    // Force a real document load to defeat in-app SPA routing (reload if the tab
    // is already at the target url, else navigate to it).
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

    // waitUntil:"none" restores the old fire-and-forget echo.
    if (opts?.waitUntil === "none") {
      await this.client.sendResourceToServer({
        resource: "navigated",
        correlationId,
        tabId,
        url,
      });
      return;
    }

    // Share ONE overall budget across settle-wait + condition-wait so their sum
    // stays under the 30s navigate-tab broker cap (mcp-server/timeouts.ts). They
    // used to run sequentially with independent budgets that ADD (≤8s + ≤29s =
    // ≤37s), which could time the request out even after the nav had settled.
    // Settle consumes ≤ settleBudget; conditions get the remainder of the cap.
    // Defaults are unchanged: any timeoutMs ≤ 20000 still yields the full
    // condition budget (only larger timeouts get clamped).
    const OVERALL_CAP_MS = 28000;
    const budget = Math.min(Math.max(opts?.timeoutMs ?? 15000, 0), 29000);
    const settleBudget = Math.min(budget, 8000);
    await waitForTabReady(tabId, { timeoutMs: settleBudget });
    const conditionBudget = Math.min(
      budget,
      Math.max(0, OVERALL_CAP_MS - settleBudget)
    );
    const mismatch = await this.awaitNavConditions(tabId, opts, conditionBudget);

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

  // Poll the post-settle wait conditions until all hold or the budget elapses.
  // Returns a human-readable mismatch string for the first unmet condition, or
  // undefined when everything is satisfied (or nothing was requested). DOM
  // predicates run in the isolated world via scripting.executeScript (func) —
  // CSP-immune; waitForUrl is a pure background tabs.get substring match.
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
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            func: (s: string) => !!document.querySelector(s),
            args: [waitForSelector],
          });
          selOk = !!(r && r[0] && (r[0] as { result?: unknown }).result);
        } catch {
          selOk = false;
        }
      }
      if (waitForText) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            func: (t: string) => (document.body?.innerText || "").includes(t),
            args: [waitForText],
          });
          textOk = !!(r && r[0] && (r[0] as { result?: unknown }).result);
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
        await attachDebugger(req.tabId, "network");
      } else {
        await detachDebugger(req.tabId, "network");
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
