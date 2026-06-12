import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import { BrowserAPI } from "./browser-api";
import { readFileForUpload } from "./file-upload";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

const mcpServer = new McpServer({
  name: "BrowserControl",
  version: "1.5.1",
});

mcpServer.tool(
  "open-browser-tab",
  "Open a new tab in the user's browser (useful when the user asks to open a website)",
  { url: z.string() },
  async ({ url }) => {
    const openedTabId = await browserApi.openTab(url);
    if (openedTabId !== undefined) {
      return {
        content: [
          {
            type: "text",
            text: `${url} opened in tab id ${openedTabId}`,
          },
        ],
      };
    } else {
      return {
        content: [{ type: "text", text: "Failed to open tab", isError: true }],
      };
    }
  }
);

mcpServer.tool(
  "close-browser-tabs",
  "Close tabs in the user's browser by tab IDs",
  { tabIds: z.array(z.number()) },
  async ({ tabIds }) => {
    await browserApi.closeTabs(tabIds);
    return {
      content: [{ type: "text", text: "Closed tabs" }],
    };
  }
);

mcpServer.tool(
  "get-list-of-open-tabs",
  "Get the list of open tabs in the user's browser. Use offset and limit parameters for pagination when there are many tabs.",
  {
    offset: z.number().int().min(0).default(0).describe("Starting index for pagination (0-based, must be >= 0)"),
    limit: z.number().default(100).describe("Maximum number of tabs to return (default: 100, max: 500)"),
  },
  async ({ offset, limit }) => {
    // Validate and cap the limit
    const effectiveLimit = Math.min(Math.max(1, limit), 500);

    const openTabs = await browserApi.getTabList();
    const totalTabs = openTabs.length;

    // Apply pagination
    const paginatedTabs = openTabs.slice(offset, offset + effectiveLimit);
    const hasMore = offset + effectiveLimit < totalTabs;

    // Add pagination info as the first content item
    const paginationInfo = {
      type: "text" as const,
      text: `Showing tabs ${offset + 1}-${offset + paginatedTabs.length} of ${totalTabs} total tabs${hasMore ? ` (use offset=${offset + effectiveLimit} to see more)` : ''}`,
    };

    const tabContent = paginatedTabs.map((tab) => {
      let lastAccessed = "unknown";
      if (tab.lastAccessed) {
        lastAccessed = dayjs(tab.lastAccessed).fromNow(); // LLM-friendly time ago
      }
      return {
        type: "text" as const,
        text: `tab id=${tab.id}, tab url=${tab.url}, tab title=${tab.title}, last accessed=${lastAccessed}`,
      };
    });

    return {
      content: [paginationInfo, ...tabContent],
    };
  }
);

mcpServer.tool(
  "get-recent-browser-history",
  "Get the list of recent browser history (to get all, don't use searchQuery)",
  { searchQuery: z.string().optional() },
  async ({ searchQuery }) => {
    const browserHistory = await browserApi.getBrowserRecentHistory(
      searchQuery
    );
    if (browserHistory.length > 0) {
      return {
        content: browserHistory.map((item) => {
          let lastVisited = "unknown";
          if (item.lastVisitTime) {
            lastVisited = dayjs(item.lastVisitTime).fromNow(); // LLM-friendly time ago
          }
          return {
            type: "text",
            text: `url=${item.url}, title="${item.title}", lastVisitTime=${lastVisited}`,
          };
        }),
      };
    } else {
      // If nothing was found for the search query, hint the AI to list
      // all the recent history items instead.
      const hint = searchQuery ? "Try without a searchQuery" : "";
      return { content: [{ type: "text", text: `No history found. ${hint}` }] };
    }
  }
);

mcpServer.tool(
  "get-tab-web-content",
  `
    Get the full text content of the webpage and the list of links in the webpage, by tab ID. 
    Use "offset" only for larger documents when the first call was truncated and if you require more content in order to assist the user.
  `,
  { tabId: z.number(), offset: z.number().default(0) },
  async ({ tabId, offset }) => {
    const content = await browserApi.getTabContent(tabId, offset);
    let links: { type: "text"; text: string }[] = [];
    if (offset === 0) {
      // Only include the links if offset is 0 (default value). Otherwise, we can
      // assume this is not the first call. Adding the links again would be redundant.
      links = content.links.map((link: { text: string; url: string }) => {
        return {
          type: "text",

          text: `Link text: ${link.text}, Link URL: ${link.url}`,
        };
      });
    }

    let text = content.fullText;
    let hint: { type: "text"; text: string }[] = [];
    if (content.isTruncated || offset > 0) {
      // If the content is truncated, add a "tip" suggesting
      // that another tool, search in page, can be used to
      // discover additional data.
      const rangeString = `${offset}-${offset + text.length}`;
      hint = [
        {
          type: "text",
          text:
            `The following text content is truncated due to size (includes character range ${rangeString} out of ${content.totalLength}). ` +
            "If you want to read characters beyond this range, please use the 'get-tab-web-content' tool with an offset. ",
        },
      ];
    }

    return {
      content: [...hint, { type: "text", text }, ...links],
    };
  }
);

mcpServer.tool(
  "reorder-browser-tabs",
  "Change the order of open browser tabs",
  { tabOrder: z.array(z.number()) },
  async ({ tabOrder }) => {
    const newOrder = await browserApi.reorderTabs(tabOrder);
    return {
      content: [
        { type: "text", text: `Tabs reordered: ${newOrder.join(", ")}` },
      ],
    };
  }
);

mcpServer.tool(
  "find-highlight-in-browser-tab",
  "Find and highlight text in a browser tab (use a query phrase that exists in the web content)",
  { tabId: z.number(), queryPhrase: z.string() },
  async ({ tabId, queryPhrase }) => {
    const noOfResults = await browserApi.findHighlight(tabId, queryPhrase);
    return {
      content: [
        {
          type: "text",
          text: `Number of results found and highlighted in the tab: ${noOfResults}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "take-snapshot",
  "Take an accessibility snapshot of a browser tab's page. Returns a list of interactive elements, each tagged with a stable uid (e.g. [uid=e12]). Use these uids with the click/fill/hover tools to act on elements. Re-take a snapshot after the page changes, as uids are reassigned each time.",
  { tabId: z.number(), verbose: z.boolean().optional() },
  async ({ tabId, verbose }) => {
    const result = await browserApi.takeSnapshot(tabId, verbose ?? false);
    const hint = result.isTruncated ? "[snapshot truncated due to size]\n" : "";
    return { content: [{ type: "text", text: hint + result.snapshot }] };
  }
);

mcpServer.tool(
  "navigate-tab",
  "Load a URL in an existing browser tab. The URL must be https, or http only for localhost.",
  { tabId: z.number(), url: z.string() },
  async ({ tabId, url }) => {
    const result = await browserApi.navigateTab(tabId, url);
    return {
      content: [
        {
          type: "text",
          text: `Navigated tab ${result.tabId} to ${result.url ?? url}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "navigate-page-history",
  "Navigate a browser tab's history: go back, go forward, or reload the page.",
  {
    tabId: z.number(),
    direction: z.enum(["back", "forward", "reload"]),
    bypassCache: z.boolean().optional(),
  },
  async ({ tabId, direction, bypassCache }) => {
    await browserApi.navigatePageHistory(tabId, direction, bypassCache);
    return {
      content: [
        {
          type: "text",
          text: `Navigated tab ${tabId} (${direction})`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "select-tab",
  "Focus/activate a browser tab and bring its window to the foreground.",
  { tabId: z.number() },
  async ({ tabId }) => {
    const result = await browserApi.selectTab(tabId);
    return {
      content: [{ type: "text", text: `Selected tab ${result.tabId}` }],
    };
  }
);

mcpServer.tool(
  "get-active-tab",
  "Get the currently active tab in the user's browser.",
  {},
  async () => {
    const tab = await browserApi.getActiveTab();
    if (!tab) {
      return { content: [{ type: "text", text: "No active tab" }] };
    }
    return {
      content: [
        {
          type: "text",
          text: `Active tab id=${tab.id}, url=${tab.url}, title=${tab.title}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "wait-for-text",
  "Wait until the given text appears on a tab's page, polling until found or the timeout elapses (default 30000ms).",
  { tabId: z.number(), text: z.string(), timeoutMs: z.number().optional() },
  async ({ tabId, text, timeoutMs }) => {
    const found = await browserApi.waitForText(tabId, text, timeoutMs);
    if (found) {
      return { content: [{ type: "text", text: "Text found" }] };
    }
    return {
      content: [
        {
          type: "text",
          text: `Text did not appear within ${timeoutMs ?? 30000}ms`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "click-element",
  "Click an element on a page. Pass a 'uid' from a recent take-snapshot (e.g. e12). Set doubleClick to fire a double-click. If the uid is stale, this returns an error asking you to take a fresh snapshot.",
  { tabId: z.number(), uid: z.string(), doubleClick: z.boolean().optional() },
  async ({ tabId, uid, doubleClick }) => {
    await browserApi.clickElement(tabId, uid, doubleClick);
    return {
      content: [
        {
          type: "text",
          text: `${doubleClick ? "Double-clicked" : "Clicked"} element ${uid}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "hover-element",
  "Hover the mouse over an element on a page (useful to reveal menus/tooltips). Pass a 'uid' from a recent take-snapshot (e.g. e12).",
  { tabId: z.number(), uid: z.string() },
  async ({ tabId, uid }) => {
    await browserApi.hoverElement(tabId, uid);
    return {
      content: [{ type: "text", text: `Hovered element ${uid}` }],
    };
  }
);

mcpServer.tool(
  "fill-element",
  "Set the value of a form field (text input, textarea, <select>, checkbox, or radio) on a page. Pass a 'uid' from a recent take-snapshot (e.g. e12) and the value. For checkboxes/radios, use \"true\"/\"false\". For <select>, use the option's value.",
  { tabId: z.number(), uid: z.string(), value: z.string() },
  async ({ tabId, uid, value }) => {
    await browserApi.fillElement(tabId, uid, value);
    return {
      content: [{ type: "text", text: `Filled element ${uid}` }],
    };
  }
);

mcpServer.tool(
  "fill-form",
  "Fill multiple form fields in one step. Provide an array of { uid, value } pairs, each uid taken from a recent take-snapshot. Filling stops at the first uid that cannot be resolved and reports it.",
  {
    tabId: z.number(),
    fields: z.array(z.object({ uid: z.string(), value: z.string() })),
  },
  async ({ tabId, fields }) => {
    await browserApi.fillForm(tabId, fields);
    return {
      content: [
        {
          type: "text",
          text: `Filled ${fields.length} field(s): ${fields
            .map((f) => f.uid)
            .join(", ")}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "type-text",
  "Type text into the currently focused element on a page (click or fill an input first to focus it). Set submit to also press Enter and submit the enclosing form. Fails if no input/textarea is focused.",
  { tabId: z.number(), text: z.string(), submit: z.boolean().optional() },
  async ({ tabId, text, submit }) => {
    await browserApi.typeText(tabId, text, submit);
    return {
      content: [
        {
          type: "text",
          text: submit ? `Typed text and submitted` : `Typed text`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "press-key",
  "Press a keyboard key on a page (e.g. 'Enter', 'Escape', 'ArrowDown', 'a'). Optionally hold modifiers (ctrl, shift, alt, meta). Targets the focused element, or the page body if nothing is focused.",
  {
    tabId: z.number(),
    key: z.string(),
    modifiers: z.array(z.enum(["ctrl", "shift", "alt", "meta"])).optional(),
  },
  async ({ tabId, key, modifiers }) => {
    await browserApi.pressKey(tabId, key, modifiers);
    const mods = modifiers && modifiers.length ? `${modifiers.join("+")}+` : "";
    return {
      content: [{ type: "text", text: `Pressed ${mods}${key}` }],
    };
  }
);

mcpServer.tool(
  "drag-element",
  "Drag one element onto another on a page (HTML5 drag-and-drop or sortable lists). Pass 'fromUid' (the element to drag) and 'toUid' (the drop target), both uids from a recent take-snapshot (e.g. e12). Note: drag-and-drop is simulated with synthetic events and is best-effort — some sites that require native/trusted drag events may not respond. If a uid is stale, this returns an error asking you to take a fresh snapshot.",
  { tabId: z.number(), fromUid: z.string(), toUid: z.string() },
  async ({ tabId, fromUid, toUid }) => {
    await browserApi.dragElement(tabId, fromUid, toUid);
    return {
      content: [
        {
          type: "text",
          text: `Dragged element ${fromUid} onto ${toUid}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "resize-window",
  "Resize the browser window that hosts a tab. Pass the tabId and the desired width and height in pixels. Note: this resizes the whole browser window (chrome included), not just the page viewport.",
  { tabId: z.number(), width: z.number(), height: z.number() },
  async ({ tabId, width, height }) => {
    await browserApi.resizeWindow(tabId, width, height);
    return {
      content: [
        {
          type: "text",
          text: `Resized window of tab ${tabId} to ${width}x${height}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "handle-dialog",
  "Arm a tab so that FUTURE native JavaScript dialogs (alert, confirm, prompt) are automatically handled without blocking. Set action to 'accept' (confirm returns true, prompt returns promptText or an empty string) or 'dismiss' (confirm returns false, prompt returns null); alert is suppressed either way. Call this BEFORE the action that triggers the dialog. Note: this cannot dismiss a dialog that is already open (a native dialog freezes the page's script until the user closes it), and the override is reset when the page navigates — re-arm after navigation.",
  {
    tabId: z.number(),
    action: z.enum(["accept", "dismiss"]),
    promptText: z.string().optional(),
  },
  async ({ tabId, action, promptText }) => {
    await browserApi.handleDialog(tabId, action, promptText);
    return {
      content: [
        {
          type: "text",
          text: `Armed tab ${tabId} to ${action} future dialogs`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "emulate",
  "Emulate device conditions for a tab. Provide 'geolocation' ({ latitude, longitude, accuracy? }) to make the page's geolocation API report those coordinates, and/or 'userAgent' to override the user agent (this changes both what the page reads via navigator.userAgent AND the User-Agent header sent on the tab's outgoing requests). Overrides apply to navigations/requests made after this call and are reset when the page navigates (re-apply afterwards). Only geolocation and userAgent are supported — CPU throttling, network conditions, and color-scheme emulation are NOT feasible from a Firefox extension and are not available.",
  {
    tabId: z.number(),
    geolocation: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        accuracy: z.number().optional(),
      })
      .optional(),
    userAgent: z.string().optional(),
  },
  async ({ tabId, geolocation, userAgent }) => {
    await browserApi.emulate(tabId, { geolocation, userAgent });
    const parts: string[] = [];
    if (geolocation) {
      parts.push(
        `geolocation=(${geolocation.latitude}, ${geolocation.longitude})`
      );
    }
    if (userAgent !== undefined) {
      parts.push(`userAgent="${userAgent}"`);
    }
    const what = parts.length ? parts.join(", ") : "nothing (no options given)";
    return {
      content: [{ type: "text", text: `Emulating on tab ${tabId}: ${what}` }],
    };
  }
);

mcpServer.tool(
  "evaluate-script",
  'Evaluate a JavaScript function in the page\'s real world and return its result. Pass "function" as a function EXPRESSION string, e.g. "() => document.title" or "(sel) => document.querySelector(sel)?.textContent". The function runs in the page context (it can see the page\'s window, frameworks, and DOM), is awaited if it returns a promise, and its result is JSON-serialized back to you. Pass "args" to forward arguments to the function. Note: pages with a strict Content-Security-Policy may block injected scripts; if so this times out with a CSP error.',
  { tabId: z.number(), function: z.string(), args: z.array(z.any()).optional() },
  async ({ tabId, function: functionSource, args }) => {
    const value = await browserApi.evaluateScript(tabId, functionSource, args);
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
    };
  }
);

mcpServer.tool(
  "upload-file",
  "Upload a local file into a file <input> on a page. Pass the 'uid' of the file input from a recent take-snapshot and the absolute 'filePath' of the file on the machine running the MCP server. The server reads the file itself and injects it into the input (browsers forbid setting a file input's path from script, so this is the reliable way). Works for arbitrary local paths. Max file size 25 MB.",
  { tabId: z.number(), uid: z.string(), filePath: z.string() },
  async ({ tabId, uid, filePath }) => {
    try {
      // The server reads the file off disk and ships the bytes (base64) to the
      // extension; the extension never sees a filesystem path.
      const file = readFileForUpload(filePath);
      await browserApi.uploadFile(tabId, uid, file);
      return {
        content: [
          { type: "text", text: `Uploaded ${file.filename} to element ${uid}` },
        ],
      };
    } catch (err) {
      // Missing/too-large file or a failed in-page upload — surface a clear,
      // non-throwing error content item so the model can recover (e.g. fix the
      // path or take a fresh snapshot for a stale uid).
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Upload failed: ${message}` }],
        isError: true,
      };
    }
  }
);

mcpServer.tool(
  "take-screenshot",
  "Take a screenshot of a browser tab and return it as an image. By default captures the visible viewport. Set fullPage to true to capture the entire scrollable page (stitched together). Pass a 'uid' from a recent take-snapshot to capture just that element (cropped). Choose 'png' (default, lossless) or 'jpeg' (smaller) for the format. Provide an absolute filePath to also save the image to disk on the machine running the MCP server.",
  {
    tabId: z.number(),
    fullPage: z.boolean().optional(),
    uid: z.string().optional(),
    format: z.enum(["png", "jpeg"]).optional(),
    filePath: z.string().optional(),
  },
  async ({ tabId, fullPage, uid, format, filePath }) => {
    const result = await browserApi.takeScreenshot(tabId, {
      fullPage,
      uid,
      format,
    });

    const content: (
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    )[] = [];

    if (filePath) {
      // Persist the image to disk on the server host, then tell the model where.
      fs.writeFileSync(filePath, Buffer.from(result.base64, "base64"));
      content.push({
        type: "text",
        text: `Screenshot saved to ${filePath}`,
      });
    }

    // Always return the image itself as MCP image content.
    content.push({
      type: "image",
      data: result.base64,
      mimeType: result.mimeType,
    });

    return { content };
  }
);

mcpServer.tool(
  "get-console-messages",
  "Get the console output (console.log/info/warn/error/debug) and uncaught errors captured for a browser tab. Requires Automation Mode, and only captures pages loaded AFTER Automation Mode was enabled (reload the page if you see nothing). Pass an optional 'limit' to return only the most recent N entries.",
  { tabId: z.number(), limit: z.number().optional() },
  async ({ tabId, limit }) => {
    const entries = await browserApi.getConsoleMessages(tabId, limit);
    if (entries.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No console messages captured (Automation Mode must be on before the page loads).",
          },
        ],
      };
    }
    return {
      content: entries.map((entry) => ({
        type: "text",
        text: `[${entry.level}] ${entry.text}`,
      })),
    };
  }
);

mcpServer.tool(
  "get-network-requests",
  "Get the network requests captured for a browser tab (URL, method, status, resource type, timing, sizes). Requires Automation Mode, and only captures requests made AFTER Automation Mode was enabled (reload the page if you see nothing). Pass 'filter' to keep only requests whose URL contains it (case-insensitive) or whose resource type matches it exactly, 'limit' to return only the most recent N, and 'includeBody' to enable best-effort response-body snippets for FUTURE requests (Firefox-specific).",
  {
    tabId: z.number(),
    filter: z.string().optional(),
    limit: z.number().optional(),
    includeBody: z.boolean().optional(),
  },
  async ({ tabId, filter, limit, includeBody }) => {
    const requests = await browserApi.getNetworkRequests(tabId, {
      filter,
      limit,
      includeBody,
    });
    if (requests.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No network requests captured (Automation Mode must be on before the activity).",
          },
        ],
      };
    }
    return {
      content: requests.map((req) => {
        const status = req.error
          ? `ERR ${req.error}`
          : req.statusCode !== undefined
          ? String(req.statusCode)
          : "?";
        const duration =
          req.durationMs !== undefined ? `, ${req.durationMs} ms` : "";
        let text = `${req.method} ${req.url} -> ${status} (${req.type}${duration})`;
        if (req.body) {
          // Keep the snippet bounded in the text output.
          const snippet =
            req.body.length > 2000 ? `${req.body.slice(0, 2000)}…` : req.body;
          text += `\n  body: ${snippet}`;
        }
        return { type: "text", text };
      }),
    };
  }
);

mcpServer.tool(
  "group-browser-tabs",
  "Organize opened browser tabs in a new tab group",
  {
    tabIds: z.array(z.number()),
    isCollapsed: z.boolean().default(false),
    groupColor: z
      .enum([
        "grey",
        "blue",
        "red",
        "yellow",
        "green",
        "pink",
        "purple",
        "cyan",
        "orange",
      ])
      .default("grey"),
    groupTitle: z.string().default("New Group"),
  },
  async ({ tabIds, isCollapsed, groupColor, groupTitle }) => {
    const groupId = await browserApi.groupTabs(
      tabIds,
      isCollapsed,
      groupColor,
      groupTitle
    );
    return {
      content: [
        {
          type: "text",
          text: `Created tab group "${groupTitle}" with ${tabIds.length} tabs (group ID: ${groupId})`,
        },
      ],
    };
  }
);

const browserApi = new BrowserAPI();
browserApi.init().catch((err) => {
  console.error("Browser API init error", err);
  process.exit(1);
});

const transport = new StdioServerTransport();
mcpServer.connect(transport).catch((err) => {
  console.error("MCP Server connection error", err);
  process.exit(1);
});

process.stdin.on("close", () => {
  browserApi.close();
  mcpServer.close();
  process.exit(0);
});
