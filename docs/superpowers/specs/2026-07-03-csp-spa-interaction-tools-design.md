# Design: CSP-strict custom-React SPA interaction capabilities

**Date:** 2026-07-03
**Status:** DRAFT — awaiting user review. #1 engine resolved: **no cursor sidecar** → `-at` tools default to `synthetic` (covert) with an optional `engine:"cdp"` trusted tier on Chrome. Remaining open items in §9.
**Repo:** `balakumardev/foxpilot` (npm `foxpilot-mcp`)
**Branch plan:** cut a fresh `feat/spa-interaction` off `origin/main` (current `main` = `fe0e7f5`). The prior `feat/extension-privileged-http` is already merged into `main`.

---

## 1. Context & goal

FoxPilot can navigate / read / screenshot fine, but it fails to *interact* with modern custom-React SPAs that (a) don't expose a proper a11y tree, and (b) enforce strict CSP. Concretely it can't drive `<div contenteditable>` chat inputs or `<div onClick>` "cards" that never surface as buttons/textboxes, and `evaluate-script` dies on strict-CSP pages.

This spec adds seven capabilities (the user's numbering is preserved throughout). It must **keep the existing `mcpkit call foxpilot <tool>` interface intact** — new tools and new *optional* params only, no breaking changes to current tools.

### Non-negotiables

- **Backward compatible.** Every current tool keeps its current signature and behavior. All new params are optional with back-compat defaults.
- **Covert-first, and no cursor sidecar in scope.** The new coordinate tools default to covert isolated-world dispatch. The OS-input sidecar (which hijacks the physical cursor + needs a separate process + OS accessibility permission) is **explicitly out of scope** — it remains in the repo untouched, backing the existing uid-based `native` input-realism mode, but no new tool uses it.
- **Cross-browser.** Chrome (MV3) and Firefox (MV2) both implemented, mirrored. Where a capability is physically impossible on one browser, degrade explicitly (clear error), never silently.
- **Both compile-time tripwires respected.** Adding a `cmd` forces edits in 3 guarded places (two `_exhaustiveCheck: never` switches + the `Record<cmd,string>` map).

---

## 2. Scope reframe: what already exists vs. what's net-new

Verified by reading the code (not assumed). This materially shrinks #5 and reshapes #1.

| # | Ask | Reality today | Work |
|---|-----|---------------|------|
| 1 | Coordinate `click-at`/`type-at`/`hover-at`/`scroll-at` (trusted input) | No `{x,y}` command exists. Chrome uses **no** CDP `Input.*` (debugger is network-only). Firefox has **no** in-process trusted-input API. Existing input is uid-based, isolated-world synthetic (untrusted) by default. | **Net-new tools**; synthetic default + opt-in CDP trusted tier (§3) |
| 2 | Snapshot includes all interactive-looking els + `selector`/`textContains` query | Base snapshot already matches `[tabindex]`,`[onclick]`,`[role]`,`[contenteditable]`,`a/button/input/textarea/select/summary`. `cursor:pointer` caught only in the *verbose* pass (cap `MAX_CLICKABLES=300`). **No `selector`/`textContains` query mode.** | Promote `cursor:pointer` to base; add query modes |
| 3 | `rootSelector`/region scoping + `offset`/`limit` paging | Truncation is a single hard 25 000-char cut in DOM order. **No scoping, no paging, no importance ranking.** 700-item sidebar crowd-out reproduced. | Net-new params |
| 4 | CSP-proof `evaluate-script` | `evaluate-script` injects a page-world `<script>` (CSP-blockable). DOM ops already run CSP-immune in the **isolated** world. The user's three stated needs — read DOM state, get element rects, read `document.cookie` — are **all isolated-world-doable**. | Add isolated-world eval path |
| 5 | `get-cookies {url,names?}` + request headers in network | `get-cookies {url?,domain?,name?}` **already reads httpOnly**. `get-network-requests` **already captures** req `Cookie`/`Authorization` + resp `Set-Cookie` (Chrome `extraHeaders`) and surfaces them via `includeHeaders` — **redacted** by design. | Add plural `names[]`; opt-in un-redact |
| 6 | Reliable fullPage screenshot + `scrollTo`/`scrollIntoView` + inner-container scroll | Stitching exists but **no retry/backoff, no empty-readback validation** (a failed tile silently yields an empty image; "image readback failed" is not a real error today). Scroll primitives exist internally but aren't exposed as tools. `press-key PageUp` doesn't scroll inner containers. | Harden + expose scroll tools |
| 7 | `wait-for-text` accepts `string \| string[]` | Schema is `text: z.string()`; confirmed it rejects arrays. Matching is a single case-sensitive `innerText.includes`. | Union type; OR-match |

---

## 3. RESOLVED DECISION — trusted input for #1, without the cursor sidecar

The user specced "CDP (Chrome) / equivalent Firefox remote API," and has since directed: **no cursor sidecar** (the OS-input path that moves the physical mouse, needs a separate process, and needs OS accessibility permission). So the sidecar is **out of scope for the new coordinate tools** — it stays in the repo, untouched, backing the existing uid-based `native` input-realism mode, but the new `-at` tools do not use it.

Trusted input (`isTrusted:true`, which strict editors won't ignore) **without the cursor** comes from **CDP `Input.dispatch*`** — it synthesizes trusted events in the renderer at `{x,y}`, does **not** move the OS cursor, and needs no sidecar and no OS permission. Its only cost is the "started debugging this browser" banner (not covert). This is exactly what was originally specced.

**Chosen design: `synthetic` (covert) default + `cdp` opt-in trusted tier on Chrome. No sidecar.** Engine selection via an optional `engine` param on each coordinate tool:

```
engine: "synthetic" | "cdp"   // default "synthetic"
```

- `synthetic` (default, both browsers): dispatch in the **isolated content-script world** at `{x,y}` (via `document.elementFromPoint`). CSP-immune, covert, no cursor, no banner. `isTrusted:false` — fine for `<div onClick>` handlers and normal inputs; **may be ignored by strict rich-text editors** (Lexical/ProseMirror/Slate).
- `cdp` (Chrome/Edge only, opt-in): attach `chrome.debugger` (refcounted, §5) and dispatch `Input.*` for **guaranteed-trusted** events at `{x,y}`. Shows the banner. Reach for it only when synthetic is ignored. **Errors on Firefox** (no CDP exists there).

**Firefox:** synthetic only. With no in-process trusted-input path and no sidecar in scope, trusted coordinate input into strict editors is a known, **documented** Firefox gap (not silently wrong). Everything else (§4.B–§4.G) is fully cross-browser.

> Because the snapshot fix (§4.B) makes `<div contenteditable>`/`<div onClick>` elements addressable by `uid`, most real clicks already work with the existing untrusted path — so the `cdp` trusted tier is load-bearing mainly for **typing into strict rich-text editors**. Open items: §9.1 (confirm the banner is acceptable, else drop CDP and ship synthetic-only) and §9.6 (confirm `synthetic` default).

---

## 4. Tool-by-tool design

Naming convention: existing tools are hyphenated (`click-element`, `take-snapshot`). New tools follow suit.

### 4.A Coordinate interaction (#1) — `click-at`, `type-at`, `hover-at`, `scroll-at`

All take a `tabId` and viewport CSS-pixel coordinates `{x, y}` (origin = top-left of the visible viewport, matching `document.elementFromPoint`). Default engine is `synthetic` (covert, no cursor, no banner); pass `engine:"cdp"` on Chrome/Edge for guaranteed-trusted events (banner).

| Tool | Params | Behavior |
|------|--------|----------|
| `click-at` | `tabId, x, y, doubleClick?, button?, engine?` | Click at `{x,y}`. |
| `type-at` | `tabId, x, y, text, submit?, engine?` | Click at `{x,y}` to focus, then type `text`. `submit:true` presses Enter after. |
| `hover-at` | `tabId, x, y, engine?` | Pointer-move to `{x,y}` (reveals hover menus/tooltips). |
| `scroll-at` | `tabId, x, y, dx?, dy?, engine?` | Scroll the **nearest scrollable ancestor** under `{x,y}` by `(dx,dy)`. Fixes inner-container scroll (see #6). Defaults to one "page" down if `dx/dy` omitted. Programmatic scroll needs no trusted input, so it's always available; `engine:"cdp"` only for sites that honor real wheel events exclusively. |

**Engine mechanics:**

- **synthetic (default, both browsers):** in the isolated content-script world, `document.elementFromPoint(x,y)` → run the existing action sequences on that element (reuse `dispatchClickSequence` for click; focus + native-setter + key events for type; `mouseover`/`mousemove` for hover; nearest-scrollable-ancestor `scrollBy` for scroll). CSP-immune, covert, `isTrusted:false`.
- **cdp (Chrome/Edge only, opt-in):** attach `chrome.debugger` (refcounted — §5), then `Input.dispatchMouseEvent {type:"mousePressed"/"mouseReleased", x, y, button, clickCount}` for click; `{type:"mouseMoved"}` for hover; `Input.insertText`/`Input.dispatchKeyEvent` for type; `{type:"mouseWheel", deltaX, deltaY}` for scroll. Coords are viewport CSS px (native — **no screen mapping, no DPR issue**). Produces `isTrusted:true`; does **not** move the OS cursor. Shows the banner. Detach honors the refcount.
- **Firefox + `engine:"cdp"`:** explicit "not supported on Firefox" error (no CDP). Firefox uses synthetic only.

**Return element info at the point (user requirement):** after the action, in the isolated content-script world, run `document.elementFromPoint(x,y)` and return a compact descriptor for confirmation:

```ts
element?: { tag, id, classes: string[], role?, name?, rect: {x,y,w,h}, editable?: boolean }
```

Wire this as a new response type `PointActionResultExtensionMessage { resource:"point-action-result"; ok; error?; element? }` (keeps the shared `action-result` clean). If `elementFromPoint` returns null (coords off-page), `ok:false` with a helpful error.

### 4.B Snapshot: capture all interactive-looking elements + query modes (#2)

Extend `take-snapshot` (no new tool — one surface, back-compatible). New optional params:

- `includePointer?: boolean` (default **true**) — promote the `cursor:pointer` detection from the verbose-only pass into the **base** pass, so `<div onClick>` cards are captured by default. Keep the jsdom guard on `getComputedStyle`. Keep a cap but raise it and make it `maxInteractive?` configurable (default e.g. 500); when a `selector`/`textContains` filter is supplied the cap applies to matches only.
- `selector?: string` — CSS selector query mode: return elements matching the selector (with fresh uids), even if not semantically interactive. Enables "grab the chat input by `div[contenteditable]`" → uid.
- `textContains?: string` — visible-text query mode: return elements whose trimmed visible text contains the string (case-insensitive), even non-interactive (e.g. the "Open" / "Test Agent" cards). Leaf-preferring (deepest matching element wins, matching the existing cursor:pointer leaf logic).

`selector` and `textContains` compose (AND) and compose with `rootSelector`/paging (§4.C). Emitted line format unchanged (`role "name" [uid=eN] (flags)`), so existing parsing keeps working. uids remain per-snapshot (re-minted each call) — documented behavior, unchanged.

### 4.C Snapshot: region scoping + paging (#3)

Additional `take-snapshot` optional params:

- `rootSelector?: string` — scope collection to the first element matching this selector (its subtree only). Solves the 700-item-sidebar crowd-out by letting the caller target the main panel. If it matches nothing → `ok:false` clear error.
- `offset?: number` (default 0) and `limit?: number` — page over the **collected candidate list** (in DOM order) *before* the 25 000-char budget cut, so paging is over elements, not characters.
- Response gains a small header line / metadata: `total` candidates collected and `hasMore` (so the caller can page deterministically). Back-compat: with no paging params, behavior is unchanged except the header line (append-only; safe).

### 4.D CSP-proof `evaluate-script` (#4)

Add an optional `world` param to `evaluate-script`:

```
world: "main" | "isolated"   // default "main" (back-compat)
```

- `isolated`: run the function in the extension's **isolated content-script world** (Chrome: `world:"ISOLATED"` executeScript, already the default injection world; Firefox: plain `browser.tabs.executeScript` — its native isolated/Xray world). **CSP-immune.** Can read DOM state, compute `getBoundingClientRect`, read non-httpOnly `document.cookie` — i.e. the user's three stated needs. Cannot see page-JS variables/functions (that's the isolation boundary).
- `main` (default): the current page-world `<script>` path — unchanged, still CSP-blockable, still the way to touch the page's real `window`.
- **Page-JS-variable access under strict CSP** (the only thing isolated can't do) is available *only* via CDP `Runtime.evaluate` (banner). Offer it as the **same opt-in CDP tier from §3** (`world:"main"` + `engine:"cdp"`), **not built in Phase 1–2** — YAGNI unless you confirm you need page-var reads on strict-CSP pages. Flagged (§9.3).

### 4.E Cookies & headers (#5)

- `get-cookies`: add `names?: string[]` (plural). Semantics: filter to cookies whose name ∈ `names`. Implement as `getAll({url|domain})` then filter, or loop `getAll` per name. Keep existing `name?` (singular) for back-compat; if both given, union. httpOnly already included.
- `get-network-requests`: add `includeCredentials?: boolean` (default **false**). When true, **skip the redaction** of `Cookie`/`Authorization`/`Set-Cookie` values so the caller can replay the app's own authenticated API calls. This deliberately loosens a privacy-by-default redaction → gate behind its own `AVAILABLE_TOOLS` toggle *and/or* the existing Automation-Mode + host-permission gate. **Flag for review (§9.4):** confirm you want raw credential values surfaced here, given `get-cookies` already returns real cookie values and `browser-fetch`/streams already replay cookies without exposing them.

### 4.F Screenshots & scrolling (#6)

**Stitch hardening** (`take-screenshot fullPage:true`):
- Validate each tile: treat empty `base64:""` from the offscreen compositor (Chrome) / canvas path (Firefox) as a **failure**, not a silent empty image.
- Retry per-segment capture with backoff (e.g. 3 attempts, 100→300→600 ms) on capture throw or empty readback (also absorbs `captureVisibleTab` rate-limiting — currently unhandled on Chrome).
- Fallback: if stitching still fails, return a **single viewport capture** with a warning field rather than an empty image.
- Introduce a real `"image readback failed"` error only after retries **and** the viewport fallback are exhausted.

**New scroll tools** (primitives already exist internally — `content-script` `scrollTo`/`readElementRect`/`readPageDimensions`):
- `scroll-to { tabId, x?, y? }` — absolute `window.scrollTo(x,y)` (position content before a viewport capture).
- `scroll-into-view { tabId, uid }` — `scrollIntoView({block:"center"})` on the uid'd element.
- `scroll-at` (from §4.A) — scrolls the **nearest scrollable ancestor** under `{x,y}`, fixing inner-container scroll and the `press-key PageUp` gap. Implementation: `elementFromPoint(x,y)` → walk ancestors for the first with scrollable overflow (`overflowY` auto/scroll **and** `scrollHeight>clientHeight`) → `scrollBy(dx,dy)`; fall back to `window`. Runs in the isolated world (CSP-immune; a programmatic scroll needs no trusted input).

### 4.G `wait-for-text` accepts `string | string[]` (#7)

- Schema: `text: z.union([z.string(), z.array(z.string()).nonempty()])`.
- Semantics: resolve as soon as **any** string appears (OR-match). Return **which** string matched (append-only to the result; back-compat).
- Touch the 5 spots: zod schema (`server.ts`), `WaitForTextServerMessage.text` type (`common/server-messages.ts`), `browser-api.waitForText`, the wire payload, and both extensions' isolated-world `.includes` poll loops (Chrome + Firefox).

---

## 5. Cross-cutting concerns

**Wiring checklist (per new tool — 8 places, 6 files; broker is transparent):**
1. `common/server-messages.ts` — request interface + add to `ServerMessage` union.
2. `common/extension-messages.ts` — reuse `action-result` or add a `resource` type (e.g. `point-action-result`) + union.
3. `mcp-server/server.ts` — `mcpServer.tool(name, desc, rawZodShape, handler)`. **Use two-arg `z.record(z.string(), z.string())`** for any map param (zod v4 gotcha).
4. `mcp-server/browser-api.ts` — public method sending the frame.
5. `firefox-extension/extension-config.ts` **and** `chrome-extension/extension-config.ts` — `AVAILABLE_TOOLS` entry + `COMMAND_TO_TOOL_ID` key + (if page-controlling) `AUTOMATION_COMMANDS`.
6. `firefox-extension/message-handler.ts` **and** `chrome-extension/message-handler.ts` — `case` + handler method ending in `sendResourceToServer({...correlationId...})`.
- Optional: `mcp-server/timeouts.ts` if slow (else inherits 5 000 ms default).
- Three compile-time guards catch half-wiring: two `_exhaustiveCheck: never` switch defaults + `COMMAND_TO_TOOL_ID: Record<cmd,string>`.

**Debugger attach refcounting (only exercised when `engine:"cdp"`):** today `attachDebugger` unconditionally does `Network.enable` and `detachDebugger` fully detaches. A CDP-Input call sharing a tab with `capture-response-bodies` would fight it. Add a per-tab **purpose set / refcount** (`{network, input}`) so: attach once; `Network.enable` only for the network purpose; detach only when the last purpose releases. Reuse the existing `onDetach` + all three auto-detach triggers (tab close, automation-off, DevTools-dismissed). No new manifest permission (`debugger` already present). Not touched at all under the default `synthetic` engine — the covert path never attaches the debugger.

**No coordinate-mapping / DPR work:** with the sidecar out of scope, coordinate tools use viewport CSS px directly — synthetic via `elementFromPoint`, CDP via native viewport coords. No screen-coordinate mapping, no DPR multiply, no HiDPI risk.

**Gating & covert posture:** `-at` tools and the new scroll tools are page-controlling → add to `AUTOMATION_COMMANDS`. The default `synthetic`/isolated paths are covert (no banner). The only covert/credential-sensitive escape hatches are the opt-in `engine:"cdp"` tier (banner) and `includeCredentials` un-redaction — both default off.

### 5.1 Covertness posture (explicit)

"Covert" here means **no automation banner, no attached debugger, no OS-level footprint** — invisible to the site at the browser level. Under that definition:

- **Covert by default — all of #2–#7 and #1's default `synthetic` engine.** Isolated-world DOM reads/dispatch, `chrome.cookies`/`webRequest` background capture, and `captureVisibleTab` are all invisible to page JS. Note `evaluate-script world:"isolated"` is *strictly more covert* than the existing `world:"main"` path, which injects an observable `<script>` element.
- **Not covert — only the opt-in `engine:"cdp"` tier**, which attaches `chrome.debugger` and shows the banner (same tradeoff as `capture-response-bodies`). Default off; reached only by explicit `engine:"cdp"`.

**Honest caveat — "no banner" ≠ "human-indistinguishable input."** Synthetic dispatch carries `isTrusted:false`; a site that checks `event.isTrusted` can detect it. This is **unchanged from the existing `click-element`/`type-text` tools** (as is the pre-existing `data-bcmcp-uid` attribute stamping the snapshot does). The design adds no new *loud* signal on the default path — the only loud signal is the opt-in CDP banner.

**The unavoidable tradeoff (given no sidecar):** for the narrow case of *typing into a trust-checking rich-text editor*, covert and trusted-input are mutually exclusive — `synthetic` is covert but `isTrusted:false` (may be ignored), `cdp` is `isTrusted:true` but shows the banner. The sidecar was the only path that was both covert (no banner) and trusted (real OS events); it is out of scope by user decision (cursor hijack). Everything outside that narrow case is fully covert with the default engine.

---

## 6. Testing plan

Mirror the established `ts-jest` + jsdom pattern (`__tests__/setup.ts` global `browser`/`chrome` mock, driven per-test with `(browser.X.y as jest.Mock).mockResolvedValue(...)`).

- **DOM-tier tools** (snapshot query modes, rootSelector/paging, isolated eval, scroll-to/into-view, wait-for-text array, get-cookies names[]): unit-test in each extension's `message-handler.test.ts` by mocking `executeScript`/`tabs.sendMessage` return values and asserting the `sendResourceToServer` payload. jsdom drives the injected `snapshot-script`/`action-script` logic directly for the collection/selector/textContains predicates.
- **Coordinate tools — synthetic tier (default, both browsers):** drive `executeScript`/`sendMessage` mocks so `document.elementFromPoint` returns a known element; assert the dispatched action sequence ran on it and the `point-action-result` element descriptor is returned. jsdom exercises the `elementFromPoint`→action path directly.
- **Coordinate tools — CDP tier (Chrome, opt-in):** use the existing `chrome.debugger` mock in `chrome-extension/__tests__/setup.ts` (`attach/detach/sendCommand` jest.fn) — assert `Input.dispatchMouseEvent`/`insertText` sendCommand calls and refcount attach/detach behavior (attach shared with a simulated network-capture purpose; no premature detach). Firefox `engine:"cdp"` → assert the "unsupported on Firefox" error.
- **CSP-strict custom-React target (required deliverable):** add a fixture page under a test-fixtures dir served locally — a Vite/React page with `Content-Security-Policy: script-src 'self'` (no `unsafe-inline`), a `<div contenteditable>` chat input, a `<div onClick>` "Open" card with no role, and a tall inner-scroll panel + a 700-item sidebar. Assertions: (a) `evaluate-script world:"isolated"` succeeds where `world:"main"` returns the CSP hint; (b) snapshot `textContains:"Open"` and `selector:'[contenteditable]'` return usable uids; (c) `rootSelector` on the main panel excludes the sidebar and lifts truncation; (d) coordinate tools (synthetic engine) target the contenteditable and the card via `elementFromPoint`; (e) `scroll-at` scrolls the inner panel, not the window. The CDP-trusted effect can't run in headless CI → assert the *dispatch* (sendCommand calls), not the OS/renderer effect.

---

## 7. Documentation (mcpkit skill)

Update the `mcpkit-foxpilot` skill (and the FoxPilot tool docs) with an entry per new tool + the new params on `take-snapshot`, `evaluate-script`, `get-cookies`, `get-network-requests`, `wait-for-text`. Each entry: purpose, params, when to reach for it (esp. coordinate tools = "a11y tree failed you"), the `engine` param (default `synthetic`/covert; `cdp` = trusted-but-banner, Chrome-only), and the `world:"isolated"` CSP-escape recipe. No sidecar/cursor prerequisites to document — the default path needs none.

---

## 8. Rollout / phasing

Phased so the bulk of the value lands **without touching the debugger** (covert-safe), and the opt-in trusted tier is isolated last.

- **Phase 0:** branch `feat/spa-interaction` off `origin/main`.
- **Phase 1 (covert-safe, isolated-world/schema only):** #7 wait-for-text array; #5 `get-cookies names[]`; #2 snapshot `includePointer` promotion + `selector`/`textContains`; #3 `rootSelector`/`offset`/`limit`. High value, low risk, no debugger.
- **Phase 2 (still covert-safe):** #4 isolated-world `evaluate-script` (`world` param); #6 scroll-to / scroll-into-view / scroll-at + screenshot stitch hardening; #1 coordinate tools on the **synthetic** engine (isolated-world `elementFromPoint` + existing action sequences) + `point-action-result` element descriptor.
- **Phase 3 (opt-in, not covert):** #1 `engine:"cdp"` trusted tier on Chrome (`Input.*` + debugger refcount); #5 `includeCredentials` un-redact. Both default off. No sidecar work.
- **Phase 4:** CSP-strict React fixture + full test pass; mcpkit skill docs; changelog.

Each phase is independently shippable and reviewable (subagent-driven implementation per project convention). Note #1 now spans Phase 2 (synthetic, the default that ships value immediately) and Phase 3 (the optional trusted tier).

---

## 9. Open decisions flagged for review

1. **§3 CDP banner** — confirm the opt-in `engine:"cdp"` tier (debugger banner) is worth building, or drop CDP and ship **synthetic-only** for the `-at` tools. (Cursor sidecar already ruled out.)
2. **Firefox strict-editor typing** — accept the documented Firefox gap (synthetic-only, may be ignored by rich-text editors), given no sidecar and no CDP there?
3. **§4.D page-var CDP eval** — build the `world:"main"+engine:"cdp"` Runtime.evaluate tier now, or defer (YAGNI)? Only matters if you need to read page-JS variables on a strict-CSP page.
4. **§4.E `includeCredentials`** — do you actually want raw `Cookie`/`Authorization` values surfaced in `get-network-requests` (given `get-cookies` already exposes cookie values)?
5. **Snapshot query mode surface** — extend `take-snapshot` with `selector`/`textContains` (chosen), or add a separate `query-dom` tool?
6. **§4.A default engine** — confirm `synthetic` as the default (covert; upgrade to `cdp` per-call when needed), not `cdp`-by-default.
7. **`take-snapshot` defaults** — is `includePointer` defaulting **true** acceptable (slightly larger snapshots, catches React `onClick` divs), or default false to preserve exact current output?

---

## 10. Backward-compatibility summary

- No existing tool loses a param or changes default behavior. New params are optional; new response fields are append-only.
- `wait-for-text` still accepts a plain string.
- `evaluate-script` still defaults to `world:"main"` (current behavior).
- `take-snapshot` output format per line is unchanged; only an append-only metadata header and (default-on) additional pointer matches differ — §9.7 lets you make even that opt-in.
- No new **required** manifest permission (`debugger`, `cookies`, `scripting`, `webRequest`, `declarativeNetRequest` all already present). The `debugger` permission is only *used* by the opt-in `engine:"cdp"` tier.
- No cursor sidecar, no OS accessibility permission, no extra process for the default path.
