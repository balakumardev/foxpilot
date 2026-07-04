import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import { BrowserAPI } from "./browser-api";
import { readFileForUpload } from "./file-upload";
import { formatPointResult } from "./point-format";
import { formatNetworkHeaders } from "./network-format";
import { formatSnapshotResult } from "./snapshot-format";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

const mcpServer = new McpServer({
  name: "FoxPilot",
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
  "Take an accessibility snapshot of a browser tab's page. Returns interactive elements each tagged with a uid (e.g. [uid=e12]) for the uid-based tools (click-element / fill-element / hover-element / etc.). IMPORTANT: a [uid=eN] is only valid until the NEXT take-snapshot on the same tab — snapshot, then act on its uids before snapshotting again; a second snapshot reassigns every uid, so a uid from an earlier snapshot will resolve to the wrong element or fail. By default it now also captures visually-clickable elements (cursor:pointer, e.g. React <div onClick> cards) — set includePointer:false to suppress that, or maxInteractive to cap how many are added. Query modes: 'selector' returns exactly the CSS-selector matches (even non-interactive, e.g. selector:'[contenteditable]' for a chat box); 'textContains' returns the deepest elements whose visible text contains the string (case-insensitive). Scope with 'rootSelector' to collect only within one subtree (e.g. the main panel, excluding a huge sidebar), and page large results with 'offset'/'limit' (the reply reports total collected and whether more remain). verbose:true additionally includes headings and aria-labelled elements.",
  {
    tabId: z.number(),
    verbose: z.boolean().optional(),
    includePointer: z.boolean().optional(),
    maxInteractive: z.number().optional(),
    selector: z.string().optional(),
    textContains: z.string().optional(),
    rootSelector: z.string().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  },
  async ({
    tabId,
    verbose,
    includePointer,
    maxInteractive,
    selector,
    textContains,
    rootSelector,
    offset,
    limit,
  }) => {
    const result = await browserApi.takeSnapshot(tabId, {
      verbose,
      includePointer,
      maxInteractive,
      selector,
      textContains,
      rootSelector,
      offset,
      limit,
    });
    // A compact element-count line is ALWAYS prepended (via formatSnapshotResult)
    // so a cold agent immediately knows the page size and when to scope; the
    // truncation / more-available hints fold into that one line. See
    // snapshot-format.ts (extracted so the composed text is unit-testable).
    return formatSnapshotResult(result);
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
  "list-browsers",
  "List the browser extensions currently connected to the FoxPilot broker (Chrome and/or Firefox) and which one is the active driver. Use this when more than one browser is connected and a tool fails asking you to choose; then call select-browser with the browserId you want.",
  {},
  async () => {
    const browsers = await browserApi.listBrowsers();
    if (browsers.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No browsers connected. Open Chrome or Firefox with the FoxPilot extension installed and connected (same secret).",
          },
        ],
      };
    }
    return {
      content: browsers.map((b) => ({
        type: "text",
        text: `${b.label} (${b.type}) id=${b.browserId}${
          b.active ? " [active]" : ""
        }${b.connected ? "" : " [disconnected]"}`,
      })),
    };
  }
);

mcpServer.tool(
  "select-browser",
  "Choose which connected browser is the single active driver for all subsequent tools. Pass the browserId from list-browsers. Required when two or more browsers are connected; with only one connected it is implicitly active.",
  { browserId: z.string() },
  async ({ browserId }) => {
    const result = await browserApi.selectBrowser(browserId);
    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: `Could not select browser: ${result.error ?? "unknown error"}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Active browser is now ${result.activeBrowserId}.`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "wait-for-text",
  "Wait until text appears on a tab's page, polling until found or the timeout elapses (default 30000ms). 'text' may be a single string OR an array of strings — with an array it resolves as soon as ANY of them appears and reports which one matched.",
  {
    tabId: z.number(),
    text: z.union([z.string(), z.array(z.string()).nonempty()]),
    timeoutMs: z.number().optional(),
  },
  async ({ tabId, text, timeoutMs }) => {
    const { found, matched } = await browserApi.waitForText(
      tabId,
      text,
      timeoutMs
    );
    if (found) {
      const which =
        Array.isArray(text) && matched !== undefined
          ? ` (matched "${matched}")`
          : "";
      return { content: [{ type: "text", text: `Text found${which}` }] };
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
  'Evaluate a JavaScript function in a browser tab and return its result. Pass "function" as a function EXPRESSION string, e.g. "() => document.title" or "(sel) => document.querySelector(sel)?.textContent". By default (world:"main") it runs in the page\'s real world (sees the page\'s window/frameworks/DOM, is awaited if it returns a promise) — but a page with a strict Content-Security-Policy can block it. Set world:"isolated" to run in the extension\'s isolated content-script world instead: CSP-immune, can read the DOM, element rects, and non-httpOnly document.cookie, but CANNOT see the page\'s own JS globals/framework state and runs SYNCHRONOUSLY (a returned Promise is not awaited). Browser support for world:"isolated" is asymmetric: Firefox runs it fully (the source is compiled, so it is genuinely CSP-immune), but on Chrome MV3 the isolated-world CSP blocks arbitrary-source eval, so it honestly degrades to a clear ok:false — on Chrome use world:"main", or read state with the CSP-immune snapshot/screenshot/coordinate tools instead. Pass "args" to forward arguments to the function.',
  {
    tabId: z.number(),
    function: z.string(),
    args: z.array(z.any()).optional(),
    world: z.enum(["main", "isolated"]).optional(),
  },
  async ({ tabId, function: functionSource, args, world }) => {
    const value = await browserApi.evaluateScript(
      tabId,
      functionSource,
      args,
      world
    );
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
    };
  }
);

// formatPointResult lives in ./point-format (a pure, importable module) so it
// can be unit-tested without importing this self-executing server entrypoint.

mcpServer.tool(
  "click-at",
  "Click at viewport pixel coordinates {x,y} (origin = top-left of the visible viewport, as used by document.elementFromPoint). Coordinates are CSS pixels — if you read them off a take-screenshot, that image is CSS-px × devicePixelRatio (typically 2 on Retina/HiDPI), so divide the screenshot pixel coordinates by the DPR first; then use the returned element descriptor to confirm you hit the intended element and re-aim if not. Reach for this when take-snapshot did NOT surface a clickable element (e.g. a custom-React <div onClick> with no role/tabindex) but you can see where it is — e.g. from take-screenshot. Runs covertly in the isolated world (no automation banner, no debugger) by default. Set engine:\"cdp\" (Chrome/Edge only) to dispatch a TRUSTED (isTrusted:true) click via the debugger instead — reach for it only when the default click is ignored by a strict handler; it shows a 'started debugging this browser' banner (detectable) and errors on Firefox. Set doubleClick for a double-click, or button to 'middle'/'right'. Returns a descriptor of the element that was under the point (or an error if the point hit nothing).",
  {
    tabId: z.number(),
    x: z.number(),
    y: z.number(),
    doubleClick: z.boolean().optional(),
    button: z.enum(["left", "middle", "right"]).optional(),
    engine: z.enum(["synthetic", "cdp"]).optional(),
  },
  async ({ tabId, x, y, doubleClick, button, engine }) => {
    const result = await browserApi.clickAt(tabId, x, y, { doubleClick, button, engine });
    return formatPointResult("Clicked", tabId, x, y, result);
  }
);

mcpServer.tool(
  "type-at",
  "Type text into the element at viewport pixel coordinates {x,y}. Coordinates are CSS pixels — if you read them off a take-screenshot, that image is CSS-px × devicePixelRatio (typically 2 on Retina/HiDPI), so divide the screenshot pixel coordinates by the DPR first; the returned element descriptor reports what was actually under the point, so use it to confirm you targeted the intended field and re-aim if not. Clicks the point to focus it first, then types — works for <input>/<textarea> AND custom <div contenteditable> chat inputs that take-snapshot may not expose as textboxes. Set submit:true to press Enter afterward (and submit the form if there is one). Runs covertly (synthetic) by default. Set engine:\"cdp\" (Chrome/Edge only) to type via TRUSTED events through the debugger — this is the reliable path for strict rich-text editors (Lexical/ProseMirror/Slate) that ignore synthetic keystrokes; it shows a debugging banner and errors on Firefox. Returns a descriptor of the element that was typed into.",
  {
    tabId: z.number(),
    x: z.number(),
    y: z.number(),
    text: z.string(),
    submit: z.boolean().optional(),
    engine: z.enum(["synthetic", "cdp"]).optional(),
  },
  async ({ tabId, x, y, text, submit, engine }) => {
    const result = await browserApi.typeAt(tabId, x, y, text, submit, engine);
    return formatPointResult("Typed", tabId, x, y, result);
  }
);

mcpServer.tool(
  "hover-at",
  "Hover at viewport pixel coordinates {x,y} to reveal hover-triggered UI (dropdown menus, tooltips) before a follow-up snapshot/click. Coordinates are CSS pixels — if you read them off a take-screenshot, that image is CSS-px × devicePixelRatio (typically 2 on Retina/HiDPI), so divide the screenshot pixel coordinates by the DPR first; use the returned element descriptor to confirm you hovered the intended element and re-aim if not. Runs covertly in the isolated world via synthetic pointer events by default (fires the page's JS mouseover/mouseenter listeners, which open most such menus, but does NOT activate CSS :hover styling). Set engine:\"cdp\" (Chrome/Edge only) to move a TRUSTED pointer via the debugger (shows a banner; errors on Firefox). Returns a descriptor of the element under the point.",
  {
    tabId: z.number(),
    x: z.number(),
    y: z.number(),
    engine: z.enum(["synthetic", "cdp"]).optional(),
  },
  async ({ tabId, x, y, engine }) => {
    const result = await browserApi.hoverAt(tabId, x, y, engine);
    return formatPointResult("Hovered", tabId, x, y, result);
  }
);

mcpServer.tool(
  "scroll-at",
  "Scroll the NEAREST SCROLLABLE CONTAINER under viewport pixel coordinates {x,y} by (dx, dy) pixels — this scrolls an inner panel (e.g. a chat message list) rather than the whole window, which press-key PageUp cannot do. Coordinates are CSS pixels — if you read them off a take-screenshot, that image is CSS-px × devicePixelRatio (typically 2 on Retina/HiDPI), so divide the screenshot pixel coordinates by the DPR first; the returned descriptor reports which container was scrolled, so use it to confirm you targeted the intended panel and re-aim if not. Omit dx/dy to scroll one container-viewport down. Falls back to the window when nothing under the point scrolls. Runs covertly (synthetic) by default. Set engine:\"cdp\" (Chrome/Edge only) to dispatch a TRUSTED wheel event via the debugger for sites that honor real wheel events exclusively (shows a banner; errors on Firefox). Returns a descriptor of the container that was scrolled.",
  {
    tabId: z.number(),
    x: z.number(),
    y: z.number(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    engine: z.enum(["synthetic", "cdp"]).optional(),
  },
  async ({ tabId, x, y, dx, dy, engine }) => {
    const result = await browserApi.scrollAt(tabId, x, y, { dx, dy, engine });
    return formatPointResult("Scrolled", tabId, x, y, result);
  }
);

mcpServer.tool(
  "scroll-to",
  "Scroll the page to absolute coordinates via window.scrollTo(x, y). Omit x or y to leave that axis unchanged. Useful to position content before a viewport screenshot.",
  { tabId: z.number(), x: z.number().optional(), y: z.number().optional() },
  async ({ tabId, x, y }) => {
    const result = await browserApi.scrollTo(tabId, x, y);
    if (!result.ok) {
      return {
        content: [
          { type: "text", text: `scroll-to failed: ${result.error ?? "unknown error"}` },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Scrolled tab ${tabId} to (${x ?? "*"}, ${y ?? "*"})`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "scroll-into-view",
  "Scroll the element with the given snapshot uid into view (centered). Take a fresh take-snapshot first to get a current uid (uids are reassigned each snapshot).",
  { tabId: z.number(), uid: z.string() },
  async ({ tabId, uid }) => {
    const result = await browserApi.scrollIntoView(tabId, uid);
    if (!result.ok) {
      return {
        content: [
          { type: "text", text: `scroll-into-view failed: ${result.error ?? "unknown error"}` },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: "text", text: `Scrolled element ${uid} into view on tab ${tabId}` },
      ],
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

    // Surface a fallback warning (e.g. the full-page stitch failed and a single
    // viewport capture was returned instead) so the model knows the image is not
    // the full page it asked for.
    if (result.warning) {
      content.push({ type: "text", text: `Warning: ${result.warning}` });
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
  "Get the network requests captured for a browser tab (URL, method, status, resource type, timing, size). Requires Automation Mode, and only captures requests made AFTER Automation Mode was enabled (reload the page if you see nothing). Pass 'filter' to keep only requests whose URL contains it (case-insensitive) or whose resource type matches it exactly, 'limit' to return only the most recent N, 'includeHeaders' to also print each request's captured request/response headers (credential-bearing values — Cookie/Authorization/Set-Cookie — are redacted by default), 'includeCredentials' to print those credential values UN-REDACTED (has an effect ONLY together with includeHeaders:true — it un-redacts the header values that includeHeaders prints, so headers must be shown for it to do anything; WARNING: this exposes real session cookies/tokens in the tool output — use it only when you must replay the app's own authenticated calls, and never log the values), and 'includeBody' to request best-effort response-body snippets for FUTURE requests (browser-dependent: captured on Firefox; Chrome MV3 cannot capture bodies via webRequest and returns metadata only).",
  {
    tabId: z.number(),
    filter: z.string().optional(),
    limit: z.number().optional(),
    includeHeaders: z.boolean().optional(),
    includeCredentials: z.boolean().optional(),
    includeBody: z.boolean().optional(),
  },
  async ({ tabId, filter, limit, includeHeaders, includeCredentials, includeBody }) => {
    const { requests, bodyCaptureSupported } =
      await browserApi.getNetworkRequests(tabId, {
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
    const content = requests.map((req) => {
      const status = req.error
        ? `ERR ${req.error}`
        : req.statusCode !== undefined
        ? String(req.statusCode)
        : "?";
      const duration =
        req.durationMs !== undefined ? `, ${req.durationMs} ms` : "";
      const size =
        req.responseSize !== undefined ? `, ${req.responseSize} B` : "";
      let text = `${req.method} ${req.url} -> ${status} (${req.type}${duration}${size})`;
      if (includeHeaders) {
        text += formatNetworkHeaders(
          "request headers",
          req.requestHeaders,
          !!includeCredentials
        );
        text += formatNetworkHeaders(
          "response headers",
          req.responseHeaders,
          !!includeCredentials
        );
      }
      if (req.requestBody) {
        // Request bodies are arbitrary (may contain form credentials); truncate
        // and pass through verbatim rather than pretty-printing.
        const snippet =
          req.requestBody.length > 2000
            ? `${req.requestBody.slice(0, 2000)}…`
            : req.requestBody;
        text += `\n    request body: ${snippet}`;
      }
      if (req.body) {
        // Keep the snippet bounded in the text output.
        const snippet =
          req.body.length > 2000 ? `${req.body.slice(0, 2000)}…` : req.body;
        text += `\n    response body: ${snippet}`;
      }
      return { type: "text" as const, text };
    });
    // Only the Chrome MV3 extension sets bodyCaptureSupported (to false); the
    // Firefox extension leaves it undefined (it does capture bodies). Surface the
    // limitation only when bodies were requested AND the browser cannot capture
    // them, so the agent knows metadata-only is expected, not a failure.
    if (includeBody && bodyCaptureSupported === false) {
      content.push({
        type: "text" as const,
        text: "Note: the connected browser (Chrome MV3) cannot capture response bodies; returning request metadata only.",
      });
    }
    return { content };
  }
);

mcpServer.tool(
  "get-cookies",
  "Read the browser's cookie jar INCLUDING httpOnly cookies (which document.cookie cannot see). Runs in the extension background, so the visited page's CSP does not apply. Narrow with 'url', 'domain', a single 'name', and/or 'names' (an array of cookie names — the union is returned); omit all to return every cookie the extension is permitted to see. Requires the user to enable Automation Mode and grant host permission for the domain. Note: cookie values are sensitive credentials — handle them with care.",
  {
    url: z.string().optional(),
    domain: z.string().optional(),
    name: z.string().optional(),
    names: z.array(z.string()).optional(),
  },
  async ({ url, domain, name, names }) => {
    const result = await browserApi.getCookies({ url, domain, name, names });
    if (!result.ok) {
      // API unavailable or host permission not granted — surface a recoverable,
      // non-throwing error so the model can prompt the user to grant access.
      return {
        content: [
          {
            type: "text",
            text: `Failed to read cookies: ${result.error ?? "unknown error"}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.cookies ?? [], null, 2),
        },
      ],
    };
  }
);

mcpServer.tool(
  "browser-fetch",
  'A privileged fetch issued from the extension background context. Because it runs at the extension origin it is immune to the visited page\'s Content-Security-Policy, it uses the browser\'s real session (credentials:"include" attaches that site\'s cookies, including httpOnly, when host permission is granted), and it is browser-originated so it passes WAFs that block curl. Provide EITHER "body" (UTF-8 text) or "bodyBase64" (binary). Requires Automation Mode + host permission for the target; there is a ~60s hard ceiling. IMPORTANT: a non-2xx status (e.g. 403) is a SUCCESSFUL result, not an error — only a network failure/timeout/permission denial is an error.',
  {
    url: z.string(),
    method: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    bodyBase64: z.string().optional(),
    credentials: z.enum(["include", "omit", "same-origin"]).optional(),
    useSessionCookies: z.boolean().optional(),
    redirect: z.enum(["follow", "manual", "error"]).optional(),
    timeoutMs: z.number().optional(),
    maxBytes: z.number().optional(),
  },
  async (params) => {
    const result = await browserApi.browserFetch(params);
    if (!result.ok) {
      // Only a transport-level failure (network/timeout/permission/abort) is an
      // error; a non-2xx HTTP status is handled as success below.
      return {
        content: [
          {
            type: "text",
            text: `Fetch failed: ${result.error ?? "unknown error"}`,
          },
        ],
        isError: true,
      };
    }
    const statusLine = `${result.status ?? "?"} ${result.statusText ?? ""}  ${
      result.finalUrl ?? params.url
    }`;
    const headersBlock = JSON.stringify(result.headers ?? {}, null, 2);
    const bodyBlock =
      result.bodyText !== undefined
        ? result.bodyText
        : `[binary body: base64 length ${result.bodyBase64?.length ?? 0}]`;
    const truncatedNote = result.truncated ? "\n(truncated)" : "";
    return {
      content: [
        {
          type: "text",
          text: `${statusLine}\n\n${headersBlock}\n\n${bodyBlock}${truncatedNote}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "stream-start",
  "Open an SSE/chunked-transfer request from the extension background and return a streamId once the response HEADERS arrive (NOT once the body completes — a streaming body never completes). The streamId model exists because a single MCP call cannot stream. Same privileged fetch semantics as browser-fetch (CSP-immune, real session, credentials/useSessionCookies/redirect). After it returns, drain buffered frames with stream-poll (pass the streamId and a sinceIndex cursor) and call stream-close when you are done. Requires Automation Mode + host permission.",
  {
    url: z.string(),
    method: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    bodyBase64: z.string().optional(),
    credentials: z.enum(["include", "omit", "same-origin"]).optional(),
    useSessionCookies: z.boolean().optional(),
    redirect: z.enum(["follow", "manual", "error"]).optional(),
    maxFrames: z.number().optional(),
    maxBytes: z.number().optional(),
    idleTimeoutMs: z.number().optional(),
    totalTimeoutMs: z.number().optional(),
  },
  async (params) => {
    const result = await browserApi.streamStart(params);
    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: `Stream failed to start: ${result.error ?? "unknown error"}`,
          },
        ],
        isError: true,
      };
    }
    const headersBlock = JSON.stringify(result.headers ?? {}, null, 2);
    return {
      content: [
        {
          type: "text",
          text:
            `Stream started. streamId=${result.streamId}, status=${
              result.status ?? "?"
            }\n\n${headersBlock}\n\n` +
            `Poll with stream-poll: pass streamId="${result.streamId}" and sinceIndex (start at 0, then advance it to the nextIndex returned by each poll). ` +
            `Call stream-close with this streamId once you are done.`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "stream-poll",
  "Drain the stream's buffered frames after a cursor. Pass the 'streamId' from stream-start and 'sinceIndex' (the cursor; start at 0, then pass the nextIndex returned by the previous poll). done:true means the stream ended — stop polling. An error result means the stream expired or the streamId is unknown (e.g. the MV3 service worker was recycled).",
  {
    streamId: z.string(),
    sinceIndex: z.number().optional(),
  },
  async ({ streamId, sinceIndex }) => {
    const result = await browserApi.streamPoll(streamId, sinceIndex);
    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: `Stream poll failed: ${
              result.error ?? "stream expired or unknown streamId"
            }`,
          },
        ],
        isError: true,
      };
    }
    const frames = result.frames ?? [];
    const errorNote = result.error ? `\nerror: ${result.error}` : "";
    return {
      content: [
        {
          type: "text",
          text:
            `${frames.length} frame(s), done=${result.done}, nextIndex=${
              result.nextIndex ?? sinceIndex ?? 0
            } (pass nextIndex as sinceIndex on your next stream-poll)${errorNote}\n\n` +
            JSON.stringify(frames, null, 2),
        },
      ],
    };
  }
);

mcpServer.tool(
  "stream-close",
  "Abort a stream and free its buffer. Pass the 'streamId' from stream-start. Idempotent — closing an already-closed or unknown stream is a harmless no-op.",
  { streamId: z.string() },
  async ({ streamId }) => {
    await browserApi.streamClose(streamId);
    return {
      content: [{ type: "text", text: `Closed stream ${streamId}` }],
    };
  }
);

mcpServer.tool(
  "capture-response-bodies",
  "Attach or detach the Chrome/Edge DEBUGGER on a tab to capture RESPONSE bodies, which the covert get-network-requests path CANNOT read on Chrome/Edge (MV3). Use this ONLY when you specifically need response bodies. WARNING: enabling it shows a 'FoxPilot started debugging this browser' banner and is DETECTABLE by the page — it BREAKS covert observation. Set enabled:false to detach and return to covert capture as soon as you're done. Typical flow: capture-response-bodies(tabId,true) → reload the page → get-network-requests(tabId, includeBody:true) now returns response bodies → capture-response-bodies(tabId,false). No-op on Firefox, which already captures response bodies covertly via get-network-requests includeBody (it reports supported:false).",
  { tabId: z.number(), enabled: z.boolean() },
  async ({ tabId, enabled }) => {
    const result = await browserApi.captureResponseBodies(tabId, enabled);
    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: `capture-response-bodies failed: ${result.error ?? "unknown error"}`,
          },
        ],
        isError: true,
      };
    }
    if (!result.supported) {
      return {
        content: [
          {
            type: "text",
            text: "Response-body debugger capture is not supported on this browser (Firefox). Response bodies are already captured covertly — just call get-network-requests with includeBody:true.",
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: enabled
            ? `Debugger attached to tab ${tabId}: response bodies will now be captured (a debugging banner is showing — detectable by the page). Reload the page, then call get-network-requests with includeBody:true. Call capture-response-bodies with enabled:false when done.`
            : `Debugger detached from tab ${tabId}: back to covert capture.`,
        },
      ],
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
