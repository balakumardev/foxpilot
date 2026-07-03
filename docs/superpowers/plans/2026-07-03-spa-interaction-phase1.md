# FoxPilot SPA Interaction — Phase 1 (Read/Query Subsystem) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the covert-safe, isolated-world-only Phase 1 of the CSP-strict-SPA interaction design: `wait-for-text` accepts `string | string[]` (#7); `get-cookies` gains `names?: string[]` (#5); `take-snapshot` promotes `cursor:pointer` detection into the base pass with an `includePointer`/`maxInteractive` cap plus `selector`/`textContains` query modes (#2); and `take-snapshot` gains `rootSelector` region scoping and `offset`/`limit` paging with `total`/`hasMore` metadata (#3). Plus the shared CSP-strict React-like test fixture + local static server reused by later phases, and the mcpkit skill docs.

**Architecture:** Every new capability is an **optional parameter on an existing tool** — no new `cmd`, no debugger, no page-world `<script>`, no sidecar. All page work runs in the CSP-immune ISOLATED content-script world (Chrome MV3 content-script messaging; Firefox `browser.tabs.executeScript` of stringified functions). Changes flow through the standard chain: `mcp-server/server.ts` (zod) → `mcp-server/browser-api.ts` (frame) → broker (transparent) → `{chrome,firefox}-extension/message-handler.ts` (handler) → injected `snapshot-script.ts` / inline isolated-world code. Both extensions are mirrored; the injected `snapshot-script.ts` is byte-identical across the two.

**Tech Stack:** TypeScript, esbuild, Jest (ts-jest + jsdom), Nx monorepo.

## Global Constraints
- **Node** `>=22` (mcp-server `engines.node`); extensions target the browser runtime. **zod 4.3.6** — for any map param use the two-arg `z.record(z.string(), z.string())` (Phase 1 needs **none**: `wait-for-text` uses `z.union`, `get-cookies` uses `z.array`).
- **ISOLATED-world only** — covert, no `chrome.debugger`, no sidecar, no page-world `<script>` injection. Nothing in Phase 1 attaches the debugger or shows the automation banner.
- **Mirror both extensions.** Show complete Chrome code, then the concrete Firefox delta. Firefox injects via `browser.tabs.executeScript(tabId,{code:'(${fn.toString()})(...)'})`; Chrome messages a persistent content-script. The injected `snapshot-script.ts` is kept identical across the two.
- **Backward compatible.** `wait-for-text` still accepts a plain string and still returns `{found}` with no extra field for the string case; `get-cookies` keeps singular `name`; `take-snapshot {tabId}` still works — new response fields (`total`/`hasMore`/`error`) are append-only and conditionally spread; the metadata header only prints when a new query/paging param is supplied.
- **Phase 1 adds NO new `cmd`.** Do **NOT** edit `COMMAND_TO_TOOL_ID`, `AVAILABLE_TOOLS`, `AUTOMATION_COMMANDS`, or the two `_exhaustiveCheck: never` switches. Only add **optional fields** to the existing `*ServerMessage` interfaces and thread them through.
- **One behavior change is intentional (design §4.B, §9.7):** `includePointer` defaults **true**, so the default snapshot now also captures `cursor:pointer` `<div onClick>` elements. This is a deliberate design decision; Task 4 updates the one existing unit test that asserted the old "verbose-only" behavior.

## File Structure

Legend: **[C]** create, **[M]** modify.

| Path | Task(s) | Responsibility |
|------|---------|----------------|
| `test-fixtures/csp-react-spa/index.html` | 1 [C] | CSP-strict static page markup (contenteditable chat, `<div onClick>` "Open" card, inner-scroll panel, `#sidebar` mount, `#main-panel` scope target) |
| `test-fixtures/csp-react-spa/app.js` | 1 [C] | External (`'self'`) script: builds the ~700-item sidebar, fills the tall inner-scroll panel, wires the card's click handler |
| `test-fixtures/csp-react-spa/server.mjs` | 1 [C] | Zero-dependency Node static server that sets `Content-Security-Policy: script-src 'self'` on every response |
| `common/server-messages.ts` | 2,3,5 [M] | `WaitForTextServerMessage.text: string \| string[]`; `GetCookiesServerMessage.names?`; `TakeSnapshotServerMessage` optional query/paging fields |
| `common/extension-messages.ts` | 2,5 [M] | `WaitForTextResultExtensionMessage.matched?`; `SnapshotExtensionMessage.total?/hasMore?/error?` |
| `mcp-server/server.ts` | 2,3,5 [M] | zod schemas + tool descriptions + handlers for `wait-for-text`, `get-cookies`, `take-snapshot` |
| `mcp-server/browser-api.ts` | 2,3,5 [M] | `waitForText`/`getCookies`/`takeSnapshot` client methods forward new params |
| `chrome-extension/message-handler.ts` | 2,3,5 [M] | `waitForText`/`getCookiesForServer`/`takeSnapshot` handlers thread new params |
| `chrome-extension/content-script.ts` | 2,5 [M] | isolated-world `waitForText` (array + which-matched) and `buildSnapshot` call site forward new options |
| `chrome-extension/browser-http.ts` | 3 [M] | `getCookies` gains `names?` filtering |
| `chrome-extension/injected/snapshot-script.ts` | 4,5,6,7,8 [M] | `includePointer`/`maxInteractive`, `selector`, `textContains`, `rootSelector`, `offset`/`limit`, `total`/`hasMore`/`error` |
| `firefox-extension/message-handler.ts` | 2,3,5 [M] | inline isolated-world `waitForText` (array + which-matched); `handleGetCookies` names; `takeSnapshot` options |
| `firefox-extension/browser-http.ts` | 3 [M] | `getCookies` gains `names?` filtering |
| `firefox-extension/injected/snapshot-script.ts` | 4,5,6,7,8 [M] | identical to the Chrome injected snapshot changes |
| `chrome-extension/__tests__/message-handler.test.ts` | 2 [M] | `wait-for-text` array + which-matched handler test |
| `chrome-extension/__tests__/browser-http.test.ts` | 3 [M] | `getCookies` `names[]` filter test |
| `chrome-extension/__tests__/snapshot-script.test.ts` | 4,5,6,7,8 [C] | jsdom unit tests for the new snapshot predicates (Chrome copy) |
| `firefox-extension/__tests__/message-handler.test.ts` | 2 [M] | `wait-for-text` array + which-matched handler test |
| `firefox-extension/__tests__/browser-http.test.ts` | 3 [M] | `getCookies` `names[]` filter test |
| `firefox-extension/__tests__/snapshot-script.test.ts` | 4,5,6,7,8 [M] | jsdom unit tests for the new snapshot predicates (+ fix the one pre-existing verbose-only test) |
| `mcp-server/__tests__/wait-for-text-arg.test.ts` | 2 [C] | broker round-trip: `waitForText` sends array, surfaces `matched` |
| `mcp-server/__tests__/get-cookies-names.test.ts` | 3 [C] | broker round-trip: `getCookies` sends `names`, returns cookies |
| `mcp-server/__tests__/take-snapshot-args.test.ts` | 5,7,8 [C] | broker round-trip: `takeSnapshot` sends query/paging fields, surfaces `total`/`hasMore`/`error` |
| `~/.claude/skills/mcpkit-foxpilot/SKILL.md` | 9 [M] | mcpkit skill docs for the new params (outside the repo) |

---

### Task 1 — CSP-strict custom-React test fixture + local static server

Shared integration target reused by all later phases. No existing fixtures convention exists in the repo (verified: no `fixtures`/`test-fixtures` dirs), so create a top-level `test-fixtures/csp-react-spa/`. It is served with `Content-Security-Policy: script-src 'self'` (no `unsafe-inline`), which (a) blocks inline `<script>` — so a later `evaluate-script world:"main"` will time out with the CSP hint while `world:"isolated"` succeeds, and (b) forces the app logic into an external `'self'` script. The page contains a `<div contenteditable>` chat input, a `<div onClick>` "Open" card with **no** role/tabindex, a tall inner-scroll panel, and a ~700-item sidebar.

**Files:**
- Create `test-fixtures/csp-react-spa/index.html`
- Create `test-fixtures/csp-react-spa/app.js`
- Create `test-fixtures/csp-react-spa/server.mjs`

**Interfaces:**
- Produces: a static site at `http://localhost:<port>/` (default `877`) whose every response carries `Content-Security-Policy: script-src 'self'`. Key selectors for later phases: `[contenteditable]` (chat input), `#open-card` (`<div onClick>`, no role), `#inner-scroll` (inner scrollable panel), `#sidebar` (~700 items), `#main-panel` (scope target excluding the sidebar).
- Consumes: nothing (zero external deps; Node `node:http`/`node:fs`/`node:path`/`node:url` only).

**Steps:**

1. - [ ] Create `test-fixtures/csp-react-spa/index.html`:
     ```html
     <!doctype html>
     <html lang="en">
       <head>
         <meta charset="utf-8" />
         <meta name="viewport" content="width=device-width, initial-scale=1" />
         <title>CSP-strict SPA fixture</title>
         <style>
           * { box-sizing: border-box; }
           body { margin: 0; font-family: system-ui, sans-serif; display: flex; }
           #sidebar { width: 240px; height: 100vh; overflow-y: auto; border-right: 1px solid #ccc; padding: 8px; }
           #sidebar .item { padding: 6px 4px; cursor: pointer; }
           #main-panel { flex: 1; padding: 16px; }
           #open-card { display: inline-block; padding: 16px 24px; background: #efefef; border-radius: 8px; cursor: pointer; user-select: none; }
           #chat { margin-top: 16px; }
           #chat [contenteditable] { min-height: 40px; border: 1px solid #999; border-radius: 6px; padding: 8px; }
           #inner-scroll { margin-top: 16px; height: 200px; overflow-y: auto; border: 1px solid #999; padding: 8px; }
           #inner-scroll .row { padding: 8px 0; border-bottom: 1px dashed #ddd; }
           #log { margin-top: 12px; color: #333; }
         </style>
       </head>
       <body>
         <nav id="sidebar" aria-label="Sidebar"><!-- ~700 items injected by app.js --></nav>
         <main id="main-panel">
           <h1>Test Agent</h1>
           <div id="open-card">Open</div>
           <div id="chat">
             <div contenteditable="true" aria-label="Message input" data-testid="chat-input"></div>
           </div>
           <div id="inner-scroll"><!-- tall content injected by app.js --></div>
           <div id="log"></div>
         </main>
         <script src="app.js"></script>
       </body>
     </html>
     ```

2. - [ ] Create `test-fixtures/csp-react-spa/app.js` (external, allowed by `script-src 'self'`):
     ```js
     // Builds the parts a strict-CSP custom-React SPA would render at runtime:
     // a large sidebar list, a tall inner-scroll panel, and a click handler on
     // the role-less "Open" card. Inline scripts are blocked by CSP, so this
     // external same-origin file is the only script that runs.
     (function () {
       var sidebar = document.getElementById("sidebar");
       for (var i = 1; i <= 700; i++) {
         var item = document.createElement("div");
         item.className = "item";
         item.textContent = "Sidebar item " + i;
         sidebar.appendChild(item);
       }

       var inner = document.getElementById("inner-scroll");
       for (var r = 1; r <= 60; r++) {
         var row = document.createElement("div");
         row.className = "row";
         row.textContent = "Inner row " + r + " — scroll me, not the window";
         inner.appendChild(row);
       }

       var card = document.getElementById("open-card");
       var log = document.getElementById("log");
       // Handler attached via addEventListener — no onclick attribute, no role,
       // no tabindex: invisible to a semantic-only snapshot, visible only via
       // cursor:pointer or a textContains/selector query.
       card.addEventListener("click", function () {
         log.textContent = "Opened at " + new Date().toISOString();
       });
     })();
     ```

3. - [ ] Create `test-fixtures/csp-react-spa/server.mjs` (zero-dependency static server):
     ```js
     // Minimal static file server for the CSP-strict SPA fixture. Sets
     // `Content-Security-Policy: script-src 'self'` on EVERY response so the
     // fixture reproduces a strict-CSP page (inline scripts blocked; external
     // same-origin scripts allowed). Run: `node server.mjs [port]` (default 877).
     import { createServer } from "node:http";
     import { readFile } from "node:fs/promises";
     import { extname, join, normalize } from "node:path";
     import { fileURLToPath } from "node:url";

     const ROOT = fileURLToPath(new URL(".", import.meta.url));
     const PORT = Number(process.argv[2] || process.env.FIXTURE_PORT || 877);
     const TYPES = {
       ".html": "text/html; charset=utf-8",
       ".js": "text/javascript; charset=utf-8",
       ".css": "text/css; charset=utf-8",
     };

     const server = createServer(async (req, res) => {
       // Strict CSP on every response — the whole point of the fixture.
       res.setHeader("Content-Security-Policy", "script-src 'self'");
       const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
       const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
       // Contain path traversal to the fixture root.
       const filePath = normalize(join(ROOT, rel));
       if (!filePath.startsWith(ROOT)) {
         res.statusCode = 403;
         res.end("Forbidden");
         return;
       }
       try {
         const body = await readFile(filePath);
         res.setHeader("Content-Type", TYPES[extname(filePath)] || "application/octet-stream");
         res.statusCode = 200;
         res.end(body);
       } catch {
         res.statusCode = 404;
         res.end("Not found");
       }
     });

     server.listen(PORT, "127.0.0.1", () => {
       console.log(`CSP-strict SPA fixture on http://localhost:${PORT}/`);
     });
     ```

4. - [ ] **Run-to-verify** the server serves the CSP header and the fixture:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     node test-fixtures/csp-react-spa/server.mjs 8791 &
     FIXTURE_PID=$!
     sleep 1
     curl -sI http://localhost:8791/ | grep -i "content-security-policy"
     curl -s http://localhost:8791/ | grep -c "open-card"
     curl -sI http://localhost:8791/app.js | grep -i "content-type"
     kill $FIXTURE_PID
     ```
     Expected output includes:
     ```
     content-security-policy: script-src 'self'
     1
     content-type: text/javascript; charset=utf-8
     ```

5. - [ ] Commit:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     git add test-fixtures/csp-react-spa
     git commit -m "test(fixtures): CSP-strict custom-React SPA fixture + static server"
     ```

---

### Task 2 — `wait-for-text` accepts `string | string[]` (OR-match, returns which matched) (#7)

Resolve as soon as **any** provided string appears; return which one matched. Back-compat: a plain string still works and, for the string case, the result carries no `matched` field (existing tests unchanged). `matched` is attached only when the input was an array.

**Files:**
- Modify `common/server-messages.ts` — `WaitForTextServerMessage.text` (line ~80).
- Modify `common/extension-messages.ts` — `WaitForTextResultExtensionMessage` (lines ~86-89).
- Modify `mcp-server/server.ts` — `wait-for-text` tool (lines ~335-353).
- Modify `mcp-server/browser-api.ts` — `waitForText` (lines ~489-501).
- Modify `chrome-extension/message-handler.ts` — `waitForText` (lines ~1248-1280).
- Modify `chrome-extension/content-script.ts` — `waitForText` (lines ~171-182) and the `case "waitForText"` (lines ~352-356).
- Modify `firefox-extension/message-handler.ts` — `waitForText` (lines ~1485-1520).
- Create `mcp-server/__tests__/wait-for-text-arg.test.ts`.
- Modify `chrome-extension/__tests__/message-handler.test.ts` and `firefox-extension/__tests__/message-handler.test.ts`.

**Interfaces:**
- Consumes (MCP): `wait-for-text { tabId: number, text: string | [string, ...string[]], timeoutMs?: number }`.
- Produces (extension): `WaitForTextResultExtensionMessage { resource:"wait-for-text-result"; found: boolean; matched?: string }`.
- Internal: `BrowserAPI.waitForText(tabId, text: string | string[], timeoutMs?) => Promise<{ found: boolean; matched?: string }>`.

**Steps:**

1. - [ ] **Failing test (Firefox handler).** In `firefox-extension/__tests__/message-handler.test.ts`, inside `describe("wait-for-text command", ...)` (after line ~1279), add:
     ```ts
     it("accepts an array of strings, OR-matches, and returns which matched", async () => {
       (browser.storage.local.get as jest.Mock).mockResolvedValue({
         config: automationConfig,
       });
       (browser.tabs.get as jest.Mock).mockResolvedValue({
         id: 123,
         url: "https://example.com",
       });
       // The injected isolated-world probe returns the matched needle (or null).
       (browser.tabs.executeScript as jest.Mock).mockResolvedValue(["World"]);

       const request: ServerMessageRequest = {
         cmd: "wait-for-text",
         tabId: 123,
         text: ["Hello", "World"],
         correlationId: "c-arr",
       };

       await messageHandler.handleDecodedMessage(request);

       expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
         resource: "wait-for-text-result",
         correlationId: "c-arr",
         found: true,
         matched: "World",
       });
     });
     ```

2. - [ ] **Run-to-fail:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/message-handler.test.ts -t "OR-matches"
     ```
     Expected: FAIL — the current handler injects a boolean `includes` probe, ignores arrays, and never emits `matched`. (TypeScript will also reject `text: ["Hello","World"]` against `text: string` once compiled — the test asserts the new behavior.)

3. - [ ] **Impl — common types.** In `common/server-messages.ts`, change `WaitForTextServerMessage`:
     ```ts
     export interface WaitForTextServerMessage extends ServerMessageBase {
       cmd: "wait-for-text";
       tabId: number;
       // Back-compat: a plain string OR a non-empty array (OR-match — resolve as
       // soon as ANY string appears). The result reports which string matched.
       text: string | string[];
       timeoutMs?: number;
     }
     ```
     In `common/extension-messages.ts`, change `WaitForTextResultExtensionMessage`:
     ```ts
     export interface WaitForTextResultExtensionMessage extends ExtensionMessageBase {
       resource: "wait-for-text-result";
       found: boolean;
       // Which needle matched (only set when the request supplied an array).
       matched?: string;
     }
     ```

4. - [ ] **Impl — Firefox handler.** In `firefox-extension/message-handler.ts`, replace the `waitForText` method (lines ~1485-1520):
     ```ts
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
         if (hit) {
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
     ```
     Update the switch dispatch (lines ~268-274) to pass the union type through unchanged — it already forwards `req.text`, and `req.text` is now `string | string[]`, so no edit is needed beyond the type flowing through. Confirm the call site compiles.

5. - [ ] **Run-to-pass (Firefox):**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/message-handler.test.ts -t "wait-for-text"
     ```
     Expected: PASS — the new array test plus the two pre-existing `found:true`/`found:false` tests (which mock `[true]`/`[false]` and pass a plain string, so `matched` is never attached).

6. - [ ] **Failing test (Chrome handler).** In `chrome-extension/__tests__/message-handler.test.ts`, add a new `describe` block (Chrome has no wait-for-text test yet):
     ```ts
     describe("wait-for-text command", () => {
       const automationConfig = { ...baseConfig, automationMode: true };

       it("OR-matches an array and returns which needle matched", async () => {
         (browser.storage.local.get as jest.Mock).mockResolvedValue({
           config: automationConfig,
         });
         (browser.tabs.get as jest.Mock).mockResolvedValue({
           id: 5,
           url: "https://example.com",
         });
         // sendMessageToTab -> content-script probe returns {found, matched}.
         (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
           found: true,
           matched: "Ready",
         });

         await messageHandler.handleDecodedMessage({
           cmd: "wait-for-text",
           tabId: 5,
           text: ["Loading", "Ready"],
           correlationId: "cw",
         } as ServerMessageRequest);

         expect(browser.tabs.sendMessage).toHaveBeenCalledWith(5, {
           type: "waitForText",
           text: ["Loading", "Ready"],
           timeoutMs: 500,
         });
         expect(transport.sendResourceToServer).toHaveBeenCalledWith({
           resource: "wait-for-text-result",
           correlationId: "cw",
           found: true,
           matched: "Ready",
         });
       });
     });
     ```

7. - [ ] **Run-to-fail:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/message-handler.test.ts -t "OR-matches an array"
     ```
     Expected: FAIL — current handler forwards a `text` string, never reads `matched`.

8. - [ ] **Impl — Chrome handler.** In `chrome-extension/message-handler.ts`, replace `waitForText` (lines ~1248-1280):
     ```ts
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
     ```
     The switch dispatch (lines ~237-244) already forwards `req.text`; no change needed beyond the type flowing through.

9. - [ ] **Impl — Chrome content-script.** In `chrome-extension/content-script.ts`, replace the `waitForText` function (lines ~171-182):
     ```ts
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
     ```
     And the `case "waitForText"` (lines ~352-356) forwards the whole result:
     ```ts
     case "waitForText": {
       const result = await waitForText(message.text, message.timeoutMs);
       sendResponse(result);
       break;
     }
     ```

10. - [ ] **Run-to-pass (Chrome):**
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/message-handler.test.ts -t "wait-for-text"
      ```
      Expected: PASS.

11. - [ ] **Impl — MCP server + browser-api.** In `mcp-server/browser-api.ts`, replace `waitForText` (lines ~489-501):
      ```ts
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
      ```
      In `mcp-server/server.ts`, replace the `wait-for-text` tool (lines ~335-353):
      ```ts
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
      ```

12. - [ ] **Failing test (MCP wire round-trip).** Create `mcp-server/__tests__/wait-for-text-arg.test.ts` (mirrors `browser-api.test.ts`):
      ```ts
      import WebSocket from "ws";
      import { BrokerServer } from "../broker";
      import { BrowserAPI } from "../browser-api";
      import { createSignature } from "../signing";
      import type { ServerMessageRequest } from "@foxpilot/common";

      jest.mock("child_process", () => {
        const actual = jest.requireActual("child_process");
        return { ...actual, spawn: jest.fn(() => ({ unref: jest.fn() })) };
      });

      const SECRET = "wft-secret";

      function startMockExtension(
        port: number,
        onReq: (req: ServerMessageRequest) => object
      ): Promise<WebSocket> {
        return new Promise((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
          ws.on("open", () => {
            const hello = {
              type: "hello",
              browserId: "wft-ext",
              browserType: "firefox",
              label: "Firefox",
            };
            ws.send(
              JSON.stringify({
                payload: hello,
                signature: createSignature(SECRET, JSON.stringify(hello)),
              })
            );
            resolve(ws);
          });
          ws.on("message", (data) => {
            const env = JSON.parse(data.toString());
            if (env?.type === "welcome" || env?.type === "rejected") return;
            const cmd = env?.payload?.cmd;
            if (typeof cmd !== "string" || cmd === "active-status") return;
            const payload = onReq(env.payload as ServerMessageRequest);
            ws.send(
              JSON.stringify({
                payload,
                signature: createSignature(SECRET, JSON.stringify(payload)),
              })
            );
          });
        });
      }

      describe("BrowserAPI.waitForText over the broker", () => {
        let server: BrokerServer;
        let ext: WebSocket;
        let api: BrowserAPI;
        let lastReq: ServerMessageRequest | null = null;
        const origSecret = process.env.EXTENSION_SECRET;
        const origPort = process.env.EXTENSION_PORT;

        beforeAll(async () => {
          server = new BrokerServer({ port: 0, host: "127.0.0.1", secret: SECRET });
          await server.listen();
          const port = server.getPort();
          ext = await startMockExtension(port, (req) => {
            lastReq = req;
            return {
              resource: "wait-for-text-result",
              correlationId: req.correlationId,
              found: true,
              matched: "World",
            };
          });
          process.env.EXTENSION_SECRET = SECRET;
          process.env.EXTENSION_PORT = String(port);
          api = new BrowserAPI();
          await api.init();
        }, 15000);

        afterAll(() => {
          api.close();
          ext.close();
          server.close();
          if (origSecret === undefined) delete process.env.EXTENSION_SECRET;
          else process.env.EXTENSION_SECRET = origSecret;
          if (origPort === undefined) delete process.env.EXTENSION_PORT;
          else process.env.EXTENSION_PORT = origPort;
        });

        it("forwards a string[] and surfaces the matched needle", async () => {
          const result = await api.waitForText(7, ["Hello", "World"]);
          expect(result).toEqual({ found: true, matched: "World" });
          expect((lastReq as any).text).toEqual(["Hello", "World"]);
        });
      });
      ```

13. - [ ] **Run-to-pass (all three packages):**
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/wait-for-text-arg.test.ts
      cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npm run build
      cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/message-handler.test.ts
      cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/message-handler.test.ts
      ```
      Expected: all PASS; `npm run build` (esbuild bundle of `server.ts` + `broker-main.ts`) completes with no type/emit error.

14. - [ ] Commit:
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp
      git add common mcp-server chrome-extension firefox-extension
      git commit -m "feat(wait-for-text): accept string | string[] (OR-match, report which matched)"
      ```

---

### Task 3 — `get-cookies` gains `names?: string[]` (#5)

Filter the jar to cookies whose name is in `names`. Keeps singular `name` for back-compat; if both are given, the union is returned. httpOnly cookies are already included by `getAll` and remain included.

**Files:**
- Modify `common/server-messages.ts` — `GetCookiesServerMessage` (lines ~243-248).
- Modify `mcp-server/server.ts` — `get-cookies` tool (lines ~738-770).
- Modify `mcp-server/browser-api.ts` — `getCookies` (lines ~727-740).
- Modify `chrome-extension/browser-http.ts` — `getCookies` (lines ~258-275).
- Modify `firefox-extension/browser-http.ts` — `getCookies` (lines ~175-192).
- Modify `chrome-extension/message-handler.ts` — `getCookiesForServer` (lines ~1127-1156) and the `case "get-cookies"` (lines ~349-354).
- Modify `firefox-extension/message-handler.ts` — `handleGetCookies` (lines ~1343-1370).
- Modify `chrome-extension/__tests__/browser-http.test.ts` and `firefox-extension/__tests__/browser-http.test.ts`.
- Create `mcp-server/__tests__/get-cookies-names.test.ts`.

**Interfaces:**
- Consumes (MCP): `get-cookies { url?, domain?, name?, names?: string[] }`.
- Internal: `getCookies({ url?, domain?, name?, names?: string[] }) => Promise<CookieRecord[]>`.

**Steps:**

1. - [ ] **Failing test (Chrome browser-http).** In `chrome-extension/__tests__/browser-http.test.ts`, inside `describe("getCookies", ...)` (after line ~206), add:
     ```ts
     it("filters getAll results to `names[]` (httpOnly included) without constraining the query by name", async () => {
       (browser as any).cookies.getAll.mockResolvedValue([
         { name: "sid", value: "s", domain: "x.com", path: "/", secure: true, httpOnly: true, expirationDate: 1 },
         { name: "csrf", value: "c", domain: "x.com", path: "/", secure: true, httpOnly: false, expirationDate: 1 },
         { name: "theme", value: "dark", domain: "x.com", path: "/", secure: false, httpOnly: false },
       ]);

       const cookies = await getCookies({ url: "https://x.com", names: ["sid", "csrf"] });

       // getAll is queried only by url — NOT by name — so multi-name filtering
       // happens in-memory.
       expect((browser as any).cookies.getAll).toHaveBeenCalledWith({ url: "https://x.com" });
       expect(cookies.map((c) => c.name).sort()).toEqual(["csrf", "sid"]);
       // httpOnly cookie survived the filter.
       expect(cookies.find((c) => c.name === "sid")!.httpOnly).toBe(true);
     });
     ```

2. - [ ] **Run-to-fail:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/browser-http.test.ts -t "filters getAll results"
     ```
     Expected: FAIL — `getCookies` has no `names` param; it would pass `name` (undefined) and return all three cookies.

3. - [ ] **Impl — Chrome browser-http.** In `chrome-extension/browser-http.ts`, replace `getCookies` (lines ~258-275):
     ```ts
     export async function getCookies(opts: {
       url?: string;
       domain?: string;
       name?: string;
       names?: string[];
     }): Promise<CookieRecord[]> {
       const query: Record<string, string> = {};
       if (opts.url !== undefined) {
         query.url = opts.url;
       }
       if (opts.domain !== undefined) {
         query.domain = opts.domain;
       }
       // When a multi-name filter is present, do NOT constrain getAll by a single
       // name — fetch all cookies in the url/domain scope and filter in-memory.
       // A lone singular `name` still narrows the query for the back-compat path.
       const multiName = !!(opts.names && opts.names.length > 0);
       if (opts.name !== undefined && !multiName) {
         query.name = opts.name;
       }
       const raw = await (browser as any).cookies.getAll(query);
       let mapped: CookieRecord[] = (raw ?? []).map(mapChromeCookie);
       if (multiName) {
         const wanted = new Set(opts.names);
         if (opts.name !== undefined) {
           wanted.add(opts.name); // union singular + plural
         }
         mapped = mapped.filter((c) => wanted.has(c.name));
       }
       return mapped;
     }
     ```

4. - [ ] **Run-to-pass (Chrome browser-http):**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/browser-http.test.ts -t "getCookies"
     ```
     Expected: PASS (new test + the pre-existing "drops undefined query keys" test, which uses no `names`).

5. - [ ] **Impl — Firefox browser-http.** In `firefox-extension/browser-http.ts`, replace `getCookies` (lines ~175-192):
     ```ts
     export async function getCookies(opts: {
       url?: string;
       domain?: string;
       name?: string;
       names?: string[];
     }): Promise<CookieRecord[]> {
       const details: Record<string, string> = {};
       if (opts.url !== undefined) {
         details.url = opts.url;
       }
       if (opts.domain !== undefined) {
         details.domain = opts.domain;
       }
       const multiName = !!(opts.names && opts.names.length > 0);
       if (opts.name !== undefined && !multiName) {
         details.name = opts.name;
       }
       const cookies = await (browser.cookies as any).getAll(details);
       let mapped: CookieRecord[] = ((cookies as any[]) ?? []).map(mapFirefoxCookie);
       if (multiName) {
         const wanted = new Set(opts.names);
         if (opts.name !== undefined) {
           wanted.add(opts.name);
         }
         mapped = mapped.filter((c) => wanted.has(c.name));
       }
       return mapped;
     }
     ```

6. - [ ] **Failing test (Firefox browser-http).** In `firefox-extension/__tests__/browser-http.test.ts`, inside its `describe("getCookies", ...)`, add the same-shaped test (Firefox's `getAll` mock lives on `browser.cookies.getAll`):
     ```ts
     it("filters getAll results to `names[]` (httpOnly included), querying only by url", async () => {
       (browser.cookies.getAll as jest.Mock).mockResolvedValue([
         { name: "sid", value: "s", domain: "x.com", path: "/", secure: true, httpOnly: true, expirationDate: 1 },
         { name: "csrf", value: "c", domain: "x.com", path: "/", secure: true, httpOnly: false, expirationDate: 1 },
         { name: "theme", value: "dark", domain: "x.com", path: "/", secure: false, httpOnly: false },
       ]);

       const cookies = await getCookies({ url: "https://x.com", names: ["sid", "csrf"] });

       expect(browser.cookies.getAll).toHaveBeenCalledWith({ url: "https://x.com" });
       expect(cookies.map((c) => c.name).sort()).toEqual(["csrf", "sid"]);
       expect(cookies.find((c) => c.name === "sid")!.httpOnly).toBe(true);
     });
     ```
     Then:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/browser-http.test.ts -t "getCookies"
     ```
     Expected: PASS.

7. - [ ] **Impl — common type + handlers.** In `common/server-messages.ts`, extend `GetCookiesServerMessage`:
     ```ts
     export interface GetCookiesServerMessage extends ServerMessageBase {
       cmd: "get-cookies";
       url?: string;
       domain?: string;
       name?: string;
       // Filter to cookies whose name is in this set (union with `name` if both).
       names?: string[];
     }
     ```
     In `chrome-extension/message-handler.ts`, update the `case "get-cookies"` (lines ~349-354) to forward `names`:
     ```ts
     case "get-cookies":
       await this.getCookiesForServer(req.correlationId, {
         url: req.url,
         domain: req.domain,
         name: req.name,
         names: req.names,
       });
       break;
     ```
     and the `getCookiesForServer` signature + call (lines ~1127-1141):
     ```ts
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
     ```
     In `firefox-extension/message-handler.ts`, update `handleGetCookies` (lines ~1350-1355) to pass `names`:
     ```ts
     const cookies = await getCookies({
       url: req.url,
       domain: req.domain,
       name: req.name,
       names: req.names,
     });
     ```

8. - [ ] **Impl — MCP server + browser-api.** In `mcp-server/browser-api.ts`, extend `getCookies` (lines ~727-740):
     ```ts
     async getCookies(opts: {
       url?: string;
       domain?: string;
       name?: string;
       names?: string[];
     }): Promise<CookiesExtensionMessage> {
       return await this.sendTool<CookiesExtensionMessage>({
         cmd: "get-cookies",
         ...opts,
       });
     }
     ```
     In `mcp-server/server.ts`, update the `get-cookies` tool schema + description (lines ~738-746):
     ```ts
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
             { type: "text", text: JSON.stringify(result.cookies ?? [], null, 2) },
           ],
         };
       }
     );
     ```

9. - [ ] **Failing test (MCP wire round-trip).** Create `mcp-server/__tests__/get-cookies-names.test.ts` using the same mock-extension harness as Task 2 step 12 (copy the `startMockExtension` helper and lifecycle, change `SECRET` to `"gcn-secret"`, `browserId` to `"gcn-ext"`). The reply handler:
     ```ts
     ext = await startMockExtension(port, (req) => {
       lastReq = req;
       return {
         resource: "cookies",
         correlationId: req.correlationId,
         ok: true,
         cookies: [
           { name: "sid", value: "s", domain: "x.com", path: "/", secure: true, httpOnly: true, session: false },
         ],
       };
     });
     ```
     The test:
     ```ts
     it("forwards `names` in the get-cookies frame and returns the cookies", async () => {
       const result = await api.getCookies({ url: "https://x.com", names: ["sid", "csrf"] });
       expect(result.ok).toBe(true);
       expect(result.cookies).toHaveLength(1);
       expect((lastReq as any).names).toEqual(["sid", "csrf"]);
     });
     ```

10. - [ ] **Run-to-pass + build:**
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/get-cookies-names.test.ts && npm run build
      cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/browser-http.test.ts
      cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/browser-http.test.ts
      ```
      Expected: all PASS; `npm run build` succeeds.

11. - [ ] Commit:
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp
      git add common mcp-server chrome-extension firefox-extension
      git commit -m "feat(get-cookies): add names[] filter (union with singular name; httpOnly preserved)"
      ```

---

### Task 4 — Promote `cursor:pointer` detection into the BASE snapshot pass + `includePointer?` (default true) + `maxInteractive?` cap (#2)

Change the second (`cursor:pointer`) pass gate from `verbose` to `includePointer` (default **true**), and make its cap configurable via `maxInteractive` (default **500**, was a hard `300`). This makes React `<div onClick>` cards visible in the default snapshot. Sets the FINAL Phase-1 `buildSnapshot` signature (options + return type) so Tasks 5–8 are purely additive.

**Files:**
- Modify `chrome-extension/injected/snapshot-script.ts` and `firefox-extension/injected/snapshot-script.ts` (identical edits): the function signature (lines ~19-23) and the second-pass gate/cap (lines ~350-353).
- Create `chrome-extension/__tests__/snapshot-script.test.ts`.
- Modify `firefox-extension/__tests__/snapshot-script.test.ts` — **fix the one pre-existing "verbose only" test** (lines ~383-390) and add new coverage.

**Interfaces:**
- Produces: `buildSnapshot(doc, options) => { tree, isTruncated, total?, hasMore?, error? }` where `options` is the full Phase-1 shape (below). `includePointer` default `true`; `maxInteractive` default `500`.

**Steps:**

1. - [ ] **Failing test (Firefox jsdom).** In `firefox-extension/__tests__/snapshot-script.test.ts`, add inside the top-level `describe("buildSnapshot", ...)` (before the verbose sub-describe):
     ```ts
     describe("includePointer (Task 4)", () => {
       it("captures an inline cursor:pointer div by DEFAULT (includePointer defaults true)", () => {
         document.body.innerHTML = `<div style="cursor: pointer">Open</div>`;
         const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
         expect(tree).toMatch(/clickable "Open" \[uid=e\d+\]/);
       });

       it("omits pointer elements when includePointer is explicitly false", () => {
         document.body.innerHTML = `<div style="cursor: pointer">Open</div>`;
         const { tree } = buildSnapshot(document, {
           verbose: false,
           maxLength: 25000,
           includePointer: false,
         });
         expect(tree).not.toContain("Open");
       });

       it("honors maxInteractive as the pointer-pass cap", () => {
         let html = "";
         for (let i = 0; i < 5; i++) html += `<div style="cursor: pointer">P${i}</div>`;
         document.body.innerHTML = html;
         const { tree } = buildSnapshot(document, {
           verbose: false,
           maxLength: 25000,
           maxInteractive: 2,
         });
         const matches = tree.match(/clickable "P\d"/g) || [];
         expect(matches.length).toBe(2);
       });
     });
     ```

2. - [ ] **Run-to-fail:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/snapshot-script.test.ts -t "includePointer"
     ```
     Expected: FAIL — pointer detection is gated on `verbose`, so default (`verbose:false`) omits "Open"; `includePointer`/`maxInteractive` are unknown options.

3. - [ ] **Impl — function signature (both `snapshot-script.ts`).** Replace the signature (lines ~19-23 Chrome / ~20-23 Firefox):
     ```ts
     export function buildSnapshot(
       doc: Document,
       options: {
         verbose: boolean;
         maxLength: number;
         // Phase-1 additions (all optional; back-compatible):
         includePointer?: boolean; // default true — capture cursor:pointer elements
         maxInteractive?: number; // cap on the pointer pass (default 500)
         selector?: string; // CSS-selector query mode (Task 5)
         textContains?: string; // visible-text query mode (Task 6)
         rootSelector?: string; // region scoping (Task 7)
         offset?: number; // paging (Task 8)
         limit?: number; // paging (Task 8)
       }
     ): {
       tree: string;
       isTruncated: boolean;
       total?: number;
       hasMore?: boolean;
       error?: string;
     } {
       const verbose = !!options.verbose;
       const maxLength = options.maxLength;
       const includePointer = options.includePointer !== false; // default true
       const maxInteractive =
         typeof options.maxInteractive === "number" ? options.maxInteractive : 500;
     ```

4. - [ ] **Impl — second-pass gate + cap (both files).** Replace the gate line (Chrome line ~351 / Firefox line ~352):
     ```ts
     if (includePointer && win && typeof win.getComputedStyle === "function") {
     ```
     and replace `const MAX_CLICKABLES = 300;` (Chrome line ~352 / Firefox line ~353) with:
     ```ts
     const MAX_CLICKABLES = maxInteractive;
     ```
     Also update the comment block just above the gate (lines ~340-350) so it reads "This pass runs by default (includePointer) …" instead of "This pass is opt-in (verbose) …" — replace the phrase `This pass is opt-in (verbose)` with `This pass runs by default (includePointer, on by default)`.

5. - [ ] **Impl — fix the pre-existing Firefox test.** In `firefox-extension/__tests__/snapshot-script.test.ts`, the test at lines ~383-390 ("captures a non-semantic div with inline cursor:pointer as a clickable (verbose only)") asserts the NON-verbose snapshot excludes "Click me" — now false by design. Replace that test body with:
     ```ts
     it("captures a non-semantic div with inline cursor:pointer as a clickable (default and verbose)", () => {
       document.body.innerHTML = `<div style="cursor: pointer">Click me</div>`;
       const verbose = build(true);
       expect(verbose.tree).toMatch(/clickable "Click me" \[uid=e\d+\]/);
       // includePointer now defaults true, so the DEFAULT snapshot includes it too.
       const nonVerbose = build(false);
       expect(nonVerbose.tree).toMatch(/clickable "Click me" \[uid=e\d+\]/);
     });
     ```
     Leave every other test in the `verbose visually-clickable second pass` describe unchanged — they call `build(true)`, which still triggers the pass (verbose implies `includePointer` default true → pass runs), so they stay green.

6. - [ ] **Create the Chrome jsdom test file.** Chrome currently has no `snapshot-script.test.ts` (verified). Create `chrome-extension/__tests__/snapshot-script.test.ts` mirroring the Firefox structure, seeded with the Task-4 coverage (later tasks extend it):
     ```ts
     import { buildSnapshot } from "../injected/snapshot-script";

     // jsdom unit tests for the Chrome copy of the (byte-identical) snapshot
     // builder. Mirrors firefox-extension/__tests__/snapshot-script.test.ts.
     describe("buildSnapshot (chrome)", () => {
       afterEach(() => {
         document.body.innerHTML = "";
         document.head.innerHTML = "";
       });

       it("captures an inline cursor:pointer div by default (includePointer default true)", () => {
         document.body.innerHTML = `<div style="cursor: pointer">Open</div>`;
         const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
         expect(tree).toMatch(/clickable "Open" \[uid=e\d+\]/);
       });

       it("omits pointer elements when includePointer is false", () => {
         document.body.innerHTML = `<div style="cursor: pointer">Open</div>`;
         const { tree } = buildSnapshot(document, {
           verbose: false,
           maxLength: 25000,
           includePointer: false,
         });
         expect(tree).not.toContain("Open");
       });

       it("still surfaces base-pass semantic elements", () => {
         document.body.innerHTML = `<a href="/h">Home</a><button>Go</button>`;
         const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
         expect(tree).toContain('link "Home" [uid=e1]');
         expect(tree).toContain('button "Go" [uid=e2]');
       });
     });
     ```

7. - [ ] **Run-to-pass (both extensions):**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/snapshot-script.test.ts
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/snapshot-script.test.ts
     ```
     Expected: both PASS (Firefox: all pre-existing tests still green with the one edited test; Chrome: new file green).

8. - [ ] Commit:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     git add chrome-extension firefox-extension
     git commit -m "feat(snapshot): promote cursor:pointer to base pass; includePointer (default true) + maxInteractive"
     ```

---

### Task 5 — `selector?: string` query mode + full message/plumbing wiring (#2)

Add CSS-selector query mode (return exactly the selector's matches, interactive or not, with fresh uids) AND do the one-time end-to-end plumbing that carries every Phase-1 snapshot option and returns `total`/`hasMore`/`error`. After this task, Tasks 6–8 touch only the injected `snapshot-script.ts` logic.

**Files:**
- Modify both `injected/snapshot-script.ts` (selector branch; rename the local `selector` string to avoid the option clash).
- Modify `common/server-messages.ts` — `TakeSnapshotServerMessage` (lines ~49-53).
- Modify `common/extension-messages.ts` — `SnapshotExtensionMessage` (lines ~63-68).
- Modify `mcp-server/server.ts` — `take-snapshot` tool (lines ~199-208).
- Modify `mcp-server/browser-api.ts` — `takeSnapshot` (lines ~440-449).
- Modify `chrome-extension/message-handler.ts` — `takeSnapshot` + switch case (lines ~217-219, ~521-544).
- Modify `chrome-extension/content-script.ts` — `case "buildSnapshot"` (lines ~244-251).
- Modify `firefox-extension/message-handler.ts` — `takeSnapshot` + switch case (lines ~248-249, ~605-634).
- Modify both `__tests__/snapshot-script.test.ts`.
- Create `mcp-server/__tests__/take-snapshot-args.test.ts`.

**Interfaces:**
- Consumes (MCP): `take-snapshot { tabId, verbose?, includePointer?, maxInteractive?, selector?, textContains?, rootSelector?, offset?, limit? }`.
- Produces (extension): `SnapshotExtensionMessage { resource:"snapshot"; tabId; snapshot; isTruncated; total?; hasMore?; error? }`.
- Internal: `BrowserAPI.takeSnapshot(tabId, opts) => Promise<SnapshotExtensionMessage>`.

**Steps:**

1. - [ ] **Failing test (Firefox jsdom).** In `firefox-extension/__tests__/snapshot-script.test.ts`, add:
     ```ts
     describe("selector query mode (Task 5)", () => {
       it("returns exactly the selector matches with fresh uids, even non-interactive", () => {
         document.body.innerHTML = `
           <div contenteditable="true" aria-label="Message input"></div>
           <p>ignore me</p>
           <button>Send</button>
         `;
         const { tree } = buildSnapshot(document, {
           verbose: false,
           maxLength: 25000,
           selector: "[contenteditable]",
         });
         expect(tree).toMatch(/textbox "Message input" \[uid=e\d+\]/);
         // Selector mode is self-contained: unrelated base elements are NOT emitted.
         expect(tree).not.toContain('button "Send"');
       });

       it("returns an error for an invalid selector", () => {
         document.body.innerHTML = `<div>x</div>`;
         const res = buildSnapshot(document, {
           verbose: false,
           maxLength: 25000,
           selector: "::::bad",
         });
         expect(res.error).toMatch(/Invalid CSS selector/);
         expect(res.tree).toBe("");
       });
     });
     ```

2. - [ ] **Run-to-fail:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/snapshot-script.test.ts -t "selector query mode"
     ```
     Expected: FAIL — `selector` is ignored today.

3. - [ ] **Impl — selector branch (both `snapshot-script.ts`).** Replace the candidate-selection block (Chrome lines ~306-312 / Firefox lines ~307-313):
     ```ts
     const verboseSelectors = ["h1", "h2", "h3", "h4", "h5", "h6", "[aria-label]"];
     const baseSelectorString = (verbose
       ? baseSelectors.concat(verboseSelectors)
       : baseSelectors
     ).join(",");

     // Query mode: an explicit CSS `selector` returns exactly its matches (fresh
     // uids), interactive or not, and is self-contained (no pointer pass).
     const selectorMode =
       typeof options.selector === "string" && options.selector.length > 0;

     let candidates: Element[];
     if (selectorMode) {
       try {
         candidates = Array.prototype.slice.call(
           doc.querySelectorAll(options.selector as string)
         );
       } catch (e) {
         return {
           tree: "",
           isTruncated: false,
           total: 0,
           hasMore: false,
           error: "Invalid CSS selector: " + options.selector,
         };
       }
     } else {
       candidates = Array.prototype.slice.call(
         doc.querySelectorAll(baseSelectorString)
       );
     }
     ```
     Note: the local was previously `const selector = (...).join(",")` and `const candidates = doc.querySelectorAll(selector)`. The rename to `baseSelectorString` avoids clashing with `options.selector`. The base loop below already iterates `candidates` by index — works unchanged against the array.
     Then guard the pointer pass so query mode skips it — change the gate (from Task 4):
     ```ts
     if (includePointer && !selectorMode && win && typeof win.getComputedStyle === "function") {
     ```

4. - [ ] **Run-to-pass (Firefox jsdom selector):**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/snapshot-script.test.ts -t "selector query mode"
     ```
     Expected: PASS. Then mirror the edit into `chrome-extension/injected/snapshot-script.ts` and add the same two tests to `chrome-extension/__tests__/snapshot-script.test.ts`; run:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/snapshot-script.test.ts
     ```
     Expected: PASS.

5. - [ ] **Impl — message types.** In `common/server-messages.ts`, extend `TakeSnapshotServerMessage`:
     ```ts
     export interface TakeSnapshotServerMessage extends ServerMessageBase {
       cmd: "take-snapshot";
       tabId: number;
       verbose?: boolean;
       includePointer?: boolean;
       maxInteractive?: number;
       selector?: string;
       textContains?: string;
       rootSelector?: string;
       offset?: number;
       limit?: number;
     }
     ```
     In `common/extension-messages.ts`, extend `SnapshotExtensionMessage`:
     ```ts
     export interface SnapshotExtensionMessage extends ExtensionMessageBase {
       resource: "snapshot";
       tabId: number;
       snapshot: string;
       isTruncated: boolean;
       // Phase-1 additions (append-only): total candidates collected, whether
       // more remain beyond the current page, and a query error (e.g. a
       // rootSelector/selector miss). All optional for back-compat.
       total?: number;
       hasMore?: boolean;
       error?: string;
     }
     ```

6. - [ ] **Impl — browser-api + server.** In `mcp-server/browser-api.ts`, replace `takeSnapshot` (lines ~440-449):
     ```ts
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
     ```
     In `mcp-server/server.ts`, replace the `take-snapshot` tool (lines ~199-208):
     ```ts
     mcpServer.tool(
       "take-snapshot",
       "Take an accessibility snapshot of a browser tab's page. Returns interactive elements each tagged with a stable uid (e.g. [uid=e12]) for the click/fill/hover tools; re-take after the page changes, as uids are reassigned. By default it now also captures visually-clickable elements (cursor:pointer, e.g. React <div onClick> cards) — set includePointer:false to suppress that, or maxInteractive to cap how many are added. Query modes: 'selector' returns exactly the CSS-selector matches (even non-interactive, e.g. selector:'[contenteditable]' for a chat box); 'textContains' returns the deepest elements whose visible text contains the string (case-insensitive). Scope with 'rootSelector' to collect only within one subtree (e.g. the main panel, excluding a huge sidebar), and page large results with 'offset'/'limit' (the reply reports total collected and whether more remain). verbose:true additionally includes headings and aria-labelled elements.",
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
         if (result.error) {
           return {
             content: [{ type: "text", text: `Snapshot error: ${result.error}` }],
             isError: true,
           };
         }
         const usedQuery =
           selector !== undefined ||
           textContains !== undefined ||
           rootSelector !== undefined ||
           offset !== undefined ||
           limit !== undefined;
         const truncHint = result.isTruncated
           ? "[snapshot truncated due to size]\n"
           : "";
         // Metadata footer only when a query/paging param was supplied, so the
         // default `take-snapshot {tabId}` output stays as-is (aside from the
         // by-design cursor:pointer additions). total/hasMore populate in Task 8.
         let meta = "";
         if (usedQuery && typeof result.total === "number") {
           meta =
             `[snapshot: ${result.total} element(s) collected` +
             `${result.hasMore ? ", more available — page with offset/limit" : ""}]\n`;
         }
         return { content: [{ type: "text", text: truncHint + meta + result.snapshot }] };
       }
     );
     ```

7. - [ ] **Impl — Chrome handler + content-script.** In `chrome-extension/message-handler.ts`, replace the `case "take-snapshot"` (lines ~217-219):
     ```ts
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
     ```
     and replace the `takeSnapshot` method (lines ~521-544):
     ```ts
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
     ```
     In `chrome-extension/content-script.ts`, replace the `case "buildSnapshot"` (lines ~244-251):
     ```ts
     case "buildSnapshot": {
       const o = message.options || {};
       const { tree, isTruncated, total, hasMore, error } = buildSnapshot(document, {
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
       sendResponse({ tree, isTruncated, total, hasMore, error });
       break;
     }
     ```

8. - [ ] **Impl — Firefox handler.** In `firefox-extension/message-handler.ts`, replace the `case "take-snapshot"` (lines ~248-249):
     ```ts
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
     ```
     and replace the `takeSnapshot` method (lines ~605-634):
     ```ts
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
     ```
     Note: the pre-existing Firefox take-snapshot test (lines ~574-612) mocks `executeScript` → `[{ tree, isTruncated: false }]` (no total/hasMore/error) and a plain `{ cmd:"take-snapshot", tabId, correlationId }` request. `JSON.stringify(snapshotOptions)` drops the `undefined` fields (serializes to `{"verbose":false,"maxLength":25000}`), and the conditional spreads omit `total`/`hasMore`/`error`, so the asserted resource is byte-identical — the test still passes.

9. - [ ] **Failing test (MCP wire round-trip).** Create `mcp-server/__tests__/take-snapshot-args.test.ts` using the same mock-extension harness as Task 2 step 12 (SECRET `"tsa-secret"`, browserId `"tsa-ext"`). Reply handler:
     ```ts
     ext = await startMockExtension(port, (req) => {
       lastReq = req;
       return {
         resource: "snapshot",
         correlationId: req.correlationId,
         tabId: (req as any).tabId,
         snapshot: 'textbox "Message input" [uid=e1]',
         isTruncated: false,
         total: 1,
         hasMore: false,
       };
     });
     ```
     Test:
     ```ts
     it("forwards the selector query field and surfaces total/hasMore", async () => {
       const result = await api.takeSnapshot(9, { selector: "[contenteditable]" });
       expect((lastReq as any).selector).toBe("[contenteditable]");
       expect(result.total).toBe(1);
       expect(result.hasMore).toBe(false);
       expect(result.snapshot).toContain("uid=e1");
     });
     ```

10. - [ ] **Run-to-pass + build:**
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/take-snapshot-args.test.ts && npm run build
      cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/snapshot-script.test.ts __tests__/message-handler.test.ts
      cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/snapshot-script.test.ts __tests__/message-handler.test.ts
      ```
      Expected: all PASS; the pre-existing Firefox `take-snapshot` handler test still green.

11. - [ ] Commit:
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp
      git add common mcp-server chrome-extension firefox-extension
      git commit -m "feat(snapshot): selector query mode + wire options/total/hasMore/error end-to-end"
      ```

---

### Task 6 — `textContains?: string` query mode (case-insensitive, leaf-preferring) (#2)

Return the **deepest** elements whose visible text contains the string (case-insensitive), even non-interactive. Composes (AND) with `selector`. Logic-only change to the injected `snapshot-script.ts` (plumbing done in Task 5).

**Files:**
- Modify both `injected/snapshot-script.ts` (identical).
- Modify both `__tests__/snapshot-script.test.ts`.

**Interfaces:**
- Produces: with `textContains`, candidates are the leaf elements whose `textContent` (lowercased) contains the needle; with `selector`+`textContains`, the selector matches filtered to those.

**Steps:**

1. - [ ] **Failing test (Firefox jsdom).** Add to `firefox-extension/__tests__/snapshot-script.test.ts`:
     ```ts
     describe("textContains query mode (Task 6)", () => {
       it("returns the deepest element whose visible text contains the string (case-insensitive)", () => {
         document.body.innerHTML = `
           <main><section><div id="open-card">Open</div></section></main>
           <p>unrelated</p>
         `;
         const { tree } = buildSnapshot(document, {
           verbose: false,
           maxLength: 25000,
           textContains: "open",
         });
         // The leaf #open-card matches; its ancestors (main/section) do NOT get
         // their own entry (deepest-wins).
         expect(tree).toMatch(/clickable "Open" \[uid=e\d+\]/);
         const clickableLines = (tree.match(/clickable "Open"/g) || []).length;
         expect(clickableLines).toBe(1);
         expect(tree).not.toContain("unrelated");
       });

       it("composes with selector (AND)", () => {
         document.body.innerHTML = `
           <button>Open settings</button>
           <button>Close</button>
           <div>Open (not a button)</div>
         `;
         const { tree } = buildSnapshot(document, {
           verbose: false,
           maxLength: 25000,
           selector: "button",
           textContains: "open",
         });
         expect(tree).toContain('button "Open settings"');
         expect(tree).not.toContain('button "Close"');
         expect(tree).not.toContain("not a button");
       });
     });
     ```

2. - [ ] **Run-to-fail:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/snapshot-script.test.ts -t "textContains query mode"
     ```
     Expected: FAIL — `textContains` is ignored.

3. - [ ] **Impl (both `snapshot-script.ts`).** Immediately after the `selectorMode` const (added in Task 5), add the text-mode helpers:
     ```ts
     const textMode =
       typeof options.textContains === "string" && options.textContains.length > 0;
     const textNeedle = textMode
       ? (options.textContains as string).toLowerCase()
       : "";
     function ownTextIncludesNeedle(el: Element): boolean {
       return (el.textContent || "").toLowerCase().indexOf(textNeedle) !== -1;
     }
     function isLeafTextMatch(el: Element): boolean {
       // Deepest-wins: reject if any DESCENDANT element also contains the needle.
       const kids = el.querySelectorAll("*");
       for (let k = 0; k < kids.length; k++) {
         if (ownTextIncludesNeedle(kids[k])) {
           return false;
         }
       }
       return true;
     }
     ```
     Then extend the candidate-selection block from Task 5. Replace:
     ```ts
     let candidates: Element[];
     if (selectorMode) {
       try {
         candidates = Array.prototype.slice.call(
           doc.querySelectorAll(options.selector as string)
         );
       } catch (e) {
         return { tree: "", isTruncated: false, total: 0, hasMore: false, error: "Invalid CSS selector: " + options.selector };
       }
     } else {
       candidates = Array.prototype.slice.call(doc.querySelectorAll(baseSelectorString));
     }
     ```
     with:
     ```ts
     let candidates: Element[];
     if (selectorMode) {
       try {
         candidates = Array.prototype.slice.call(
           doc.querySelectorAll(options.selector as string)
         );
       } catch (e) {
         return {
           tree: "",
           isTruncated: false,
           total: 0,
           hasMore: false,
           error: "Invalid CSS selector: " + options.selector,
         };
       }
     } else if (textMode) {
       // Text query mode with no selector scans all elements; the text filter and
       // leaf-preference below narrow it down.
       candidates = Array.prototype.slice.call(doc.querySelectorAll("*"));
     } else {
       candidates = Array.prototype.slice.call(
         doc.querySelectorAll(baseSelectorString)
       );
     }
     if (textMode) {
       candidates = candidates.filter(
         (el) => ownTextIncludesNeedle(el) && isLeafTextMatch(el)
       );
     }
     ```
     Finally extend the pointer-pass gate so text mode also skips it (query modes are self-contained):
     ```ts
     if (includePointer && !selectorMode && !textMode && win && typeof win.getComputedStyle === "function") {
     ```

4. - [ ] **Run-to-pass (Firefox), then mirror to Chrome.**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/snapshot-script.test.ts -t "textContains query mode"
     ```
     Expected: PASS. Apply the identical edit to `chrome-extension/injected/snapshot-script.ts`, copy the two tests into `chrome-extension/__tests__/snapshot-script.test.ts`, and run:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/snapshot-script.test.ts
     ```
     Expected: PASS.

5. - [ ] Commit:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     git add chrome-extension firefox-extension
     git commit -m "feat(snapshot): textContains query mode (case-insensitive, leaf-preferring)"
     ```

---

### Task 7 — `rootSelector?: string` region scoping (#3)

Collect only within the subtree of the first element matching `rootSelector`; a miss returns a clear `error`. Solves the 700-item-sidebar crowd-out by targeting the main panel. Logic-only change in the injected `snapshot-script.ts`.

**Files:**
- Modify both `injected/snapshot-script.ts` (identical).
- Modify both `__tests__/snapshot-script.test.ts`.
- Modify `mcp-server/__tests__/take-snapshot-args.test.ts` (add an error-forwarding assertion).

**Interfaces:**
- Produces: `rootSelector` scopes the base, selector, textContains, and pointer collections to the matched subtree; a miss → `{ tree:"", error: "rootSelector matched no element: …" }`.

**Steps:**

1. - [ ] **Failing test (Firefox jsdom).** Add to `firefox-extension/__tests__/snapshot-script.test.ts`:
     ```ts
     describe("rootSelector scoping (Task 7)", () => {
       it("collects only within the matched subtree, excluding a sibling sidebar", () => {
         document.body.innerHTML = `
           <nav id="sidebar"><a href="/1">Side 1</a><a href="/2">Side 2</a></nav>
           <main id="main-panel"><button>Main Action</button></main>
         `;
         const { tree } = buildSnapshot(document, {
           verbose: false,
           maxLength: 25000,
           rootSelector: "#main-panel",
         });
         expect(tree).toContain('button "Main Action"');
         expect(tree).not.toContain("Side 1");
         expect(tree).not.toContain("Side 2");
       });

       it("returns an error when rootSelector matches nothing", () => {
         document.body.innerHTML = `<button>X</button>`;
         const res = buildSnapshot(document, {
           verbose: false,
           maxLength: 25000,
           rootSelector: "#does-not-exist",
         });
         expect(res.error).toMatch(/rootSelector matched no element/);
         expect(res.tree).toBe("");
       });
     });
     ```

2. - [ ] **Run-to-fail:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/snapshot-script.test.ts -t "rootSelector scoping"
     ```
     Expected: FAIL — `rootSelector` is ignored; the sidebar links appear.

3. - [ ] **Impl (both `snapshot-script.ts`).** Immediately BEFORE the candidate-selection block (after the `textMode`/helpers from Task 6), resolve the scope root:
     ```ts
     // Region scoping: restrict collection to the subtree of the first element
     // matching rootSelector. A miss is an explicit, recoverable error. Name
     // resolution (getElementById/querySelector for labels) still uses `doc`.
     let root: ParentNode = doc;
     if (
       typeof options.rootSelector === "string" &&
       options.rootSelector.length > 0
     ) {
       let scoped: Element | null = null;
       try {
         scoped = doc.querySelector(options.rootSelector);
       } catch (e) {
         return {
           tree: "",
           isTruncated: false,
           total: 0,
           hasMore: false,
           error: "Invalid rootSelector: " + options.rootSelector,
         };
       }
       if (!scoped) {
         return {
           tree: "",
           isTruncated: false,
           total: 0,
           hasMore: false,
           error: "rootSelector matched no element: " + options.rootSelector,
         };
       }
       root = scoped;
     }
     ```
     Then swap the three collection sources from `doc` to `root`:
     - selector mode: `doc.querySelectorAll(options.selector as string)` → `root.querySelectorAll(options.selector as string)`
     - text mode: `doc.querySelectorAll("*")` → `root.querySelectorAll("*")`
     - base: `doc.querySelectorAll(baseSelectorString)` → `root.querySelectorAll(baseSelectorString)`

     And in the pointer pass, swap `const allEls = doc.querySelectorAll("*");` → `const allEls = root.querySelectorAll("*");` (Chrome line ~369 / Firefox line ~370).

     Leave the stale-uid clear (`doc.querySelectorAll("[" + UID_ATTR + "]")`, lines ~288-291) on `doc` — stale uids anywhere must be cleared, not just within the root.

4. - [ ] **Run-to-pass (Firefox), then mirror to Chrome.**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/snapshot-script.test.ts -t "rootSelector scoping"
     ```
     Expected: PASS. Mirror the edit into `chrome-extension/injected/snapshot-script.ts`, copy the two tests into the Chrome test file, and run:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/snapshot-script.test.ts
     ```
     Expected: PASS.

5. - [ ] **Add error-forwarding assertion (MCP wire).** In `mcp-server/__tests__/take-snapshot-args.test.ts`, make the mock extension branch on `rootSelector` so a miss returns an `error` reply, and assert `api.takeSnapshot` surfaces it. Update the reply handler:
     ```ts
     ext = await startMockExtension(port, (req) => {
       lastReq = req;
       if ((req as any).rootSelector === "#missing") {
         return {
           resource: "snapshot",
           correlationId: req.correlationId,
           tabId: (req as any).tabId,
           snapshot: "",
           isTruncated: false,
           total: 0,
           hasMore: false,
           error: "rootSelector matched no element: #missing",
         };
       }
       return {
         resource: "snapshot",
         correlationId: req.correlationId,
         tabId: (req as any).tabId,
         snapshot: 'textbox "Message input" [uid=e1]',
         isTruncated: false,
         total: 1,
         hasMore: false,
       };
     });
     ```
     Add the test:
     ```ts
     it("surfaces a rootSelector miss as an error field", async () => {
       const result = await api.takeSnapshot(9, { rootSelector: "#missing" });
       expect((lastReq as any).rootSelector).toBe("#missing");
       expect(result.error).toMatch(/rootSelector matched no element/);
     });
     ```

6. - [ ] **Run-to-pass + build:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/take-snapshot-args.test.ts && npm run build
     ```
     Expected: PASS; build OK.

7. - [ ] Commit:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     git add chrome-extension firefox-extension mcp-server
     git commit -m "feat(snapshot): rootSelector region scoping with clear no-match error"
     ```

---

### Task 8 — `offset?`/`limit?` paging + append-only `total`/`hasMore` metadata (#3)

Page over the collected candidate lines (in DOM order) **before** the char-budget cut, and report `total`/`hasMore`. The server metadata footer (wired in Task 5) now activates because `total` is populated. Logic-only change in the injected `snapshot-script.ts`.

**Files:**
- Modify both `injected/snapshot-script.ts` (identical) — the join/truncate tail (Chrome lines ~434-446 / Firefox lines ~435-447).
- Modify both `__tests__/snapshot-script.test.ts`.
- Modify `mcp-server/__tests__/take-snapshot-args.test.ts` (paging assertion).

**Interfaces:**
- Produces: `{ tree, isTruncated, total, hasMore }` where `total` = full collected-candidate count, and `hasMore` = elements remain beyond this page (or the char budget truncated).

**Steps:**

1. - [ ] **Failing test (Firefox jsdom).** Add to `firefox-extension/__tests__/snapshot-script.test.ts`:
     ```ts
     describe("offset/limit paging + total/hasMore (Task 8)", () => {
       function tenButtons() {
         let html = "";
         for (let i = 0; i < 10; i++) html += `<button>Btn ${i}</button>`;
         document.body.innerHTML = html;
       }

       it("reports total across the full candidate list", () => {
         tenButtons();
         const res = buildSnapshot(document, { verbose: false, maxLength: 25000 });
         expect(res.total).toBe(10);
         expect(res.hasMore).toBe(false);
       });

       it("returns only the requested page and sets hasMore when more remain", () => {
         tenButtons();
         const res = buildSnapshot(document, {
           verbose: false,
           maxLength: 25000,
           offset: 0,
           limit: 3,
         });
         expect(res.total).toBe(10);
         expect(res.hasMore).toBe(true);
         const lines = res.tree.split("\n").filter(Boolean);
         expect(lines.length).toBe(3);
         expect(res.tree).toContain('button "Btn 0"');
         expect(res.tree).toContain('button "Btn 2"');
         expect(res.tree).not.toContain('button "Btn 3"');
       });

       it("pages from an offset and clears hasMore on the last page", () => {
         tenButtons();
         const res = buildSnapshot(document, {
           verbose: false,
           maxLength: 25000,
           offset: 8,
           limit: 5,
         });
         expect(res.total).toBe(10);
         expect(res.hasMore).toBe(false);
         const lines = res.tree.split("\n").filter(Boolean);
         expect(lines.length).toBe(2); // items 8 and 9
         expect(res.tree).toContain('button "Btn 8"');
         expect(res.tree).toContain('button "Btn 9"');
       });
     });
     ```

2. - [ ] **Run-to-fail:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/snapshot-script.test.ts -t "offset/limit paging"
     ```
     Expected: FAIL — no paging, no `total`/`hasMore`.

3. - [ ] **Impl (both `snapshot-script.ts`).** Replace the final join/truncate block (Chrome lines ~434-446 / Firefox lines ~435-447):
     ```ts
     // --- 6c. page over the collected candidate lines (before the char cut) ---
     const total = lines.length;
     const offset =
       typeof options.offset === "number" && options.offset > 0
         ? Math.floor(options.offset)
         : 0;
     const hasLimit = typeof options.limit === "number" && options.limit >= 0;
     const limit = hasLimit ? Math.floor(options.limit as number) : undefined;
     let pagedLines = lines;
     if (offset > 0 || limit !== undefined) {
       pagedLines = lines.slice(
         offset,
         limit !== undefined ? offset + limit : undefined
       );
     }
     const moreAfterPage = offset + pagedLines.length < total;

     // --- 7. join and truncate ---
     const full = pagedLines.join("\n");
     if (full.length > maxLength) {
       // Truncate to the last COMPLETE line so no `[uid=eN]` token is cut.
       const sliced = full.slice(0, maxLength);
       const lastNewline = sliced.lastIndexOf("\n");
       const tree = lastNewline >= 0 ? sliced.slice(0, lastNewline) : "";
       // The char cut dropped lines too, so more content exists either way.
       return { tree: tree, isTruncated: true, total: total, hasMore: true };
     }
     return { tree: full, isTruncated: false, total: total, hasMore: moreAfterPage };
     ```

4. - [ ] **Run-to-pass (Firefox), then mirror to Chrome.**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/snapshot-script.test.ts
     ```
     Expected: PASS — the new paging tests plus every pre-existing truncation test (they now also carry `total`/`hasMore`, which those tests don't assert on, so they stay green). Mirror the edit into `chrome-extension/injected/snapshot-script.ts`, copy the three paging tests into the Chrome test file, and run:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/snapshot-script.test.ts
     ```
     Expected: PASS.

5. - [ ] **Paging assertion (MCP wire).** In `mcp-server/__tests__/take-snapshot-args.test.ts`, add a branch to the mock extension for `limit` and assert forwarding + the server metadata footer. Extend the reply handler's default branch to echo paging when present:
     ```ts
     if (typeof (req as any).limit === "number") {
       return {
         resource: "snapshot",
         correlationId: req.correlationId,
         tabId: (req as any).tabId,
         snapshot: 'button "Btn 0" [uid=e1]',
         isTruncated: false,
         total: 10,
         hasMore: true,
       };
     }
     ```
     Add the test (drives the tool handler indirectly via `browser-api`, asserting the frame carries paging and the reply surfaces `total`/`hasMore`):
     ```ts
     it("forwards offset/limit and surfaces total/hasMore for paging", async () => {
       const result = await api.takeSnapshot(9, { offset: 0, limit: 3 });
       expect((lastReq as any).offset).toBe(0);
       expect((lastReq as any).limit).toBe(3);
       expect(result.total).toBe(10);
       expect(result.hasMore).toBe(true);
     });
     ```

6. - [ ] **Run-to-pass + full build:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/take-snapshot-args.test.ts && npm run build
     cd /Users/balakumar/personal/browser-control-mcp && npx nx run-many --target=build --all --parallel
     ```
     Expected: all PASS; the Nx `build` target succeeds for mcp-server + firefox-extension (chrome-extension builds via `npm run package --prefix chrome-extension`, run it separately if needed).

7. - [ ] Commit:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     git add chrome-extension firefox-extension mcp-server
     git commit -m "feat(snapshot): offset/limit paging over candidates with total/hasMore metadata"
     ```

---

### Task 9 — mcpkit skill docs for the Phase-1 additions

Update the FoxPilot tool docs so the model can discover the new params. The canonical source is the `mcpServer.tool(...)` descriptions in `mcp-server/server.ts` (already updated in Tasks 2/3/5). The `mcpkit-foxpilot` **SKILL.md is generated from those descriptions** — running `mcpkit update foxpilot` (or `mcpkit sync foxpilot --force`) regenerates it. This task both (a) documents that regeneration step and (b) provides exact prose to hand-edit the three entries if regeneration is not run.

> **Note:** the skill lives OUTSIDE the repo at `~/.claude/skills/mcpkit-foxpilot/SKILL.md`. It currently documents 27 tools but is **missing** `get-cookies`, `browser-fetch`, `stream-*`, and `capture-response-bodies` (they were added after the last generation). Regenerating picks all of these up. Editing by hand only touches the three Phase-1 tools.

**Files:**
- Modify `~/.claude/skills/mcpkit-foxpilot/SKILL.md`.

**Interfaces:** documentation only — no code, no tests.

**Steps:**

1. - [ ] **Preferred path — regenerate from the updated server descriptions.** After Tasks 2/3/5 are merged and `mcp-server` is rebuilt, bounce the runtime and regenerate:
     ```bash
     mcpkit runtime stop foxpilot 2>/dev/null || true
     mcpkit update foxpilot        # re-discovers tools + regenerates SKILL.md
     mcpkit view foxpilot          # confirm the server config
     grep -n "names\|textContains\|rootSelector\|string\[\]\|offset" ~/.claude/skills/mcpkit-foxpilot/SKILL.md | head
     ```
     Expected: the regenerated SKILL.md now shows the new `take-snapshot` params (`includePointer`, `maxInteractive`, `selector`, `textContains`, `rootSelector`, `offset`, `limit`), the `wait-for-text` array note, and a `get-cookies` entry with `names`.

2. - [ ] **Fallback path — hand-edit the three entries** (use only if `mcpkit update` is unavailable). In `~/.claude/skills/mcpkit-foxpilot/SKILL.md`:

     a. Replace the `### take-snapshot` parameter table (lines ~214-224) with:
     ```markdown
     **Parameters:**

     | Param | Type | Required | Description |
     |-------|------|----------|-------------|
     | `tabId` | number | Yes |  |
     | `verbose` | boolean | No | Also include headings and aria-labelled elements |
     | `includePointer` | boolean | No | Capture cursor:pointer elements (e.g. React `<div onClick>` cards). Default true — set false to suppress |
     | `maxInteractive` | number | No | Cap on how many cursor:pointer elements to add (default 500) |
     | `selector` | string | No | Query mode: return exactly the CSS-selector matches (even non-interactive), e.g. `[contenteditable]` for a chat box |
     | `textContains` | string | No | Query mode: return the deepest elements whose visible text contains this string (case-insensitive) |
     | `rootSelector` | string | No | Scope collection to the first matching element's subtree (e.g. the main panel, excluding a huge sidebar); errors if it matches nothing |
     | `offset` | number | No | Paging: skip this many collected candidates before the char-budget cut |
     | `limit` | number | No | Paging: return at most this many candidates. The reply reports total collected and whether more remain |

     **Usage:**
     ```bash
     mcpkit call foxpilot take-snapshot '{"tabId": 0}'
     mcpkit call foxpilot take-snapshot '{"tabId": 0, "selector": "[contenteditable]"}'
     mcpkit call foxpilot take-snapshot '{"tabId": 0, "textContains": "Open"}'
     mcpkit call foxpilot take-snapshot '{"tabId": 0, "rootSelector": "#main-panel", "offset": 0, "limit": 100}'
     ```
     ```

     b. Replace the `### wait-for-text` parameter table (lines ~319-330) with:
     ```markdown
     **Parameters:**

     | Param | Type | Required | Description |
     |-------|------|----------|-------------|
     | `tabId` | number | Yes |  |
     | `text` | string \| string[] | Yes | A single string, OR an array — with an array it resolves as soon as ANY appears and reports which one matched |
     | `timeoutMs` | number | No |  |

     **Usage:**
     ```bash
     mcpkit call foxpilot wait-for-text '{"tabId": 0, "text": "Ready"}'
     mcpkit call foxpilot wait-for-text '{"tabId": 0, "text": ["Ready", "Error", "Timed out"]}'
     ```
     ```

     c. Add a new `### get-cookies` section (immediately after the `### emulate` block, ~line 498, keeping the file's ordering) — the tool is currently undocumented:
     ```markdown
     ### get-cookies

     Read the browser's cookie jar INCLUDING httpOnly cookies (which document.cookie cannot see). Runs in the extension background, so the visited page's CSP does not apply. Narrow with 'url', 'domain', a single 'name', and/or 'names' (an array of cookie names — the union is returned); omit all to return every cookie the extension is permitted to see. Requires Automation Mode + host permission for the domain. Cookie values are sensitive — handle with care.

     **Parameters:**

     | Param | Type | Required | Description |
     |-------|------|----------|-------------|
     | `url` | string | No | Restrict to cookies readable for this URL |
     | `domain` | string | No | Restrict to this domain |
     | `name` | string | No | A single cookie name |
     | `names` | string[] | No | Multiple cookie names (union with `name` if both given) |

     **Usage:**
     ```bash
     mcpkit call foxpilot get-cookies '{"url": "https://example.com", "names": ["session", "csrf"]}'
     ```
     ```

     d. Update the top-of-file "When to Use" bullets: change the `take-snapshot` bullet (line ~26) to mention selector/textContains/rootSelector/paging, change the `wait-for-text` bullet (line ~33) to note `string | string[]`, and add a `get-cookies` bullet.

3. - [ ] **Verify** the edits are present:
     ```bash
     grep -n "textContains\|rootSelector\|string\[\]\|get-cookies\|names" ~/.claude/skills/mcpkit-foxpilot/SKILL.md | head
     ```
     Expected: matches for `take-snapshot` new params, the `wait-for-text` array note, and the new `get-cookies` entry.

4. - [ ] **No commit inside the repo for the skill file** (it lives under `~/.claude`, outside the repo). If the repo also carries user-facing docs you updated (optional — e.g. `README.md`), commit those:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     git add -A
     git status --porcelain   # confirm only intended files
     git commit -m "docs(mcpkit-foxpilot): document Phase-1 take-snapshot/wait-for-text/get-cookies params" --allow-empty
     ```

---

## Appendix — verification matrix (what each task proves)

| Capability | jsdom unit (predicate) | extension handler | MCP wire round-trip | build |
|-----------|------------------------|-------------------|---------------------|-------|
| #7 wait-for-text array | — | Task 2 (both) | Task 2 (`wait-for-text-arg`) | Task 2 |
| #5 get-cookies names[] | — | (browser-http, both) | Task 3 (`get-cookies-names`) | Task 3 |
| #2 includePointer/maxInteractive | Task 4 (both) | — | — | Task 4 |
| #2 selector | Task 5 (both) | Task 5 threading | Task 5 (`take-snapshot-args`) | Task 5 |
| #2 textContains | Task 6 (both) | — | — | Task 6 |
| #3 rootSelector | Task 7 (both) | — | Task 7 (error field) | Task 7 |
| #3 offset/limit + total/hasMore | Task 8 (both) | — | Task 8 (paging) | Task 8 |

## Appendix — reconciliation notes (spec vs. real code)

- **§4.B "verbose-only" pointer pass → default-on.** Confirmed the pass is currently gated on `verbose` with a hard `MAX_CLICKABLES=300`. Flipping it to `includePointer` (default true) **changes the default snapshot output** and **breaks one existing test** (`firefox-extension/__tests__/snapshot-script.test.ts`, "captures a non-semantic div with inline cursor:pointer as a clickable (verbose only)"). Task 4 updates that test — this is the deliberate §9.7 decision, not a regression.
- **§4.C `ok:false` on rootSelector miss.** `SnapshotExtensionMessage` has **no `ok` field**. Implemented as an append-only `error?: string` on the snapshot message; `server.ts` turns a non-empty `error` into `isError: true`. Documented in Task 5/7.
- **Chrome vs Firefox snapshot injection differ.** Chrome routes through a **persistent content-script** (`content-script.ts` `case "buildSnapshot"`), so Chrome snapshot tasks touch `content-script.ts` in addition to `message-handler.ts`; Firefox injects the stringified `buildSnapshot` via `executeScript`, so only its `message-handler.ts` changes. Both were wired in Task 5.
- **Chrome had no `snapshot-script.test.ts`.** Only Firefox shipped one. Task 4 **creates** the Chrome copy so both byte-identical `snapshot-script.ts` files are independently covered.
- **`wait-for-text` back-compat.** Returning `matched` unconditionally would break the two existing Firefox tests (they assert an exact `{resource, correlationId, found}` object). Fixed by attaching `matched` **only when the input is an array** — the plain-string path is byte-identical.
