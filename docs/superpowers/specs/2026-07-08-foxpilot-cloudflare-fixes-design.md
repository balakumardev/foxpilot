# FoxPilot Cloudflare-flow fixes — design spec

**Date:** 2026-07-08
**Status:** Approved (design), pending implementation plan
**Scope:** Seven defects surfaced while driving the Cloudflare dashboard (`dash.cloudflare.com`) API-token-creation flow — a page that is heavy on **react-select** custom dropdowns, a re-mounting **OneTrust** consent overlay, client-side **SPA routing**, and dozens of **repeated unlabeled buttons/comboboxes**. The fixes span content-script readiness, navigation settling, snapshot enrichment, a new custom-dropdown action, overlay handling, structured eval output, and a local-toolchain noise investigation.

---

## Cross-cutting guarantees

- **No new browser permissions.** `tabs`, `scripting`, `webRequest`, `cookies`, `declarativeNetRequest`, `debugger`, `activeTab` are already in `chrome-extension/manifest.json`; `tabs`, `webRequest` in `firefox-extension/manifest.json`. Host access stays the existing on-demand `<all_urls>` optional grant (`options.ts:429`). Adding no permission → **no new Chrome Web Store review scope** (the release workflow fires CWS review on every push to `main`).
- **Byte-identical injected code.** Any edit to an `injected/*` module *body* (or code past `export function`) must stay byte-identical between `chrome-extension/injected/*` and `firefox-extension/injected/*` (guarded by `firefox-extension/__tests__/self-containment.test.ts`; per project `CLAUDE.md`). Header/doc-comment lines may diverge. New injected functions **must** be added to that file's `INJECTED_FUNCTIONS` array (`:68-77`) and contain none of its `FORBIDDEN_TOKENS` (`:57-66`).
- **Background helpers may diverge.** Helpers that call `chrome`/`browser` globals (nav-race, the new readiness helper, message-handler orchestration) live in the extension-specific layer and are allowed to differ by the global swap + MV3/MV2 API only — the `nav-race.ts` convention.
- **Two compile-time tripwires** protect any new `cmd`: the `switch(req.cmd)` `_exhaustiveCheck: never` in both `message-handler.ts` (`firefox …:489-491`, `chrome …:478-479`) and the `COMMAND_TO_TOOL_ID: Record<ServerMessageRequest["cmd"], string>` map (`extension-config.ts:230`, both). A new cmd fails compilation until a `case` and a map entry exist in **both** extensions.
- **Additive-first.** Every change is a new tool, a new optional param, or an additive result field, except the three the user explicitly requested: the snapshot line grammar (§C), the eval-script text shape (§F), and `navigate-tab` returning the *accurate* URL (§B, same message shape).

---

## A. Content-script readiness after navigation (item 1)

### Root cause (confirmed)
- `navigate-tab` (`firefox-extension/message-handler.ts:1578-1599`, `chrome-extension/message-handler.ts:1352-1370`) calls `browser.tabs.update(tabId, { url })` and immediately replies. `tabs.update` resolves when the navigation **commits**, not when the document is ready — so the old isolated world is torn down and the next tool runs mid-navigation.
- Chrome injects the DOM content script **lazily**: `sendMessageToTab` (`chrome-extension/message-handler.ts:97-120`) only injects `dist/content-script.js` on catching `"Receiving end does not exist"`, then `sleep(100)` and retries once — there is **no readiness handshake**. The content script *has* a `case "ping": sendResponse({ok:true})` responder (`chrome-extension/content-script.ts:274-276`) but **nothing sends it** (the only `type:"ping"` sender is the WS keepalive, `client.ts:471`) — it is dead code.
- `"Missing host permission for the tab"` is a **native** browser error (not in the repo) thrown by `chrome.scripting.executeScript` when the extension lacks host permission for the tab's *current* origin. Right after a nav it appears because (a) injection targets the new origin before `<all_urls>` coverage is confirmed, and (b) the permission pre-check `checkForUrlPermission(tab.url)` (`chrome-extension/message-handler.ts:564-579`) reads a **stale** `tab.url` mid-navigation, validating the wrong origin.

### Fix
- **New background helper `waitForTabReady(tabId, { timeoutMs })`** in a new per-extension module (`chrome-extension/nav-ready.ts`, `firefox-extension/nav-ready.ts`; structurally mirrored, `chrome`/`browser` + MV3/MV2 swap only — the `nav-race.ts` convention):
  1. **Settle:** resolve immediately if the tab is already `status:"complete"`; else add a one-shot `tabs.onUpdated` listener keyed on `changeInfo.status === "complete"` for `tabId`, with a timeout under the 30s `navigate-tab` budget (`timeouts.ts:13`). Listener removed in `finally`.
  2. **Re-establish readiness:** Chrome → proactively `browser.scripting.executeScript({ target:{tabId}, files:["dist/content-script.js"] })`, then send `{type:"ping"}` and poll the now-live `case "ping"` responder until `{ok:true}` or deadline (**repurposes the dead responder**). Firefox → probe `browser.tabs.executeScript(tabId, { code:"1" })` to confirm the frame is injectable.
- **Harden Chrome `sendMessageToTab`** (`chrome-extension/message-handler.ts:97-120`): on an injection/permission failure (not just `"Receiving end does not exist"`), **re-read the live `tab.url` via `browser.tabs.get`, re-check permission against the *current* origin, then retry `waitForTabReady` + inject once** before surfacing the error. This delivers the "auto-wait-for-ready and auto-reinject once before erroring" behavior for every DOM tool (snapshot / click / fill / eval) after a nav or SPA route change. Firefox's stringify-inject path gets the analogous single re-probe-and-retry.

---

## B. `navigate-tab` settle + real final URL (item 2)

### Root cause (confirmed)
- The handler echoes the **request** `url` back verbatim (`resource:"navigated", url` — the argument it was handed), never re-reading the tab. The reply type `NavigatedExtensionMessage.url` is **already optional** (`common/extension-messages.ts:76-80`) and the server already prefers it (`server.ts:255` `result.url ?? url`), so returning the true URL needs **no type change**.
- A `navigate-tab` to a client-side SPA route (e.g. `…/profile/api-tokens/create`) can be intercepted by the app's router and land elsewhere (`…/api-tokens`). Because the tool neither waits nor re-reads, it reports `"Navigated … to …/create"` — a false success.

### Fix
- After `tabs.update`, call **`waitForTabReady`** (§A), then `browser.tabs.get(tabId)` and reply with **`url: finalTab.url`** — the accurate settled URL. `server.ts` output becomes `Navigated tab N to <finalUrl>`.
- **New optional params** on `navigate-tab` (schema `server.ts:248`, `NavigateTabServerMessage` `common/server-messages.ts:62-66`, threaded through `browser-api.navigateTab` `:461-470` and both handlers):
  - `waitForSelector?: string`, `waitForText?: string`, `waitForUrl?: string` (substring match) — after settle, poll until the condition holds or `timeoutMs` elapses. `waitForText`/`waitForSelector` reuse the existing in-page poll shape (`chrome-extension/content-script.ts:196-216`; Firefox background poll `firefox-extension/message-handler.ts:1887-1938`); `waitForUrl` is satisfied purely in background via `tabs.get`/`onUpdated` URL matching (no injection).
  - `forceLoad?: boolean` — force a real document load (`tabs.update` to the URL, or `tabs.reload` when already there), defeating in-app SPA routing so a deep route actually loads.
  - `waitUntil?: "complete" | "none"` (default `"complete"`) — see the decision below.
  - `timeoutMs?: number` — overall wait budget (bounded by the 30s broker cap).
  - If a `waitFor*` is given and unmet within timeout, the tool **reports the mismatch** (`Navigated to <finalUrl> — expected "<x>" not found`) rather than claiming success.

### Confirmed decision — default wait behavior (Fork 1)
**Settle-on-`complete` is the DEFAULT.** The return shape is unchanged (just accurate), and the current fire-and-forget behavior is itself the bug. A `waitUntil?: "none"` value restores fire-and-forget for any caller that wants it.

---

## C. Enriched snapshot — full 3-slot grammar (item 3)

### Root cause (confirmed)
- Each snapshot row is `role "name" [uid=eN]` optionally ` (flags)`, assembled at `snapshot-script.ts:446` (base pass) and `:539` (pointer pass — a **second, independent** line builder). `getAccessibleName` (`:215-264`) already resolves `aria-label` → `aria-labelledby` → `<label for>` → wrapping `<label>` → `title` → `placeholder` **attribute** → (for `link`/`button`/`heading` only) `textContent`.
- react-select renders `<div role="combobox">` whose (a) placeholder and (b) selected value live in **child** elements (`[class*="placeholder"]`, `[class*="singleValue"]`), not attributes — so `getAccessibleName` returns `""` and the row is `combobox ""`. There is **no current-value read** anywhere (even a native `<select aria-label="Country">` emits `combobox "Country"` with no selected-option text) and **no section/breadcrumb** concept. Dozens of controls are therefore indistinguishable.

### Fix — new uniform grammar on every row
```
<role> "<name>" | <value> | <breadcrumb> [uid=eN] (flags)
```
Empty slots render empty (`button "Sign in" |  | Account [uid=e15]`), matching the approved preview.

- **name** — existing `getAccessibleName` plus two fixes: (1) probe react-select's **child** placeholder/label element when the attribute chain yields nothing; (2) widen the final `textContent` fallback to include `combobox`/`textbox` as a last resort.
- **value** (new inner `getCurrentValue(el, role)`) — the control's *current displayed text*: `<input>/<textarea>.value`; native `<select>` → `selectedOptions[0].textContent`; custom combobox → `aria-valuetext`/`aria-valuenow`, else the `[class*="singleValue"]` / `[class*="single-value"]` child; **placeholder text when nothing is selected** (so an empty react-select reads `… | "Select..." | …`). Rendered quoted when present, empty otherwise.
- **breadcrumb** (new inner `getSection(el)`) — nearest titled context: `el.closest("fieldset")` → `<legend>` text; else `el.closest('section,[role="group"],[class*="card"],[aria-labelledby]')` → its `aria-labelledby`/first heading; else an ancestor + `previousElementSibling` walk for the nearest `h1–h6`/`[role="heading"]` (mirrors the `labelFromAncestor` walk at `:169-188`, reuses `getRole`'s heading detection `:134-136`). This is what disambiguates the 12 permission selectors, Account-vs-Zone resources, and the 11 "Use template" buttons (each gets its card title).

### Implementation notes
- Refactor both the base-pass (`:423-451`) and pointer-pass (`:483-544`) builders to a **shared inner `makeRow(el, role, name, value, section, flags, uid)`** inside `buildSnapshot` (inner function → preserves Firefox self-containment). New helpers `getCurrentValue`/`getSection` are inner functions too.
- Each slot independently clipped (name 120 — existing `NAME_MAX`; value ~80; breadcrumb ~60) to protect the 25 000-char budget (`maxLength`, `message-handler.ts:710`). Literal ` | ` sanitized out of slot text (collapse `|` → `/`) so the delimiter stays unambiguous.
- Byte-identical mirror to `chrome-extension/injected/snapshot-script.ts`; update both `__tests__/snapshot-script.test.ts` suites (every asserted line changes) and keep `buildSnapshot` in `self-containment.test.ts`. `snapshot-format.ts` header/`total` handling unchanged.

---

## D. `select-option` tool — native + custom dropdowns (item 4)

### Root cause (confirmed)
- `fill-element` handles a native `<select>` only, via `el.value = value` + one `change` (`action-script.ts:137-165`). On a react-select `<div>` it falls into the text branch; `nativeSetValue` (`:113-127`) does `HTMLInputElement.prototype` setter `.call(div, …)` → **`TypeError: Illegal invocation`**, caught → `ok:false`. So a custom combobox cannot be driven at all — it neither opens the menu nor picks an option.

### Fix — new tool + one new cmd
- **`select-option { tabId, uid, option, exact? }`** (`option` = desired visible text; `exact?` default false → normalized substring match). Implemented as a **single self-contained async injected `selectOption(doc, args)`** (one new cmd; Chrome awaits via async `sendResponse`, Firefox via `executeScript` awaiting the returned Promise):
  1. Resolve uid (same `data-bcmcp-uid` query as `resolve`, `:40-42`).
  2. Native `<select>` → match `option` against option text/value, set + fire `change`. Return the selected text.
  3. Custom combobox → **open** (pointerdown/mousedown/click via the `dispatchClickSequence` pattern `:72-99`) → if a search `<input>` appears, **type** `option` to filter (native-setter + `input` event, the `type-at` pattern `point-action-script.ts:185-260`) → **poll** (~300 ms loop, `await new Promise(r=>setTimeout(r,300))`, same shape as `waitForText`) for a `[role="option"]`/listbox item whose **leaf** text matches (mirrors `isLeafTextMatch`, `snapshot-script.ts:346+`) → **click** it → re-read the control's displayed value (reuse `getCurrentValue` from §C).
- Wrapped in `raceInputAgainstNavigation` (selecting can navigate). Reply reuses `action-result` with an additive `selected?: string`. Full new-tool wiring (§ files list): union + both switch cases + exhaustiveness + `COMMAND_TO_TOOL_ID` + `AUTOMATION_COMMANDS` + `AVAILABLE_TOOLS` + `server.ts` tool + `browser-api` method + `self-containment.test.ts` registration.

---

## E. Overlay handling — interception detection + `dismiss-overlays` (item 5)

### Root cause (confirmed)
- `click-element` returns `ok:true` whenever the uid resolves and nothing throws (`server.ts:402-420`, `browser-api.ts:513-530`); the injected click arm dispatches `pointerdown/mousedown/mouseup/focus/click` **directly on the resolved element** (`action-script.ts:185-193`, `72-99`) with **no hit-test** — so a covering overlay is never detected, and the tool falsely reports success.
- A read-only hit-test primitive already exists: `describe-at` → `elementAt(x,y) = doc.elementFromPoint` (`point-action-script.ts:335-344`, `46-54`) + `describeElement` (`:76-104`), and the CDP path already does "describe-before-dispatch" (`chrome-extension/message-handler.ts:768-785`).
- There is **no** cookie/consent/overlay dismissal helper anywhere.

### Fix (a) — interception detection on `click-element`
- In the injected click arm, **before** dispatch, compute the target's center from `getBoundingClientRect`, call `elementFromPoint(cx,cy)`, and classify the topmost node as the target / an ancestor / a descendant / **unrelated**. If unrelated, attach **`intercepted: { by: <describeElement> }`** to `action-result` (additive field on `ActionResultExtensionMessage`, `common/extension-messages.ts:102-110`, like `navigated`).

**Confirmed decision — interception policy (Fork 2):** **detect + report, still perform the click, keep `ok:true`**, and surface a prominent warning in the tool text (`⚠ click may be intercepted by <#onetrust-banner-sdk> — consider dismiss-overlays`). Add an opt-in **`failIfIntercepted?: boolean`** (default false) for a hard `ok:false`. Rationale: FoxPilot's synthetic click dispatches *directly on the element* and frequently still works when visually covered — hard-failing by default would regress working flows; this reports the interception without breaking them.

### Fix (b) — `dismiss-overlays` tool + one new cmd
- **`dismiss-overlays { tabId }`** → new self-contained injected `dismissOverlays(doc)` (isolated-world, CSP-immune, `querySelectorAll`-only):
  - Targets OneTrust (`#onetrust-banner-sdk`, `#onetrust-consent-sdk`, `#onetrust-pc-sdk`, `.onetrust-pc-dark-filter`; reject `#onetrust-reject-all-handler`), TrustArc (`#truste-consent-track`, `.truste_overlay`), Cookiebot (`#CybotCookiebotDialog`; decline `#CybotCookiebotDialogBodyButtonDecline`), Osano/Quantcast, and generic `[role="dialog"][aria-modal="true"]` + common backdrop classes.
  - **Privacy-preserving reject path:** prefer clicking a Reject/Decline/"Necessary only" control (known id, else text match on reject/decline/necessary); only if none exists, remove the node(s) and restore `body`/`documentElement` scroll locks (`overflow`). Idempotent; safe to re-call.
  - Returns `{ ok, dismissed:[…], method:"reject"|"remove" }`. "Stays gone across a route change" is a property of re-invocation + idempotency, verified by the fixture test (dismiss → `pushState` re-mount → dismiss again → gone).
- Full new-tool wiring, same as §D. New injected fn registered in `self-containment.test.ts` and byte-mirrored.

---

## F. `evaluate-script` structured result (item 6)

### Root cause (confirmed)
- The extension already returns the **raw JS value** unmodified (`page-world.ts:143-146` serialize → `:495` parse → `message-handler.ts:1145-1151` forward → `browser-api.ts:786` return). The double-quoting is introduced by **exactly one line**: `server.ts:608` `text: JSON.stringify(value)`. A page function returning an already-serialized string (`() => JSON.stringify(state)`) gets **double-encoded** → the model sees `"{\"a\":1}"` and must `unicode_escape`-decode one layer.

### Fix
- New pure module **`mcp-server/eval-format.ts` exporting `formatEvalResult(value)`** (mirrors the extracted-formatter pattern — `point-format.ts`/`snapshot-format.ts`/`network-format.ts` — because `server.ts` self-executes on import and can't be unit-tested). The `evaluate-script` handler calls it in place of `JSON.stringify(value)`.
- **Confirmed decision — format richness (Fork 3):** strings **pass through raw/unquoted** (kills the double-escape); non-strings **pretty-printed** `JSON.stringify(value, null, 2)`; **and**, when supported by the installed MCP SDK version, set `structuredContent` to the raw value so structured clients get typed data (additive — the text block remains the primary channel; if the SDK/`tool()` return type doesn't accept it, drop it, no behavior loss). Extension unchanged; unit-tested in isolation (`mcp-server/__tests__/eval-format.test.ts`), which also pins the raw-string and pretty-print cases.

---

## G. Stray `"You have not agreed to the Xcode license agreements"` (item 7)

### Hypothesis
- The string is a macOS toolchain (clang/git/xcodebuild) message emitted when the Command Line Tools license isn't accepted — almost certainly triggered by a **native rebuild during `npm install`/`postinstall`** (`input-sidecar` is a native helper). It is **local machine state**, not a FoxPilot code bug.

### Plan
- **Investigate, don't assume:** reproduce, confirm the exact trigger (which subproject/step, `install`-time vs runtime), and — critically — **verify it never reaches the MCP server's stdout** (stdout is the JSON-RPC protocol channel; any leak there would corrupt MCP). Confirm server startup triggers no native build and that broker/server stdout stays clean.
- If purely install-time CLT-license state, the remedy is `sudo xcodebuild -license accept` — **documented** in `CLAUDE.md` dev-notes rather than coded around. Fix in code **only if** FoxPilot actually pollutes tool output.

---

## Fixture + test harness

- **New fixture `test-fixtures/spa-widgets/`** (vanilla JS, zero-dependency, small `node:http` server mirroring `test-fixtures/csp-react-spa/server.mjs`), bundling: (a) a **react-select-style searchable portal dropdown** (`div[role=combobox]` + portal `[role=option]` menu + search `<input>` + `singleValue`/`placeholder` children); (b) a **fixed full-screen OneTrust-like overlay** (`#onetrust-*` with a reject button) that **re-mounts on a simulated `pushState` route change**; (c) several identically-labeled **"Use template" buttons inside titled cards**; (d) **SPA `pushState` routing** including a link that "lands elsewhere."
- **Playwright** (Chromium) drives the fixture in a **real browser** — the robust choice for the geometry/routing/portal behaviors jsdom cannot model (`elementFromPoint`, layout, `pushState`). It loads the fixture and exercises the injected functions via `page.evaluate`/`addScriptTag`, asserting: enriched grammar + values + breadcrumbs; `select-option` picks the right option in a real portal menu; `dismiss-overlays` clears + stays cleared after the route change; `click-element` reports interception when covered. Runs as its **own `npm run test:e2e` script, NOT wired into the release-blocking jest path**, so releases stay green.
- **jsdom / node unit tests** cover pure logic: label/value/breadcrumb computation (both extensions' `snapshot-script.test.ts`), `select-option` text-matching, `dismiss-overlays` selector predicate, `eval-format`, and `navigate-tab` settle (mocked `browser.tabs`). Interception *decision* logic is factored to accept an injected `elementFromPoint` (dependency injection) so its classification is jsdom-testable; the real hit-test is Playwright-covered.

---

## Wave plan (dependency-ordered; disjoint files per wave)

| Wave | Items | Primary files |
|---|---|---|
| **0 — Fixture/harness** | test infra | `test-fixtures/spa-widgets/*`, `playwright.config.*`, `test:e2e` script |
| **1 — Readiness/nav** | 1, 2 | new `*/nav-ready.ts` (both), both `message-handler.ts` (navigate + `sendMessageToTab`), `chrome-extension/content-script.ts` (ping), `server.ts` (navigate-tab params + output), `browser-api.ts`, `common/server-messages.ts`, `timeouts.ts` |
| **2 — Snapshot** | 3 | both `injected/snapshot-script.ts`, both `__tests__/snapshot-script.test.ts`, `self-containment.test.ts` |
| **3a — Interception** | 5(a) | both `injected/action-script.ts`, `action-result` field (`common/extension-messages.ts`), `click-element` output (`server.ts`) |
| **3b — New tools** | 4, 5(b) | new injected `selectOption`/`dismissOverlays` (both), new cmds (`common/server-messages.ts` union + both switch cases + exhaustiveness + `extension-config.ts` maps), `server.ts`, `browser-api.ts`, `self-containment.test.ts` |
| **4 — Ergonomics** | 6, 7 | new `mcp-server/eval-format.ts` + `server.ts` one-line swap + `eval-format.test.ts`; xcode investigation + `CLAUDE.md` doc |

Waves 1–4 touch largely disjoint files. **3a** (`action-script.ts` edits) is split from **3b** (new-cmd wiring) so they don't collide; within **3b**, `select-option` and `dismiss-overlays` share the same union/config/server files, so **one implementer owns both new cmds** (they are not parallelized against each other). **One final spec-review + quality-review pass** at the end (the v1.0.14 wave-mode discipline), not per-task.

---

## Files touched (superset)

| Area | Files |
|---|---|
| Server | `mcp-server/server.ts` (navigate-tab params/output, `select-option`/`dismiss-overlays` tools, `click-element` intercept output, eval-format call), `mcp-server/browser-api.ts`, **new** `mcp-server/eval-format.ts` |
| Common | `common/server-messages.ts` (navigate-tab params, `select-option`/`dismiss-overlays` cmds), `common/extension-messages.ts` (`intercepted?`, `selected?`) |
| Chrome ext | `message-handler.ts` (navigate settle, `sendMessageToTab` harden, new cmd cases), `content-script.ts` (ping), **new** `nav-ready.ts`, `injected/snapshot-script.ts`, `injected/action-script.ts`, **new** `injected/select-option-script.ts` + `injected/dismiss-overlays-script.ts`, `extension-config.ts` |
| Firefox ext | `message-handler.ts` (mirror), **new** `nav-ready.ts`, `injected/snapshot-script.ts`, `injected/action-script.ts`, **new** mirrored injected fns, `extension-config.ts`, `__tests__/self-containment.test.ts` |
| Fixture/tests | **new** `test-fixtures/spa-widgets/*`, `playwright.config.*`, both `__tests__/snapshot-script.test.ts`, **new** `eval-format.test.ts` + action/select/dismiss + nav-settle unit tests |
| Docs | `CLAUDE.md` (new tools/params + xcode note) |

---

## Backward-compat / non-goals

- **No new browser permissions**; no `unsafe-eval`; no `webNavigation` (settle uses `tabs.onUpdated`, consistent with nav-race).
- **No manifest changes.** Byte-identical injected mirroring preserved; new injected fns registered in `self-containment.test.ts`.
- Behavior changes limited to the three the user requested (snapshot grammar, eval text, accurate navigate URL — the last with a `waitUntil:"none"` escape). All else is additive tools/params/fields; existing callers of `click-element`/`navigate-tab`/`evaluate-script` that only read `ok`/text keep working.
- Playwright is **not** added to the release-blocking test path.

## Open risks / accepted edges

- **Snapshot grammar churn:** the full 3-slot grammar rewrites nearly every asserted line in both `snapshot-script.test.ts` suites — expected and bounded (mechanical test updates), accepted for the uniform, reliably-parseable output the user chose.
- **`waitForTabReady` timeout:** a page that never reaches `status:"complete"` (long-poll/streaming) falls back to the timeout, then proceeds with a best-effort readiness probe — the tool still returns the settled-so-far URL rather than hanging.
- **Interception false-negative across shadow DOM:** `elementFromPoint` returns the shadow host, not the inner target; classification treats a same-subtree host as "related" (not intercepted). Acceptable — the goal is catching *foreign overlays*, which are not in the target's tree.
- **`select-option` non-standard widgets:** the open→filter→poll→click sequence targets react-select/Downshift/Radix-shaped menus (`[role=option]`/listbox). Exotic virtualized menus that render options only on scroll may miss; the poll timeout then returns a clear `ok:false` naming the control, not a false success.
- **Xcode line:** if investigation shows it is genuinely local CLT-license state, the deliverable is documentation + a stdout-cleanliness confirmation, not a code change — flagged so the plan doesn't over-scope item 7.
