import type { ServerMessageRequest } from "@browser-control-mcp/common";
import { ExtensionTransport } from "./transport";
import { isCommandAllowed, isDomainInDenyList, COMMAND_TO_TOOL_ID, addAuditLogEntry, requiresAutomationMode, isAutomationModeEnabled } from "./extension-config";
import { buildSnapshot } from "./injected/snapshot-script";
import { performInputAction } from "./injected/action-script";

// The argument shape accepted by the injected `performInputAction` function.
type InputActionArgs = Parameters<typeof performInputAction>[1];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns whether a URL is allowed for in-tab navigation: https:// always, and
 * http:// only for localhost / 127.0.0.1 hosts (convenient for local dev).
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
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  }
  return false;
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
