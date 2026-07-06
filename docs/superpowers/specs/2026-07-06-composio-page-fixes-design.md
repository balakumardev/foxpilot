# Composio handoff-page fixes — design spec

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan
**Scope:** Three independent, root-caused bugs surfaced on the composio OAuth handoff page (`https://connect.composio.dev/link/{token}`), which is a strict-CSP custom-React SPA **and** has a slow cross-origin redirect — it exercises both the CSP path and the navigation path in one page.

---

## Cross-cutting guarantees

- **No manifest changes.** `debugger`, `tabs`, `webRequest`, `scripting`, `cookies`, `declarativeNetRequest` are already present in `chrome-extension/manifest.json`; `tabs`, `webRequest`, `webRequestBlocking` in `firefox-extension/manifest.json`. Adding no permission → **no new Chrome Web Store review scope** (the release workflow fires CWS review on every push to `main`).
- **Byte-identical injected code.** Any edit to a `injected/*` module body must stay byte-identical between `chrome-extension/injected/*` and `firefox-extension/injected/*` (guarded by `self-containment.test.ts`; per project `CLAUDE.md`). Header/doc-comment lines may diverge. The nav-race helper and CDP-eval module live in `message-handler.ts` / background (extension-specific) and are allowed to diverge.
- **No new `cmd` in the message union.** All three fixes are params on existing tools or internal behavior, so the `switch(req.cmd)` `_exhaustiveCheck: never` tripwire in both `message-handler.ts` files is untouched.

---

## Bug 1 — `evaluate-script world:"main"` fails on strict-CSP pages

### Root cause (confirmed)
- Chrome `world:"main"` injects a **page-world inline `<script>`** element (`chrome-extension/content-script.ts:38-41`). Strict `script-src` silently blocks it; failure is detected **purely by a 10s timeout** (`EVAL_TIMEOUT_MS`, `chrome-extension/message-handler.ts:70`; poll at `content-script.ts:43-64`), which resolves `{ok:false, error:"CSP hint: page may have blocked inline script injection"}` (`content-script.ts:58`). The "CSP hint" string is a *guess*, not a detection.
- `world:"isolated"` on Chrome **also fails**: `evalInIsolatedWorld` uses `new Function()` (`chrome-extension/injected/page-world.ts:150-187`), which Chrome MV3's own isolated-world CSP blocks → already returns an honest degrade. **So main→isolated auto-fallback buys nothing on Chrome.** Isolated only works on **Firefox** (there `browser.tabs.executeScript({code})` compiles the source; no runtime eval — `firefox-extension/injected/page-world.ts:156-182`).
- Tool def: `mcp-server/server.ts:586-606` (`world: z.enum(["main","isolated"]).optional()`, no default → `undefined` treated as main). Server throws the extension's `ok:false` as a tool error at `mcp-server/browser-api.ts:765-782`.

### Fix

**1a. API surface** (`mcp-server/server.ts`, `mcp-server/browser-api.ts`, `common/server-messages.ts`, `common/extension-messages.ts`):
- Add `"auto"` to the `world` enum and make it the **default when `world` is unspecified**. `"main"` / `"isolated"` remain explicit-force (no fallback) → existing callers unchanged.
- Add `engine?: "auto" | "cdp"` (default `"auto"`). `engine:"cdp"` forces the debugger path and **overrides `world`**; Chrome/Edge-only.
- Update the tool description to state when to reach for `engine:"cdp"` (strict-CSP pages where covert eval can't run), including the banner/detectability tradeoff.

**1b. `world:"auto"` semantics** (per-extension `evaluateScript` in `message-handler.ts`):
- **Firefox:** try `main`; on CSP failure, transparently retry `isolated` (works) → return it.
- **Chrome:** try `main`; on CSP failure, return a fast, definitive, actionable error naming the escape (`engine:"cdp"`, or snapshot / coord tools / `get-cookies`). No isolated retry (futile).

**1c. Fast + definitive CSP detection** (replaces the 10s timeout guess; lives in the **mirrored inject/poll code**, byte-identical both extensions):
- Register a one-shot `securitypolicyviolation` listener (matching `blockedURI:"inline"` / a `script-src` directive) immediately before appending the inline `<script>`. It fires within ~ms of the block → resolve immediately as `{ok:false, cspBlocked:true, error:"…"}`.
- Keep a **backstop timeout, reduced 10000ms → ~1500ms**, for the rare case no event fires. Net effect: 10s → ~instant, "hint" → definitive.
- Correlation is best-effort (a page can emit unrelated CSP violations) but reliable in practice when combined with "our injected script's result attribute is not yet set".

**1d. Chrome CDP eval engine** (new `chrome-extension/cdp-eval.ts`, mirrors `chrome-extension/cdp-input.ts`):
- `attachDebugger(tabId, "eval")` → `Runtime.evaluate` → `detachDebugger(tabId, "eval")` in `finally`.
- Extend `DebuggerPurpose` (`chrome-extension/network-capture.ts:51`) to `"network" | "input" | "eval"`. The refcounted Set-based attach already handles a new purpose; no `Network.enable`/`Runtime.enable` needed (one-shot).
- Expression: wrap the user function source + args →
  `expression = "(" + functionSource + ")(" + args.map(a => JSON.stringify(a)).join(",") + ")"`,
  with `{ returnByValue:true, awaitPromise:true, userGesture:true }`. Map `exceptionDetails` → `{ok:false,error}`; return `result.value`.
- **CSP-immune** — `Runtime.evaluate` runs in the page's context via the debugger protocol and is not subject to the page's `script-src` (same reason the DevTools console can eval on CSP pages).
- **Firefox:** reject `engine:"cdp"` with a clear error (no debugger API), mirroring `firefox-extension/message-handler.ts` `click-at` cdp rejection.

---

## Bug 2 — `click-element` (and synthetic `click-at` / `type-at`) time out on a navigating click

### Root cause (confirmed)
- The click fires synchronously in the page/content-script context (`el.click()`, `chrome-extension/injected/action-script.ts:90-92`); the button's `onclick` sets `window.location.href = <cross-origin OAuth URL>`. The **reply frame originates inside the doomed page context** and must travel content-script → background *after* the click. The cross-origin navigation tears down the content-script world before the ack flushes, so `browser.tabs.sendMessage` (Chrome) / `browser.tabs.executeScript` (Firefox) **hangs — neither resolves nor rejects**. The broker's per-command timer fires at **5s** (`DEFAULT_RESPONSE_TIMEOUT_MS`, `mcp-server/timeouts.ts:9`; `click-element` has no override; fired at `mcp-server/broker-core.ts:136`). The click **did** work; only the ack was lost.
- CDP `click-at` is resilient (`chrome-extension/message-handler.ts:734-795`): it captures the descriptor **before** dispatch and fires from the background via `chrome.debugger`, which survives navigation. **Synthetic `click-at` (`point-action-script.ts`) and `type-at` share the identical page-context bug.** Firefox has no CDP path at all (`firefox-extension/message-handler.ts` rejects `engine:"cdp"`).
- Handlers: Chrome `runInputAction` `message-handler.ts:658-688`, `runPointAction` `:695-719`; Firefox `runInputAction` `:741-774`. Default input mode is `"synthetic"` (`extension-config.ts`), routing through `runHumanInputAction` → `el.click()`.

### Fix
**Shared background-side helper** `raceInputAgainstNavigation(tabId, dispatchPromise)` (both extensions — the **background** context survives page teardown):
- **Before** dispatch, register a one-shot `tabs.onUpdated` listener filtered to `tabId` with `changeInfo.status === "loading"` (top-frame navigation). Chosen over `webNavigation` because **both manifests already have `tabs`** — no new permission / CWS scope.
- Race the content-script reply promise against the nav-detected promise:
  - **reply wins** (non-navigating click, e.g. a menu toggle) → return the reply verbatim.
  - **nav wins** (page tore down, ack lost) → return `{ok:true, navigated:true}`.
- Remove the listener in `finally`.

Wrap the page-context dispatch call in `runInputAction` (click-element) and the synthetic branch of `runPointAction` (click-at / type-at), covering the `off` / `native` modes too. **Leave the CDP paths as-is** — they already fire from background and win the reply race naturally.

- `navigated?: boolean` is **additive** on the action-result / point-result messages (`common/extension-messages.ts`); the tools currently only check `ok`, so no breaking change. Optionally reflect it in the tool's text output ("clicked; page navigated").
- **False-positive analysis:** a failed uid-resolve does not navigate, so its fast `notFound` reply wins the race → correctly surfaces the error. A coincidental unrelated navigation racing a genuinely-successful click is rare and low-harm (reports success for a click that did fire).

**Not doing:** no timeout bump (a lost ack never arrives — waiting longer only fails slower); no click-mechanism change (`click-element` is already synthetic dispatch — there is no separate a11y-click path to fall back from).

---

## Bug 3 — `take-screenshot` → "Failed to capture tab: image readback failed"

### Root cause (confirmed)
- The observed string (**with** the `"Failed to capture tab: "` prefix) is the **raw Chromium `captureVisibleTab` rejection passed through verbatim** — that prefix exists nowhere in the repo. (The prefix-less `"image readback failed"` FoxPilot throws is a *different* path: the `captureFullPage` fallback, `chrome-extension/message-handler.ts:1273,1277`, which discards the underlying `e`.)
- `takeScreenshot` activates the tab (`browser.tabs.update(tabId,{active:true})`, `chrome-extension/message-handler.ts:1122`) then **captures immediately with no paint-settle**. On a just-activated / mid-navigation tab the compositor has no frame ready → GPU readback fails. Intermittent (race against the compositor).
- `captureWindowWithRetry` (3 tries, backoff `[100,300,600]`ms, treats rejection **and** empty readback as transient — `chrome-extension/message-handler.ts:1190-1215`) **exists but is wired only into `captureFullPage`**. The default `captureViewport` (`:1150-1157`) and `captureElement` (`:1159-1184`) call bare `captureWindow` — one shot, no retry. Firefox mirrors this (`firefox-extension/message-handler.ts`).

### Fix
- Route `captureViewport` **and** `captureElement` through the existing tested `captureWindowWithRetry` instead of bare `captureWindow`, in **both** extensions. This absorbs the transient readback failure.
- Preserve the real reason in the `captureFullPage` fallback `catch(e)`: throw `"image readback failed: " + (e?.message ?? e)` instead of discarding `e`.
- **Not doing:** no extra explicit paint-settle sleep — the first retry backoff already provides the settle (YAGNI).

---

## Testing

**Jest (both extensions):**
- Bug 1: `securitypolicyviolation` → immediate `cspBlocked` result (no 10s wait); Firefox `world:"auto"` falls back main→isolated; CDP-eval builds the correct `expression` and parses both `result.value` and `exceptionDetails`; Firefox `engine:"cdp"` → clear error.
- Bug 2: helper — reply-wins returns the reply; nav-wins returns `{ok:true,navigated:true}`; listener removed on both paths (mock `tabs.onUpdated` + `sendMessageToTab`).
- Bug 3: `captureViewport` / `captureElement` now retry (mock `captureVisibleTab` reject-then-succeed); fullPage fallback preserves error text.

**Server (jest):** schema unit tests for `world:"auto"` and `engine` on `evaluate-script`.

**Fixture:** extend `test-fixtures/csp-react-spa/` with a "Continue" button whose handler does a cross-origin `window.location.href` (exercises Bug 2; the fixture already serves strict CSP for Bug 1). Live composio link stays the manual regression target.

**Manual regression** (after build): `cd mcp-server && npm run build` → `mcpkit runtime stop foxpilot` (bounce the persistent runtime) → **reload/reinstall the extension** (an already-loaded extension runs OLD code) → drive the composio link via `mcpkit call foxpilot …` for all three paths.

---

## Files touched

| Area | Files |
|---|---|
| Server | `mcp-server/server.ts` (eval `world:"auto"`+`engine`, pass-through `navigated`), `mcp-server/browser-api.ts` (`evaluateScript` signature) |
| Common | `common/server-messages.ts`, `common/extension-messages.ts` (`world:"auto"`, `engine`, `navigated?`) |
| Chrome ext | `message-handler.ts` (eval dispatch, nav-race, screenshot retry), **new** `cdp-eval.ts`, `network-capture.ts` (`DebuggerPurpose += "eval"`), mirrored inject/poll module (CSP detection) |
| Firefox ext | `message-handler.ts` (eval `world:"auto"` fallback + `engine:"cdp"` rejection, nav-race, screenshot retry), mirrored inject/poll module (CSP detection, byte-identical) |
| Fixture | `test-fixtures/csp-react-spa/` (add navigating Continue button) |
| Tests | new/updated jest suites in both extensions + server |

---

## Non-goals / out of scope
- Adding `unsafe-eval` to the Chrome manifest (explicitly rejected — CWS review risk + uncertain MV3 support).
- Adding a `webNavigation` permission (avoided by using `tabs.onUpdated`).
- Auto-escalating `engine:"auto"` → CDP on CSP failure (the banner/detectability must remain a deliberate opt-in, consistent with `capture-response-bodies` and cdp input).
- A separate CDP-side eval timeout (the existing 30s broker timeout for `evaluate-script` bounds a hung `awaitPromise`; the `finally` detaches when it returns).

## Open risks
- `securitypolicyviolation` correlation is heuristic; mitigated by the reduced backstop timeout so the worst case is a fast, slightly-less-specific failure rather than a 10s hang.
- CDP-eval leaves the debugger attached until `Runtime.evaluate` returns; a broker timeout on a hung promise defers the `finally` detach until the eval resolves/errors. Acceptable; noted for future refinement.
