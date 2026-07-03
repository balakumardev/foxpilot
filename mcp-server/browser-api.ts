/**
 * BrowserAPI — the per-session MCP server's client to the broker.
 *
 * Public API is unchanged from the original WebSocket-server implementation, so
 * `server.ts` does not change: it constructs a `BrowserAPI`, calls `init()`,
 * and invokes `openTab` / `getTabList` / etc.
 *
 * Internally this is now a thin client of the long-lived broker daemon. On
 * `init()` it connects to the broker, auto-spawning the broker (detached) if
 * none is listening. Tool calls are posted as signed frames and matched back
 * by `requestId`. Many MCP-client processes share one broker, which owns the
 * single connection to the browser extension.
 */

import { WebSocket } from "ws";
import { spawn } from "child_process";
import * as path from "path";
import type {
  ServerMessage,
  ExtensionMessage,
  BrowserTab,
  BrowserHistoryItem,
  TabContentExtensionMessage,
  OpenedTabIdExtensionMessage,
  TabsExtensionMessage,
  BrowserHistoryExtensionMessage,
  ReorderedTabsExtensionMessage,
  FindHighlightExtensionMessage,
  TabGroupCreatedExtensionMessage,
  SnapshotExtensionMessage,
  NavigatedExtensionMessage,
  TabSelectedExtensionMessage,
  ActiveTabExtensionMessage,
  WaitForTextResultExtensionMessage,
  ActionResultExtensionMessage,
  EvalResultExtensionMessage,
  ScreenshotExtensionMessage,
  ConsoleEntry,
  ConsoleMessagesExtensionMessage,
  NetworkRecord,
  NetworkRequestsExtensionMessage,
  CookieRecord,
  CookiesExtensionMessage,
  BrowserFetchServerMessage,
  BrowserFetchResultExtensionMessage,
  StreamStartServerMessage,
  StreamStartedExtensionMessage,
  StreamFramesExtensionMessage,
  StreamClosedExtensionMessage,
  ResponseBodyCaptureExtensionMessage,
  PointActionResultExtensionMessage,
} from "@foxpilot/common";
import {
  BrokerClientFrame,
  BrokerServerFrame,
  BrokerControlRequest,
  BrokerControlResult,
  BrowserInfo,
} from "./broker-protocol";
import { createSignature, verifySignature } from "./signing";
import { getControlSecret } from "./control-secret";

const WS_DEFAULT_PORT = 8089;
const CONNECT_TIMEOUT_MS = 10000;
const CONNECT_RETRY_INTERVAL_MS = 200;
// Client-side safety net; the broker enforces its own per-command timeouts.
const REQUEST_TIMEOUT_MS = 60000;

interface RequestResolver {
  resolve: (msg: ExtensionMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ControlResolver {
  resolve: (result: BrokerControlResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BrowserAPI {
  private ws: WebSocket | null = null;
  private secret: string | null = null;
  private port: number = WS_DEFAULT_PORT;
  private requestCounter = 0;
  private readonly requestMap = new Map<string, RequestResolver>();
  private readonly controlMap = new Map<string, ControlResolver>();
  /** Dedupes concurrent reconnect attempts triggered from the send path. */
  private connecting: Promise<void> | null = null;

  async init() {
    const { port } = readConfig();
    // The extension leg is origin-gated; this secret only authenticates the
    // control leg to the broker, and is auto-managed (env, else persisted file).
    this.secret = getControlSecret();
    this.port = port;
    await this.ensureBrokerAndConnect();
  }

  close() {
    this.rejectAllPending("MCP server shutting down");
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  getSelectedPort() {
    return this.port;
  }

  // ---- connection / auto-spawn ----

  private async ensureBrokerAndConnect(): Promise<void> {
    if (await this.tryConnect()) {
      this.ensureSidecar();
      return;
    }
    // No broker listening — spawn one (detached) and retry connecting.
    this.spawnBroker();
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(CONNECT_RETRY_INTERVAL_MS);
      if (await this.tryConnect()) {
        this.ensureSidecar();
        return;
      }
    }
    throw new Error(
      `Could not connect to or start the FoxPilot broker on port ${this.port}.`
    );
  }

  /**
   * Best-effort (re)connect from the command path. The broker is a detached
   * daemon that idle-exits when nothing is attached, and an MV3 service-worker
   * sleep can drop the extension and let it go — so a command can arrive after
   * our socket has closed. Re-establish it (auto-spawning the broker if needed)
   * before giving up, deduping concurrent attempts. Errors are swallowed; the
   * caller re-checks the socket and reports "Not connected" if still down.
   */
  private async ensureConnectedForSend(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.ensureBrokerAndConnect().finally(() => {
        this.connecting = null;
      });
    }
    try {
      await this.connecting;
    } catch {
      /* re-checked by the caller */
    }
  }

  /**
   * Opt-in, best-effort auto-spawn of the native-input sidecar. Gated entirely
   * on the INPUT_SIDECAR_ENTRY env var: when unset (the default), this is a
   * no-op so server behavior is byte-for-byte unchanged and no sidecar process
   * is created. When set, spawns the sidecar detached (mirroring spawnBroker's
   * exact shape) wrapped in try/catch so it NEVER blocks or throws — a failed
   * spawn just means native input falls back to the synthetic path.
   */
  private ensureSidecar(): void {
    const entry = process.env.INPUT_SIDECAR_ENTRY;
    if (!entry) {
      return;
    }
    try {
      const child = spawn(process.execPath, [entry], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          EXTENSION_SECRET: this.secret ?? "",
          SIDECAR_PORT: process.env.SIDECAR_PORT ?? "8090",
        },
      });
      child.unref();
    } catch (err) {
      console.error("BrowserAPI: failed to auto-spawn input sidecar", err);
    }
  }

  private tryConnect(): Promise<boolean> {
    return new Promise((resolve) => {
      // Connect via "localhost" (not 127.0.0.1) so we match the host the broker
      // binds and the extension connects to. Otherwise an IPv6-only (::1)
      // localhost listener rejects an IPv4 (127.0.0.1) client (and vice versa).
      const ws = new WebSocket(`ws://localhost:${this.port}/mcp`);
      let settled = false;
      ws.on("open", () => {
        settled = true;
        this.attachSocket(ws);
        resolve(true);
      });
      ws.on("error", () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
    });
  }

  private spawnBroker(): void {
    const brokerEntry = path.join(__dirname, "broker-main.js");
    const child = spawn(process.execPath, [brokerEntry], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        EXTENSION_SECRET: this.secret ?? "",
        EXTENSION_PORT: String(this.port),
      },
    });
    child.unref();
  }

  private attachSocket(ws: WebSocket): void {
    this.ws = ws;
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", () => {
      if (this.ws === ws) {
        this.ws = null;
      }
      this.rejectAllPending("Broker connection closed");
    });
    ws.on("error", () => {
      /* close handler will run */
    });
  }

  private onMessage(raw: string): void {
    let decoded: { payload?: BrokerServerFrame; signature?: string };
    try {
      decoded = JSON.parse(raw);
    } catch {
      return;
    }
    if (!decoded || !decoded.payload || typeof decoded.signature !== "string") {
      return;
    }
    if (
      !verifySignature(
        this.secret!,
        JSON.stringify(decoded.payload),
        decoded.signature
      )
    ) {
      console.error("BrowserAPI: invalid broker message signature");
      return;
    }

    const frame = decoded.payload;
    if (frame.kind === "tool-result") {
      const resolver = this.requestMap.get(frame.requestId);
      if (!resolver) {
        return;
      }
      clearTimeout(resolver.timer);
      this.requestMap.delete(frame.requestId);
      resolver.resolve(frame.message);
    } else if (frame.kind === "tool-error") {
      const resolver = this.requestMap.get(frame.requestId);
      if (!resolver) {
        return;
      }
      clearTimeout(resolver.timer);
      this.requestMap.delete(frame.requestId);
      resolver.reject(new Error(frame.errorMessage));
    } else if (frame.kind === "control-result") {
      const resolver = this.controlMap.get(frame.requestId);
      if (!resolver) {
        return;
      }
      clearTimeout(resolver.timer);
      this.controlMap.delete(frame.requestId);
      resolver.resolve(frame.result);
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [requestId, resolver] of this.requestMap) {
      clearTimeout(resolver.timer);
      resolver.reject(new Error(reason));
      this.requestMap.delete(requestId);
    }
    for (const [requestId, resolver] of this.controlMap) {
      clearTimeout(resolver.timer);
      resolver.reject(new Error(reason));
      this.controlMap.delete(requestId);
    }
  }

  private async sendTool<T extends ExtensionMessage>(
    message: ServerMessage
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.ensureConnectedForSend();
    }
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to the broker"));
        return;
      }
      const requestId = `${process.pid}-${++this.requestCounter}`;
      const timer = setTimeout(() => {
        if (this.requestMap.has(requestId)) {
          this.requestMap.delete(requestId);
          reject(new Error("Timed out waiting for broker response"));
        }
      }, REQUEST_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
      this.requestMap.set(requestId, {
        resolve: resolve as (msg: ExtensionMessage) => void,
        reject,
        timer,
      });

      const frame: BrokerClientFrame = { kind: "tool", requestId, message };
      const payload = JSON.stringify(frame);
      const signature = createSignature(this.secret!, payload);
      this.ws.send(JSON.stringify({ payload: frame, signature }));
    });
  }

  private async sendControl(
    control: BrokerControlRequest
  ): Promise<BrokerControlResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.ensureConnectedForSend();
    }
    return new Promise<BrokerControlResult>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to the broker"));
        return;
      }
      const requestId = `${process.pid}-${++this.requestCounter}`;
      const timer = setTimeout(() => {
        if (this.controlMap.has(requestId)) {
          this.controlMap.delete(requestId);
          reject(new Error("Timed out waiting for broker control response"));
        }
      }, REQUEST_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
      this.controlMap.set(requestId, { resolve, reject, timer });

      const frame: BrokerClientFrame = { kind: "control", requestId, control };
      const payload = JSON.stringify(frame);
      const signature = createSignature(this.secret!, payload);
      this.ws.send(JSON.stringify({ payload: frame, signature }));
    });
  }

  // ---- public tool API (unchanged signatures) ----

  async openTab(url: string): Promise<number | undefined> {
    const message = await this.sendTool<OpenedTabIdExtensionMessage>({
      cmd: "open-tab",
      url,
    });
    return message.tabId;
  }

  async closeTabs(tabIds: number[]): Promise<void> {
    await this.sendTool({ cmd: "close-tabs", tabIds });
  }

  async getTabList(): Promise<BrowserTab[]> {
    const message = await this.sendTool<TabsExtensionMessage>({
      cmd: "get-tab-list",
    });
    return message.tabs;
  }

  async getBrowserRecentHistory(
    searchQuery?: string
  ): Promise<BrowserHistoryItem[]> {
    const message = await this.sendTool<BrowserHistoryExtensionMessage>({
      cmd: "get-browser-recent-history",
      searchQuery,
    });
    return message.historyItems;
  }

  async getTabContent(
    tabId: number,
    offset: number
  ): Promise<TabContentExtensionMessage> {
    return await this.sendTool<TabContentExtensionMessage>({
      cmd: "get-tab-content",
      tabId,
      offset,
    });
  }

  async reorderTabs(tabOrder: number[]): Promise<number[]> {
    const message = await this.sendTool<ReorderedTabsExtensionMessage>({
      cmd: "reorder-tabs",
      tabOrder,
    });
    return message.tabOrder;
  }

  async findHighlight(tabId: number, queryPhrase: string): Promise<number> {
    const message = await this.sendTool<FindHighlightExtensionMessage>({
      cmd: "find-highlight",
      tabId,
      queryPhrase,
    });
    return message.noOfResults;
  }

  async groupTabs(
    tabIds: number[],
    isCollapsed: boolean,
    groupColor: string,
    groupTitle: string
  ): Promise<number> {
    const message = await this.sendTool<TabGroupCreatedExtensionMessage>({
      cmd: "group-tabs",
      tabIds,
      isCollapsed,
      groupColor,
      groupTitle,
    });
    return message.groupId;
  }

  async takeSnapshot(
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
  ): Promise<SnapshotExtensionMessage> {
    return await this.sendTool<SnapshotExtensionMessage>({
      cmd: "take-snapshot",
      tabId,
      ...opts,
    });
  }

  async navigateTab(
    tabId: number,
    url: string
  ): Promise<NavigatedExtensionMessage> {
    return await this.sendTool<NavigatedExtensionMessage>({
      cmd: "navigate-tab",
      tabId,
      url,
    });
  }

  async navigatePageHistory(
    tabId: number,
    direction: "back" | "forward" | "reload",
    bypassCache?: boolean
  ): Promise<NavigatedExtensionMessage> {
    return await this.sendTool<NavigatedExtensionMessage>({
      cmd: "navigate-page-history",
      tabId,
      direction,
      bypassCache,
    });
  }

  async selectTab(tabId: number): Promise<TabSelectedExtensionMessage> {
    return await this.sendTool<TabSelectedExtensionMessage>({
      cmd: "select-tab",
      tabId,
    });
  }

  async getActiveTab(): Promise<BrowserTab | null> {
    const message = await this.sendTool<ActiveTabExtensionMessage>({
      cmd: "get-active-tab",
    });
    return message.tab;
  }

  async waitForText(
    tabId: number,
    text: string | string[],
    timeoutMs?: number
  ): Promise<{ found: boolean; matched?: string }> {
    const message = await this.sendTool<WaitForTextResultExtensionMessage>({
      cmd: "wait-for-text",
      tabId,
      text,
      timeoutMs,
    });
    return { found: message.found, matched: message.matched };
  }

  async clickElement(
    tabId: number,
    uid: string,
    doubleClick?: boolean
  ): Promise<void> {
    const message = await this.sendTool<ActionResultExtensionMessage>({
      cmd: "click-element",
      tabId,
      uid,
      doubleClick,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "Action failed");
    }
  }

  async clickAt(
    tabId: number,
    x: number,
    y: number,
    opts?: { doubleClick?: boolean; button?: "left" | "middle" | "right" }
  ): Promise<PointActionResultExtensionMessage> {
    // Returned unchanged (NOT thrown on ok:false) so the tool can report the
    // element descriptor even when the point missed / hit a non-typable node.
    return await this.sendTool<PointActionResultExtensionMessage>({
      cmd: "click-at",
      tabId,
      x,
      y,
      doubleClick: opts?.doubleClick,
      button: opts?.button,
    });
  }

  async typeAt(
    tabId: number,
    x: number,
    y: number,
    text: string,
    submit?: boolean
  ): Promise<PointActionResultExtensionMessage> {
    // Returned unchanged (NOT thrown on ok:false) so the tool can report the
    // element descriptor even when the point missed / hit a non-typable node.
    return await this.sendTool<PointActionResultExtensionMessage>({
      cmd: "type-at",
      tabId,
      x,
      y,
      text,
      submit,
    });
  }

  async hoverAt(
    tabId: number,
    x: number,
    y: number
  ): Promise<PointActionResultExtensionMessage> {
    // Returned unchanged (NOT thrown on ok:false) so the tool can report the
    // element descriptor even when the point missed.
    return await this.sendTool<PointActionResultExtensionMessage>({
      cmd: "hover-at",
      tabId,
      x,
      y,
    });
  }

  async scrollAt(
    tabId: number,
    x: number,
    y: number,
    opts?: { dx?: number; dy?: number }
  ): Promise<PointActionResultExtensionMessage> {
    // Returned unchanged (NOT thrown on ok:false) so the tool can report the
    // scrolled container's descriptor (or the element at the point when it falls
    // back to the window), and surface an off-point miss.
    return await this.sendTool<PointActionResultExtensionMessage>({
      cmd: "scroll-at",
      tabId,
      x,
      y,
      dx: opts?.dx,
      dy: opts?.dy,
    });
  }

  async hoverElement(tabId: number, uid: string): Promise<void> {
    const message = await this.sendTool<ActionResultExtensionMessage>({
      cmd: "hover-element",
      tabId,
      uid,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "Action failed");
    }
  }

  async fillElement(tabId: number, uid: string, value: string): Promise<void> {
    const message = await this.sendTool<ActionResultExtensionMessage>({
      cmd: "fill-element",
      tabId,
      uid,
      value,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "Action failed");
    }
  }

  async fillForm(
    tabId: number,
    fields: { uid: string; value: string }[]
  ): Promise<void> {
    const message = await this.sendTool<ActionResultExtensionMessage>({
      cmd: "fill-form",
      tabId,
      fields,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "Action failed");
    }
  }

  async typeText(tabId: number, text: string, submit?: boolean): Promise<void> {
    const message = await this.sendTool<ActionResultExtensionMessage>({
      cmd: "type-text",
      tabId,
      text,
      submit,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "Action failed");
    }
  }

  async pressKey(
    tabId: number,
    key: string,
    modifiers?: string[]
  ): Promise<void> {
    const message = await this.sendTool<ActionResultExtensionMessage>({
      cmd: "press-key",
      tabId,
      key,
      modifiers,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "Action failed");
    }
  }

  async dragElement(
    tabId: number,
    fromUid: string,
    toUid: string
  ): Promise<void> {
    const message = await this.sendTool<ActionResultExtensionMessage>({
      cmd: "drag-element",
      tabId,
      fromUid,
      toUid,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "Action failed");
    }
  }

  async resizeWindow(
    tabId: number,
    width: number,
    height: number
  ): Promise<void> {
    const message = await this.sendTool<ActionResultExtensionMessage>({
      cmd: "resize-window",
      tabId,
      width,
      height,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "Action failed");
    }
  }

  async handleDialog(
    tabId: number,
    action: "accept" | "dismiss",
    promptText?: string
  ): Promise<void> {
    const message = await this.sendTool<ActionResultExtensionMessage>({
      cmd: "handle-dialog",
      tabId,
      action,
      promptText,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "handle-dialog failed");
    }
  }

  async emulate(
    tabId: number,
    opts: {
      geolocation?: { latitude: number; longitude: number; accuracy?: number };
      userAgent?: string;
    }
  ): Promise<void> {
    const message = await this.sendTool<ActionResultExtensionMessage>({
      cmd: "emulate",
      tabId,
      geolocation: opts.geolocation,
      userAgent: opts.userAgent,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "emulate failed");
    }
  }

  async evaluateScript(
    tabId: number,
    functionSource: string,
    args?: unknown[],
    world?: "main" | "isolated"
  ): Promise<unknown> {
    const message = await this.sendTool<EvalResultExtensionMessage>({
      cmd: "evaluate-script",
      tabId,
      function: functionSource,
      args,
      world,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "Script evaluation failed");
    }
    return message.value;
  }

  async uploadFile(
    tabId: number,
    uid: string,
    file: { filename: string; mimeType: string; base64: string }
  ): Promise<void> {
    const message = await this.sendTool<ActionResultExtensionMessage>({
      cmd: "upload-file",
      tabId,
      uid,
      filename: file.filename,
      mimeType: file.mimeType,
      base64: file.base64,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "Upload failed");
    }
  }

  async takeScreenshot(
    tabId: number,
    opts: { fullPage?: boolean; uid?: string; format?: "png" | "jpeg" }
  ): Promise<ScreenshotExtensionMessage> {
    return await this.sendTool<ScreenshotExtensionMessage>({
      cmd: "take-screenshot",
      tabId,
      fullPage: opts.fullPage,
      uid: opts.uid,
      format: opts.format,
    });
  }

  async getConsoleMessages(
    tabId: number,
    limit?: number
  ): Promise<ConsoleEntry[]> {
    const message = await this.sendTool<ConsoleMessagesExtensionMessage>({
      cmd: "get-console-messages",
      tabId,
      limit,
    });
    return message.entries;
  }

  async getNetworkRequests(
    tabId: number,
    opts?: { filter?: string; limit?: number; includeBody?: boolean }
  ): Promise<{ requests: NetworkRecord[]; bodyCaptureSupported?: boolean }> {
    const message = await this.sendTool<NetworkRequestsExtensionMessage>({
      cmd: "get-network-requests",
      tabId,
      filter: opts?.filter,
      limit: opts?.limit,
      includeBody: opts?.includeBody,
    });
    return {
      requests: message.requests,
      bodyCaptureSupported: message.bodyCaptureSupported,
    };
  }

  async getCookies(opts: {
    url?: string;
    domain?: string;
    name?: string;
    names?: string[];
  }): Promise<CookiesExtensionMessage> {
    // Reads the browser's cookie jar via the extension background (sees httpOnly
    // cookies document.cookie cannot). Does NOT throw on failure — returns the
    // message so server.ts formats the ok:false case (API unavailable or host
    // permission not granted).
    return await this.sendTool<CookiesExtensionMessage>({
      cmd: "get-cookies",
      ...opts,
    });
  }

  async browserFetch(
    params: Omit<BrowserFetchServerMessage, "cmd">
  ): Promise<BrowserFetchResultExtensionMessage> {
    // A privileged one-shot fetch from the extension background (immune to the
    // page's CSP, uses the browser's real session). Returned unchanged: a non-2xx
    // status is still ok:true; only ok:false (network/permission/timeout/abort)
    // is a failure, and server.ts decides how to present each.
    return await this.sendTool<BrowserFetchResultExtensionMessage>({
      cmd: "browser-fetch",
      ...params,
    });
  }

  async streamStart(
    params: Omit<StreamStartServerMessage, "cmd">
  ): Promise<StreamStartedExtensionMessage> {
    // Opens a streaming/SSE request and resolves once response HEADERS arrive,
    // returning a streamId the caller then drains with streamPoll. Returned
    // as-is (ok:false carries the error).
    return await this.sendTool<StreamStartedExtensionMessage>({
      cmd: "stream-start",
      ...params,
    });
  }

  async streamPoll(
    streamId: string,
    sinceIndex?: number
  ): Promise<StreamFramesExtensionMessage> {
    // Drains buffered frames produced after `sinceIndex` (a cursor). Returned
    // unchanged: frames/nextIndex/done, or ok:false when the streamId is
    // unknown/expired.
    return await this.sendTool<StreamFramesExtensionMessage>({
      cmd: "stream-poll",
      streamId,
      sinceIndex,
    });
  }

  async streamClose(streamId: string): Promise<StreamClosedExtensionMessage> {
    // Aborts the stream and frees its buffer. Idempotent; returns the ack.
    return await this.sendTool<StreamClosedExtensionMessage>({
      cmd: "stream-close",
      streamId,
    });
  }

  async captureResponseBodies(
    tabId: number,
    enabled: boolean
  ): Promise<ResponseBodyCaptureExtensionMessage> {
    // Opt-in deep capture (Chrome/Edge chrome.debugger). Returns the resulting
    // state; server.ts decides how to surface supported/enabled/error.
    return await this.sendTool<ResponseBodyCaptureExtensionMessage>({
      cmd: "capture-response-bodies",
      tabId,
      enabled,
    });
  }

  async listBrowsers(): Promise<BrowserInfo[]> {
    const result = await this.sendControl({ control: "list-browsers" });
    return result.browsers ?? [];
  }

  async selectBrowser(browserId: string): Promise<BrokerControlResult> {
    return await this.sendControl({ control: "select-browser", browserId });
  }
}

function readConfig() {
  return {
    port: process.env.EXTENSION_PORT
      ? parseInt(process.env.EXTENSION_PORT, 10)
      : WS_DEFAULT_PORT,
  };
}
