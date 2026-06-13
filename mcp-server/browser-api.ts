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

import WebSocket from "ws";
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
} from "@foxpilot/common";
import { BrokerClientFrame, BrokerServerFrame } from "./broker-protocol";
import { createSignature, verifySignature } from "./signing";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BrowserAPI {
  private ws: WebSocket | null = null;
  private secret: string | null = null;
  private port: number = WS_DEFAULT_PORT;
  private requestCounter = 0;
  private readonly requestMap = new Map<string, RequestResolver>();

  async init() {
    const { secret, port } = readConfig();
    if (!secret) {
      throw new Error(
        "EXTENSION_SECRET env var missing. See the extension's options page."
      );
    }
    this.secret = secret;
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
    }
    // control-result frames are handled by control-specific waiters (none yet).
  }

  private rejectAllPending(reason: string): void {
    for (const [requestId, resolver] of this.requestMap) {
      clearTimeout(resolver.timer);
      resolver.reject(new Error(reason));
      this.requestMap.delete(requestId);
    }
  }

  private sendTool<T extends ExtensionMessage>(
    message: ServerMessage
  ): Promise<T> {
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
    verbose: boolean
  ): Promise<SnapshotExtensionMessage> {
    return await this.sendTool<SnapshotExtensionMessage>({
      cmd: "take-snapshot",
      tabId,
      verbose,
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
    text: string,
    timeoutMs?: number
  ): Promise<boolean> {
    const message = await this.sendTool<WaitForTextResultExtensionMessage>({
      cmd: "wait-for-text",
      tabId,
      text,
      timeoutMs,
    });
    return message.found;
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
    args?: unknown[]
  ): Promise<unknown> {
    const message = await this.sendTool<EvalResultExtensionMessage>({
      cmd: "evaluate-script",
      tabId,
      function: functionSource,
      args,
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
  ): Promise<NetworkRecord[]> {
    const message = await this.sendTool<NetworkRequestsExtensionMessage>({
      cmd: "get-network-requests",
      tabId,
      filter: opts?.filter,
      limit: opts?.limit,
      includeBody: opts?.includeBody,
    });
    return message.requests;
  }
}

function readConfig() {
  return {
    secret: process.env.EXTENSION_SECRET,
    port: process.env.EXTENSION_PORT
      ? parseInt(process.env.EXTENSION_PORT, 10)
      : WS_DEFAULT_PORT,
  };
}
