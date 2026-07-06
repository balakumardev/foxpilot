# Composio handoff-page fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three independent, root-caused bugs that surface on the composio OAuth handoff page: `evaluate-script` failing on strict CSP, `click-element` timing out on a navigating click, and `take-screenshot` failing with "image readback failed".

**Architecture:** Three independent phases. Phase A (Bug 1) adds a "did-the-injected-script-start" CSP probe + a Chrome CDP `Runtime.evaluate` engine + a `world:"auto"` mode. Phase B (Bug 2) adds a background-side navigation-race so a click that tears down the page reports success instead of hanging. Phase C (Bug 3) wires the existing capture-retry into the default screenshot paths. Each phase produces working, independently-testable software.

**Tech Stack:** TypeScript, esbuild bundling, Jest (both extensions + server), Nx monorepo, MV3 (chrome-extension) / MV2 (firefox-extension), `chrome.debugger` CDP tier, `@foxpilot/common` shared message types.

## Global Constraints

- **No manifest changes.** `debugger`, `tabs`, `webRequest`, `scripting`, `cookies` are already in `chrome-extension/manifest.json`; `tabs`, `webRequest`, `webRequestBlocking` in `firefox-extension/manifest.json`. Adding no permission → no new Chrome Web Store review scope.
- **Injected functions must stay self-contained** (`firefox-extension/__tests__/self-containment.test.ts`): any function stringified via `.toString()` and injected (snapshot/action/point/humanize) may reference only inner helpers — no module imports in the body. New CDP-eval and nav-race code lives in `message-handler.ts` / background (bundled, not injected) — unaffected. Page-world *string builders* (`buildEvalPageScript` etc.) return self-contained source by construction.
- **Byte-identical mirroring:** shared functions that exist in BOTH `chrome-extension/injected/*` and `firefox-extension/injected/*` with the same name must have byte-identical bodies (per project `CLAUDE.md`; mirror manually). `buildEvalPageScript` is such a shared function — edit both identically. Functions that already diverge by design (`evalInIsolatedWorld` is Chrome-only; `buildIsolatedEvalCode` is Firefox-only) may stay divergent.
- **No new `cmd` in the `ServerMessage` union** — every fix is a param on an existing tool or internal behavior, so the `switch(req.cmd)` `_exhaustiveCheck: never` tripwire in both `message-handler.ts` files stays satisfied.
- **`EVAL_TIMEOUT_MS = 10000` stays** (`chrome-extension/message-handler.ts:70`, `firefox-extension/message-handler.ts:71`). A legitimate async eval awaiting a fetch needs it. The CSP probe fails fast *without* shortening this.
- **Build & bounce for manual testing:** `cd mcp-server && npm run build` → `mcpkit runtime stop foxpilot` (never `pkill` the runtime child) → Remove + Load-unpacked the extension (`npm run package --prefix chrome-extension` → load `chrome-extension/web-ext-artifacts/chrome-unpacked`); Firefox `about:debugging` → Reload. A still-loaded extension runs OLD code.
- **Run tests per extension:** `cd chrome-extension && npx jest`, `cd firefox-extension && npx jest`, `cd mcp-server && npx jest`.
- Commit after every task (frequent commits). Branch is `fix/composio-page-fixes` (already created).

---

# Phase A — Bug 1: `evaluate-script` on strict-CSP pages

**Outcome:** On strict-CSP Chrome pages, `evaluate-script` fails *instantly and definitively* (not after a 10s guess) with an actionable error, and `engine:"cdp"` actually runs the eval (CSP-immune, via `chrome.debugger`). On Firefox, `world:"auto"` transparently falls back to the isolated world (which works there).

### Task A1: Common types + server surface for `world:"auto"` and `engine`

**Files:**
- Modify: `common/server-messages.ts:152-163` (`EvaluateScriptServerMessage`)
- Modify: `mcp-server/server.ts:586-606` (tool schema + description)
- Modify: `mcp-server/browser-api.ts:765-782` (`evaluateScript` signature)
- Test: `mcp-server/__tests__/` (new `evaluate-script-schema.test.ts` if server tests live there; otherwise co-locate with existing server tests — check `mcp-server/*.test.ts` first)

**Interfaces:**
- Produces: `EvaluateScriptServerMessage.world?: "main" | "isolated" | "auto"`, `EvaluateScriptServerMessage.engine?: "auto" | "cdp"`. `BrowserAPI.evaluateScript(tabId, functionSource, args?, world?, engine?)`.

- [ ] **Step 1: Write the failing test** — verify the zod schema accepts the new values. In the server test file:

```ts
import { z } from "zod";
// Mirror the evaluate-script arg schema (kept in sync with server.ts).
const evalArgs = z.object({
  tabId: z.number(),
  function: z.string(),
  args: z.array(z.any()).optional(),
  world: z.enum(["main", "isolated", "auto"]).optional(),
  engine: z.enum(["auto", "cdp"]).optional(),
});

test("evaluate-script schema accepts world:auto and engine:cdp", () => {
  expect(evalArgs.parse({ tabId: 1, function: "() => 1", world: "auto", engine: "cdp" }))
    .toMatchObject({ world: "auto", engine: "cdp" });
});
test("evaluate-script schema still accepts legacy world:main with no engine", () => {
  expect(evalArgs.parse({ tabId: 1, function: "() => 1", world: "main" }))
    .toMatchObject({ world: "main" });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd mcp-server && npx jest evaluate-script-schema` → FAIL (or the test file doesn't exist yet).

- [ ] **Step 3: Update `EvaluateScriptServerMessage`** (`common/server-messages.ts`). Replace the `world?` line and add `engine?`:

```ts
export interface EvaluateScriptServerMessage extends ServerMessageBase {
  cmd: "evaluate-script";
  tabId: number;
  function: string;
  args?: unknown[];
  // Which JS world to run in. "auto" (default) tries the page's real "main"
  // world first and, if a strict page CSP blocks the injected <script>, on
  // Firefox transparently retries "isolated" (which is genuinely CSP-immune
  // there); on Chrome it returns a fast, actionable CSP error (isolated eval is
  // also blocked on Chrome MV3 — use engine:"cdp"). "main" forces the page world
  // (no fallback). "isolated" forces the isolated content-script world (CSP-
  // immune, sees the DOM but not page-JS globals, synchronous).
  world?: "main" | "isolated" | "auto";
  // Dispatch engine. "auto" (default) uses the world above (covert injection).
  // "cdp" (Chrome/Edge only) runs the eval via chrome.debugger Runtime.evaluate,
  // which BYPASSES the page CSP entirely (runs arbitrary source on strict-CSP
  // pages) but shows the "started debugging this browser" banner and is
  // detectable. engine:"cdp" overrides `world`. Errors on Firefox (no debugger).
  engine?: "auto" | "cdp";
}
```

- [ ] **Step 4: Update the server tool** (`mcp-server/server.ts:589-601`). Extend the schema and pass `engine`:

```ts
  {
    tabId: z.number(),
    function: z.string(),
    args: z.array(z.any()).optional(),
    world: z.enum(["main", "isolated", "auto"]).optional(),
    engine: z.enum(["auto", "cdp"]).optional(),
  },
  async ({ tabId, function: functionSource, args, world, engine }) => {
    const value = await browserApi.evaluateScript(
      tabId,
      functionSource,
      args,
      world,
      engine
    );
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
    };
  }
```

Append to the tool description string (after the existing text, before the closing quote) — one sentence on the new capability:

```
 world defaults to "auto" (main-world, with an isolated fallback on Firefox). On a strict-CSP page where you must run real page JS, pass engine:"cdp" (Chrome/Edge only): it runs via the debugger so it bypasses the page CSP, at the cost of showing the debugger banner (detectable) — reach for it only when the covert path is CSP-blocked.
```

- [ ] **Step 5: Update `browser-api.ts`** (`mcp-server/browser-api.ts:765-782`) — add `world:"auto"` to the type and an `engine` param:

```ts
  async evaluateScript(
    tabId: number,
    functionSource: string,
    args?: unknown[],
    world?: "main" | "isolated" | "auto",
    engine?: "auto" | "cdp"
  ): Promise<unknown> {
    const message = await this.sendTool<EvalResultExtensionMessage>({
      cmd: "evaluate-script",
      tabId,
      function: functionSource,
      args,
      world,
      engine,
    });
    if (!message.ok) {
      throw new Error(message.error ?? "Script evaluation failed");
    }
    return message.value;
  }
```

- [ ] **Step 6: Run tests** — `cd mcp-server && npx jest` → PASS. Also `cd mcp-server && npm run build` → compiles (the `common` union change type-checks).

- [ ] **Step 7: Commit** — `git add common/server-messages.ts mcp-server/server.ts mcp-server/browser-api.ts mcp-server/__tests__/ && git commit -m "feat(evaluate-script): add world:auto + engine:cdp to schema/server surface"`

---

### Task A2: `started` marker in `buildEvalPageScript` (both extensions, byte-identical)

**Files:**
- Modify: `chrome-extension/injected/page-world.ts:103-139` (`buildEvalPageScript`)
- Modify: `firefox-extension/injected/page-world.ts:103-139` (`buildEvalPageScript` — identical edit)
- Test: `chrome-extension/__tests__/page-world.test.ts` and `firefox-extension/__tests__/page-world.test.ts` (find the existing suites that test `buildEvalPageScript`; if none, add to the nearest page-world test file)

**Interfaces:**
- Produces: `buildEvalPageScript(functionSource: string, args: unknown[], resultAttr: string, startedAttr: string): string`. The returned source sets `startedAttr="1"` on `document.documentElement` **synchronously, before** evaluating the function — so a caller that finds `startedAttr` absent knows the inline `<script>` never executed (CSP-blocked).

- [ ] **Step 1: Write the failing test** (both extensions' page-world test file):

```ts
import { buildEvalPageScript } from "../injected/page-world";

test("buildEvalPageScript sets the started marker before evaluating", () => {
  const src = buildEvalPageScript("() => 1", [], "data-r", "data-started");
  // The started attribute is set, and it appears BEFORE the result attribute in source order.
  expect(src).toContain("data-started");
  expect(src.indexOf("data-started")).toBeLessThan(src.lastIndexOf("data-r"));
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd chrome-extension && npx jest page-world` → FAIL (signature has 3 params).

- [ ] **Step 3: Edit `buildEvalPageScript`** — add the `startedAttr` param and emit the marker synchronously at the top of the IIFE (before the `try`). New body:

```ts
export function buildEvalPageScript(
  functionSource: string,
  args: unknown[],
  resultAttr: string,
  startedAttr: string
): string {
  return (
    "(async function () {" +
    "var __attr = " +
    jsonForScript(resultAttr) +
    ";" +
    // Synchronous "the injected script executed" marker. If a strict page CSP
    // blocks this inline <script>, NEITHER this nor __attr is ever set, so the
    // caller can distinguish "CSP-blocked" (no marker) from "slow async eval"
    // (marker set, result pending) instead of guessing on a 10s timeout.
    "document.documentElement.setAttribute(" +
    jsonForScript(startedAttr) +
    ", \"1\");" +
    "try {" +
    "var __fn = (" +
    jsonForScript(functionSource) +
    ");" +
    "var __args = " +
    jsonForScript(args) +
    ";" +
    "var __callable = (0, eval)('(' + __fn + ')');" +
    "var __result = __callable.apply(null, __args);" +
    "if (__result && typeof __result.then === 'function') {" +
    "__result = await __result;" +
    "}" +
    "var __out;" +
    "if (__result === undefined) { __out = null; }" +
    "else { try { __out = JSON.parse(JSON.stringify(__result)); } catch (e) { __out = String(__result); } }" +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:true, value: __out }));" +
    "} catch (err) {" +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:false, error: String(err && err.message || err) }));" +
    "}" +
    "})();"
  );
}
```

- [ ] **Step 4: Apply the identical edit to `firefox-extension/injected/page-world.ts:103-139`** — byte-identical body.

- [ ] **Step 5: Run tests both extensions** — `cd chrome-extension && npx jest page-world` and `cd firefox-extension && npx jest page-world` → PASS. Any existing `buildEvalPageScript` callers/tests that used the 3-arg form must be updated to pass a `startedAttr` (Task A3/A6 fix the runtime callers; fix any other test call sites here).

- [ ] **Step 6: Commit** — `git add chrome-extension/injected/page-world.ts firefox-extension/injected/page-world.ts chrome-extension/__tests__ firefox-extension/__tests__ && git commit -m "feat(evaluate-script): buildEvalPageScript emits a synchronous started marker"`

---

### Task A3: Chrome `runInPageWorld` CSP probe + eval-case wiring

**Files:**
- Modify: `chrome-extension/content-script.ts:33-65` (`runInPageWorld`) and `:345-353` (`evaluateScript` case)
- Test: manual (content-script.ts is not unit-tested in jsdom easily; verify via build + the manual regression in Phase D). Add a focused test only if `content-script` has an existing suite.

**Interfaces:**
- Consumes: `buildEvalPageScript(..., startedAttr)` from A2.
- Produces: `runInPageWorld(pageScript, resultAttr, timeoutMs, startedAttr?)`. When `startedAttr` is provided and the marker is absent immediately after injection, returns `{ ok:false, cspBlocked:true, error }` instantly.

- [ ] **Step 1: Edit `runInPageWorld`** (`chrome-extension/content-script.ts:33-65`) — add the optional `startedAttr` param and the synchronous post-inject probe (the inline `<script>` runs synchronously on `appendChild`, so if it wasn't CSP-blocked the marker is already set by the time `appendChild` returns):

```ts
  async function runInPageWorld(
    pageScript: string,
    resultAttr: string,
    timeoutMs: number,
    startedAttr?: string
  ): Promise<{ ok: boolean; value?: any; error?: string; cspBlocked?: boolean }> {
    const script = document.createElement("script");
    script.textContent = pageScript;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();

    // Definitive CSP detection: an ALLOWED inline <script> executes
    // synchronously during appendChild, so its `startedAttr` marker is already
    // present here. If the caller asked for a marker and it is absent, the page
    // CSP blocked the injection — fail instantly instead of waiting out the 10s
    // timeout (which must stay long for legitimately-slow async evals).
    if (startedAttr) {
      if (document.documentElement.getAttribute(startedAttr) === null) {
        return {
          ok: false,
          cspBlocked: true,
          error:
            'CSP blocked the injected script (the page forbids inline script execution). On Chrome/Edge retry with engine:"cdp" (runs via the debugger, bypasses page CSP), or read state with the CSP-immune take-snapshot / take-screenshot / coordinate tools / get-cookies.',
        };
      }
      document.documentElement.removeAttribute(startedAttr);
    }

    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const el = document.documentElement;
        const result = el.getAttribute(resultAttr);
        if (result) {
          el.removeAttribute(resultAttr);
          try {
            resolve(JSON.parse(result));
          } catch {
            resolve({ ok: false, error: "Failed to parse result" });
          }
          return;
        }
        if (Date.now() - start > timeoutMs) {
          resolve({ ok: false, error: "CSP hint: page may have blocked inline script injection" });
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }
```

- [ ] **Step 2: Wire the `evaluateScript` case** (`chrome-extension/content-script.ts:345-353`) to pass a `startedAttr` and the new builder arg:

```ts
          case "evaluateScript": {
            const startedAttr = message.resultAttr + "-started";
            const result = await runInPageWorld(
              buildEvalPageScript(message.functionSource, message.args, message.resultAttr, startedAttr),
              message.resultAttr,
              message.timeoutMs,
              startedAttr
            );
            sendResponse(result);
            break;
          }
```

Leave the `handleDialog` and `emulate` cases unchanged (they pass no `startedAttr` → old behavior; they set their result synchronously so they never hit the long timeout on a non-CSP page). Note: on a CSP page, dialog/emulate still time out at 10s — out of scope for this bug (evaluate-script is the reported tool). Do NOT change them.

- [ ] **Step 3: Build** — `cd chrome-extension && npm run build` → compiles. (`message.functionSource`/`message.resultAttr` already exist on the eval message; `cspBlocked` is an added optional field on the local return type only.)

- [ ] **Step 4: Commit** — `git add chrome-extension/content-script.ts && git commit -m "feat(evaluate-script): instant CSP detection via started-marker probe (chrome)"`

---

### Task A4: Chrome CDP eval engine (`cdp-eval.ts`)

**Files:**
- Create: `chrome-extension/cdp-eval.ts`
- Modify: `chrome-extension/network-capture.ts:51` (`DebuggerPurpose`)
- Test: `chrome-extension/__tests__/cdp-eval.test.ts`

**Interfaces:**
- Consumes: `attachDebugger(tabId, "eval")`, `detachDebugger(tabId, "eval")` from `network-capture.ts`.
- Produces: `cdpEval(tabId: number, functionSource: string, args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: string }>`.

- [ ] **Step 1: Extend `DebuggerPurpose`** (`chrome-extension/network-capture.ts:51`):

```ts
type DebuggerPurpose = "network" | "input" | "eval";
```

- [ ] **Step 2: Write the failing test** (`chrome-extension/__tests__/cdp-eval.test.ts`) — mock `chrome.debugger` and the attach/detach:

```ts
jest.mock("../network-capture", () => ({
  attachDebugger: jest.fn(async () => {}),
  detachDebugger: jest.fn(async () => {}),
}));
import { cdpEval } from "../cdp-eval";
import { attachDebugger, detachDebugger } from "../network-capture";

function mockDebugger(sendImpl: (method: string, params: any) => any) {
  (globalThis as any).chrome = {
    debugger: { sendCommand: jest.fn(async (_t: any, method: string, params: any) => sendImpl(method, params)) },
  };
}

test("cdpEval returns the Runtime.evaluate value and attaches/detaches the eval purpose", async () => {
  mockDebugger((method) => {
    if (method === "Runtime.evaluate") return { result: { value: 42 } };
    return {};
  });
  const r = await cdpEval(7, "() => 40 + 2", []);
  expect(r).toEqual({ ok: true, value: 42 });
  expect(attachDebugger).toHaveBeenCalledWith(7, "eval");
  expect(detachDebugger).toHaveBeenCalledWith(7, "eval");
});

test("cdpEval surfaces exceptionDetails as ok:false", async () => {
  mockDebugger((method) => {
    if (method === "Runtime.evaluate") return { exceptionDetails: { exception: { description: "ReferenceError: x is not defined" } } };
    return {};
  });
  const r = await cdpEval(7, "() => x", []);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("ReferenceError");
});

test("cdpEval detaches even when Runtime.evaluate throws", async () => {
  mockDebugger(() => { throw new Error("Target closed"); });
  const r = await cdpEval(7, "() => 1", []);
  expect(r.ok).toBe(false);
  expect(detachDebugger).toHaveBeenCalledWith(7, "eval");
});
```

- [ ] **Step 3: Run it, confirm it fails** — `cd chrome-extension && npx jest cdp-eval` → FAIL (module not found).

- [ ] **Step 4: Create `chrome-extension/cdp-eval.ts`:**

```ts
/**
 * Chrome/Edge-only CSP-immune eval via chrome.debugger (CDP). Backs
 * evaluate-script engine:"cdp": Runtime.evaluate runs arbitrary source in the
 * page's real world through the debugger protocol, which is NOT subject to the
 * page's script-src CSP (the same reason the DevTools console can eval on a
 * strict-CSP page). Its only cost is the "started debugging this browser"
 * banner (documented, opt-in) — same tradeoff as capture-response-bodies and the
 * -at tools' engine:"cdp". The attach is REFCOUNTED under the "eval" purpose so
 * it coexists with input/network debugger holders on the same tab; each call
 * attaches "eval", evaluates, and releases "eval" in a finally.
 *
 * Firefox has no chrome.debugger; the Firefox message handler rejects
 * engine:"cdp" before reaching here (this file is imported ONLY by the Chrome
 * extension).
 */
import { attachDebugger, detachDebugger } from "./network-capture";

export async function cdpEval(
  tabId: number,
  functionSource: string,
  args: unknown[]
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const dbg = (chrome as any).debugger;
  // Build "(<fn>)(<arg0>, <arg1>, ...)". args are JSON-encoded; functionSource
  // is a function-expression string by the tool's contract.
  const argList = (args || []).map((a) => JSON.stringify(a)).join(",");
  const expression = "(" + functionSource + ")(" + argList + ")";
  await attachDebugger(tabId, "eval");
  try {
    const res = await dbg.sendCommand({ tabId }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res && res.exceptionDetails) {
      const ex = res.exceptionDetails;
      const msg =
        (ex.exception && (ex.exception.description || ex.exception.value)) ||
        ex.text ||
        "Runtime.evaluate threw";
      return { ok: false, error: String(msg) };
    }
    const value = res && res.result ? res.result.value : undefined;
    return { ok: true, value: value === undefined ? null : value };
  } catch (err) {
    return { ok: false, error: String((err as { message?: unknown })?.message ?? err) };
  } finally {
    await detachDebugger(tabId, "eval");
  }
}
```

- [ ] **Step 5: Run tests** — `cd chrome-extension && npx jest cdp-eval` → PASS.

- [ ] **Step 6: Commit** — `git add chrome-extension/cdp-eval.ts chrome-extension/network-capture.ts chrome-extension/__tests__/cdp-eval.test.ts && git commit -m "feat(evaluate-script): chrome CDP Runtime.evaluate engine (cdp-eval.ts)"`

---

### Task A5: Chrome `message-handler.evaluateScript` — `world:"auto"` + `engine:"cdp"` dispatch

**Files:**
- Modify: `chrome-extension/message-handler.ts:957-1000` (`evaluateScript`)
- Modify: `chrome-extension/message-handler.ts:398-406` (the `evaluate-script` dispatch case — pass `req.engine`)
- Test: `chrome-extension/__tests__/message-handler.test.ts`

**Interfaces:**
- Consumes: `cdpEval` (A4). The extension's `evaluateScript(tabId, functionSource, args, world, engine)`.
- Reads the request's `world`/`engine` off `EvaluateScriptServerMessage`.

- [ ] **Step 1: Read the current `evaluateScript` method** (`chrome-extension/message-handler.ts:957-1000`) and the dispatch case (`:398-406`) to get the exact surrounding code (the executor reads the file). Current shape (for reference): `world === "isolated"` → `sendMessageToTabRaw(..., evaluateScriptIsolated)`; else → `sendMessageToTab(..., evaluateScript)` with `resultAttr` + `EVAL_TIMEOUT_MS`; then it wraps the result into an `eval-result` resource.

- [ ] **Step 2: Write the failing test** (`chrome-extension/__tests__/message-handler.test.ts`) — mock the send + cdpEval; verify engine:"cdp" calls cdpEval and world:"auto" surfaces the actionable CSP error on a cspBlocked main result. Follow the existing mocking patterns in that suite (check how it stubs `sendMessageToTab`/`this.client.sendResourceToServer`). Sketch:

```ts
// engine:"cdp" path routes to cdpEval and is CSP-immune.
test("evaluate-script engine:cdp uses cdpEval", async () => {
  // arrange: spy cdpEval to resolve { ok:true, value: 5 }
  // act: dispatch an evaluate-script request with engine:"cdp"
  // assert: cdpEval called with (tabId, functionSource, args); eval-result ok:true value:5 sent
});

// world:"auto" on a cspBlocked main result surfaces the actionable error.
test("evaluate-script world:auto returns actionable CSP error when main is blocked", async () => {
  // arrange: sendMessageToTab resolves { ok:false, cspBlocked:true, error:"CSP blocked..." }
  // act: dispatch evaluate-script world:"auto"
  // assert: eval-result ok:false, error contains 'engine:"cdp"'
});
```

- [ ] **Step 3: Rewrite `evaluateScript`** so it branches on `engine` first, then `world`. Target logic (adapt exact variable names to the file):

```ts
private async evaluateScript(
  correlationId: string,
  tabId: number,
  functionSource: string,
  args: unknown[] | undefined,
  world: "main" | "isolated" | "auto" | undefined,
  engine: "auto" | "cdp" | undefined
): Promise<void> {
  const argv = args ?? [];
  let result: { ok: boolean; value?: unknown; error?: string };

  if (engine === "cdp") {
    // CSP-immune debugger eval (Chrome/Edge). Banner tradeoff, opt-in.
    result = await cdpEval(tabId, functionSource, argv);
  } else if (world === "isolated") {
    result =
      (await sendMessageToTabRaw(tabId, {
        type: "evaluateScriptIsolated",
        functionSource,
        args: argv,
      })) ?? { ok: false, error: "isolated evaluation produced no result." };
  } else {
    // "main" and "auto" both inject the page world. On Chrome the isolated
    // world cannot eval either, so "auto" does NOT retry isolated — it just
    // returns a fast, actionable CSP error (the started-marker probe in the
    // content script sets cspBlocked). engine:"cdp" is the real escape.
    const resultAttr = `data-bcmcp-result-${Date.now()}-${++evalKeyCounter}`;
    const raw = await sendMessageToTabRaw(tabId, {
      type: "evaluateScript",
      functionSource,
      args: argv,
      resultAttr,
      timeoutMs: EVAL_TIMEOUT_MS,
    });
    result = raw ?? { ok: false, error: "evaluation produced no result." };
  }

  await this.client.sendResourceToServer({
    resource: "eval-result",
    correlationId,
    ok: result.ok,
    value: result.value,
    error: result.error,
  } as EvalResultExtensionMessage);
}
```

Note: the existing code may currently use `sendMessageToTab` (which throws on `ok:false`) for the main branch — switch the main branch to `sendMessageToTabRaw` so a `cspBlocked` result flows through as an `eval-result` (with the actionable error the content script produced in A3) instead of being thrown up as a generic error. Keep the existing `eval-result` resource-send shape the file already uses; only the branching changes.

- [ ] **Step 4: Update the dispatch case** (`:398-406`) to pass `req.engine`:

```ts
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
```

- [ ] **Step 5: Add the import** at the top of `message-handler.ts`: `import { cdpEval } from "./cdp-eval";`

- [ ] **Step 6: Run tests + build** — `cd chrome-extension && npx jest message-handler` → PASS; `npm run build` → compiles.

- [ ] **Step 7: Commit** — `git add chrome-extension/message-handler.ts chrome-extension/__tests__/message-handler.test.ts && git commit -m "feat(evaluate-script): chrome world:auto + engine:cdp dispatch"`

---

### Task A6: Firefox `runInPageWorld` CSP probe + eval builder wiring

**Files:**
- Modify: `firefox-extension/injected/page-world.ts:421-459` (`runInPageWorld`)
- Modify: `firefox-extension/message-handler.ts` (the `evaluateScript` main path that calls `runInPageWorld` + `buildEvalPageScript`)
- Test: `firefox-extension/__tests__/page-world.test.ts`

**Interfaces:**
- Consumes: `buildEvalPageScript(..., startedAttr)` (A2).
- Produces: `runInPageWorld(exec, pageScript, resultAttr, timeoutMs, sleep, startedAttr?)` — when `startedAttr` is given and the marker never appears within a short probe window, returns `{ ok:false, cspBlocked:true, error }`.

- [ ] **Step 1: Write the failing test** (`firefox-extension/__tests__/page-world.test.ts`) — `exec` mock that never sets the started marker (simulating CSP block) resolves cspBlocked fast; one that returns the marker then the result resolves the value:

```ts
import { runInPageWorld } from "../injected/page-world";
const sleep = () => Promise.resolve();

test("runInPageWorld returns cspBlocked when the started marker never appears", async () => {
  // poller always returns null (nothing injected ran).
  const exec = jest.fn(async () => [null]);
  const r = await runInPageWorld(exec, "PAGESCRIPT", "data-r", 10000, sleep, "data-started");
  expect(r.cspBlocked).toBe(true);
  expect(r.ok).toBe(false);
});

test("runInPageWorld resolves the value when the script started", async () => {
  // 1st poll: started marker present; 2nd: result present.
  let n = 0;
  const exec = jest.fn(async (code: string) => {
    if (code.includes("data-started")) return ["1"];       // started poll
    n++;
    return [n >= 1 ? JSON.stringify({ ok: true, value: 9 }) : null]; // result poll
  });
  const r = await runInPageWorld(exec, "PAGESCRIPT", "data-r", 10000, sleep, "data-started");
  expect(r).toEqual({ ok: true, value: 9 });
});
```

(Adapt to how the existing suite drives `exec`/poller codes — the executor should check the current `runInPageWorld` tests first and match their mock convention.)

- [ ] **Step 2: Run it, confirm it fails** — `cd firefox-extension && npx jest page-world` → FAIL.

- [ ] **Step 3: Edit `runInPageWorld`** (`firefox-extension/injected/page-world.ts:421-459`) to add the `startedAttr` probe. Because Firefox injects via background-driven `executeScript`, poll the started marker for a short bounded window (not the full 10s) before declaring CSP-blocked; once started, poll the result up to `timeoutMs`:

```ts
export async function runInPageWorld(
  exec: (code: string) => Promise<any[]>,
  pageScript: string,
  resultAttr: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  startedAttr?: string
): Promise<{ ok: boolean; value?: any; error?: string; cspBlocked?: boolean }> {
  // 1. Inject the page-world script (one executeScript call).
  await exec(buildInjectorCode(pageScript));

  // 1b. CSP probe: an allowed inline <script> sets the started marker
  // synchronously; poll it briefly. If it never appears, the page CSP blocked
  // the injection — fail fast (the 10s result timeout stays for slow async).
  if (startedAttr) {
    const startedPoller = buildPollerCode(startedAttr);
    const CSP_PROBE_MS = 1000;
    const probeDeadline = Date.now() + CSP_PROBE_MS;
    let started = false;
    while (true) {
      const [marker] = await exec(startedPoller);
      if (marker != null) { started = true; break; }
      if (Date.now() >= probeDeadline) break;
      await sleep(POLL_INTERVAL_MS);
    }
    if (!started) {
      return {
        ok: false,
        cspBlocked: true,
        error:
          "CSP blocked the injected script (the page forbids inline script execution). Retrying in the isolated world.",
      };
    }
  }

  const pollerCode = buildPollerCode(resultAttr);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const [raw] = await exec(pollerCode);
    if (raw != null) {
      try {
        return JSON.parse(raw as string);
      } catch (e) {
        return { ok: false, error: `Failed to parse in-page result: ${String(e)}` };
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  return {
    ok: false,
    error:
      "Timed out waiting for in-page result (the page's Content-Security-Policy may be blocking injected scripts).",
  };
}
```

Note: `buildPollerCode` removes the attribute it reads, so the started-marker poll consumes the marker (fine — we only need to observe it once).

- [ ] **Step 4: Wire Firefox `evaluateScript`** (in `firefox-extension/message-handler.ts`, the main-world branch, ~`:1075-1084`) — generate a `startedAttr`, pass it to `buildEvalPageScript` and `runInPageWorld`. Match the file's exact existing call (the executor reads it). Target:

```ts
    const startedAttr = resultAttr + "-started";
    result = await runInPageWorld(
      exec,
      buildEvalPageScript(functionSource, argv, resultAttr, startedAttr),
      resultAttr,
      EVAL_TIMEOUT_MS,
      sleep,
      startedAttr
    );
```

(The `world:"auto"` isolated-fallback on a `cspBlocked` result is Task A7.)

- [ ] **Step 5: Run tests + build** — `cd firefox-extension && npx jest page-world` → PASS; `npm run build` → compiles.

- [ ] **Step 6: Commit** — `git add firefox-extension/injected/page-world.ts firefox-extension/message-handler.ts firefox-extension/__tests__ && git commit -m "feat(evaluate-script): firefox started-marker CSP probe in runInPageWorld"`

---

### Task A7: Firefox `evaluateScript` — `world:"auto"` isolated fallback + `engine:"cdp"` rejection

**Files:**
- Modify: `firefox-extension/message-handler.ts` (`evaluateScript` — the top-level branch on `world`/`engine`)
- Test: `firefox-extension/__tests__/message-handler.test.ts`

**Interfaces:**
- Consumes: `runInPageWorld` (A6, returns `cspBlocked`), `buildIsolatedEvalCode` (existing, Firefox-only).

- [ ] **Step 1: Write the failing test** — `world:"auto"` where the main path returns `cspBlocked:true` should retry isolated and return the isolated value; `engine:"cdp"` should return an ok:false naming the lack of debugger. Sketch (match the suite's existing mock style):

```ts
test("firefox evaluate-script world:auto falls back to isolated on CSP block", async () => {
  // arrange: main runInPageWorld → { ok:false, cspBlocked:true }; isolated exec → { ok:true, value:3 }
  // act: dispatch evaluate-script world:"auto"
  // assert: eval-result ok:true value:3
});
test("firefox evaluate-script engine:cdp returns a clear no-debugger error", async () => {
  // act: dispatch evaluate-script engine:"cdp"
  // assert: eval-result ok:false error mentions Chrome/Edge (no debugger on Firefox)
});
```

- [ ] **Step 2: Edit Firefox `evaluateScript`** — add the `engine`/`world` branching. Target logic (adapt to the file's actual structure and helper names):

```ts
// engine:"cdp" is Chrome/Edge-only — Firefox has no chrome.debugger.
if (engine === "cdp") {
  await this.client.sendResourceToServer({
    resource: "eval-result",
    correlationId,
    ok: false,
    error:
      'engine:"cdp" is only available on Chrome/Edge (no debugger API on Firefox). On Firefox use world:"isolated" (CSP-immune) or world:"auto".',
  } as EvalResultExtensionMessage);
  return;
}

if (world === "isolated") {
  // ... existing isolated path (buildIsolatedEvalCode via executeScript) ...
} else {
  // main / auto
  const mainResult = await runInPageWorld(exec, buildEvalPageScript(...startedAttr), resultAttr, EVAL_TIMEOUT_MS, sleep, startedAttr);
  let finalResult = mainResult;
  if (world !== "main" && mainResult.cspBlocked) {
    // world:"auto" — the page CSP blocked the main world; the isolated world is
    // genuinely CSP-immune on Firefox (executeScript compiles the source).
    finalResult = await this.evalIsolated(tabId, functionSource, argv); // existing isolated helper/exec
  }
  await this.client.sendResourceToServer({
    resource: "eval-result",
    correlationId,
    ok: finalResult.ok,
    value: finalResult.value,
    error: finalResult.error,
  } as EvalResultExtensionMessage);
  return;
}
```

Use whatever the file already uses to run the isolated code (`buildIsolatedEvalCode` + `executeScript`) for the fallback — factor a small private helper if it reduces duplication, else inline it.

- [ ] **Step 3: Update the dispatch case** in Firefox `handleDecodedMessage` to pass `req.engine` (mirror A5 Step 4).

- [ ] **Step 4: Run tests + build** — `cd firefox-extension && npx jest message-handler` → PASS; `npm run build` → compiles.

- [ ] **Step 5: Commit** — `git add firefox-extension/message-handler.ts firefox-extension/__tests__ && git commit -m "feat(evaluate-script): firefox world:auto isolated fallback + engine:cdp rejection"`

---

# Phase B — Bug 2: navigating-click timeout

**Outcome:** `click-element`, synthetic `click-at`, and `type-at` return `{ok:true, navigated:true}` (instead of timing out) when the click triggers a page navigation that tears down the content-script world.

### Task B1: `navigated?` on the result messages

**Files:**
- Modify: `common/extension-messages.ts:102-106` (`ActionResultExtensionMessage`), `:304-309` (`PointActionResultExtensionMessage`)
- Test: type-only (compile check).

- [ ] **Step 1: Add the field** to both interfaces:

```ts
export interface ActionResultExtensionMessage extends ExtensionMessageBase {
  resource: "action-result";
  ok: boolean;
  error?: string;
  // Set true when the input dispatched but the page began navigating before the
  // content-script ack could return (the click worked; the ack was lost to
  // page teardown). Append-only.
  navigated?: boolean;
}
```

```ts
export interface PointActionResultExtensionMessage extends ExtensionMessageBase {
  resource: "point-action-result";
  ok: boolean;
  error?: string;
  element?: PointElementDescriptor;
  navigated?: boolean; // see ActionResultExtensionMessage.navigated
}
```

- [ ] **Step 2: Build** — `cd mcp-server && npm run build` and both extensions build → compiles.

- [ ] **Step 3: Commit** — `git add common/extension-messages.ts && git commit -m "feat(input): add navigated? to action/point result messages"`

---

### Task B2: Chrome nav-race helper

**Files:**
- Create: `chrome-extension/nav-race.ts`
- Test: `chrome-extension/__tests__/nav-race.test.ts`

**Interfaces:**
- Produces: `raceInputAgainstNavigation<T extends { ok: boolean }>(tabId: number, dispatch: Promise<T>): Promise<T | { ok: true; navigated: true }>`. Registers a one-shot `chrome.tabs.onUpdated` listener (status `"loading"` on `tabId`) before awaiting `dispatch`; if the nav fires first, resolves `{ok:true, navigated:true}`; else returns the dispatch result. Always removes the listener.

- [ ] **Step 1: Write the failing test:**

```ts
import { raceInputAgainstNavigation } from "../nav-race";

function mockTabs() {
  const listeners: any[] = [];
  (globalThis as any).chrome = {
    tabs: {
      onUpdated: {
        addListener: (cb: any) => listeners.push(cb),
        removeListener: (cb: any) => {
          const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
  };
  return {
    fireNav: (tabId: number) => listeners.forEach((cb) => cb(tabId, { status: "loading" }, {})),
    count: () => listeners.length,
  };
}

test("returns the dispatch result when no navigation occurs", async () => {
  mockTabs();
  const r = await raceInputAgainstNavigation(5, Promise.resolve({ ok: true }));
  expect(r).toEqual({ ok: true });
});

test("returns navigated:true when the tab starts loading before the ack", async () => {
  const t = mockTabs();
  let resolveDispatch: (v: any) => void;
  const dispatch = new Promise<any>((res) => { resolveDispatch = res; });
  const p = raceInputAgainstNavigation(5, dispatch);
  t.fireNav(5);                       // nav wins
  const r = await p;
  expect(r).toEqual({ ok: true, navigated: true });
  expect(t.count()).toBe(0);          // listener removed
});

test("ignores navigation on a different tab", async () => {
  const t = mockTabs();
  const dispatch = Promise.resolve({ ok: true, foo: 1 });
  const p = raceInputAgainstNavigation(5, dispatch);
  t.fireNav(999);                     // different tab — must not win
  const r = await p;
  expect(r).toMatchObject({ ok: true, foo: 1 });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd chrome-extension && npx jest nav-race` → FAIL.

- [ ] **Step 3: Create `chrome-extension/nav-race.ts`:**

```ts
/**
 * Background-side navigation race for input dispatch. A click whose handler does
 * `window.location.href = <cross-origin URL>` tears down the content-script
 * world before its ack can return, so the content-script reply promise hangs and
 * the broker times out — even though the click WORKED. The background context
 * survives the navigation, so we watch tabs.onUpdated(status:"loading") on the
 * target tab and, if it fires before the ack, report success with navigated:true.
 * tabs.onUpdated needs only the "tabs" permission (already granted) — no
 * webNavigation, no new CWS scope.
 */
export async function raceInputAgainstNavigation<T extends { ok: boolean }>(
  tabId: number,
  dispatch: Promise<T>
): Promise<T | { ok: true; navigated: true }> {
  let onUpdated: ((id: number, info: { status?: string }) => void) | null = null;
  const navPromise = new Promise<{ ok: true; navigated: true }>((resolve) => {
    onUpdated = (id, info) => {
      if (id === tabId && info && info.status === "loading") {
        resolve({ ok: true, navigated: true });
      }
    };
    (chrome as any).tabs.onUpdated.addListener(onUpdated);
  });
  try {
    return await Promise.race([dispatch, navPromise]);
  } finally {
    if (onUpdated) {
      (chrome as any).tabs.onUpdated.removeListener(onUpdated);
    }
  }
}
```

- [ ] **Step 4: Run tests** — `cd chrome-extension && npx jest nav-race` → PASS.

- [ ] **Step 5: Commit** — `git add chrome-extension/nav-race.ts chrome-extension/__tests__/nav-race.test.ts && git commit -m "feat(input): chrome background navigation-race helper"`

---

### Task B3: Wire nav-race into Chrome `runInputAction` + `runPointAction`

**Files:**
- Modify: `chrome-extension/message-handler.ts:658-688` (`runInputAction`), `:695-719` (`runPointAction`)
- Test: `chrome-extension/__tests__/message-handler.test.ts`

**Interfaces:**
- Consumes: `raceInputAgainstNavigation` (B2).

- [ ] **Step 1: Read** `runInputAction` and `runPointAction` to see the exact page-world dispatch call each awaits (the `sendMessageToTab*`/`runHumanInputAction` result assigned to `result`).

- [ ] **Step 2: Write the failing test** — a `click-element` whose content-script dispatch never resolves but whose tab fires `onUpdated` loading resolves as an `action-result` with `ok:true, navigated:true`. Match the suite's dispatch mocks.

- [ ] **Step 3: Wrap the page-world dispatch** in `runInputAction`. Only the covert (non-CDP) dispatch — CDP already fires from the background and survives navigation, so leave `runNativeInputAction`/any CDP path unwrapped. Target: where `result` is assigned from the content-script path (`sendMessageToTab({type:"performInputAction"...})` for mode "off", and `runHumanInputAction`/`sendMessageToTab({type:"runHumanInput"...})` for synthetic), wrap that awaited promise:

```ts
// synthetic (default) + off modes route through the page/content-script world,
// which a navigating click tears down. Race the ack against tab navigation.
result = await raceInputAgainstNavigation(tabId, /* the existing dispatch promise */);
```

Then include `navigated` in the `action-result` send:

```ts
await this.client.sendResourceToServer({
  resource: "action-result",
  correlationId,
  ok: result.ok,
  error: result.error,
  navigated: (result as { navigated?: boolean }).navigated,
} as ActionResultExtensionMessage);
```

- [ ] **Step 4: Do the same in `runPointAction`** for the synthetic branch (`sendMessageToTabRaw({type:"performPointAction"...})`) — wrap it in `raceInputAgainstNavigation` and forward `navigated` on the `point-action-result`. Leave `dispatchCdpPointAction` unwrapped.

- [ ] **Step 5: Import** `raceInputAgainstNavigation` at the top of `message-handler.ts`.

- [ ] **Step 6: Run tests + build** — `cd chrome-extension && npx jest message-handler` → PASS; `npm run build` → compiles.

- [ ] **Step 7: Commit** — `git add chrome-extension/message-handler.ts chrome-extension/__tests__ && git commit -m "feat(input): chrome nav-race for click-element/click-at/type-at synthetic paths"`

---

### Task B4: Firefox nav-race helper + wiring

**Files:**
- Create: `firefox-extension/nav-race.ts` (byte-identical body to Chrome's, but using `browser.tabs.onUpdated` — Firefox's `onUpdated` callback signature is `(tabId, changeInfo, tab)`, same as Chrome; if the extension uses the `browser` polyfill/global, use `browser`)
- Modify: `firefox-extension/message-handler.ts:741-774` (`runInputAction`) and the synthetic `runPointAction`
- Test: `firefox-extension/__tests__/nav-race.test.ts`

**Interfaces:** same signature as B2.

- [ ] **Step 1: Write the failing test** — mirror B2's test but mock `browser.tabs.onUpdated` (or `chrome`, matching whatever global the Firefox extension uses elsewhere — check the top of `firefox-extension/message-handler.ts`).

- [ ] **Step 2: Create `firefox-extension/nav-race.ts`** — same logic as B2, using the Firefox global (`browser` if that's what the codebase uses). Keep the function body identical to Chrome's aside from the `chrome`/`browser` global.

- [ ] **Step 3: Wire into Firefox `runInputAction`** (`:741-774`) and the synthetic `runPointAction`: wrap the `executeScript`-based page dispatch in `raceInputAgainstNavigation` and forward `navigated` on the result send. Leave any non-page path unwrapped. (Firefox has no CDP, so every input path here is page-world and benefits.)

- [ ] **Step 4: Run tests + build** — `cd firefox-extension && npx jest` → PASS; `npm run build` → compiles.

- [ ] **Step 5: Commit** — `git add firefox-extension/nav-race.ts firefox-extension/message-handler.ts firefox-extension/__tests__ && git commit -m "feat(input): firefox nav-race for input paths"`

---

### Task B5: Surface `navigated` in the server tool output (optional polish)

**Files:**
- Modify: `mcp-server/browser-api.ts:513-527` (`clickElement`) and the `clickAt`/`typeAt` methods; `mcp-server/server.ts` (click-element / click-at / type-at handlers)
- Test: `mcp-server/__tests__`

- [ ] **Step 1:** `clickElement` currently returns `void` and throws on `!ok`. Change it to return `{ navigated?: boolean }` so the tool can mention navigation, WITHOUT breaking the `!ok` throw:

```ts
async clickElement(tabId: number, uid: string, doubleClick?: boolean): Promise<{ navigated?: boolean }> {
  const message = await this.sendTool<ActionResultExtensionMessage>({ cmd: "click-element", tabId, uid, doubleClick });
  if (!message.ok) { throw new Error(message.error ?? "Action failed"); }
  return { navigated: message.navigated };
}
```

- [ ] **Step 2:** In the `click-element` server handler, reflect it in the text:

```ts
const { navigated } = await browserApi.clickElement(tabId, uid, doubleClick);
return { content: [{ type: "text", text: navigated ? `Clicked uid ${uid} (page navigated)` : `Clicked uid ${uid}` }] };
```

Do the equivalent for `click-at`/`type-at` if their `browser-api` methods and handlers surface a result (check `formatPointResult` in `mcp-server/point-format.ts` — thread `navigated` through if it already formats the point result).

- [ ] **Step 3: Test + build + commit** — `cd mcp-server && npx jest` → PASS; `npm run build`; `git add mcp-server && git commit -m "feat(input): surface navigated in click tool output"`

---

# Phase C — Bug 3: screenshot readback retry

**Outcome:** The default viewport screenshot and the element-crop screenshot survive a transient post-activation GPU readback failure by reusing the existing retry helper; the full-page fallback preserves the real error text.

### Task C1: Chrome — route default paths through `captureWindowWithRetry`

**Files:**
- Modify: `chrome-extension/message-handler.ts:1150-1157` (`captureViewport`), `:1159-1184` (`captureElement`), `:1270-1278` (fullPage fallback `catch`)
- Test: `chrome-extension/__tests__/message-handler.test.ts`

- [ ] **Step 1: Write the failing test** — `captureVisibleTab` rejects once with "image readback failed" then succeeds; a default (viewport) screenshot should still resolve. Match the suite's existing screenshot mocks (there is already a fullPage retry test to mirror):

```ts
test("viewport screenshot retries a transient readback failure", async () => {
  let calls = 0;
  // mock captureVisibleTab: reject first, succeed second
  // dispatch take-screenshot (no fullPage, no uid)
  // assert: screenshot resource sent with base64; captureVisibleTab called twice
});
```

- [ ] **Step 2: Read** `captureViewport`, `captureElement`, `captureWindow`, and `captureWindowWithRetry` to get exact signatures (executor reads the file). `captureWindowWithRetry(windowId, format)` already exists (3 tries, backoff `[100,300,600]`).

- [ ] **Step 3: Edit `captureViewport`** to call `captureWindowWithRetry` instead of `captureWindow`:

```ts
private async captureViewport(windowId: number | undefined, format: "png" | "jpeg"): Promise<...> {
  const dataUrl = await this.captureWindowWithRetry(windowId, format);   // was captureWindow
  // ...rest unchanged (strip prefix → { mimeType, base64 })...
}
```

- [ ] **Step 4: Edit `captureElement`** similarly — replace its `captureWindow` call with `captureWindowWithRetry` (keep the `sleep(100)` scroll-settle).

- [ ] **Step 5: Preserve the real error** in the fullPage fallback (`:1272-1273`): `catch (e) { throw new Error("image readback failed: " + ((e as { message?: string })?.message ?? String(e))); }`.

- [ ] **Step 6: Run tests + build** — `cd chrome-extension && npx jest message-handler` → PASS; `npm run build`.

- [ ] **Step 7: Commit** — `git add chrome-extension/message-handler.ts chrome-extension/__tests__ && git commit -m "fix(take-screenshot): retry transient readback on viewport/element paths (chrome)"`

---

### Task C2: Firefox — same retry wiring

**Files:**
- Modify: `firefox-extension/message-handler.ts` — `captureViewport` (`:1297-1304`), `captureElement` (`:1308-1335`), fullPage fallback (`:1449-1453`)
- Test: `firefox-extension/__tests__/message-handler.test.ts`

- [ ] **Step 1:** Write the mirror test (viewport screenshot retries transient readback).
- [ ] **Step 2:** Route `captureViewport` + `captureElement` through `captureWindowWithRetry` (`:1342-1367`); preserve the real error in the fullPage fallback.
- [ ] **Step 3: Test + build + commit** — `cd firefox-extension && npx jest` → PASS; `npm run build`; `git add firefox-extension/message-handler.ts firefox-extension/__tests__ && git commit -m "fix(take-screenshot): retry transient readback on viewport/element paths (firefox)"`

---

# Phase D — Fixture + full-suite + manual regression

### Task D1: Extend the CSP-SPA fixture with a navigating "Continue" button

**Files:**
- Modify: `test-fixtures/csp-react-spa/app.js` and/or `index.html`

- [ ] **Step 1:** Add a button whose handler does a cross-origin navigation, so the fixture exercises Bug 2 (it already serves strict CSP for Bug 1):

```js
// app.js — render a Continue button that navigates cross-origin on click.
const btn = document.createElement("button");
btn.textContent = "Continue to Example";
btn.addEventListener("click", () => { window.location.href = "https://example.com/"; });
root.appendChild(btn);
```

- [ ] **Step 2:** Confirm the fixture still serves under strict CSP (`server.mjs`), and note in a comment that this button is the local Bug-2 regression target.

- [ ] **Step 3: Commit** — `git add test-fixtures/csp-react-spa && git commit -m "test(fixture): add navigating Continue button to csp-react-spa"`

---

### Task D2: Full suites + build + manual regression

- [ ] **Step 1: Run every suite** — `cd chrome-extension && npx jest` ; `cd firefox-extension && npx jest` ; `cd mcp-server && npx jest`. All green. Confirm `firefox-extension/__tests__/self-containment.test.ts` still passes (no injected-function regressions).

- [ ] **Step 2: Build everything** — `npm run build` (root, via nx) and `npm run package --prefix chrome-extension` (builds `chrome-extension/web-ext-artifacts/chrome-unpacked`).

- [ ] **Step 3: Bounce + reload** — `mcpkit runtime stop foxpilot`; Remove the old Chrome extension and Load-unpacked `chrome-extension/web-ext-artifacts/chrome-unpacked`; toggle Automation Mode ON. (Firefox: `about:debugging` → Reload / Load Temporary Add-on on `manifest.json`.)

- [ ] **Step 4: Manual regression against the composio link** (the real target). Generate a link per the bug report, `mcpkit call foxpilot open-browser-tab '{"url":"<redirect_url>"}'`, then:
  - `evaluate-script '{"tabId":<id>,"function":"() => 1"}'` → should now fail FAST (not 10s) with the actionable CSP error (Chrome), OR return via isolated fallback (Firefox).
  - `evaluate-script '{"tabId":<id>,"function":"() => document.title","engine":"cdp"}'` → returns the title (CSP bypassed) on Chrome; shows the debugger banner.
  - `take-snapshot` → get the "Continue to Google Sheets" uid → `click-element '{"tabId":<id>,"uid":"<uid>"}'` → returns `{ok:true, navigated:true}` promptly (no 5s timeout) and the tab navigates to Google OAuth.
  - `take-screenshot '{"tabId":<id>,"filePath":"/tmp/handoff.png"}'` → succeeds (retry absorbs the transient readback).

- [ ] **Step 5:** If all four behave, the phase is done. Record any deviation and loop back to the relevant phase via systematic-debugging.

---

## Self-Review (author checklist — completed)

- **Spec coverage:** Bug 1 → A1–A7 (world:"auto", engine:"cdp", fast CSP detect both extensions, Firefox isolated fallback). Bug 2 → B1–B5 (nav-race both extensions, all synthetic input paths, navigated surfaced). Bug 3 → C1–C2 (retry on viewport+element, error preserved). Fixture + non-goals → D1–D2. All spec sections map to tasks.
- **Placeholder scan:** No TBD/TODO. Edit tasks that touch large existing functions (A5, A7, B3, B4, C1) instruct the executor to read the exact current code first and give the target logic + exact new blocks — appropriate for subagent-driven execution where the executor has the file open. Full code is inlined for all new modules (cdp-eval.ts, nav-race.ts) and all test scaffolds.
- **Type consistency:** `world: "main"|"isolated"|"auto"` and `engine: "auto"|"cdp"` used identically across A1 (common), server, browser-api, and both message-handlers. `raceInputAgainstNavigation<T>` signature identical in B2/B4. `navigated?: boolean` identical across common types, both extensions, and the server surface. `buildEvalPageScript(functionSource, args, resultAttr, startedAttr)` consistent across A2/A3/A6. `DebuggerPurpose` gains `"eval"` (A4) used by `cdpEval` (A4/A5).
- **Correction captured:** the spec's "reduce backstop to ~1500ms" is replaced by the started-marker probe (keeps the 10s async budget); the spec's `securitypolicyviolation` mechanism is replaced by the started-marker probe (uniform across both extensions, no cross-world/Xray uncertainty). Same goal — instant, definitive CSP detection.
