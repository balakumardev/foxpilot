# FoxPilot SPA Interaction — Phase 2 (Isolated Eval + Synthetic Coordinate/Scroll Tools + Screenshot Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the still-covert-safe Phase 2 of the CSP-strict-SPA interaction design (spec §8): (#4) `evaluate-script` gains `world?: "main" | "isolated"`; (#1) the coordinate tools `click-at` / `type-at` / `hover-at` / `scroll-at` land on the **synthetic** engine only (isolated-world `document.elementFromPoint` → the existing action sequences), each returning a `point-action-result` element descriptor; (#6) the scroll tools `scroll-to` / `scroll-into-view` are exposed and the full-page screenshot stitch is hardened (empty-readback validation + retry/backoff + viewport fallback + a real `"image readback failed"` error). Plus the mcpkit skill docs. Builds directly on Phase 1 (already merged on `feat/spa-interaction`).

**Architecture:** Six brand-new `cmd`s (`click-at`, `type-at`, `hover-at`, `scroll-at`, `scroll-to`, `scroll-into-view`) plus one new **optional field** on the existing `evaluate-script` cmd. Every new cmd flows through the full add-a-tool chain: `common/server-messages.ts` (request interface + `ServerMessage` union) → `common/extension-messages.ts` (a new `point-action-result` reply type + union) → `mcp-server/server.ts` (zod tool) → `mcp-server/browser-api.ts` (frame) → broker (transparent) → BOTH `{chrome,firefox}-extension/extension-config.ts` (`AVAILABLE_TOOLS` + `COMMAND_TO_TOOL_ID` + `AUTOMATION_COMMANDS`) → BOTH `{chrome,firefox}-extension/message-handler.ts` (`switch` case + handler; the `default:`'s `const _exhaustiveCheck: never = req` forces a case in both). The coordinate/scroll page work runs in the CSP-immune **ISOLATED** content-script world via a NEW self-contained injected module `injected/point-action-script.ts` — Chrome imports it into the persistent content script and calls it directly; Firefox stringifies it via `browser.tabs.executeScript`. **Synthetic engine ONLY — no `chrome.debugger`, no CDP, no sidecar, no `engine` param.** The `engine:"cdp"` trusted tier is Phase 3 (it will add an OPTIONAL `engine` param, backward-compatibly). Both extensions are mirrored; the injected module is byte-identical across the two.

**Tech Stack:** TypeScript, esbuild, Jest (ts-jest + jsdom), Nx monorepo.

## Global Constraints
- **Node** `>=22` (mcp-server `engines.node`); extensions target the browser runtime. **zod 4.3.6** — for any map param use the two-arg `z.record(z.string(), z.string())`. **Phase 2 needs none**: every new param is `z.number()` / `z.string()` / `z.enum(...)` / `z.boolean()`.
- **Synthetic / isolated-world only — covert.** No `chrome.debugger`, no CDP `Input.*`, no native sidecar, no automation banner. The coordinate/scroll tools are pure DOM ops (`document.elementFromPoint`, `dispatchEvent`, `scrollBy`, `scrollIntoView`) in the ISOLATED content-script world — CSP-immune because they never `eval` and never inject a page-world `<script>`. **Do NOT add an `engine` param in Phase 2** (that is Phase 3's optional, back-compatible addition).
- **Mirror both extensions.** Show the complete Chrome code, then the concrete Firefox delta. Chrome messages a persistent content script (`content-script.ts` `case`s → imported functions); Firefox injects via `browser.tabs.executeScript(tabId, { code: \`(${fn.toString()})(document, ...)\` })`. The new `injected/point-action-script.ts` is kept byte-identical across the two and MUST stay fully self-contained (inner helpers only — enforced by `firefox-extension/__tests__/self-containment.test.ts`).
- **Backward compatible.** `evaluate-script` still defaults to `world:"main"` (the current page-world `<script>` path). All new response fields (`element`, `warning`) are append-only and conditionally spread. No existing tool changes signature or default behavior.
- **New-cmd tripwire discipline.** Each of the six new `cmd`s is added to the `ServerMessage` union AND given a `case` in BOTH `message-handler.ts` switches in the SAME task (the `const _exhaustiveCheck: never = req` default fails to compile otherwise), AND registered in BOTH `extension-config.ts` (`AVAILABLE_TOOLS` entry + `COMMAND_TO_TOOL_ID` key + `AUTOMATION_COMMANDS` — all are page-controlling).
- **jsdom caveat (coordinate tests).** jsdom has NO layout engine: `document.elementFromPoint(x,y)` returns `null` and `getBoundingClientRect()` returns zeros. Every coordinate test MUST stub `document.elementFromPoint` (e.g. `document.elementFromPoint = jest.fn(() => el)`) and MUST NOT assert specific `rect` values (the descriptor `rect` is `{x:0,y:0,w:0,h:0}` under jsdom).
- **Chrome `ok:false` is a RESULT here, not a tool-error.** The existing `sendMessageToTab` THROWS when a content-script reply is `{ok:false, error}` (its `checkResult` guard). For the coordinate/scroll tools an off-point / stale-uid `ok:false` is a legitimate result to report (spec §4.A), so Task 2 adds a `sendMessageToTabRaw` helper (same inject-retry, no throw) that the new handlers use.

## File Structure

Legend: **[C]** create, **[M]** modify.

| Path | Task(s) | Responsibility |
|------|---------|----------------|
| `common/server-messages.ts` | 1,2,3,4,5,6 [M] | `EvaluateScriptServerMessage.world?`; `ClickAt`/`TypeAt`/`HoverAt`/`ScrollAt`/`ScrollTo`/`ScrollIntoView` `ServerMessage` interfaces + union entries |
| `common/extension-messages.ts` | 2,7 [M] | `PointElementDescriptor` + `PointActionResultExtensionMessage` + union; `ScreenshotExtensionMessage.warning?` |
| `mcp-server/server.ts` | 1,2,3,4,5,6,7 [M] | `evaluate-script` `world` param; `click-at`/`type-at`/`hover-at`/`scroll-at`/`scroll-to`/`scroll-into-view` tools; `formatPointResult` helper; screenshot `warning` surfacing |
| `mcp-server/browser-api.ts` | 1,2,3,4,5,6 [M] | `evaluateScript` `world`; `clickAt`/`typeAt`/`hoverAt`/`scrollAt`/`scrollTo`/`scrollIntoView` client methods |
| `chrome-extension/injected/point-action-script.ts` | 2,3,4,5,6 [C] | `performPointAction` (click-at→scroll-at), `scrollWindowTo`, `scrollElementIntoView`, `PointElementDescriptor` |
| `firefox-extension/injected/point-action-script.ts` | 2,3,4,5,6 [C] | identical byte-for-byte to the Chrome copy |
| `chrome-extension/injected/page-world.ts` | 1 [M] | `evalInIsolatedWorld(functionSource, args)` (isolated-world eval via `new Function`; CSP-degrade) |
| `firefox-extension/injected/page-world.ts` | 1 [M] | `buildIsolatedEvalCode(functionSource, args)` (pure code-string builder; `executeScript`-compiled, no runtime eval) |
| `chrome-extension/injected/screenshot-script.ts` | 7 [M] | `isValidCapture(dataUrl)` pure guard |
| `firefox-extension/injected/screenshot-script.ts` | 7 [M] | identical `isValidCapture(dataUrl)` |
| `chrome-extension/content-script.ts` | 1,2,6 [M] | `case`s: `evaluateScriptIsolated`, `performPointAction`, `scrollWindowTo`, `scrollElementIntoView` |
| `chrome-extension/message-handler.ts` | 1,2,3,4,5,6,7 [M] | switch cases + `runPointAction`/`scrollWindow`/`scrollIntoViewByUid` handlers; `evaluateScript` world branch; `sendMessageToTabRaw`; `captureWindowWithRetry` + hardened `captureFullPage` |
| `firefox-extension/message-handler.ts` | 1,2,3,4,5,6,7 [M] | mirror: switch cases + handlers (`executeScript`-stringified injection); `evaluateScript` world branch; `captureWindowWithRetry` + hardened `captureFullPage` |
| `chrome-extension/extension-config.ts` | 2,3,4,5,6 [M] | `AVAILABLE_TOOLS` + `COMMAND_TO_TOOL_ID` + `AUTOMATION_COMMANDS` for the 6 new cmds |
| `firefox-extension/extension-config.ts` | 2,3,4,5,6 [M] | identical config entries |
| `chrome-extension/__tests__/point-action-script.test.ts` | 2,3,4,5,6 [C] | jsdom unit tests for `performPointAction`/`scrollWindowTo`/`scrollElementIntoView` (stub `elementFromPoint`) |
| `firefox-extension/__tests__/point-action-script.test.ts` | 2,3,4,5,6 [C] | identical jsdom unit tests |
| `firefox-extension/__tests__/self-containment.test.ts` | 2,6 [M] | register `performPointAction`, `scrollWindowTo`, `scrollElementIntoView` in `INJECTED_FUNCTIONS` |
| `chrome-extension/__tests__/message-handler.test.ts` | 1,2,3,4,5,6,7 [M] | handler tests: isolated-eval routing; coordinate/scroll `sendResourceToServer`; screenshot hardening |
| `firefox-extension/__tests__/message-handler.test.ts` | 1,2,3,4,5,6,7 [M] | mirror handler tests (`executeScript` injection asserts) |
| `firefox-extension/__tests__/page-world.test.ts` | 1 [M] | `buildIsolatedEvalCode` unit tests |
| `chrome-extension/__tests__/page-world.test.ts` | 1 [C] | `evalInIsolatedWorld` unit tests (Chrome copy) |
| `mcp-server/__tests__/evaluate-script-world.test.ts` | 1 [C] | broker round-trip: `evaluateScript` forwards `world:"isolated"` |
| `mcp-server/__tests__/coordinate-tools.test.ts` | 2,3,4,5,6 [C] | broker round-trip: `-at` + scroll tools forward coords, surface `point-action-result`/`action-result` |
| `~/.claude/skills/mcpkit-foxpilot/SKILL.md` | 8 [M] | mcpkit skill docs for the new tools + `evaluate-script` `world` (outside the repo) |

---

### Task 1 — `evaluate-script` gains `world?: "main" | "isolated"` (#4)

Add an optional `world` param. `"main"` (default) is the current page-world `<script>` path (sees the page's real `window`; blockable by a strict CSP). `"isolated"` runs the function in the extension's ISOLATED content-script world (CSP-immune; sees the DOM/rects/non-httpOnly `document.cookie` but NOT the page's JS globals), synchronously. **The two browsers reach "isolated" by DIFFERENT mechanisms** (see the reconciliation note): Firefox embeds the source into a code string that `browser.tabs.executeScript` COMPILES (no runtime `eval`, genuinely CSP-immune); Chrome MV3 has no `code:` injection API, so it compiles via `new Function` in the isolated content-script world — which Chrome's isolated-world extension CSP blocks by default, so the Chrome path degrades with a clear error when eval is unavailable (jsdom, having no CSP, exercises the success path).

**Files:**
- Modify `common/server-messages.ts` — `EvaluateScriptServerMessage`.
- Modify `chrome-extension/injected/page-world.ts` — add `evalInIsolatedWorld`.
- Modify `firefox-extension/injected/page-world.ts` — add `buildIsolatedEvalCode`.
- Modify `chrome-extension/content-script.ts` — add `case "evaluateScriptIsolated"`.
- Modify `chrome-extension/message-handler.ts` — `evaluateScript` world branch (+ import).
- Modify `firefox-extension/message-handler.ts` — `evaluateScript` world branch (+ import).
- Modify `mcp-server/browser-api.ts` — `evaluateScript(tabId, fn, args?, world?)`.
- Modify `mcp-server/server.ts` — `evaluate-script` tool schema/description.
- Create `chrome-extension/__tests__/page-world.test.ts`; modify `firefox-extension/__tests__/page-world.test.ts`.
- Modify both `__tests__/message-handler.test.ts`.
- Create `mcp-server/__tests__/evaluate-script-world.test.ts`.

**Interfaces:**
- Consumes (MCP): `evaluate-script { tabId, function, args?, world?: "main"|"isolated" }`.
- Produces (extension): the existing `EvalResultExtensionMessage { resource:"eval-result"; ok; value?; error? }`.
- Internal: `evalInIsolatedWorld(functionSource, args) => { ok; value?; error? }` (Chrome); `buildIsolatedEvalCode(functionSource, args) => string` (Firefox).

**Steps:**

1. - [ ] **Impl — message type.** In `common/server-messages.ts`, replace `EvaluateScriptServerMessage`:
     ```ts
     export interface EvaluateScriptServerMessage extends ServerMessageBase {
       cmd: "evaluate-script";
       tabId: number;
       function: string;
       args?: unknown[];
       // Which JS world to run in. "main" (default) injects a page-world <script>
       // (sees the page's real window/globals; blockable by a strict page CSP).
       // "isolated" runs in the extension's isolated content-script world
       // (CSP-immune; sees the DOM but not page-JS globals; synchronous — a
       // returned Promise is not awaited). Back-compat default is "main".
       world?: "main" | "isolated";
     }
     ```

2. - [ ] **Failing test (Firefox builder).** In `firefox-extension/__tests__/page-world.test.ts`, add:
     ```ts
     import { buildIsolatedEvalCode } from "../injected/page-world";

     describe("buildIsolatedEvalCode (Task 1)", () => {
       it("embeds the source as a compiled expression (no runtime eval/Function)", () => {
         const code = buildIsolatedEvalCode("() => document.title", []);
         expect(code).toContain("() => document.title");
         expect(code).not.toContain("eval(");
         expect(code).not.toContain("new Function");
       });

       it("produces a runnable sync IIFE that returns {ok,value}", () => {
         document.body.innerHTML = `<div id="x">hi</div>`;
         const code = buildIsolatedEvalCode(
           "(sel) => document.querySelector(sel).textContent",
           ["#x"]
         );
         // executeScript would return the IIFE's value; emulate that with eval here
         // (the TEST env has no CSP — this only validates the emitted logic).
         const result = eval(code);
         expect(result).toEqual({ ok: true, value: "hi" });
       });

       it("reports a Promise return as an unsupported-async ok:false", () => {
         const code = buildIsolatedEvalCode("() => Promise.resolve(1)", []);
         const result = eval(code);
         expect(result.ok).toBe(false);
         expect(result.error).toMatch(/synchronous/i);
       });
     });
     ```
     Then:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/page-world.test.ts -t "buildIsolatedEvalCode"
     ```
     Expected: FAIL — `buildIsolatedEvalCode` does not exist yet.

3. - [ ] **Impl — Firefox builder.** In `firefox-extension/injected/page-world.ts`, add after `buildEvalPageScript` (it reuses the existing module-level `jsonForScript`; the builder is called in the background and its OUTPUT never references `jsonForScript`, so this is safe exactly like `buildEvalPageScript`):
     ```ts
     /**
      * Builds the ISOLATED-world eval code string for `evaluate-script world:"isolated"`.
      *
      * Unlike buildEvalPageScript (which injects a page-world <script>, blockable by
      * a strict page CSP), this string is handed to `browser.tabs.executeScript`,
      * which COMPILES it in the isolated content-script world — there is no runtime
      * `eval()`/`Function()` call, so the extension CSP never triggers and the page
      * CSP never applies to the isolated world (the same mechanism the snapshot
      * injection uses). SYNCHRONOUS: a returned Promise cannot be awaited here, so it
      * is reported as ok:false (use world:"main" for async).
      *
      * `functionSource` is embedded RAW (it is arbitrary code by the tool's
      * contract); a syntax error surfaces as a rejected executeScript, handled by
      * the caller. `args` is JSON-encoded via jsonForScript.
      */
     export function buildIsolatedEvalCode(
       functionSource: string,
       args: unknown[]
     ): string {
       return (
         "(function () {" +
         "try {" +
         "var __args = " +
         jsonForScript(args) +
         ";" +
         "var __fn = (" +
         functionSource +
         ");" +
         "var __r = (typeof __fn === 'function') ? __fn.apply(null, __args) : __fn;" +
         "if (__r && typeof __r.then === 'function') {" +
         "return { ok:false, error: 'isolated-world evaluation is synchronous and cannot await a Promise \\u2014 use world:\"main\" for async results.' };" +
         "}" +
         "var __out;" +
         "if (__r === undefined) { __out = null; }" +
         "else { try { __out = JSON.parse(JSON.stringify(__r)); } catch (e) { __out = String(__r); } }" +
         "return { ok:true, value: __out };" +
         "} catch (err) {" +
         "return { ok:false, error: String(err && err.message || err) };" +
         "}" +
         "})();"
       );
     }
     ```
     Re-run step 2's command → PASS.

4. - [ ] **Failing test (Chrome evaluator).** Create `chrome-extension/__tests__/page-world.test.ts`:
     ```ts
     import { evalInIsolatedWorld } from "../injected/page-world";

     // jsdom has NO Content-Security-Policy, so `new Function` works here and these
     // tests exercise the SUCCESS path. On real Chrome MV3 the isolated-world
     // extension CSP blocks new Function; that failure is caught and reported as a
     // clear ok:false (see the try/catch's CSP branch) — not reproducible in jsdom.
     describe("evalInIsolatedWorld (chrome, Task 1)", () => {
       afterEach(() => {
         document.body.innerHTML = "";
       });

       it("evaluates a function expression against the DOM and returns ok/value", () => {
         document.body.innerHTML = `<div id="x">hi</div>`;
         const r = evalInIsolatedWorld(
           "(sel) => document.querySelector(sel).textContent",
           ["#x"]
         );
         expect(r).toEqual({ ok: true, value: "hi" });
       });

       it("maps a top-level undefined to null", () => {
         const r = evalInIsolatedWorld("() => undefined", []);
         expect(r).toEqual({ ok: true, value: null });
       });

       it("reports a Promise return as an unsupported-async ok:false", () => {
         const r = evalInIsolatedWorld("() => Promise.resolve(1)", []);
         expect(r.ok).toBe(false);
         expect(r.error).toMatch(/synchronous/i);
       });

       it("reports a thrown error as ok:false", () => {
         const r = evalInIsolatedWorld("() => { throw new Error('boom'); }", []);
         expect(r.ok).toBe(false);
         expect(r.error).toContain("boom");
       });
     });
     ```
     Then:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/page-world.test.ts
     ```
     Expected: FAIL — `evalInIsolatedWorld` does not exist.

5. - [ ] **Impl — Chrome evaluator.** In `chrome-extension/injected/page-world.ts`, add after `buildEvalPageScript` (this is imported and called directly by the content script — it is NOT stringified/injected, so `new Function` is fine and the self-containment rule does not apply):
     ```ts
     /**
      * Runs `evaluate-script world:"isolated"` in Chrome's isolated content-script
      * world. There is no MV3 `code:` injection API, so the only way to compile an
      * arbitrary source string is `new Function`. Chrome's DEFAULT isolated-world
      * extension CSP (`script-src 'self' 'wasm-unsafe-eval'`) BLOCKS eval/new
      * Function, so on stable Chrome this throws an EvalError — caught below and
      * reported as a clear, recoverable ok:false (never silent). SYNCHRONOUS: a
      * returned Promise cannot be awaited, so it is reported as ok:false.
      */
     export function evalInIsolatedWorld(
       functionSource: string,
       args: unknown[]
     ): { ok: boolean; value?: unknown; error?: string } {
       try {
         const factory = new Function("return (" + functionSource + ")");
         const fn = factory();
         const result = typeof fn === "function" ? fn.apply(null, args) : fn;
         if (result && typeof (result as { then?: unknown }).then === "function") {
           return {
             ok: false,
             error:
               'isolated-world evaluation is synchronous and cannot await a Promise — use world:"main" for async results.',
           };
         }
         let out: unknown;
         if (result === undefined) {
           out = null;
         } else {
           try {
             out = JSON.parse(JSON.stringify(result));
           } catch (e) {
             out = String(result);
           }
         }
         return { ok: true, value: out };
       } catch (err) {
         const msg = String((err as { message?: unknown })?.message ?? err);
         if (/unsafe-eval|call to Function|EvalError|Content Security Policy/i.test(msg)) {
           return {
             ok: false,
             error:
               'isolated-world evaluation is not available on this Chrome build (the extension\'s isolated-world CSP blocks eval). Use world:"main", or read DOM state via take-snapshot / take-screenshot.',
           };
         }
         return { ok: false, error: msg };
       }
     }
     ```
     Re-run step 4's command → PASS.

6. - [ ] **Impl — Chrome content-script case.** In `chrome-extension/content-script.ts`, extend the page-world import (add `evalInIsolatedWorld`):
     ```ts
     import {
       buildEvalPageScript,
       buildDialogPageScript,
       buildEmulatePageScript,
       evalInIsolatedWorld,
     } from "./injected/page-world";
     ```
     and add a `case` next to `case "evaluateScript"` (inside the `switch (message.type)`):
     ```ts
     case "evaluateScriptIsolated": {
       const result = evalInIsolatedWorld(message.functionSource, message.args);
       sendResponse(result);
       break;
     }
     ```

7. - [ ] **Impl — Chrome handler branch.** In `chrome-extension/message-handler.ts`, replace the `evaluateScript` method (`private async evaluateScript(...)`, currently ~line 709) with a `world`-aware version:
     ```ts
     private async evaluateScript(
       correlationId: string,
       tabId: number,
       functionSource: string,
       args?: unknown[],
       world?: "main" | "isolated"
     ): Promise<void> {
       const tab = await browser.tabs.get(tabId);
       if (tab.url && (await isDomainInDenyList(tab.url))) {
         throw new Error(`Domain in tab URL is in the deny list`);
       }
       await this.checkForUrlPermission(tab.url);

       let result: { ok: boolean; value?: unknown; error?: string };
       if (world === "isolated") {
         // Isolated content-script world (CSP-immune DOM reads). Uses the raw
         // sender so a Chrome-CSP eval degrade comes back as eval-result ok:false
         // rather than a thrown tool-error.
         result = await sendMessageToTabRaw(tabId, {
           type: "evaluateScriptIsolated",
           functionSource,
           args: args ?? [],
         });
       } else {
         const resultAttr = `data-bcmcp-result-${Date.now()}-${++evalKeyCounter}`;
         result = await sendMessageToTab(tabId, {
           type: "evaluateScript",
           functionSource,
           args: args ?? [],
           resultAttr,
           timeoutMs: EVAL_TIMEOUT_MS,
         });
       }

       await this.client.sendResourceToServer({
         resource: "eval-result",
         correlationId,
         ok: result.ok,
         value: result.value,
         error: result.error,
       });
     }
     ```
     and update the `case "evaluate-script"` dispatch (currently ~line 309) to forward `req.world`:
     ```ts
     case "evaluate-script":
       await this.evaluateScript(
         req.correlationId,
         req.tabId,
         req.function,
         req.args,
         req.world
       );
       break;
     ```
     > `sendMessageToTabRaw` is added in Task 2. If Task 1 lands first, add this minimal helper next to `sendMessageToTab` now (Task 2 keeps it):
     > ```ts
     > // Like sendMessageToTab but returns the raw content-script reply WITHOUT
     > // throwing on an {ok:false,error} payload — for tools whose ok:false is a
     > // legitimate result to report, not a thrown tool-error.
     > async function sendMessageToTabRaw(tabId: number, message: any): Promise<any> {
     >   try {
     >     return await browser.tabs.sendMessage(tabId, message);
     >   } catch (e: any) {
     >     if (
     >       e.message &&
     >       (e.message.includes("Receiving end does not exist") ||
     >         e.message.includes("Could not establish connection"))
     >     ) {
     >       await browser.scripting.executeScript({
     >         target: { tabId },
     >         files: ["dist/content-script.js"],
     >       });
     >       await sleep(100);
     >       return await browser.tabs.sendMessage(tabId, message);
     >     }
     >     throw e;
     >   }
     > }
     > ```

8. - [ ] **Impl — Firefox handler branch.** In `firefox-extension/message-handler.ts`, extend the page-world import (add `buildIsolatedEvalCode`):
     ```ts
     import {
       buildEvalPageScript,
       buildDialogPageScript,
       buildEmulatePageScript,
       runInPageWorld,
       buildIsolatedEvalCode,
     } from "./injected/page-world";
     ```
     replace the `evaluateScript` method (currently ~line 865) to branch on `world`:
     ```ts
     private async evaluateScript(
       correlationId: string,
       tabId: number,
       functionSource: string,
       args?: unknown[],
       world?: "main" | "isolated"
     ): Promise<void> {
       const tab = await browser.tabs.get(tabId);
       if (tab.url && (await isDomainInDenyList(tab.url))) {
         throw new Error(`Domain in tab URL is in the deny list`);
       }
       await this.checkForUrlPermission(tab.url);

       let result: { ok: boolean; value?: unknown; error?: string };
       if (world === "isolated") {
         // executeScript COMPILES the code string in the isolated world (no runtime
         // eval) — CSP-immune, exactly like the snapshot injection. A compile/syntax
         // error rejects executeScript; surface it as ok:false.
         try {
           const results = await browser.tabs.executeScript(tabId, {
             code: buildIsolatedEvalCode(functionSource, args ?? []),
           });
           result =
             (results && (results[0] as { ok: boolean; value?: unknown; error?: string })) || {
               ok: false,
               error: "isolated evaluation produced no result.",
             };
         } catch (e) {
           result = {
             ok: false,
             error: e instanceof Error ? e.message : String(e),
           };
         }
       } else {
         const resultAttr = `data-bcmcp-result-${Date.now()}-${++evalKeyCounter}`;
         const pageScript = buildEvalPageScript(functionSource, args ?? [], resultAttr);
         result = await runInPageWorld(
           (code) => browser.tabs.executeScript(tabId, { code }),
           pageScript,
           resultAttr,
           EVAL_TIMEOUT_MS,
           sleep
         );
       }

       await this.client.sendResourceToServer({
         resource: "eval-result",
         correlationId,
         ok: result.ok,
         value: result.value,
         error: result.error,
       });
     }
     ```
     and update the `case "evaluate-script"` dispatch (currently ~line 340) to forward `req.world`:
     ```ts
     case "evaluate-script":
       await this.evaluateScript(
         req.correlationId,
         req.tabId,
         req.function,
         req.args,
         req.world
       );
       break;
     ```

9. - [ ] **Impl — browser-api + server.** In `mcp-server/browser-api.ts`, replace `evaluateScript` (currently ~line 659):
     ```ts
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
     ```
     In `mcp-server/server.ts`, replace the `evaluate-script` tool (currently ~line 603):
     ```ts
     mcpServer.tool(
       "evaluate-script",
       'Evaluate a JavaScript function in a browser tab and return its result. Pass "function" as a function EXPRESSION string, e.g. "() => document.title" or "(sel) => document.querySelector(sel)?.textContent". By default (world:"main") it runs in the page\'s real world (sees the page\'s window/frameworks/DOM, is awaited if it returns a promise) — but a page with a strict Content-Security-Policy can block it. Set world:"isolated" to run in the extension\'s isolated content-script world instead: CSP-IMMUNE (works where world:"main" is blocked), can read the DOM, element rects, and non-httpOnly document.cookie, but CANNOT see the page\'s own JS globals/framework state and runs SYNCHRONOUSLY (a returned Promise is not awaited). Pass "args" to forward arguments to the function.',
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
     ```

10. - [ ] **Failing test (Firefox handler routing).** In `firefox-extension/__tests__/message-handler.test.ts`, add a new top-level `describe` (model the config on the `input action commands` block — `automationMode:true`):
      ```ts
      describe("evaluate-script world (Task 1)", () => {
        const automationConfig = {
          secret: "test-secret",
          ports: [8089],
          domainDenyList: [] as string[],
          auditLog: [],
          automationMode: true,
        };

        beforeEach(() => {
          (browser.storage.local.get as jest.Mock).mockResolvedValue({
            config: automationConfig,
          });
          (browser.tabs.get as jest.Mock).mockResolvedValue({
            id: 3,
            url: "https://example.com",
          });
          (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
        });

        it("world:isolated compiles the source in the isolated world (no page-world <script>) and returns the value", async () => {
          (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
            { ok: true, value: "TITLE" },
          ]);

          await messageHandler.handleDecodedMessage({
            cmd: "evaluate-script",
            tabId: 3,
            function: "() => document.title",
            world: "isolated",
            correlationId: "ei",
          } as ServerMessageRequest);

          // Exactly one executeScript (the compiled isolated eval) — NO inject+poll.
          expect((browser.tabs.executeScript as jest.Mock).mock.calls.length).toBe(1);
          const code = (browser.tabs.executeScript as jest.Mock).mock.calls[0][1].code;
          expect(code).toContain("() => document.title");
          expect(code).not.toContain("createElement('script')");
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "eval-result",
            correlationId: "ei",
            ok: true,
            value: "TITLE",
            error: undefined,
          });
        });
      });
      ```
      Then:
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/message-handler.test.ts -t "evaluate-script world"
      ```
      Expected: FAIL before the impl in steps 8; PASS after. (Run it now to confirm PASS.)

11. - [ ] **Failing test (Chrome handler routing).** In `chrome-extension/__tests__/message-handler.test.ts`, add:
      ```ts
      describe("evaluate-script world (Task 1)", () => {
        const automationConfig = { ...baseConfig, automationMode: true };

        beforeEach(() => {
          (browser.storage.local.get as jest.Mock).mockResolvedValue({
            config: automationConfig,
          });
          (browser.tabs.get as jest.Mock).mockResolvedValue({
            id: 5,
            url: "https://example.com",
          });
          (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
        });

        it("world:isolated routes to the isolated content-script message and forwards the result", async () => {
          (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
            ok: true,
            value: 42,
          });

          await messageHandler.handleDecodedMessage({
            cmd: "evaluate-script",
            tabId: 5,
            function: "() => 42",
            world: "isolated",
            correlationId: "ci",
          } as ServerMessageRequest);

          expect(browser.tabs.sendMessage).toHaveBeenCalledWith(5, {
            type: "evaluateScriptIsolated",
            functionSource: "() => 42",
            args: [],
          });
          expect(transport.sendResourceToServer).toHaveBeenCalledWith({
            resource: "eval-result",
            correlationId: "ci",
            ok: true,
            value: 42,
            error: undefined,
          });
        });
      });
      ```
      Run:
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/message-handler.test.ts -t "evaluate-script world"
      ```
      Expected: PASS.

12. - [ ] **Failing test (MCP wire round-trip).** Create `mcp-server/__tests__/evaluate-script-world.test.ts` reusing the `startMockExtension` harness from `mcp-server/__tests__/wait-for-text-arg.test.ts` (copy the helper + lifecycle verbatim; SECRET `"esw-secret"`, `browserId` `"esw-ext"`). Reply handler + test:
      ```ts
      ext = await startMockExtension(port, (req) => {
        lastReq = req;
        return {
          resource: "eval-result",
          correlationId: req.correlationId,
          ok: true,
          value: "isolated-ok",
        };
      });
      // ...
      it("forwards world:isolated in the evaluate-script frame and returns the value", async () => {
        const value = await api.evaluateScript(4, "() => document.title", [], "isolated");
        expect(value).toBe("isolated-ok");
        expect((lastReq as any).world).toBe("isolated");
        expect((lastReq as any).function).toBe("() => document.title");
      });
      ```

13. - [ ] **Run-to-pass + build:**
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/evaluate-script-world.test.ts && npm run build
      cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/page-world.test.ts __tests__/message-handler.test.ts
      cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/page-world.test.ts __tests__/message-handler.test.ts
      ```
      Expected: all PASS; `npm run build` (esbuild bundle of `server.ts` + `broker-main.ts`) completes with no type/emit error.

14. - [ ] Commit:
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp
      git add common mcp-server chrome-extension firefox-extension
      git commit -m "feat(evaluate-script): add world:'isolated' (CSP-immune isolated-world eval; main stays default)"
      ```

---

### Task 2 — `click-at` (synthetic) + the coordinate infrastructure (#1)

The heavy task: the new `injected/point-action-script.ts` module (byte-identical both extensions) with `performPointAction` (starting with the `click-at` branch, a `describe` element-descriptor helper, and the shared `elementFromPoint` scaffolding); the new `PointActionResultExtensionMessage`; the `sendMessageToTabRaw` helper (Chrome); and the FULL add-a-tool wiring for `click-at`. Tasks 3–5 then only add one action branch + one cmd's wiring each.

**Files:**
- Create `chrome-extension/injected/point-action-script.ts` and `firefox-extension/injected/point-action-script.ts` (identical).
- Modify `common/server-messages.ts` — `ClickAtServerMessage` + union.
- Modify `common/extension-messages.ts` — `PointElementDescriptor` + `PointActionResultExtensionMessage` + union.
- Modify `mcp-server/server.ts` — `formatPointResult` helper + `click-at` tool.
- Modify `mcp-server/browser-api.ts` — `clickAt`.
- Modify both `extension-config.ts` — `click-at` in `AVAILABLE_TOOLS` + `COMMAND_TO_TOOL_ID` + `AUTOMATION_COMMANDS`.
- Modify `chrome-extension/content-script.ts` — `case "performPointAction"` (+ import).
- Modify `chrome-extension/message-handler.ts` — `sendMessageToTabRaw` + `runPointAction` + `case "click-at"` (+ import + `PointActionArgs` type).
- Modify `firefox-extension/message-handler.ts` — `runPointAction` + `case "click-at"` (+ import + `PointActionArgs` type).
- Create both `__tests__/point-action-script.test.ts`.
- Modify `firefox-extension/__tests__/self-containment.test.ts`.
- Modify both `__tests__/message-handler.test.ts`.
- Create `mcp-server/__tests__/coordinate-tools.test.ts`.

**Interfaces:**
- Consumes (MCP): `click-at { tabId, x, y, doubleClick?, button? }`.
- Produces (extension): `PointActionResultExtensionMessage { resource:"point-action-result"; ok; error?; element? }` where `element: PointElementDescriptor`.
- Internal: `performPointAction(doc, args) => { ok; error?; element? }`; `BrowserAPI.clickAt(tabId, x, y, opts?) => Promise<PointActionResultExtensionMessage>`.

**Steps:**

1. - [ ] **Create the injected module (both, identical).** Create `chrome-extension/injected/point-action-script.ts` AND `firefox-extension/injected/point-action-script.ts` with the SAME content. Task 2 ships the `click-at` branch; Tasks 3–5 add `type-at`/`hover-at`/`scroll-at`. (The `type`, `hover`, and `scroll` branches below are stubbed with the `click-at` branch only for now — add the rest in later tasks.)
     ```ts
     /**
      * Coordinate (synthetic) interaction executor for the -at tools + the scroll
      * tools. Like action-script.ts's performInputAction, every exported function
      * here is used TWO ways: (a) imported and unit-tested in jsdom; (b) run in the
      * ISOLATED content-script world — Chrome imports it into content-script.ts and
      * calls it directly; Firefox stringifies it via `.toString()` and injects it
      * with browser.tabs.executeScript. Both are CSP-IMMUNE: pure DOM ops
      * (elementFromPoint, dispatchEvent, scrollBy, scrollIntoView) — no eval, no
      * page-world <script>. So each function MUST be fully self-contained: inner
      * helpers only, no imports, no module-scope references (enforced by
      * self-containment.test.ts).
      *
      * jsdom caveat: document.elementFromPoint returns null (no layout) and
      * getBoundingClientRect returns zeros, so unit tests stub elementFromPoint and
      * do not assert rect values.
      */

     export interface PointElementDescriptor {
       tag: string;
       id?: string;
       classes: string[];
       role?: string;
       name?: string;
       rect: { x: number; y: number; w: number; h: number };
       editable?: boolean;
     }

     export function performPointAction(
       doc: Document,
       args:
         | {
             action: "click-at";
             x: number;
             y: number;
             doubleClick?: boolean;
             button?: "left" | "middle" | "right";
           }
     ): { ok: boolean; error?: string; element?: PointElementDescriptor } {
       try {
         const win = doc.defaultView as (Window & typeof globalThis) | null;

         function elementAt(x: number, y: number): Element | null {
           const efp = (doc as {
             elementFromPoint?: (x: number, y: number) => Element | null;
           }).elementFromPoint;
           if (typeof efp !== "function") {
             return null;
           }
           return efp.call(doc, x, y);
         }

         function offPoint(x: number, y: number): { ok: boolean; error?: string } {
           return {
             ok: false,
             error:
               "No element at point (" +
               x +
               ", " +
               y +
               ") — the coordinates may be outside the visible viewport or over a cross-origin frame.",
           };
         }

         function isEditable(el: Element): boolean {
           const tag = el.tagName;
           if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
             return true;
           }
           return (el as { isContentEditable?: boolean }).isContentEditable === true;
         }

         function describe(el: Element): PointElementDescriptor {
           const tag = el.tagName.toLowerCase();
           const id = el.id ? el.id : undefined;
           const classes =
             typeof (el as { className?: unknown }).className === "string"
               ? (el.getAttribute("class") || "").split(/\s+/).filter(Boolean)
               : [];
           const role = el.getAttribute("role") || undefined;
           const ariaLabel = el.getAttribute("aria-label");
           const rawName =
             ariaLabel || (el.textContent || "").replace(/\s+/g, " ").trim();
           const name = rawName ? rawName.slice(0, 80) : undefined;
           let rect = { x: 0, y: 0, w: 0, h: 0 };
           try {
             const r = (el as Element).getBoundingClientRect();
             rect = { x: r.left, y: r.top, w: r.width, h: r.height };
           } catch (e) {
             /* jsdom / detached — zero rect */
           }
           return {
             tag,
             ...(id ? { id } : {}),
             classes,
             ...(role ? { role } : {}),
             ...(name ? { name } : {}),
             rect,
             editable: isEditable(el),
           };
         }

         function mouseEvt(type: string, button: number): Event {
           return new MouseEvent(type, {
             bubbles: true,
             cancelable: true,
             view: win as Window,
             button,
           });
         }

         function buttonCode(b?: "left" | "middle" | "right"): number {
           if (b === "middle") return 1;
           if (b === "right") return 2;
           return 0;
         }

         if (args.action === "click-at") {
           const el = elementAt(args.x, args.y);
           if (!el) {
             return offPoint(args.x, args.y);
           }
           const b = buttonCode(args.button);
           // Realistic press sequence (none activate the element) + focus, mirroring
           // action-script.ts's dispatchClickSequence.
           el.dispatchEvent(mouseEvt("pointerdown", b));
           el.dispatchEvent(mouseEvt("mousedown", b));
           el.dispatchEvent(mouseEvt("mouseup", b));
           try {
             (el as { focus?: () => void }).focus?.();
           } catch (e) {
             /* not focusable */
           }
           if (b === 2) {
             el.dispatchEvent(mouseEvt("contextmenu", b));
           } else if (b === 1) {
             el.dispatchEvent(mouseEvt("auxclick", b));
           } else {
             // Exactly ONE left activation: el.click() fires `click` + default action.
             try {
               (el as { click?: () => void }).click?.();
             } catch (e) {
               /* ignore */
             }
           }
           if (args.doubleClick) {
             el.dispatchEvent(mouseEvt("dblclick", b));
           }
           return { ok: true, element: describe(el) };
         }

         return { ok: false, error: "Unknown point action" };
       } catch (e) {
         return { ok: false, error: String(e) };
       }
     }
     ```

2. - [ ] **Failing test (Firefox jsdom).** Create `firefox-extension/__tests__/point-action-script.test.ts`:
     ```ts
     import { performPointAction } from "../injected/point-action-script";

     // jsdom has no layout: document.elementFromPoint returns null and rects are
     // zero. Every test stubs elementFromPoint and never asserts rect values.
     describe("performPointAction (firefox)", () => {
       afterEach(() => {
         document.body.innerHTML = "";
         (document as any).elementFromPoint = undefined;
       });

       function stubPoint(el: Element | null) {
         (document as any).elementFromPoint = jest.fn(() => el);
       }

       describe("click-at (Task 2)", () => {
         it("clicks the element under the point and returns its descriptor", () => {
           document.body.innerHTML = `<div id="card" role="button" class="a b">Open</div>`;
           const el = document.getElementById("card")!;
           stubPoint(el);
           const onClick = jest.fn();
           el.addEventListener("click", onClick);

           const res = performPointAction(document, { action: "click-at", x: 10, y: 20 });

           expect((document as any).elementFromPoint).toHaveBeenCalledWith(10, 20);
           expect(onClick).toHaveBeenCalledTimes(1);
           expect(res.ok).toBe(true);
           expect(res.element).toMatchObject({
             tag: "div",
             id: "card",
             role: "button",
             classes: ["a", "b"],
             name: "Open",
           });
           expect(res.element!.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
         });

         it("returns ok:false with a helpful error when no element is at the point", () => {
           stubPoint(null);
           const res = performPointAction(document, { action: "click-at", x: 1, y: 2 });
           expect(res.ok).toBe(false);
           expect(res.error).toMatch(/No element at point \(1, 2\)/);
           expect(res.element).toBeUndefined();
         });

         it("fires dblclick when doubleClick is set", () => {
           document.body.innerHTML = `<button>Go</button>`;
           const el = document.querySelector("button")!;
           stubPoint(el);
           const onDbl = jest.fn();
           el.addEventListener("dblclick", onDbl);
           performPointAction(document, { action: "click-at", x: 5, y: 5, doubleClick: true });
           expect(onDbl).toHaveBeenCalledTimes(1);
         });

         it("fires contextmenu for button:'right' instead of activating", () => {
           document.body.innerHTML = `<button>Go</button>`;
           const el = document.querySelector("button")!;
           stubPoint(el);
           const onClick = jest.fn();
           const onCtx = jest.fn();
           el.addEventListener("click", onClick);
           el.addEventListener("contextmenu", onCtx);
           performPointAction(document, { action: "click-at", x: 5, y: 5, button: "right" });
           expect(onCtx).toHaveBeenCalledTimes(1);
           expect(onClick).not.toHaveBeenCalled();
         });
       });
     });
     ```
     Then (also copy this whole file to `chrome-extension/__tests__/point-action-script.test.ts` — imports resolve against the Chrome copy):
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/point-action-script.test.ts
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/point-action-script.test.ts
     ```
     Expected: PASS on both (the module was created in step 1).

3. - [ ] **Impl — self-containment registration (Firefox).** In `firefox-extension/__tests__/self-containment.test.ts`, add the import and list entry:
     ```ts
     import { performPointAction } from "../injected/point-action-script";
     ```
     and add to `INJECTED_FUNCTIONS`:
     ```ts
       ["performPointAction", performPointAction as unknown as (...args: any[]) => any],
     ```
     Run:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/self-containment.test.ts
     ```
     Expected: PASS — `performPointAction` stringifies with no forbidden module-system token (all helpers are inner).

4. - [ ] **Impl — extension messages.** In `common/extension-messages.ts`, add before `ExtensionMessage` union:
     ```ts
     // Compact descriptor of the element under a coordinate point, returned by the
     // coordinate tools (click-at/type-at/hover-at/scroll-at) for confirmation.
     // `rect` is the viewport-relative bounding box in CSS px; `editable` is true
     // for inputs/textareas/selects/contenteditable.
     export interface PointElementDescriptor {
       tag: string;
       id?: string;
       classes: string[];
       role?: string;
       name?: string;
       rect: { x: number; y: number; w: number; h: number };
       editable?: boolean;
     }

     // Reply for the coordinate tools. `ok` is false (with `error`) when no element
     // resolves at the point; on success `element` describes what was under it.
     export interface PointActionResultExtensionMessage extends ExtensionMessageBase {
       resource: "point-action-result";
       ok: boolean;
       error?: string;
       element?: PointElementDescriptor;
     }
     ```
     and add `| PointActionResultExtensionMessage` to the `ExtensionMessage` union.

5. - [ ] **Impl — server message + union.** In `common/server-messages.ts`, add (before the `ServerMessage` union):
     ```ts
     // --- Coordinate (synthetic) interaction — Phase 2 ---
     // Act at viewport CSS-pixel coordinates {x,y} (origin = top-left of the visible
     // viewport, matching document.elementFromPoint). All run covertly in the
     // isolated content-script world (elementFromPoint → the existing action
     // sequences). No trusted-input engine in Phase 2 — the optional `engine` param
     // is a backward-compatible Phase 3 addition.
     export interface ClickAtServerMessage extends ServerMessageBase {
       cmd: "click-at";
       tabId: number;
       x: number;
       y: number;
       doubleClick?: boolean;
       button?: "left" | "middle" | "right";
     }
     ```
     and add `| ClickAtServerMessage` to the `ServerMessage` union.

6. - [ ] **Impl — both extension-config.ts.** In BOTH `chrome-extension/extension-config.ts` and `firefox-extension/extension-config.ts`, append to `AVAILABLE_TOOLS` (before the closing `];`):
     ```ts
       ,
       {
         id: "click-at",
         name: "Click at Coordinates",
         description: "Allows the MCP server to click at pixel coordinates on a page (synthetic, covert)"
       }
     ```
     add to `COMMAND_TO_TOOL_ID`:
     ```ts
       "click-at": "click-at",
     ```
     and add to the `AUTOMATION_COMMANDS` set:
     ```ts
       "click-at",
     ```

7. - [ ] **Impl — Chrome content-script + handler.** In `chrome-extension/content-script.ts`, add the import:
     ```ts
     import { performPointAction } from "./injected/point-action-script";
     ```
     and add a `case` (inside the `switch (message.type)`):
     ```ts
     case "performPointAction": {
       const result = performPointAction(document, message.args);
       sendResponse(result);
       break;
     }
     ```
     In `chrome-extension/message-handler.ts`, add the import near the top:
     ```ts
     import { performPointAction } from "./injected/point-action-script";
     ```
     add the `PointActionArgs` type next to `InputActionArgs`:
     ```ts
     type PointActionArgs = Parameters<typeof performPointAction>[1];
     ```
     add `sendMessageToTabRaw` next to `sendMessageToTab` (skip if Task 1 already added it):
     ```ts
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
     ```
     add the `runPointAction` handler (place near `runInputAction`):
     ```ts
     private async runPointAction(
       correlationId: string,
       tabId: number,
       args: PointActionArgs
     ): Promise<void> {
       const tab = await browser.tabs.get(tabId);
       if (tab.url && (await isDomainInDenyList(tab.url))) {
         throw new Error(`Domain in tab URL is in the deny list`);
       }
       await this.checkForUrlPermission(tab.url);

       const result = await sendMessageToTabRaw(tabId, {
         type: "performPointAction",
         args,
       });
       await this.client.sendResourceToServer({
         resource: "point-action-result",
         correlationId,
         ok: !!(result && result.ok),
         ...(result && result.error !== undefined ? { error: result.error } : {}),
         ...(result && result.element !== undefined ? { element: result.element } : {}),
       });
     }
     ```
     and the `case "click-at"` (inside `handleDecodedMessage`'s switch):
     ```ts
     case "click-at":
       await this.runPointAction(req.correlationId, req.tabId, {
         action: "click-at",
         x: req.x,
         y: req.y,
         doubleClick: req.doubleClick,
         button: req.button,
       });
       break;
     ```

8. - [ ] **Impl — Firefox handler.** In `firefox-extension/message-handler.ts`, add the import:
     ```ts
     import { performPointAction } from "./injected/point-action-script";
     ```
     add the `PointActionArgs` type next to `InputActionArgs`:
     ```ts
     type PointActionArgs = Parameters<typeof performPointAction>[1];
     ```
     add the `runPointAction` handler (near `runInputAction`):
     ```ts
     // Coordinate (synthetic) executor. Injects the self-contained
     // performPointAction into the ISOLATED world (executeScript compiles it — no
     // eval, no page-world <script>) and replies with point-action-result. An
     // off-point / not-typable ok:false is a legitimate RESULT, not a thrown error.
     private async runPointAction(
       correlationId: string,
       tabId: number,
       args: PointActionArgs
     ): Promise<void> {
       const tab = await browser.tabs.get(tabId);
       if (tab.url && (await isDomainInDenyList(tab.url))) {
         throw new Error(`Domain in tab URL is in the deny list`);
       }
       await this.checkForUrlPermission(tab.url);

       const results = await browser.tabs.executeScript(tabId, {
         code: `(${performPointAction.toString()})(document, ${JSON.stringify(args)})`,
       });
       const result = (results && results[0]) || {
         ok: false,
         error:
           "point action produced no result (the content script may not be loaded in this tab — reload the page and retry).",
       };
       await this.client.sendResourceToServer({
         resource: "point-action-result",
         correlationId,
         ok: !!result.ok,
         ...(result.error !== undefined ? { error: result.error } : {}),
         ...(result.element !== undefined ? { element: result.element } : {}),
       });
     }
     ```
     and the `case "click-at"`:
     ```ts
     case "click-at":
       await this.runPointAction(req.correlationId, req.tabId, {
         action: "click-at",
         x: req.x,
         y: req.y,
         doubleClick: req.doubleClick,
         button: req.button,
       });
       break;
     ```

9. - [ ] **Impl — browser-api + server.** In `mcp-server/browser-api.ts`, add the type import (extend the existing `@foxpilot/common` import block):
     ```ts
       PointActionResultExtensionMessage,
     ```
     and add the client method (near `clickElement`):
     ```ts
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
     ```
     In `mcp-server/server.ts`, add the shared formatter ABOVE the first coordinate tool (e.g. right before the `evaluate-script` tool or near the top-of-file helpers):
     ```ts
     // Formats a point-action-result for the coordinate tools: a one-line
     // confirmation with the element descriptor, or isError:true on a miss.
     function formatPointResult(
       verb: string,
       tabId: number,
       x: number,
       y: number,
       result: {
         ok: boolean;
         error?: string;
         element?: {
           tag: string;
           id?: string;
           name?: string;
           role?: string;
           editable?: boolean;
         };
       }
     ) {
       if (!result.ok) {
         return {
           content: [
             {
               type: "text" as const,
               text: `${verb} failed at (${x}, ${y}) on tab ${tabId}: ${
                 result.error ?? "no element at point"
               }`,
             },
           ],
           isError: true,
         };
       }
       const el = result.element;
       const desc = el
         ? ` — element: <${el.tag}${el.id ? " #" + el.id : ""}${
             el.role ? ' role="' + el.role + '"' : ""
           }>${el.name ? ' "' + el.name + '"' : ""}${el.editable ? " (editable)" : ""}`
         : "";
       return {
         content: [
           { type: "text" as const, text: `${verb} at (${x}, ${y}) on tab ${tabId}${desc}` },
         ],
       };
     }
     ```
     and add the `click-at` tool (place after the `evaluate-script`/coordinate area):
     ```ts
     mcpServer.tool(
       "click-at",
       "Click at viewport pixel coordinates {x,y} (origin = top-left of the visible viewport, as used by document.elementFromPoint). Reach for this when take-snapshot did NOT surface a clickable element (e.g. a custom-React <div onClick> with no role/tabindex) but you can see where it is — e.g. from take-screenshot. Runs covertly in the isolated world (no automation banner, no debugger). Set doubleClick for a double-click, or button to 'middle'/'right'. Returns a descriptor of the element that was under the point (or an error if the point hit nothing).",
       {
         tabId: z.number(),
         x: z.number(),
         y: z.number(),
         doubleClick: z.boolean().optional(),
         button: z.enum(["left", "middle", "right"]).optional(),
       },
       async ({ tabId, x, y, doubleClick, button }) => {
         const result = await browserApi.clickAt(tabId, x, y, { doubleClick, button });
         return formatPointResult("Clicked", tabId, x, y, result);
       }
     );
     ```

10. - [ ] **Failing test (Chrome handler).** In `chrome-extension/__tests__/message-handler.test.ts`, add:
      ```ts
      describe("coordinate tools (Task 2+)", () => {
        const automationConfig = { ...baseConfig, automationMode: true };

        beforeEach(() => {
          (browser.storage.local.get as jest.Mock).mockResolvedValue({
            config: automationConfig,
          });
          (browser.tabs.get as jest.Mock).mockResolvedValue({
            id: 8,
            url: "https://example.com",
          });
          (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
        });

        it("click-at forwards coords to the isolated point action and returns point-action-result with the descriptor", async () => {
          (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
            ok: true,
            element: { tag: "div", id: "card", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: false },
          });

          await messageHandler.handleDecodedMessage({
            cmd: "click-at",
            tabId: 8,
            x: 12,
            y: 34,
            correlationId: "cx",
          } as ServerMessageRequest);

          expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
            type: "performPointAction",
            args: { action: "click-at", x: 12, y: 34, doubleClick: undefined, button: undefined },
          });
          expect(transport.sendResourceToServer).toHaveBeenCalledWith({
            resource: "point-action-result",
            correlationId: "cx",
            ok: true,
            element: { tag: "div", id: "card", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: false },
          });
        });

        it("click-at reports ok:false (not a thrown error) when the point missed", async () => {
          (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
            ok: false,
            error: "No element at point (1, 2) — the coordinates may be outside the visible viewport or over a cross-origin frame.",
          });

          await messageHandler.handleDecodedMessage({
            cmd: "click-at",
            tabId: 8,
            x: 1,
            y: 2,
            correlationId: "cm",
          } as ServerMessageRequest);

          expect(transport.sendResourceToServer).toHaveBeenCalledWith({
            resource: "point-action-result",
            correlationId: "cm",
            ok: false,
            error: "No element at point (1, 2) — the coordinates may be outside the visible viewport or over a cross-origin frame.",
          });
        });
      });
      ```
      Run:
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/message-handler.test.ts -t "coordinate tools"
      ```
      Expected: PASS.

11. - [ ] **Failing test (Firefox handler).** In `firefox-extension/__tests__/message-handler.test.ts`, add:
      ```ts
      describe("coordinate tools (Task 2+)", () => {
        const automationConfig = {
          secret: "test-secret",
          ports: [8089],
          domainDenyList: [] as string[],
          auditLog: [],
          automationMode: true,
        };

        beforeEach(() => {
          (browser.storage.local.get as jest.Mock).mockResolvedValue({
            config: automationConfig,
          });
          (browser.tabs.get as jest.Mock).mockResolvedValue({
            id: 9,
            url: "https://example.com",
          });
          (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
        });

        it("click-at injects performPointAction with the click-at args and replies point-action-result", async () => {
          (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
            { ok: true, element: { tag: "div", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: false } },
          ]);

          await messageHandler.handleDecodedMessage({
            cmd: "click-at",
            tabId: 9,
            x: 12,
            y: 34,
            correlationId: "fx",
          } as ServerMessageRequest);

          const code = (browser.tabs.executeScript as jest.Mock).mock.calls[0][1].code;
          expect(code).toContain('"action":"click-at"');
          expect(code).toContain('"x":12');
          expect(code).toContain('"y":34');
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "point-action-result",
            correlationId: "fx",
            ok: true,
            element: { tag: "div", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: false },
          });
        });
      });
      ```
      Run:
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/message-handler.test.ts -t "coordinate tools"
      ```
      Expected: PASS.

12. - [ ] **Failing test (MCP wire round-trip).** Create `mcp-server/__tests__/coordinate-tools.test.ts` reusing the `startMockExtension` harness from `mcp-server/__tests__/wait-for-text-arg.test.ts` (copy verbatim; SECRET `"coord-secret"`, `browserId` `"coord-ext"`). Reply handler + test:
      ```ts
      ext = await startMockExtension(port, (req) => {
        lastReq = req;
        return {
          resource: "point-action-result",
          correlationId: req.correlationId,
          ok: true,
          element: {
            tag: "div",
            id: "open-card",
            classes: ["card"],
            rect: { x: 0, y: 0, w: 0, h: 0 },
            editable: false,
          },
        };
      });
      // ...
      it("forwards click-at coordinates and surfaces the element descriptor", async () => {
        const result = await api.clickAt(2, 100, 200, { button: "right" });
        expect((lastReq as any).cmd).toBe("click-at");
        expect((lastReq as any).x).toBe(100);
        expect((lastReq as any).y).toBe(200);
        expect((lastReq as any).button).toBe("right");
        expect(result.ok).toBe(true);
        expect(result.element!.id).toBe("open-card");
      });
      ```

13. - [ ] **Run-to-pass + build:**
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/coordinate-tools.test.ts && npm run build
      cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/point-action-script.test.ts __tests__/self-containment.test.ts __tests__/message-handler.test.ts
      cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/point-action-script.test.ts __tests__/message-handler.test.ts
      ```
      Expected: all PASS; `npm run build` succeeds (both `_exhaustiveCheck` switches now include `click-at`).

14. - [ ] Commit:
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp
      git add common mcp-server chrome-extension firefox-extension
      git commit -m "feat(click-at): synthetic coordinate click + point-action-result infrastructure (both extensions)"
      ```

---

### Task 3 — `type-at` (synthetic) (#1)

`elementFromPoint` → click-to-focus → type the text. Reuses the framework-safe native-setter path for `<input>`/`<textarea>` AND additionally handles `<div contenteditable>` (the motivating SPA chat-input case, which `performInputAction`'s INPUT/TEXTAREA-only `type` does NOT — see the reconciliation note). Optional `submit` presses Enter (+ `form.requestSubmit()`). One new cmd; the shared `runPointAction`/`case` scaffolding is already in place from Task 2.

**Files:**
- Modify both `injected/point-action-script.ts` — add the `type-at` branch to `performPointAction`'s union + body.
- Modify `common/server-messages.ts` — `TypeAtServerMessage` + union.
- Modify `mcp-server/server.ts` — `type-at` tool.
- Modify `mcp-server/browser-api.ts` — `typeAt`.
- Modify both `extension-config.ts` — `type-at` entries.
- Modify both `message-handler.ts` — `case "type-at"`.
- Modify both `__tests__/point-action-script.test.ts` and `mcp-server/__tests__/coordinate-tools.test.ts`.

**Interfaces:**
- Consumes (MCP): `type-at { tabId, x, y, text, submit? }`.
- Produces (extension): `point-action-result` (reused).

**Steps:**

1. - [ ] **Impl — injected `type-at` (both, identical).** In both `injected/point-action-script.ts`, extend `performPointAction`'s parameter union with:
     ```ts
         | { action: "type-at"; x: number; y: number; text: string; submit?: boolean }
     ```
     add these inner helpers alongside `mouseEvt`/`buttonCode` (before the `if (args.action === "click-at")` branch):
     ```ts
         function keyEvt(type: string, key: string): KeyboardEvent {
           return new KeyboardEvent(type, { key: key, bubbles: true });
         }

         function nativeSetValue(el: Element, value: string): void {
           const proto =
             el.tagName === "TEXTAREA"
               ? win!.HTMLTextAreaElement.prototype
               : win!.HTMLInputElement.prototype;
           const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
           const setter = descriptor && descriptor.set;
           if (setter) {
             setter.call(el, value);
           } else {
             (el as { value?: string }).value = value;
           }
         }
     ```
     and add the branch (after the `click-at` branch):
     ```ts
         if (args.action === "type-at") {
           const el = elementAt(args.x, args.y);
           if (!el) {
             return offPoint(args.x, args.y);
           }
           // Click-to-focus (press sequence + focus + activate) so the type targets it.
           el.dispatchEvent(mouseEvt("pointerdown", 0));
           el.dispatchEvent(mouseEvt("mousedown", 0));
           el.dispatchEvent(mouseEvt("mouseup", 0));
           try {
             (el as { focus?: () => void }).focus?.();
           } catch (e) {
             /* ignore */
           }
           try {
             (el as { click?: () => void }).click?.();
           } catch (e) {
             /* ignore */
           }
           const text = args.text;
           const tag = el.tagName;
           if (tag === "INPUT" || tag === "TEXTAREA") {
             // Framework-safe native-setter append + input (mirrors action-script.ts).
             const current = ((el as { value?: string }).value || "") as string;
             nativeSetValue(el, current + text);
             el.dispatchEvent(new Event("input", { bubbles: true }));
           } else if ((el as { isContentEditable?: boolean }).isContentEditable === true) {
             // contenteditable (the SPA chat-input case): insert text + fire input.
             const doExec = (doc as {
               execCommand?: (c: string, s?: boolean, v?: string) => boolean;
             }).execCommand;
             let inserted = false;
             if (typeof doExec === "function") {
               try {
                 inserted = doExec.call(doc, "insertText", false, text);
               } catch (e) {
                 inserted = false;
               }
             }
             if (!inserted) {
               (el as { textContent?: string }).textContent =
                 (el.textContent || "") + text;
             }
             el.dispatchEvent(new Event("input", { bubbles: true }));
           } else {
             return {
               ok: false,
               error:
                 "Element at point is not typable (not an input, textarea, or contenteditable).",
               element: describe(el),
             };
           }
           for (let i = 0; i < text.length; i++) {
             const ch = text.charAt(i);
             el.dispatchEvent(keyEvt("keydown", ch));
             el.dispatchEvent(keyEvt("keyup", ch));
           }
           if (args.submit) {
             el.dispatchEvent(keyEvt("keydown", "Enter"));
             el.dispatchEvent(keyEvt("keyup", "Enter"));
             const form = (el as { form?: HTMLFormElement }).form;
             if (form) {
               try {
                 const rs = (form as { requestSubmit?: () => void }).requestSubmit;
                 if (typeof rs === "function") {
                   rs.call(form);
                 } else {
                   form.submit();
                 }
               } catch (e) {
                 /* ignore */
               }
             }
           }
           return { ok: true, element: describe(el) };
         }
     ```

2. - [ ] **Failing test (both jsdom).** Add to BOTH `__tests__/point-action-script.test.ts` (inside `describe("performPointAction ...")`):
     ```ts
     describe("type-at (Task 3)", () => {
       function stubPoint(el: Element | null) {
         (document as any).elementFromPoint = jest.fn(() => el);
       }

       it("types into an <input> via the native setter and fires input", () => {
         document.body.innerHTML = `<input type="text" />`;
         const el = document.querySelector("input")!;
         stubPoint(el);
         const onInput = jest.fn();
         el.addEventListener("input", onInput);

         const res = performPointAction(document, { action: "type-at", x: 3, y: 4, text: "hi" });

         expect(res.ok).toBe(true);
         expect(el.value).toBe("hi");
         expect(onInput).toHaveBeenCalled();
         expect(res.element!.editable).toBe(true);
       });

       it("types into a contenteditable div (textContent fallback when execCommand is absent)", () => {
         document.body.innerHTML = `<div contenteditable="true"></div>`;
         const el = document.querySelector("[contenteditable]")!;
         // jsdom has no execCommand — the fallback path runs.
         stubPoint(el);
         const res = performPointAction(document, { action: "type-at", x: 1, y: 1, text: "yo" });
         expect(res.ok).toBe(true);
         expect(el.textContent).toBe("yo");
       });

       it("submits with a trailing Enter when submit is set", () => {
         document.body.innerHTML = `<input type="text" />`;
         const el = document.querySelector("input")!;
         stubPoint(el);
         const onKeydown = jest.fn();
         el.addEventListener("keydown", onKeydown);
         performPointAction(document, { action: "type-at", x: 1, y: 1, text: "x", submit: true });
         const keys = onKeydown.mock.calls.map((c) => c[0].key);
         expect(keys).toContain("Enter");
       });

       it("returns ok:false for a non-typable element", () => {
         document.body.innerHTML = `<div>plain</div>`;
         const el = document.querySelector("div")!;
         stubPoint(el);
         const res = performPointAction(document, { action: "type-at", x: 1, y: 1, text: "z" });
         expect(res.ok).toBe(false);
         expect(res.error).toMatch(/not typable/);
         expect(res.element!.tag).toBe("div");
       });
     });
     ```
     Run both:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/point-action-script.test.ts -t "type-at"
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/point-action-script.test.ts -t "type-at"
     ```
     Expected: PASS.

3. - [ ] **Impl — server message + union.** In `common/server-messages.ts`, add:
     ```ts
     export interface TypeAtServerMessage extends ServerMessageBase {
       cmd: "type-at";
       tabId: number;
       x: number;
       y: number;
       text: string;
       submit?: boolean;
     }
     ```
     and add `| TypeAtServerMessage` to the `ServerMessage` union.

4. - [ ] **Impl — both extension-config.ts.** Append to `AVAILABLE_TOOLS` in BOTH:
     ```ts
       ,
       {
         id: "type-at",
         name: "Type at Coordinates",
         description: "Allows the MCP server to type text into the element at pixel coordinates on a page (synthetic, covert)"
       }
     ```
     add `"type-at": "type-at",` to `COMMAND_TO_TOOL_ID`, and `"type-at",` to `AUTOMATION_COMMANDS`.

5. - [ ] **Impl — both handlers.** In BOTH `message-handler.ts`, add the `case`:
     ```ts
     case "type-at":
       await this.runPointAction(req.correlationId, req.tabId, {
         action: "type-at",
         x: req.x,
         y: req.y,
         text: req.text,
         submit: req.submit,
       });
       break;
     ```

6. - [ ] **Impl — browser-api + server.** In `mcp-server/browser-api.ts`, add:
     ```ts
     async typeAt(
       tabId: number,
       x: number,
       y: number,
       text: string,
       submit?: boolean
     ): Promise<PointActionResultExtensionMessage> {
       return await this.sendTool<PointActionResultExtensionMessage>({
         cmd: "type-at",
         tabId,
         x,
         y,
         text,
         submit,
       });
     }
     ```
     In `mcp-server/server.ts`, add:
     ```ts
     mcpServer.tool(
       "type-at",
       "Type text into the element at viewport pixel coordinates {x,y}. Clicks the point to focus it first, then types — works for <input>/<textarea> AND custom <div contenteditable> chat inputs that take-snapshot may not expose as textboxes. Set submit:true to press Enter afterward (and submit the form if there is one). Runs covertly in the isolated world. Returns a descriptor of the element that was typed into.",
       {
         tabId: z.number(),
         x: z.number(),
         y: z.number(),
         text: z.string(),
         submit: z.boolean().optional(),
       },
       async ({ tabId, x, y, text, submit }) => {
         const result = await browserApi.typeAt(tabId, x, y, text, submit);
         return formatPointResult("Typed", tabId, x, y, result);
       }
     );
     ```

7. - [ ] **Add the wire round-trip assertion.** In `mcp-server/__tests__/coordinate-tools.test.ts`, add:
     ```ts
     it("forwards type-at text/submit", async () => {
       await api.typeAt(2, 50, 60, "hello", true);
       expect((lastReq as any).cmd).toBe("type-at");
       expect((lastReq as any).text).toBe("hello");
       expect((lastReq as any).submit).toBe(true);
     });
     ```

8. - [ ] **Run-to-pass + build:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/coordinate-tools.test.ts && npm run build
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/point-action-script.test.ts __tests__/self-containment.test.ts __tests__/message-handler.test.ts
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/point-action-script.test.ts __tests__/message-handler.test.ts
     ```
     Expected: all PASS (both `_exhaustiveCheck` switches now include `type-at`; self-containment still green — the new branch stays inner-only).

9. - [ ] Commit:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     git add common mcp-server chrome-extension firefox-extension
     git commit -m "feat(type-at): synthetic coordinate typing (input/textarea + contenteditable) with optional submit"
     ```

---

### Task 4 — `hover-at` (synthetic) (#1)

`elementFromPoint` → `mouseover`/`mouseenter`/`mousemove` (reveals hover menus/tooltips). One new cmd.

**Files:**
- Modify both `injected/point-action-script.ts` — `hover-at` branch.
- Modify `common/server-messages.ts`; `mcp-server/server.ts`; `mcp-server/browser-api.ts`; both `extension-config.ts`; both `message-handler.ts`; both `__tests__/point-action-script.test.ts`; `mcp-server/__tests__/coordinate-tools.test.ts`.

**Interfaces:**
- Consumes (MCP): `hover-at { tabId, x, y }`. Produces: `point-action-result`.

**Steps:**

1. - [ ] **Impl — injected `hover-at` (both).** Extend the union with `| { action: "hover-at"; x: number; y: number }` and add the branch (after `type-at`):
     ```ts
         if (args.action === "hover-at") {
           const el = elementAt(args.x, args.y);
           if (!el) {
             return offPoint(args.x, args.y);
           }
           el.dispatchEvent(mouseEvt("mouseover", 0));
           el.dispatchEvent(
             new MouseEvent("mouseenter", {
               bubbles: false,
               cancelable: true,
               view: win as Window,
             })
           );
           el.dispatchEvent(mouseEvt("mousemove", 0));
           return { ok: true, element: describe(el) };
         }
     ```

2. - [ ] **Failing test (both jsdom).** Add to BOTH `__tests__/point-action-script.test.ts`:
     ```ts
     describe("hover-at (Task 4)", () => {
       it("dispatches mouseover/mouseenter/mousemove on the element under the point", () => {
         document.body.innerHTML = `<div id="menu">Menu</div>`;
         const el = document.getElementById("menu")!;
         (document as any).elementFromPoint = jest.fn(() => el);
         const over = jest.fn();
         const move = jest.fn();
         el.addEventListener("mouseover", over);
         el.addEventListener("mousemove", move);

         const res = performPointAction(document, { action: "hover-at", x: 7, y: 8 });

         expect(over).toHaveBeenCalled();
         expect(move).toHaveBeenCalled();
         expect(res.ok).toBe(true);
         expect(res.element!.id).toBe("menu");
       });

       it("returns ok:false when the point hits nothing", () => {
         (document as any).elementFromPoint = jest.fn(() => null);
         const res = performPointAction(document, { action: "hover-at", x: 0, y: 0 });
         expect(res.ok).toBe(false);
       });
     });
     ```
     Run both; expected PASS.

3. - [ ] **Impl — server message + union.**
     ```ts
     export interface HoverAtServerMessage extends ServerMessageBase {
       cmd: "hover-at";
       tabId: number;
       x: number;
       y: number;
     }
     ```
     add `| HoverAtServerMessage` to the union.

4. - [ ] **Impl — both extension-config.ts.** Append to `AVAILABLE_TOOLS`:
     ```ts
       ,
       {
         id: "hover-at",
         name: "Hover at Coordinates",
         description: "Allows the MCP server to hover the pointer at pixel coordinates on a page (reveals hover menus/tooltips; synthetic, covert)"
       }
     ```
     add `"hover-at": "hover-at",` to `COMMAND_TO_TOOL_ID` and `"hover-at",` to `AUTOMATION_COMMANDS`.

5. - [ ] **Impl — both handlers.** Add the `case`:
     ```ts
     case "hover-at":
       await this.runPointAction(req.correlationId, req.tabId, {
         action: "hover-at",
         x: req.x,
         y: req.y,
       });
       break;
     ```

6. - [ ] **Impl — browser-api + server.** In `browser-api.ts`:
     ```ts
     async hoverAt(
       tabId: number,
       x: number,
       y: number
     ): Promise<PointActionResultExtensionMessage> {
       return await this.sendTool<PointActionResultExtensionMessage>({
         cmd: "hover-at",
         tabId,
         x,
         y,
       });
     }
     ```
     In `server.ts`:
     ```ts
     mcpServer.tool(
       "hover-at",
       "Move the pointer to viewport pixel coordinates {x,y} to reveal hover-only UI (dropdown menus, tooltips) before a follow-up snapshot/click. Runs covertly in the isolated world. Returns a descriptor of the element under the point.",
       { tabId: z.number(), x: z.number(), y: z.number() },
       async ({ tabId, x, y }) => {
         const result = await browserApi.hoverAt(tabId, x, y);
         return formatPointResult("Hovered", tabId, x, y, result);
       }
     );
     ```

7. - [ ] **Wire round-trip assertion.** In `mcp-server/__tests__/coordinate-tools.test.ts`:
     ```ts
     it("forwards hover-at coords", async () => {
       await api.hoverAt(2, 11, 22);
       expect((lastReq as any).cmd).toBe("hover-at");
       expect((lastReq as any).x).toBe(11);
       expect((lastReq as any).y).toBe(22);
     });
     ```

8. - [ ] **Run-to-pass + build:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/coordinate-tools.test.ts && npm run build
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/point-action-script.test.ts __tests__/message-handler.test.ts
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/point-action-script.test.ts __tests__/message-handler.test.ts
     ```
     Expected: all PASS.

9. - [ ] Commit:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     git add common mcp-server chrome-extension firefox-extension
     git commit -m "feat(hover-at): synthetic coordinate hover (reveals hover menus/tooltips)"
     ```

---

### Task 5 — `scroll-at` (nearest scrollable ancestor) (#1, #6)

`elementFromPoint` → walk ancestors for the first scrollable container (`overflowY`/`overflowX` auto|scroll AND `scroll*>client*`) → `scrollBy(dx,dy)`; fall back to the window. Fixes inner-container scroll and the `press-key PageUp` gap. Defaults to one container-viewport down when `dx`/`dy` are omitted. One new cmd.

**Files:**
- Modify both `injected/point-action-script.ts` — `scroll-at` branch.
- Modify `common/server-messages.ts`; `mcp-server/server.ts`; `mcp-server/browser-api.ts`; both `extension-config.ts`; both `message-handler.ts`; both `__tests__/point-action-script.test.ts`; `mcp-server/__tests__/coordinate-tools.test.ts`.

**Interfaces:**
- Consumes (MCP): `scroll-at { tabId, x, y, dx?, dy? }`. Produces: `point-action-result` (describes the resolved scroll container, or the element at the point when it falls back to the window).

**Steps:**

1. - [ ] **Impl — injected `scroll-at` (both).** Extend the union with `| { action: "scroll-at"; x: number; y: number; dx?: number; dy?: number }` and add the branch (after `hover-at`):
     ```ts
         if (args.action === "scroll-at") {
           const el = elementAt(args.x, args.y);
           if (!el) {
             return offPoint(args.x, args.y);
           }
           function isScrollable(node: Element): boolean {
             if (!win || typeof win.getComputedStyle !== "function") {
               return false;
             }
             let oy = "";
             let ox = "";
             try {
               const cs = win.getComputedStyle(node);
               oy = cs.overflowY || "";
               ox = cs.overflowX || "";
             } catch (e) {
               return false;
             }
             const canY =
               (oy === "auto" || oy === "scroll") &&
               node.scrollHeight > node.clientHeight;
             const canX =
               (ox === "auto" || ox === "scroll") &&
               node.scrollWidth > node.clientWidth;
             return canY || canX;
           }
           let container: Element | null = el;
           while (container && !isScrollable(container)) {
             container = container.parentElement;
           }
           const dx = typeof args.dx === "number" ? args.dx : 0;
           const viewportH = win ? win.innerHeight || 0 : 0;
           if (container) {
             const dy =
               typeof args.dy === "number"
                 ? args.dy
                 : container.clientHeight || viewportH || 600;
             const sb = (container as {
               scrollBy?: (x: number, y: number) => void;
             }).scrollBy;
             if (typeof sb === "function") {
               sb.call(container, dx, dy);
             } else {
               (container as { scrollTop: number }).scrollTop += dy;
               (container as { scrollLeft: number }).scrollLeft += dx;
             }
             return { ok: true, element: describe(container) };
           }
           // No scrollable ancestor — scroll the window.
           const dyWin = typeof args.dy === "number" ? args.dy : viewportH || 600;
           if (win && typeof win.scrollBy === "function") {
             win.scrollBy(dx, dyWin);
           }
           return { ok: true, element: describe(el) };
         }
     ```

2. - [ ] **Failing test (both jsdom).** Add to BOTH `__tests__/point-action-script.test.ts` (jsdom has no layout, so make an ancestor scrollable by inline style + defined scroll/client sizes, and spy on `scrollBy`):
     ```ts
     describe("scroll-at (Task 5)", () => {
       function stubPoint(el: Element | null) {
         (document as any).elementFromPoint = jest.fn(() => el);
       }

       it("scrolls the nearest scrollable ANCESTOR, not the window", () => {
         document.body.innerHTML = `
           <div id="panel" style="overflow-y: scroll">
             <div id="inner"><span id="leaf">row</span></div>
           </div>`;
         const panel = document.getElementById("panel")!;
         const leaf = document.getElementById("leaf")!;
         // jsdom reports 0 sizes; force a scrollable geometry on the panel.
         Object.defineProperty(panel, "scrollHeight", { value: 500, configurable: true });
         Object.defineProperty(panel, "clientHeight", { value: 200, configurable: true });
         (panel as any).scrollBy = jest.fn();
         (window as any).scrollBy = jest.fn();
         stubPoint(leaf);

         const res = performPointAction(document, { action: "scroll-at", x: 5, y: 5, dy: 120 });

         expect((panel as any).scrollBy).toHaveBeenCalledWith(0, 120);
         expect((window as any).scrollBy).not.toHaveBeenCalled();
         expect(res.ok).toBe(true);
         expect(res.element!.id).toBe("panel");
       });

       it("falls back to window.scrollBy when no ancestor is scrollable", () => {
         document.body.innerHTML = `<div id="plain">x</div>`;
         const el = document.getElementById("plain")!;
         (window as any).scrollBy = jest.fn();
         stubPoint(el);

         const res = performPointAction(document, { action: "scroll-at", x: 1, y: 1, dy: 300 });

         expect((window as any).scrollBy).toHaveBeenCalledWith(0, 300);
         expect(res.ok).toBe(true);
       });
     });
     ```
     Run both; expected PASS.

3. - [ ] **Impl — server message + union.**
     ```ts
     export interface ScrollAtServerMessage extends ServerMessageBase {
       cmd: "scroll-at";
       tabId: number;
       x: number;
       y: number;
       dx?: number;
       dy?: number;
     }
     ```
     add `| ScrollAtServerMessage` to the union.

4. - [ ] **Impl — both extension-config.ts.** Append to `AVAILABLE_TOOLS`:
     ```ts
       ,
       {
         id: "scroll-at",
         name: "Scroll at Coordinates",
         description: "Allows the MCP server to scroll the nearest scrollable container under pixel coordinates (fixes inner-container scroll; synthetic, covert)"
       }
     ```
     add `"scroll-at": "scroll-at",` to `COMMAND_TO_TOOL_ID` and `"scroll-at",` to `AUTOMATION_COMMANDS`.

5. - [ ] **Impl — both handlers.** Add the `case`:
     ```ts
     case "scroll-at":
       await this.runPointAction(req.correlationId, req.tabId, {
         action: "scroll-at",
         x: req.x,
         y: req.y,
         dx: req.dx,
         dy: req.dy,
       });
       break;
     ```

6. - [ ] **Impl — browser-api + server.** In `browser-api.ts`:
     ```ts
     async scrollAt(
       tabId: number,
       x: number,
       y: number,
       opts?: { dx?: number; dy?: number }
     ): Promise<PointActionResultExtensionMessage> {
       return await this.sendTool<PointActionResultExtensionMessage>({
         cmd: "scroll-at",
         tabId,
         x,
         y,
         dx: opts?.dx,
         dy: opts?.dy,
       });
     }
     ```
     In `server.ts`:
     ```ts
     mcpServer.tool(
       "scroll-at",
       "Scroll the NEAREST SCROLLABLE CONTAINER under viewport pixel coordinates {x,y} by (dx, dy) pixels — this scrolls an inner panel (e.g. a chat message list) rather than the whole window, which press-key PageUp cannot do. Omit dx/dy to scroll one container-viewport down. Falls back to the window when nothing under the point scrolls. Returns a descriptor of the container that was scrolled.",
       {
         tabId: z.number(),
         x: z.number(),
         y: z.number(),
         dx: z.number().optional(),
         dy: z.number().optional(),
       },
       async ({ tabId, x, y, dx, dy }) => {
         const result = await browserApi.scrollAt(tabId, x, y, { dx, dy });
         return formatPointResult("Scrolled", tabId, x, y, result);
       }
     );
     ```

7. - [ ] **Wire round-trip assertion.** In `mcp-server/__tests__/coordinate-tools.test.ts`:
     ```ts
     it("forwards scroll-at deltas", async () => {
       await api.scrollAt(2, 30, 40, { dx: 0, dy: 250 });
       expect((lastReq as any).cmd).toBe("scroll-at");
       expect((lastReq as any).dy).toBe(250);
     });
     ```

8. - [ ] **Run-to-pass + build:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/coordinate-tools.test.ts && npm run build
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/point-action-script.test.ts __tests__/message-handler.test.ts
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/point-action-script.test.ts __tests__/message-handler.test.ts
     ```
     Expected: all PASS.

9. - [ ] Commit:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     git add common mcp-server chrome-extension firefox-extension
     git commit -m "feat(scroll-at): scroll the nearest scrollable ancestor under a point (inner-container scroll)"
     ```

---

### Task 6 — `scroll-to` + `scroll-into-view` (#6)

Two related scroll tools that do NOT act at an arbitrary point, so they reply with the shared `action-result` (not `point-action-result`): `scroll-to { x?, y? }` → `window.scrollTo`; `scroll-into-view { uid }` → `scrollIntoView({block:"center"})` on the uid'd element. Two new cmds; two new self-contained injected functions.

**Files:**
- Modify both `injected/point-action-script.ts` — `scrollWindowTo` + `scrollElementIntoView`.
- Modify `common/server-messages.ts` — `ScrollToServerMessage` + `ScrollIntoViewServerMessage` + union.
- Modify `mcp-server/server.ts`; `mcp-server/browser-api.ts`; both `extension-config.ts`; both `message-handler.ts`; `chrome-extension/content-script.ts`; `firefox-extension/__tests__/self-containment.test.ts`; both `__tests__/point-action-script.test.ts`; both `__tests__/message-handler.test.ts`; `mcp-server/__tests__/coordinate-tools.test.ts`.

**Interfaces:**
- Consumes (MCP): `scroll-to { tabId, x?, y? }`, `scroll-into-view { tabId, uid }`. Produces: `action-result` (`{resource:"action-result"; ok; error?}`).

**Steps:**

1. - [ ] **Impl — injected functions (both, identical).** In both `injected/point-action-script.ts`, add two exports (self-contained):
     ```ts
     export function scrollWindowTo(
       doc: Document,
       x?: number,
       y?: number
     ): { ok: boolean; error?: string } {
       try {
         const win = doc.defaultView as (Window & typeof globalThis) | null;
         if (!win || typeof win.scrollTo !== "function") {
           return { ok: false, error: "Window is not scrollable in this context." };
         }
         const toX = typeof x === "number" ? x : win.scrollX || 0;
         const toY = typeof y === "number" ? y : win.scrollY || 0;
         win.scrollTo(toX, toY);
         return { ok: true };
       } catch (e) {
         return { ok: false, error: String(e) };
       }
     }

     export function scrollElementIntoView(
       doc: Document,
       uid: string
     ): { ok: boolean; error?: string } {
       try {
         const el = doc.querySelector('[data-bcmcp-uid="' + uid + '"]');
         if (!el) {
           return {
             ok: false,
             error:
               "Element uid '" +
               uid +
               "' not found — take a fresh snapshot (uids are reassigned each snapshot).",
           };
         }
         try {
           (el as { scrollIntoView?: (opts?: unknown) => void }).scrollIntoView?.({
             block: "center",
             inline: "center",
           });
         } catch (e) {
           /* jsdom lacks a layout engine — never throw on scroll */
         }
         return { ok: true };
       } catch (e) {
         return { ok: false, error: String(e) };
       }
     }
     ```

2. - [ ] **Impl — self-containment registration (Firefox).** In `firefox-extension/__tests__/self-containment.test.ts`, extend the import and add two list entries:
     ```ts
     import {
       performPointAction,
       scrollWindowTo,
       scrollElementIntoView,
     } from "../injected/point-action-script";
     ```
     ```ts
       ["scrollWindowTo", scrollWindowTo as unknown as (...args: any[]) => any],
       ["scrollElementIntoView", scrollElementIntoView as unknown as (...args: any[]) => any],
     ```

3. - [ ] **Failing test (both jsdom).** Add to BOTH `__tests__/point-action-script.test.ts` (import the two new functions at the top of the file):
     ```ts
     // (top of file)
     import {
       performPointAction,
       scrollWindowTo,
       scrollElementIntoView,
     } from "../injected/point-action-script";

     describe("scrollWindowTo / scrollElementIntoView (Task 6)", () => {
       it("scrollWindowTo calls window.scrollTo(x,y)", () => {
         (window as any).scrollTo = jest.fn();
         const res = scrollWindowTo(document, 0, 400);
         expect((window as any).scrollTo).toHaveBeenCalledWith(0, 400);
         expect(res.ok).toBe(true);
       });

       it("scrollElementIntoView resolves the uid and centers it", () => {
         document.body.innerHTML = `<div data-bcmcp-uid="e5">target</div>`;
         const el = document.querySelector('[data-bcmcp-uid="e5"]')!;
         (el as any).scrollIntoView = jest.fn();
         const res = scrollElementIntoView(document, "e5");
         expect((el as any).scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "center" });
         expect(res.ok).toBe(true);
       });

       it("scrollElementIntoView returns ok:false for a stale uid", () => {
         document.body.innerHTML = `<div>nope</div>`;
         const res = scrollElementIntoView(document, "e404");
         expect(res.ok).toBe(false);
         expect(res.error).toMatch(/not found/);
       });
     });
     ```
     Run both; expected PASS.

4. - [ ] **Impl — server messages + union.**
     ```ts
     export interface ScrollToServerMessage extends ServerMessageBase {
       cmd: "scroll-to";
       tabId: number;
       x?: number;
       y?: number;
     }

     export interface ScrollIntoViewServerMessage extends ServerMessageBase {
       cmd: "scroll-into-view";
       tabId: number;
       uid: string;
     }
     ```
     add `| ScrollToServerMessage | ScrollIntoViewServerMessage` to the `ServerMessage` union.

5. - [ ] **Impl — both extension-config.ts.** Append to `AVAILABLE_TOOLS`:
     ```ts
       ,
       {
         id: "scroll-to",
         name: "Scroll to Position",
         description: "Allows the MCP server to scroll the page to absolute coordinates (window.scrollTo)"
       },
       {
         id: "scroll-into-view",
         name: "Scroll Element into View",
         description: "Allows the MCP server to scroll a snapshot element into view by uid"
       }
     ```
     add to `COMMAND_TO_TOOL_ID`:
     ```ts
       "scroll-to": "scroll-to",
       "scroll-into-view": "scroll-into-view",
     ```
     and to `AUTOMATION_COMMANDS`:
     ```ts
       "scroll-to",
       "scroll-into-view",
     ```

6. - [ ] **Impl — Chrome content-script cases.** In `chrome-extension/content-script.ts`, extend the import:
     ```ts
     import {
       performPointAction,
       scrollWindowTo,
       scrollElementIntoView,
     } from "./injected/point-action-script";
     ```
     and add two `case`s:
     ```ts
     case "scrollWindowTo": {
       const result = scrollWindowTo(document, message.x, message.y);
       sendResponse(result);
       break;
     }
     case "scrollElementIntoView": {
       const result = scrollElementIntoView(document, message.uid);
       sendResponse(result);
       break;
     }
     ```

7. - [ ] **Impl — Chrome handlers + cases.** In `chrome-extension/message-handler.ts`, extend the import:
     ```ts
     import {
       performPointAction,
       scrollWindowTo,
       scrollElementIntoView,
     } from "./injected/point-action-script";
     ```
     add the two handlers:
     ```ts
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
     ```
     and the two `case`s:
     ```ts
     case "scroll-to":
       await this.scrollWindow(req.correlationId, req.tabId, req.x, req.y);
       break;
     case "scroll-into-view":
       await this.scrollIntoViewByUid(req.correlationId, req.tabId, req.uid);
       break;
     ```

8. - [ ] **Impl — Firefox handlers + cases.** In `firefox-extension/message-handler.ts`, extend the import:
     ```ts
     import {
       performPointAction,
       scrollWindowTo,
       scrollElementIntoView,
     } from "./injected/point-action-script";
     ```
     add the two handlers (executeScript-stringified):
     ```ts
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
     ```
     > Note: `JSON.stringify(x ?? null) ?? undefined` embeds `null ?? undefined` → `undefined` when the coord was omitted, so `scrollWindowTo` sees `undefined` and preserves that axis. Verify the emitted code compiles (it is `null ?? undefined` → `undefined`, or `42 ?? undefined` → `42`).
     and the two `case`s:
     ```ts
     case "scroll-to":
       await this.scrollWindow(req.correlationId, req.tabId, req.x, req.y);
       break;
     case "scroll-into-view":
       await this.scrollIntoViewByUid(req.correlationId, req.tabId, req.uid);
       break;
     ```

9. - [ ] **Impl — browser-api + server.** In `mcp-server/browser-api.ts` (import `ActionResultExtensionMessage` is already present), add:
     ```ts
     async scrollTo(
       tabId: number,
       x?: number,
       y?: number
     ): Promise<ActionResultExtensionMessage> {
       return await this.sendTool<ActionResultExtensionMessage>({
         cmd: "scroll-to",
         tabId,
         x,
         y,
       });
     }

     async scrollIntoView(
       tabId: number,
       uid: string
     ): Promise<ActionResultExtensionMessage> {
       return await this.sendTool<ActionResultExtensionMessage>({
         cmd: "scroll-into-view",
         tabId,
         uid,
       });
     }
     ```
     In `mcp-server/server.ts`:
     ```ts
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
     ```

10. - [ ] **Failing tests (both handlers).** Add to BOTH `__tests__/message-handler.test.ts` inside the `coordinate tools` describe (or a new `scroll tools` describe with the same `automationConfig`/`beforeEach`). Chrome:
      ```ts
      it("scroll-to replies action-result ok:true", async () => {
        (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({ ok: true });
        await messageHandler.handleDecodedMessage({
          cmd: "scroll-to", tabId: 8, x: 0, y: 500, correlationId: "st",
        } as ServerMessageRequest);
        expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, { type: "scrollWindowTo", x: 0, y: 500 });
        expect(transport.sendResourceToServer).toHaveBeenCalledWith({
          resource: "action-result", correlationId: "st", ok: true,
        });
      });

      it("scroll-into-view replies action-result ok:false for a stale uid", async () => {
        (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({ ok: false, error: "Element uid 'e9' not found — take a fresh snapshot (uids are reassigned each snapshot)." });
        await messageHandler.handleDecodedMessage({
          cmd: "scroll-into-view", tabId: 8, uid: "e9", correlationId: "sv",
        } as ServerMessageRequest);
        expect(transport.sendResourceToServer).toHaveBeenCalledWith({
          resource: "action-result", correlationId: "sv", ok: false,
          error: "Element uid 'e9' not found — take a fresh snapshot (uids are reassigned each snapshot).",
        });
      });
      ```
      Firefox (executeScript-based):
      ```ts
      it("scroll-into-view injects scrollElementIntoView and replies action-result", async () => {
        (browser.tabs.executeScript as jest.Mock).mockResolvedValue([{ ok: true }]);
        await messageHandler.handleDecodedMessage({
          cmd: "scroll-into-view", tabId: 9, uid: "e5", correlationId: "sv",
        } as ServerMessageRequest);
        const code = (browser.tabs.executeScript as jest.Mock).mock.calls[0][1].code;
        expect(code).toContain('"e5"');
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "action-result", correlationId: "sv", ok: true,
        });
      });
      ```

11. - [ ] **Wire round-trip assertion.** In `mcp-server/__tests__/coordinate-tools.test.ts`, extend the mock reply to branch on scroll cmds (return `{resource:"action-result", ok:true}` for `scroll-to`/`scroll-into-view`), then:
      ```ts
      it("forwards scroll-to and scroll-into-view", async () => {
        const r1 = await api.scrollTo(2, 0, 900);
        expect((lastReq as any).cmd).toBe("scroll-to");
        expect((lastReq as any).y).toBe(900);
        expect(r1.ok).toBe(true);
        const r2 = await api.scrollIntoView(2, "e7");
        expect((lastReq as any).cmd).toBe("scroll-into-view");
        expect((lastReq as any).uid).toBe("e7");
        expect(r2.ok).toBe(true);
      });
      ```
      > In the reply handler, key off `req.cmd`: `if (req.cmd === "scroll-to" || req.cmd === "scroll-into-view") return { resource:"action-result", correlationId: req.correlationId, ok: true };` before the point-action-result default.

12. - [ ] **Run-to-pass + build:**
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/coordinate-tools.test.ts && npm run build
      cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/point-action-script.test.ts __tests__/self-containment.test.ts __tests__/message-handler.test.ts
      cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/point-action-script.test.ts __tests__/message-handler.test.ts
      ```
      Expected: all PASS (both switches now exhaustive over all six new cmds).

13. - [ ] Commit:
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp
      git add common mcp-server chrome-extension firefox-extension
      git commit -m "feat(scroll): add scroll-to (window) and scroll-into-view (uid) tools"
      ```

---

### Task 7 — Full-page screenshot stitch hardening (#6)

Harden `take-screenshot fullPage:true`: validate each captured tile (treat an empty `base64` readback as a failure), retry per-segment capture with backoff (3 attempts, sleeping 100→300ms between them — also absorbs `captureVisibleTab` rate-limiting), fall back to a single viewport capture with a `warning` when the stitch fails (empty readback OR canvas/offscreen throw), and surface a real `"image readback failed"` error only after retries AND the viewport fallback are exhausted. No new cmd.

**Files:**
- Modify both `injected/screenshot-script.ts` — add `isValidCapture`.
- Modify `common/extension-messages.ts` — `ScreenshotExtensionMessage.warning?`.
- Modify both `message-handler.ts` — `captureWindowWithRetry` + hardened `captureFullPage` (+ surface `warning` in `takeScreenshot`).
- Modify `mcp-server/server.ts` — surface `warning` in the `take-screenshot` tool output.
- Modify both `__tests__/message-handler.test.ts`; both `__tests__/screenshot-script.test.ts` (or create the Chrome one if absent — Firefox has `screenshot-script.test.ts`).

**Interfaces:**
- Produces (extension): `ScreenshotExtensionMessage { resource:"screenshot"; mimeType; base64; warning? }` — `warning` is append-only.
- Internal: `isValidCapture(dataUrl) => boolean`; `captureFullPage(...) => { mimeType; base64; warning? }`.

**Steps:**

1. - [ ] **Impl — `isValidCapture` (both, identical).** In both `injected/screenshot-script.ts`, add after `stripDataUrlPrefix`:
     ```ts
     /**
      * True when `dataUrl` is a usable capture: a non-empty string whose data-URL
      * payload has a non-empty base64 body. A failed captureVisibleTab / empty
      * offscreen readback yields "" (or a prefix with no payload) — that is a
      * FAILURE, not a valid (empty) image.
      */
     export function isValidCapture(dataUrl: unknown): boolean {
       if (typeof dataUrl !== "string" || dataUrl.length === 0) {
         return false;
       }
       const { base64 } = stripDataUrlPrefix(dataUrl);
       return base64.length > 0;
     }
     ```

2. - [ ] **Failing test (both jsdom, pure helper).** In `firefox-extension/__tests__/screenshot-script.test.ts` add (and create `chrome-extension/__tests__/screenshot-script.test.ts` with the import + these cases if it does not exist):
     ```ts
     import { isValidCapture } from "../injected/screenshot-script";

     describe("isValidCapture (Task 7)", () => {
       it("accepts a real data URL", () => {
         expect(isValidCapture("data:image/png;base64,AAAA")).toBe(true);
       });
       it("rejects an empty string and a payload-less data URL", () => {
         expect(isValidCapture("")).toBe(false);
         expect(isValidCapture("data:image/png;base64,")).toBe(false);
         expect(isValidCapture(undefined)).toBe(false);
       });
     });
     ```
     Run both; expected PASS.

3. - [ ] **Impl — extension message.** In `common/extension-messages.ts`, add `warning?` to `ScreenshotExtensionMessage`:
     ```ts
     export interface ScreenshotExtensionMessage extends ExtensionMessageBase {
       resource: "screenshot";
       mimeType: string;
       base64: string;
       // Set when a fallback path produced the image (e.g. full-page stitch failed
       // and a single viewport capture was returned instead). Append-only.
       warning?: string;
     }
     ```

4. - [ ] **Impl — Chrome `captureWindowWithRetry` + hardened `captureFullPage`.** In `chrome-extension/message-handler.ts`, extend the screenshot-script import (add `isValidCapture`), add the retry helper, and rewrite `captureFullPage`:
     ```ts
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
         throw new Error("image readback failed");
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
     ```
     and thread `warning` through `takeScreenshot`'s `sendResourceToServer` (the method that calls `captureFullPage`). Change its result type and the send:
     ```ts
     let result: { mimeType: string; base64: string; warning?: string };
     ```
     ```ts
     await this.client.sendResourceToServer({
       resource: "screenshot",
       correlationId,
       mimeType: result.mimeType,
       base64: result.base64,
       ...(result.warning !== undefined ? { warning: result.warning } : {}),
     });
     ```

5. - [ ] **Impl — Firefox `captureWindowWithRetry` + hardened `captureFullPage`.** In `firefox-extension/message-handler.ts`, extend the screenshot-script import (add `isValidCapture`), add the SAME `captureWindowWithRetry` (identical body), and rewrite `captureFullPage` — same structure, except stitching is the imported `stitchFullPage(...)` (which THROWS under jsdom / on canvas failure → caught → fallback):
     ```ts
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
           await browser.tabs.executeScript(tabId, { code: `window.scrollTo(0, ${y})` });
           await sleep(100);
           const dataUrl = await this.captureWindowWithRetry(windowId, format);
           captures.push({ offsetY: y, dataUrl });
         }
       } catch (e) {
         tileError = true;
       } finally {
         await browser.tabs.executeScript(tabId, {
           code: `window.scrollTo(0, ${dims.originalScrollY})`,
         });
       }

       let stitched: { mimeType: string; base64: string } | null = null;
       if (!tileError) {
         try {
           const result = await stitchFullPage(
             captures,
             { scrollWidth: dims.scrollWidth, scrollHeight: dims.scrollHeight, dpr: dims.dpr },
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

       let fallbackUrl: string;
       try {
         fallbackUrl = await this.captureWindowWithRetry(windowId, format);
       } catch (e) {
         throw new Error("image readback failed");
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
     ```
     and thread `warning` through Firefox `takeScreenshot`'s result type + `sendResourceToServer` (same edit as Chrome step 4).

6. - [ ] **Impl — server surfaces the warning.** In `mcp-server/server.ts`, in the `take-screenshot` tool (currently ~line 643), after the `filePath` block and BEFORE pushing the image content, add:
     ```ts
     if (result.warning) {
       content.push({ type: "text", text: `Warning: ${result.warning}` });
     }
     ```

7. - [ ] **Failing test (Firefox handler — fallback + error).** In `firefox-extension/__tests__/message-handler.test.ts`, add (jsdom canvas makes `stitchFullPage` throw, so the fallback path runs naturally):
     ```ts
     describe("screenshot fullPage hardening (Task 7)", () => {
       const automationConfig = {
         secret: "test-secret", ports: [8089], domainDenyList: [] as string[],
         auditLog: [], automationMode: true,
       };
       beforeEach(() => {
         (browser.storage.local.get as jest.Mock).mockResolvedValue({ config: automationConfig });
         (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 3, url: "https://example.com", windowId: 1 });
         (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 3 }]);
         (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
         (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
         (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
           { scrollWidth: 100, scrollHeight: 100, clientWidth: 100, clientHeight: 100, dpr: 1, originalScrollY: 0 },
         ]);
       });

       it("falls back to a single viewport capture (with a warning) when stitching fails", async () => {
         // Tiles capture fine; jsdom canvas makes stitchFullPage throw -> fallback.
         (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue("data:image/png;base64,GOOD");
         await messageHandler.handleDecodedMessage({
           cmd: "take-screenshot", tabId: 3, fullPage: true, correlationId: "fp",
         } as ServerMessageRequest);
         expect(mockClient.sendResourceToServer).toHaveBeenCalledWith(
           expect.objectContaining({
             resource: "screenshot", correlationId: "fp", base64: "GOOD",
             warning: "Full-page stitch failed; returning a single viewport capture instead.",
           })
         );
       });

       it("retries an empty tile readback then succeeds", async () => {
         (browser.tabs.captureVisibleTab as jest.Mock)
           .mockResolvedValueOnce("")                         // tile attempt 1: empty -> retry
           .mockResolvedValue("data:image/png;base64,GOOD");  // attempt 2+ and fallback
         await messageHandler.handleDecodedMessage({
           cmd: "take-screenshot", tabId: 3, fullPage: true, correlationId: "rt",
         } as ServerMessageRequest);
         expect((browser.tabs.captureVisibleTab as jest.Mock).mock.calls.length).toBeGreaterThan(1);
         expect(mockClient.sendResourceToServer).toHaveBeenCalledWith(
           expect.objectContaining({ resource: "screenshot", correlationId: "rt", base64: "GOOD" })
         );
       });

       it("throws 'image readback failed' when every capture is empty (retries + fallback exhausted)", async () => {
         (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue("");
         await expect(
           messageHandler.handleDecodedMessage({
             cmd: "take-screenshot", tabId: 3, fullPage: true, correlationId: "err",
           } as ServerMessageRequest)
         ).rejects.toThrow("image readback failed");
       });
     });
     ```

8. - [ ] **Failing test (Chrome handler — fallback + error).** In `chrome-extension/__tests__/message-handler.test.ts`, add the same three cases, but drive the stitch failure via the offscreen `runtime.sendMessage` returning an empty readback, and dimensions via `browser.tabs.sendMessage` (`type:"readPageDimensions"`/`"scrollTo"`):
     ```ts
     describe("screenshot fullPage hardening (Task 7)", () => {
       const automationConfig = { ...baseConfig, automationMode: true };
       beforeEach(() => {
         (browser.storage.local.get as jest.Mock).mockResolvedValue({ config: automationConfig });
         (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 3, url: "https://example.com", windowId: 1 });
         (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 3 }]);
         (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
         (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
         (browser.offscreen.hasDocument as jest.Mock).mockResolvedValue(true);
         // Content-script measurement reads (readPageDimensions / scrollTo).
         (browser.tabs.sendMessage as jest.Mock).mockImplementation((_id, msg) => {
           if (msg.type === "readPageDimensions") {
             return Promise.resolve({ scrollWidth: 100, scrollHeight: 100, clientWidth: 100, clientHeight: 100, dpr: 1, originalScrollY: 0 });
           }
           return Promise.resolve({ ok: true });
         });
       });

       it("falls back to a single viewport capture with a warning when the offscreen stitch returns empty", async () => {
         (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue("data:image/png;base64,GOOD");
         // Offscreen stitch (runtime.sendMessage) returns an empty readback.
         (browser.runtime.sendMessage as jest.Mock).mockResolvedValue({ mimeType: "image/png", base64: "" });
         await messageHandler.handleDecodedMessage({
           cmd: "take-screenshot", tabId: 3, fullPage: true, correlationId: "fp",
         } as ServerMessageRequest);
         expect(transport.sendResourceToServer).toHaveBeenCalledWith(
           expect.objectContaining({
             resource: "screenshot", correlationId: "fp", base64: "GOOD",
             warning: "Full-page stitch failed; returning a single viewport capture instead.",
           })
         );
       });

       it("throws 'image readback failed' when tiles and the fallback are all empty", async () => {
         (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue("");
         (browser.runtime.sendMessage as jest.Mock).mockResolvedValue({ mimeType: "image/png", base64: "" });
         await expect(
           messageHandler.handleDecodedMessage({
             cmd: "take-screenshot", tabId: 3, fullPage: true, correlationId: "err",
           } as ServerMessageRequest)
         ).rejects.toThrow("image readback failed");
       });
     });
     ```

9. - [ ] **Run-to-pass + build:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/screenshot-script.test.ts __tests__/message-handler.test.ts
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/screenshot-script.test.ts __tests__/message-handler.test.ts
     cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npm run build
     ```
     Expected: all PASS; build OK. (The empty-everything test sleeps ~400ms per exhausted retry × 2 ≈ under 1s — comfortably within Jest's default 5s.)

10. - [ ] Commit:
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp
      git add common mcp-server chrome-extension firefox-extension
      git commit -m "fix(screenshot): harden full-page stitch (tile retry/backoff, empty-readback validation, viewport fallback, real error)"
      ```

---

### Task 8 — mcpkit skill docs for the Phase-2 additions

Document the new coordinate/scroll tools + the `evaluate-script` `world` param + the `take-screenshot` fallback warning in the FoxPilot mcpkit skill. **Hand-edit only** — do NOT run `mcpkit update`/`mcpkit sync`/`mcpkit runtime stop` (per the task constraints). Also confirm the new `server.ts` tool descriptions (written in Tasks 1–7) are accurate, since they are the canonical source the skill mirrors.

**Files:**
- Modify `~/.claude/skills/mcpkit-foxpilot/SKILL.md` (outside the repo).

**Interfaces:** documentation only — no code, no tests.

**Steps:**

1. - [ ] **Add entries for the six new tools.** In `~/.claude/skills/mcpkit-foxpilot/SKILL.md`, add a section per tool (match the file's existing per-tool format — heading, one-line purpose, a params table, a Usage block). Use these descriptions (kept in sync with the `server.ts` tool descriptions):
     - `### click-at` — `{tabId, x, y, doubleClick?, button?}` — "Click at viewport pixel coordinates when take-snapshot didn't surface the element (custom-React `<div onClick>`). Covert isolated-world synthetic click. Returns the element descriptor at the point."
     - `### type-at` — `{tabId, x, y, text, submit?}` — "Type into the element at coordinates; works for input/textarea AND `<div contenteditable>` chat inputs. `submit:true` presses Enter."
     - `### hover-at` — `{tabId, x, y}` — "Hover at coordinates to reveal hover menus/tooltips."
     - `### scroll-at` — `{tabId, x, y, dx?, dy?}` — "Scroll the nearest scrollable container under the point (inner-panel scroll that press-key PageUp can't do). Omit dx/dy for one viewport down."
     - `### scroll-to` — `{tabId, x?, y?}` — "window.scrollTo(x,y); omit an axis to leave it unchanged."
     - `### scroll-into-view` — `{tabId, uid}` — "scrollIntoView (centered) on a snapshot uid."
     - Note under click-at/type-at that these are the tools to reach for "when the a11y snapshot failed you," they are covert (no automation banner), and the trusted `engine:"cdp"` tier is a future addition (Phase 3).

2. - [ ] **Document the `evaluate-script` `world` param.** Update the `### evaluate-script` entry: add a `world` param row — "`world` | string | No | `\"main\"` (default; page world, sees the page's real window, blockable by strict CSP) or `\"isolated\"` (CSP-immune isolated content-script world; reads DOM/rects/non-httpOnly document.cookie; can't see page-JS globals; synchronous). On Chrome, `\"isolated\"` requires the isolated-world CSP to permit eval — otherwise it returns a clear unsupported error (use `\"main\"` or the Firefox build)." Add a usage line:
     ```bash
     mcpkit call foxpilot evaluate-script '{"tabId": 0, "function": "() => getComputedStyle(document.body).background", "world": "isolated"}'
     ```

3. - [ ] **Note the `take-screenshot` fallback.** Under the `### take-screenshot` entry, add a one-line note: "On a full-page capture, if stitching fails after retries the tool returns a single viewport capture plus a `Warning:` line rather than an empty image."

4. - [ ] **Update the top-of-file tool list / 'When to Use' bullets** to mention the six new coordinate/scroll tools and the `evaluate-script world` option, so the model can discover them.

5. - [ ] **Verify** the edits are present:
     ```bash
     grep -n "click-at\|type-at\|hover-at\|scroll-at\|scroll-to\|scroll-into-view\|world\|isolated" ~/.claude/skills/mcpkit-foxpilot/SKILL.md | head -30
     ```
     Expected: matches for all six new tools and the `world`/`isolated` note.

6. - [ ] **No repo commit** for the skill file (it lives under `~/.claude`, outside the repo). If any in-repo user-facing docs were updated alongside, commit those; otherwise this task ends with the SKILL.md hand-edit only.

---

## Appendix — verification matrix (what each task proves)

| Capability | jsdom unit (injected) | extension handler (both) | MCP wire round-trip | build |
|-----------|------------------------|--------------------------|---------------------|-------|
| #4 evaluate-script world:isolated | Task 1 (`page-world`, both) | Task 1 (isolated routing) | Task 1 (`evaluate-script-world`) | Task 1 |
| #1 click-at + infra | Task 2 (`point-action-script`, both) | Task 2 (both) | Task 2 (`coordinate-tools`) | Task 2 |
| #1 type-at | Task 3 (both) | (covered by shared runPointAction) | Task 3 | Task 3 |
| #1 hover-at | Task 4 (both) | (shared) | Task 4 | Task 4 |
| #1 scroll-at | Task 5 (both) | (shared) | Task 5 | Task 5 |
| #6 scroll-to / scroll-into-view | Task 6 (both) | Task 6 (both) | Task 6 | Task 6 |
| #6 screenshot stitch hardening | Task 7 (`isValidCapture`, both) | Task 7 (both: fallback + error) | — | Task 7 |

## Appendix — reconciliation notes (spec vs. real code — for self-review)

1. **`evaluate-script world:"isolated"` is genuinely asymmetric across browsers — the spec (§4.D) under-specified this.** The spec treats "isolated-world eval" as uniformly CSP-immune. Reality (verified against Chromium/MDN CSP docs):
   - **Firefox works cleanly.** `browser.tabs.executeScript({ code })` COMPILES the code string in the isolated world (like the existing snapshot injection) — there is no runtime `eval()`/`Function()` call, so the extension CSP never triggers and the page CSP never applies to the isolated world. Task 1's Firefox path embeds the source as a compiled expression → genuinely CSP-immune, no manifest change.
   - **Chrome MV3 is constrained.** MV3 removed `tabs.executeScript({code})`; `chrome.scripting.executeScript` accepts only `func`/`files`, so arbitrary source can only be compiled with `new Function`/`eval` — and Chrome's DEFAULT isolated-world extension CSP (`script-src 'self' 'wasm-unsafe-eval'`) BLOCKS those. So Task 1's Chrome path (`evalInIsolatedWorld` via `new Function`, wrapped in try/catch) **degrades to a clear `ok:false` error on stable Chrome unless the isolated-world CSP is relaxed.** jsdom has no CSP, so the unit tests exercise the success path; real Chrome returns the degrade error.
   - **Decision to reconcile:** either (a) ship Chrome `world:"isolated"` as the explicit clear-error degrade (Firefox is the full-support browser — matches the spec's "degrade explicitly, never silently"), or (b) add `content_security_policy.isolated_world: "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; object-src 'self'"` to `chrome-extension/manifest.json` (the documented, page-CSP-preserving relaxation) so the `new Function` path works. **(b) needs verification that the `isolated_world` CSP key is supported on the target stable-Chrome version** (it was an early/experimental key and is NOT among the standard MV3 `content_security_policy` keys — `extension_pages`/`sandbox`). The plan ships the code that works under either outcome (the try/catch degrades cleanly), and leaves the manifest relaxation as your call. **No manifest change is included by default** to avoid an unverified/CWS-review-expanding key.

2. **The coordinate tools do NOT literally reuse `performInputAction`'s `dispatchClickSequence` etc. — those are inner functions, not exports.** The spec says "reuse the existing action sequences (reuse `dispatchClickSequence` etc.)." Because `dispatchClickSequence`/`fillElement`/the type loop are inner functions of `performInputAction` (they MUST be, for stringify-injection self-containment), Phase 2 REPLICATES the identical click/press/key sequences inside a NEW self-contained module `injected/point-action-script.ts` rather than importing them. The event sequences are byte-for-byte the same idea (pointerdown→mousedown→mouseup→focus→one activation, per-char keydown/keyup, native-setter value append). This is the only way to keep the injected function self-contained (a shared exported helper would break `self-containment.test.ts`).

3. **`type-at` EXTENDS the type sequence to support `<div contenteditable>` — `performInputAction`'s `type` does not.** `performInputAction`'s `type` action only handles `INPUT`/`TEXTAREA` (it rejects everything else with "No focused element to type into"). But the motivating case in the spec (§1) is exactly the `<div contenteditable>` chat input. So `type-at` adds a contenteditable branch (`execCommand("insertText")` with a `textContent` fallback + `input` event). This is a deliberate superset of the existing behavior — flag if you'd rather keep them identical (then contenteditable typing would not work, defeating the feature's purpose).

4. **Chrome's `sendMessageToTab` throws on `{ok:false,error}` — the coordinate/scroll tools need `ok:false` as a RESULT.** The existing `sendMessageToTab.checkResult` throws whenever a content-script reply is `{ok:false,error}` (so, e.g., Chrome's `click-element` stale-uid becomes a thrown tool-error, whereas Firefox returns `action-result ok:false`). For the new tools an off-point / stale-uid / not-typable `ok:false` is a legitimate result to report (spec §4.A), so Task 2 adds `sendMessageToTabRaw` (same inject-retry, no throw) used by all the new Chrome handlers. This also makes Chrome and Firefox behave identically for these tools (both report `ok:false` as a result). Note the pre-existing Chrome/Firefox inconsistency for the OLD uid-based tools is left untouched.

5. **`scroll-to` / `scroll-into-view` reply `action-result`, not `point-action-result`.** They don't act at an arbitrary `{x,y}` point (no element-at-point to describe), so they reuse the existing `ActionResultExtensionMessage` (`{ok, error?}`) rather than the new `point-action-result`. Only `click-at`/`type-at`/`hover-at`/`scroll-at` return the element descriptor.

6. **Screenshot hardening: the empty-readback failure has two concrete shapes, and jsdom forces the Firefox stitch to throw.** On Chrome the offscreen compositor returns `{ base64: "" }` on canvas failure (`offscreen.ts` catch); on Firefox `stitchFullPage` THROWS `"Canvas 2D context unavailable"` under jsdom (and on real canvas failure). Task 7 treats BOTH (empty base64 OR a throw) as a stitch failure → single-viewport fallback with a `warning` → `"image readback failed"` only if the fallback capture is also empty. This makes the Firefox fallback path naturally testable in jsdom (where the real canvas always throws) without mocking the compositor. `offscreen.ts` and the `screenshot-script.ts` canvas code are otherwise unchanged; the retry/fallback orchestration lives in the message-handlers, and the only shared pure addition is `isValidCapture`.

7. **`point-action-result.element.rect` is `{0,0,0,0}` under jsdom (no layout engine), and `document.elementFromPoint` returns `null` there.** Every coordinate unit test stubs `document.elementFromPoint` and asserts the descriptor's tag/id/role/name/editable but NOT its rect values. This is called out in each coordinate task's tests and in the Global Constraints.

8. **No `engine` param, no `chrome.debugger`, no manifest permission change in Phase 2.** Phase 2 stays entirely on the covert synthetic/isolated path. The `engine:"cdp"` trusted tier (with `chrome.debugger` refcounting), `includeCredentials`, and the Chrome isolated-world CSP relaxation (item 1b) are all Phase 3 / deferred decisions. The six new `AVAILABLE_TOOLS` entries default enabled (fresh installs) and are all added to `AUTOMATION_COMMANDS`, so they require Automation Mode like every other page-controlling tool.
