# FoxPilot Cloudflare-flow Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix seven defects that break FoxPilot on complex SPA sites (the Cloudflare dashboard token-creation flow): content-script readiness after navigation, navigation settling + real settled URL, snapshot enrichment, a custom-dropdown `select-option` action, overlay interception detection + a `dismiss-overlays` tool, structured `evaluate-script` output, and a local-toolchain-noise investigation.

**Architecture:** Changes span the MCP server (`mcp-server/`), both browser extensions (`chrome-extension/` MV3 + `firefox-extension/` MV2), the shared message types (`common/`), and a new Playwright-driven browser fixture. Injected page code is mirrored **byte-identically** between the two extensions; background/handler code is **structurally mirrored** with the `chrome`/`browser` global swap. Work is organized into dependency-ordered waves executed by parallel implementers on disjoint files, with one final review pass.

**Tech Stack:** TypeScript throughout; esbuild bundling; Jest (jsdom for extensions, node for mcp-server); **Playwright** (new — Chromium, for the browser fixture); Nx monorepo; MCP SDK; Zod 4.3.6.

**Source spec:** `docs/superpowers/specs/2026-07-08-foxpilot-cloudflare-fixes-design.md` (committed `c5d42d8`).

## Global Constraints

Every task's requirements implicitly include this section.

- **No new browser permissions / no manifest changes.** `tabs`, `scripting`, `webRequest`, `cookies`, `declarativeNetRequest`, `debugger`, `activeTab` already exist in `chrome-extension/manifest.json`; `tabs`, `webRequest` in `firefox-extension/manifest.json`. Adding no permission → no new Chrome Web Store review scope (release workflow fires CWS review on every push to `main`).
- **Byte-identical injected code.** Any edit to an `injected/*` module body (or code past `export function`) must stay byte-identical between `chrome-extension/injected/*` and `firefox-extension/injected/*`. Header/doc-comment lines may diverge. **New injected functions MUST be added to `firefox-extension/__tests__/self-containment.test.ts` `INJECTED_FUNCTIONS` (`:68-77`) and contain none of its `FORBIDDEN_TOKENS` (`:57-66`: `require(`, `import `, `exports.`, `module.exports`, `__name`, `__commonJS`, `__toESM`, `__require`).** Practical rule: implement all helpers as **inner functions** inside the exported injected function (Firefox stringifies via `.toString()` — no module refs survive).
- **Background helpers may diverge** by the `chrome`/`browser` global + MV3/MV2 API only (the `nav-race.ts` convention) — they live in the extension layer, never in `common/` (which holds pure TS types, no `browser`/`chrome` calls).
- **Two compile-time tripwires** guard any new `cmd`: the `switch(req.cmd)` `_exhaustiveCheck: never` default (`firefox-extension/message-handler.ts:489-491`, `chrome-extension/message-handler.ts:478-479`) and `COMMAND_TO_TOOL_ID: Record<ServerMessageRequest["cmd"], string>` (`extension-config.ts:230`, both). A new cmd fails compilation until a `case` + a map entry exist in **both** extensions.
- **Additive-first.** Only three intentional behavior changes (all user-approved): the snapshot line grammar (Wave 2), the eval-script text shape (Wave 4), and `navigate-tab` returning the accurate URL (Wave 1, same message shape, `waitUntil:"none"` escape). Everything else is new tools / optional params / additive result fields.
- **Zod 4.3.6 gotcha:** `z.record(z.string())` infers `Record<string, unknown>`. For `Record<string,string>` use the **two-arg** form `z.record(z.string(), z.string())`. (Only relevant if a new param is a string map — none currently are, but honor it if added.)
- **Manual-verify ritual after any server rebuild:** `cd mcp-server && npm run build` → `mcpkit runtime stop foxpilot` (bounce the persistent runtime; NEVER `pkill` its child `dist/server.js`) → **reload/reinstall the extension** (an already-loaded extension runs OLD code; for Chrome, `npm run package --prefix chrome-extension` then load `chrome-extension/web-ext-artifacts/chrome-unpacked`). The broker (`dist/broker-main.js`) stays up across the bounce.

---

## Shared Contracts / Interfaces

**These names and types are authoritative. Every task uses them verbatim.** Where a contract extends an existing type, confirm the existing interface name against source and add fields **additively** (do not reorder existing fields).

### `common/server-messages.ts`

Extend existing `NavigateTabServerMessage` (confirm name; it has `cmd:"navigate-tab"; tabId; url`):
```ts
export interface NavigateTabServerMessage {
  cmd: "navigate-tab";
  tabId: number;
  url: string;
  // NEW — all optional, additive:
  waitUntil?: "complete" | "none";   // default "complete"
  waitForSelector?: string;
  waitForText?: string;
  waitForUrl?: string;               // substring match against the settled URL
  forceLoad?: boolean;
  timeoutMs?: number;                // overall settle+condition budget; clamp to < 30000
}
```

Extend the existing **click-element** server message (confirm its interface name in source, e.g. `ClickElementServerMessage`) with one optional field:
```ts
  failIfIntercepted?: boolean;       // NEW, optional, default false
```

Add two new cmds and add both to the `ServerMessage` union:
```ts
export interface SelectOptionServerMessage {
  cmd: "select-option";
  tabId: number;
  uid: string;
  option: string;                    // desired visible option text
  exact?: boolean;                   // default false → normalized (trim/lowercase) substring match
}
export interface DismissOverlaysServerMessage {
  cmd: "dismiss-overlays";
  tabId: number;
}
```

### `common/extension-messages.ts`

Extend existing `ActionResultExtensionMessage` with additive optionals (`navigated?` already exists — keep it; do not reorder):
```ts
  intercepted?: { tag: string; id?: string; classes?: string; role?: string; name?: string }; // NEW
  selected?: string;                 // NEW — select-option's resulting displayed value
  dismissed?: string[];              // NEW — dismiss-overlays: identifiers of what was dismissed
  method?: "reject" | "remove";      // NEW — dismiss-overlays method used
```
**Both `select-option` and `dismiss-overlays` reply with `resource:"action-result"` (reuse `ActionResultExtensionMessage`).** No new reply type, no new extension-messages union member.

### New cmd wiring — do in BOTH extensions

For each new cmd (`select-option`, `dismiss-overlays`):
- `message-handler.ts`: a `case "<cmd>":` in `switch(req.cmd)` calling a new handler method; the `_exhaustiveCheck: never` default is satisfied once both cases exist.
- `extension-config.ts`:
  - `COMMAND_TO_TOOL_ID["select-option"] = "select-option"` and `["dismiss-overlays"] = "dismiss-overlays"` (KEBAB — source-verified; the tool id equals the cmd string).
  - Add both cmds to `AUTOMATION_COMMANDS` (they control a page).
  - Add both tool ids to `AVAILABLE_TOOLS`, shaped `{ id, name, description }` (source-verified `ToolInfo`; default-enabled is derived all-true), e.g. `{ id: "select-option", name: "Select Option", description: "…" }`.

### New injected functions

`injected/select-option-script.ts` — NEW, byte-identical body both extensions:
```ts
export async function selectOption(
  doc: Document,
  args: { uid: string; option: string; exact?: boolean }
): Promise<{ ok: boolean; selected?: string; error?: string }>;
```
Self-contained: inline resolve-by-uid (`doc.querySelector('[data-bcmcp-uid="'+uid+'"]')`), a click sequence (pointerdown/mousedown/mouseup/focus/click), native `<select>` handling (`.value=` + `change`), a search-input typing helper (native-setter + `input`), leaf-text option matching, and a bounded poll (`await new Promise(r => setTimeout(r, 300))`, ≤ ~15 iterations).

`injected/dismiss-overlays-script.ts` — NEW, byte-identical both:
```ts
export function dismissOverlays(
  doc: Document
): { ok: boolean; dismissed: string[]; method?: "reject" | "remove"; error?: string };
```

Interception — MODIFY existing `performInputAction` in `injected/action-script.ts` (both, byte-identical). In the `"click"` arm, before dispatch: compute target center via `getBoundingClientRect`, call `doc.elementFromPoint(cx, cy)`, and use a pure inner helper `classifyHit(target, topmost)` → `"self" | "ancestor" | "descendant" | "unrelated"`. If `"unrelated"`, set `intercepted` (lightweight `{tag,id?,classes?,role?,name?}`) on the result. Still dispatch + return `ok:true` UNLESS `args.failIfIntercepted === true`, in which case return `ok:false, intercepted, error:"click intercepted by <selector>"`. Thread `failIfIntercepted` from the click-element cmd → `runInputAction` → `performInputAction` args. `classifyHit` MUST be a pure helper (no `elementFromPoint` inside it) so jsdom tests call it with fabricated nodes.

Add `selectOption` and `dismissOverlays` to `firefox-extension/__tests__/self-containment.test.ts` `INJECTED_FUNCTIONS`.

### New background helper

`nav-ready.ts` — NEW per extension; structurally mirrored (`chrome`/`browser` + MV3/MV2 swap only):
```ts
export async function waitForTabReady(
  tabId: number,
  opts?: { timeoutMs?: number }
): Promise<void>;
```
Resolves when the tab reaches `status:"complete"` AND the content script is confirmed live (Chrome: inject `dist/content-script.js`, then `{type:"ping"}` → `{ok:true}` from the existing `content-script.ts:274-276` responder; Firefox: `executeScript({code:"1"})` probe), OR when `timeoutMs` elapses. **Never rejects on timeout** — resolves best-effort so the caller proceeds. Default `timeoutMs` ~8000, clamped under the 30s navigate budget.

### New server module

`mcp-server/eval-format.ts`:
```ts
export function formatEvalResult(
  value: unknown
): { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> };
```
- `typeof value === "string"` → `{ content:[{type:"text", text: value}] }` (raw, unquoted).
- else → `{ content:[{type:"text", text: JSON.stringify(value, null, 2)}] }` (with a `?? String(value)` guard so `undefined` renders `"undefined"`).
- Set `structuredContent: value` **only when `value` is a non-null, non-array object** (SDK `@modelcontextprotocol/sdk` 1.29.0 types `CallToolResult.structuredContent` as `Record<string, unknown>`; a schema-less tool passes it through un-validated). Strings/numbers/booleans/null/arrays carry in the text block alone.
The `evaluate-script` handler (`server.ts:599-610`) calls `formatEvalResult(value)` in place of the inline `JSON.stringify(value)`.

### Fixture + Playwright

`test-fixtures/spa-widgets/` — vanilla JS, zero-dep, `node:http` server mirroring `test-fixtures/csp-react-spa/server.mjs`. Files: `server.mjs`, `index.html`, `app.js`. Bundles: (a) react-select-style searchable **portal** dropdown (`div[role=combobox]` + portal `[role=option]` menu + search `<input>` + `singleValue`/`placeholder` children); (b) fixed full-screen OneTrust-like overlay (`#onetrust-banner-sdk`, reject `#onetrust-reject-all-handler`) that **re-mounts on a `pushState` route change**; (c) several identically-labeled "Use template" buttons inside titled cards; (d) SPA `pushState` routing incl. a link that lands elsewhere. Playwright config lives in a dedicated dir with its **own `npm run test:e2e` script — NOT wired into `release.yml` or any per-project `jest`**.

---

## File Structure

| File | Responsibility | Wave |
|---|---|---|
| `test-fixtures/spa-widgets/{server.mjs,index.html,app.js}` | Manual + Playwright fixture bundling all four Cloudflare-like hazards | 0 |
| `e2e/playwright.config.ts`, `e2e/*.spec.ts` | Real-browser regression for geometry/routing/portal behaviors | 0, threaded |
| `{chrome,firefox}-extension/nav-ready.ts` | `waitForTabReady` background helper | 1 |
| `{chrome,firefox}-extension/message-handler.ts` | navigate settle+finalUrl+waits; `sendMessageToTab` harden; new cmd cases | 1, 3 |
| `chrome-extension/content-script.ts` | ping readiness (repurpose dead responder) | 1 |
| `mcp-server/server.ts` | navigate-tab params/output; new tools; click-element intercept output; eval-format call | 1, 3, 4 |
| `mcp-server/browser-api.ts` | new tool methods; navigate/eval signatures | 1, 3, 4 |
| `common/server-messages.ts`, `common/extension-messages.ts` | message types + additive fields | 1, 3 |
| `mcp-server/timeouts.ts` | timeout entries if a new cmd needs one | 1, 3 |
| `{chrome,firefox}-extension/injected/snapshot-script.ts` | 3-slot grammar; `getCurrentValue`; `getSection`; react-select probes; shared `makeRow` | 2 |
| `{chrome,firefox}-extension/injected/action-script.ts` | interception detection in click arm | 3a |
| `{chrome,firefox}-extension/injected/select-option-script.ts` | `selectOption` injected fn | 3b |
| `{chrome,firefox}-extension/injected/dismiss-overlays-script.ts` | `dismissOverlays` injected fn | 3b |
| `{chrome,firefox}-extension/extension-config.ts` | `COMMAND_TO_TOOL_ID`, `AUTOMATION_COMMANDS`, `AVAILABLE_TOOLS` for new cmds | 3b |
| `mcp-server/eval-format.ts` | structured eval result formatter | 4 |
| `firefox-extension/__tests__/self-containment.test.ts` | register new injected fns | 2, 3b |
| `{chrome,firefox}-extension/__tests__/*.test.ts`, `mcp-server/__tests__/*.test.ts` | unit tests per task | all |
| `CLAUDE.md` | new tools/params + xcode note | 4 |

---

## Waves — execution & reconciliation notes

**Task numbering** is wave-blocked with reserved gaps between waves (Wave 0–1: Tasks 1–8; Wave 2: 11–15; Wave 3a: 21–23; Wave 3b: 26–30; Wave 4: 36–38). Gaps are intentional — there are no missing tasks, and each wave's internal cross-references use these numbers.

**Execution order & parallelism (wave mode):**
- **Wave 0 (Tasks 1–2) first** — the fixture + Playwright harness are consumed by later waves' e2e specs.
- **Wave 1 (3–8), Wave 2 (11–15), Wave 4 (36–38)** touch disjoint files and may run as parallel implementers after Wave 0.
- **Wave 3a (21–23) then Wave 3b (26–30):** both co-edit `common/extension-messages.ts` (`ActionResultExtensionMessage`, append-only) and edit different regions of `message-handler.ts`/`server.ts`. Run 3a before 3b so the additive field order is deterministic (3a appends `intercepted?`; 3b appends `selected?`/`dismissed?`/`method?`). They may parallelize with a merge checkpoint on `extension-messages.ts`.
- **One final consolidated review pass** at the end (spec + quality), not per-task — the v1.0.14 wave-mode discipline. See "Final review pass" at the end of this plan.

**Reconciliations applied (drafters vs the scaffold contract) — the following are authoritative:**
- **Tool-ids are KEBAB.** `COMMAND_TO_TOOL_ID["select-option"] = "select-option"`, `["dismiss-overlays"] = "dismiss-overlays"` (source-verified; supersedes any camelCase note). `AVAILABLE_TOOLS` entries are shaped `{ id, name, description }` (default-enabled is derived, all-true) — not `{label, default-enabled}`.
- **`formatEvalResult` returns `structuredContent?: Record<string, unknown>`** and sets it **only for non-null, non-array objects** (SDK `@modelcontextprotocol/sdk` 1.29.0 types `CallToolResult.structuredContent` as `Record<string, unknown>`; a schema-less tool passes it through un-validated). Strings/numbers/booleans/null/arrays ride in the text block alone.
- **`ActionResultExtensionMessage.intercepted` is the FLAT shape** `{ tag; id?; classes?; role?; name? }` (supersedes spec §E(a)'s nested `{ by: … }`). `classes` is the space-joined class string.
- **`navigate-tab` waitFor* mismatch** is surfaced by suffixing the returned `url` (`<finalUrl> — expected "x" not found`), which the server prints verbatim — honoring spec §B's "no message-type change." No new field on `NavigatedExtensionMessage`.
- **`chrome-extension/content-script.ts` needs NO code edit for Wave 1** — the `case "ping"` responder + async-channel `return true` already exist; Task 5 verifies via grep.

**Accepted scope boundaries (documented, deliberate):**
- **Firefox has no single `sendMessageToTab` choke point** — it stringify-injects per DOM call, so it re-establishes the isolated world every call (inherently less prone to the Chrome "Receiving end does not exist" staleness). Wave 1 delivers `waitForTabReady` + `execWithReadyRetry` for the primary post-nav case; broad migration of Firefox's other ~16 `executeScript` call sites to the retry helper is a **deferred follow-up** (would collide with Waves 2/3, which edit those handlers).
- **`dismiss-overlays` is synchronous and not nav-raced** (matches the spec's sync contract). A consent SDK that navigates on reject is a cheap follow-up (wrap in `raceInputAgainstNavigation`).
- **Item 7 (Xcode line) is expected to be documentation-only.** A code change is gated on the plan's smoke check proving a real stdout leak (server runs esbuild bundles with no startup native build; sidecar/broker spawn detached `stdio:"ignore"`; stdout is owned by `StdioServerTransport`).

---


<!-- ============================================================= -->
<!-- WAVE 0 + WAVE 1 — inserted at the scaffold's                    -->
<!-- <!-- WAVES INSERTED BELOW --> marker. Task numbering starts at  -->
<!-- Task 1; sibling sections (Waves 2-4) continue the sequence.     -->
<!-- ============================================================= -->

## Wave 0 — Fixture + Playwright harness

**Outcome:** A vanilla-JS, zero-dependency fixture (`test-fixtures/spa-widgets/`) that reproduces all four Cloudflare-dashboard hazards (react-select portal dropdown, re-mounting OneTrust overlay, repeated "Use template" buttons in titled cards, `pushState` SPA routing that lands elsewhere), plus a dedicated `e2e/` Playwright project with its **own** `npm run test:e2e` script and ONE smoke spec. Playwright is **NOT** wired into `release.yml`, `postinstall`, `nx`, or any per-project `jest`, so releases stay green. Later waves thread deeper `.spec.ts` files into this same harness.

---

### Task 1: Fixture `test-fixtures/spa-widgets/{server.mjs,index.html,app.js}`

**Files:**
- Create: `test-fixtures/spa-widgets/server.mjs` (mirrors `test-fixtures/csp-react-spa/server.mjs`, minus the strict-CSP header, plus an SPA-fallback so deep `pushState` routes load)
- Create: `test-fixtures/spa-widgets/index.html`
- Create: `test-fixtures/spa-widgets/app.js`
- Verify: node boot + `curl` (no jest — this is a static fixture; the Playwright smoke spec in Task 2 is its automated gate)

**Interfaces:**
- Produces (stable selectors later waves target): `#country-select` (`div[role="combobox"]` with `.rs__placeholder` "Select..." and `.rs__single-value` children); portal menu `.rs__menu[role="listbox"]` with `.rs__input` search box and `[role="option"]` items appended to `document.body`; `#onetrust-banner-sdk` (fixed full-screen `[role="dialog"][aria-modal="true"]`) with reject `#onetrust-reject-all-handler` + accept `#onetrust-accept-btn-handler`, re-mounted by `mountOverlay()` on every route render; ≥3 `<section class="card">` each with an `<h3>` title and an identically-labelled `<button>Use template</button>`; nav links `#link-home` / `#link-templates` where `/templates` deliberately lands on `/home`.

- [ ] **Step 1: Create `test-fixtures/spa-widgets/server.mjs`** (zero-dep static server; SPA fallback):

```js
// Minimal static file server for the SPA-widgets fixture. Mirrors
// test-fixtures/csp-react-spa/server.mjs (zero-dependency node:http static
// server) but WITHOUT the strict-CSP header — this fixture exercises portal
// dropdowns, a re-mounting consent overlay, repeated buttons, and pushState
// routing, none of which depend on CSP. Unknown (extension-less) paths fall back
// to index.html so client-side deep routes load. Run: `node server.mjs [port]`
// (default 878).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.argv[2] || process.env.FIXTURE_PORT || 878);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  // SPA fallback: serve index.html for "/" and any path without a known asset
  // extension so client-side pushState deep routes (/home, /templates) resolve.
  let rel;
  if (urlPath === "/") {
    rel = "index.html";
  } else if (/\.(html|js|css)$/.test(urlPath)) {
    rel = urlPath.replace(/^\/+/, "");
  } else {
    rel = "index.html";
  }
  const filePath = normalize(join(ROOT, rel));
  // Contain path traversal to the fixture root.
  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.setHeader(
      "Content-Type",
      TYPES[extname(filePath)] || "application/octet-stream"
    );
    res.statusCode = 200;
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`SPA-widgets fixture on http://localhost:${PORT}/`);
});
```

- [ ] **Step 2: Create `test-fixtures/spa-widgets/index.html`** (shell + styles; the full-screen fixed overlay style is the interception hazard):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SPA widgets fixture</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; font-family: system-ui, sans-serif; }
      #app { padding: 16px; }
      #nav a { margin-right: 12px; }
      .card { border: 1px solid #ccc; border-radius: 8px; padding: 12px; margin: 8px 0; }
      .rs__control { border: 1px solid #999; border-radius: 6px; padding: 8px; min-width: 220px; cursor: pointer; display: inline-block; }
      .rs__menu { background: #fff; border: 1px solid #999; border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.2); z-index: 2000; }
      .rs__input { width: 100%; box-sizing: border-box; padding: 6px; }
      .rs__option { padding: 6px 8px; cursor: pointer; }
      .rs__option:hover { background: #eef; }
      /* Full-screen fixed consent overlay — the click-interception hazard. */
      #onetrust-banner-sdk {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,.55); color: #fff;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 12px;
      }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script src="app.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `test-fixtures/spa-widgets/app.js`** (all four hazards):

```js
// Renders the four Cloudflare-dashboard hazards for the injected-tool tests:
// (a) a react-select-style searchable PORTAL dropdown, (b) a fixed full-screen
// OneTrust-like consent overlay that RE-MOUNTS on every pushState route change,
// (c) several identically-labelled "Use template" buttons inside titled cards,
// (d) pushState SPA routing where /templates deliberately lands on /home.
(function () {
  var COUNTRIES = ["France", "Germany", "India", "Japan", "Spain", "United States"];

  // ---- (c) Repeated "Use template" buttons inside titled cards ----
  function renderCards(container) {
    ["Starter", "Pro", "Enterprise"].forEach(function (title) {
      var card = document.createElement("section");
      card.className = "card";
      var h = document.createElement("h3");
      h.textContent = title;
      var p = document.createElement("p");
      p.textContent = title + " plan template.";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Use template"; // identical label across every card
      btn.addEventListener("click", function () {
        document.getElementById("log").textContent = "Chose " + title;
      });
      card.appendChild(h);
      card.appendChild(p);
      card.appendChild(btn);
      container.appendChild(card);
    });
  }

  // ---- (a) react-select-style searchable PORTAL dropdown ----
  function renderSelect(container) {
    var control = document.createElement("div");
    control.id = "country-select";
    control.className = "rs__control";
    control.setAttribute("role", "combobox");
    control.setAttribute("aria-expanded", "false");
    control.setAttribute("aria-label", "Country");
    control.tabIndex = 0;

    var placeholder = document.createElement("div");
    placeholder.className = "rs__placeholder";
    placeholder.textContent = "Select...";

    var single = document.createElement("div");
    single.className = "rs__single-value";
    single.style.display = "none"; // revealed once a value is chosen

    control.appendChild(placeholder);
    control.appendChild(single);
    container.appendChild(control);

    var menu = null;
    function closeMenu() {
      if (menu) { menu.remove(); menu = null; }
      control.setAttribute("aria-expanded", "false");
    }
    function choose(value) {
      single.textContent = value;
      single.style.display = "";
      placeholder.style.display = "none";
      closeMenu();
    }
    function openMenu() {
      if (menu) return;
      control.setAttribute("aria-expanded", "true");
      // Portal: appended to <body>, NOT inside the control — react-select shape.
      menu = document.createElement("div");
      menu.className = "rs__menu";
      menu.setAttribute("role", "listbox");
      var search = document.createElement("input");
      search.className = "rs__input";
      search.type = "text";
      search.setAttribute("aria-label", "Search country");
      var list = document.createElement("div");
      list.className = "rs__options";
      menu.appendChild(search);
      menu.appendChild(list);
      function paint(filter) {
        list.textContent = "";
        COUNTRIES.filter(function (c) {
          return c.toLowerCase().indexOf((filter || "").toLowerCase()) !== -1;
        }).forEach(function (c) {
          var opt = document.createElement("div");
          opt.setAttribute("role", "option");
          opt.className = "rs__option";
          opt.textContent = c;
          opt.addEventListener("click", function () { choose(c); });
          list.appendChild(opt);
        });
      }
      paint("");
      search.addEventListener("input", function () { paint(search.value); });
      var r = control.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.left = r.left + "px";
      menu.style.top = r.bottom + "px";
      menu.style.width = Math.max(r.width, 220) + "px";
      document.body.appendChild(menu);
      search.focus();
    }
    control.addEventListener("click", function () {
      if (menu) closeMenu(); else openMenu();
    });
  }

  // ---- (b) OneTrust-like full-screen overlay; re-mounts on every route ----
  function mountOverlay() {
    if (document.getElementById("onetrust-banner-sdk")) return;
    var overlay = document.createElement("div");
    overlay.id = "onetrust-banner-sdk";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    var msg = document.createElement("p");
    msg.textContent = "We use cookies.";
    var reject = document.createElement("button");
    reject.id = "onetrust-reject-all-handler";
    reject.type = "button";
    reject.textContent = "Reject All";
    reject.addEventListener("click", function () { overlay.remove(); });
    var accept = document.createElement("button");
    accept.id = "onetrust-accept-btn-handler";
    accept.type = "button";
    accept.textContent = "Accept All";
    accept.addEventListener("click", function () { overlay.remove(); });
    overlay.appendChild(msg);
    overlay.appendChild(reject);
    overlay.appendChild(accept);
    document.body.appendChild(overlay);
  }

  // ---- (d) pushState routing; /templates deliberately lands on /home ----
  function renderRoute() {
    var view = document.getElementById("view");
    view.textContent = "";
    var title = document.createElement("h2");
    title.textContent = "Route: " + location.pathname;
    view.appendChild(title);
    renderCards(view);
    renderSelect(view);
    mountOverlay(); // every (re)render re-mounts the consent overlay
  }
  function navigate(to) {
    // The router intercepts /templates and "lands elsewhere" (/home) — the
    // navigate-tab false-success hazard.
    var landing = to === "/templates" ? "/home" : to;
    history.pushState({}, "", landing);
    renderRoute();
  }

  var root = document.getElementById("app");
  root.innerHTML =
    '<nav id="nav">' +
    '<a href="#" data-to="/home" id="link-home">Home</a>' +
    '<a href="#" data-to="/templates" id="link-templates">Templates</a>' +
    "</nav>" +
    '<main id="view"></main>' +
    '<div id="log"></div>';
  Array.prototype.forEach.call(
    root.querySelectorAll("a[data-to]"),
    function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        navigate(a.getAttribute("data-to"));
      });
    }
  );
  window.addEventListener("popstate", renderRoute);
  renderRoute();
})();
```

- [ ] **Step 4: Verify the fixture boots and serves the hazards** — run the server and curl the HTML (this is the pre-Playwright sanity check; expected: HTTP 200 and the shell markup present):

```
node test-fixtures/spa-widgets/server.mjs 878 &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:878/        # expect 200
curl -s http://localhost:878/ | grep -q 'id="app"' && echo "shell OK"   # expect "shell OK"
curl -s http://localhost:878/app.js | grep -q "onetrust-banner-sdk" && echo "app OK"  # expect "app OK"
kill %1
```

- [ ] **Step 5: Commit** — `git add test-fixtures/spa-widgets && git commit -m "test(fixture): spa-widgets fixture (portal dropdown, re-mounting overlay, repeated buttons, pushState routing)"`

---

### Task 2: `e2e/` Playwright harness + smoke spec (off the release path)

**Files:**
- Create: `e2e/package.json` (own devDependency on `@playwright/test`; own `test`/`test:e2e` scripts — its `npm install` is NEVER triggered by the root `postinstall`)
- Create: `e2e/playwright.config.ts` (boots `../test-fixtures/spa-widgets/server.mjs` via `webServer`)
- Create: `e2e/smoke.spec.ts` (ONE smoke test)
- Modify: `package.json` (root) — add a convenience `test:e2e` script delegating to the `e2e/` package (does NOT add `e2e` to `postinstall` or `build`)
- Create: `e2e/.gitignore` (ignore `node_modules`, `test-results`, `playwright-report`)

**Interfaces:**
- Consumes: the Task-1 fixture at `test-fixtures/spa-widgets/`.
- Produces: `npm run test:e2e` (root) → `npm --prefix e2e test` → `playwright test` in `e2e/`. **Not referenced by `release.yml`, `nx`, or any `jest.config`.**

- [ ] **Step 1: Create `e2e/package.json`:**

```json
{
  "name": "foxpilot-e2e",
  "private": true,
  "version": "0.0.0",
  "description": "Playwright real-browser regression for FoxPilot injected tools against the spa-widgets fixture. Intentionally SEPARATE from the release-blocking jest path — not built by nx, not installed by the root postinstall, not run in release.yml.",
  "scripts": {
    "test": "playwright test",
    "test:e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0"
  }
}
```

- [ ] **Step 2: Create `e2e/playwright.config.ts`** (the `webServer` block is what "boots server.mjs"):

```ts
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.FIXTURE_PORT || 878);

// Real-browser (Chromium) regression harness for the spa-widgets fixture. This
// project is deliberately outside the release-blocking test path (npm/jest/nx);
// run it locally with `npm run test:e2e`. `webServer` boots the zero-dep fixture
// server and tears it down when the run ends.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  fullyParallel: true,
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `node ../test-fixtures/spa-widgets/server.mjs ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 10_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
```

- [ ] **Step 3: Write the smoke spec** `e2e/smoke.spec.ts` (the ONE spec — boots via `webServer`, asserts the fixture + all four hazards load):

```ts
import { test, expect } from "@playwright/test";

test("spa-widgets fixture loads with all four hazards present", async ({ page }) => {
  await page.goto("/");

  // (a) react-select-style combobox is present with its placeholder.
  await expect(page.locator("#country-select")).toBeVisible();
  await expect(page.locator("#country-select .rs__placeholder")).toHaveText("Select...");

  // (b) OneTrust-like consent overlay is mounted with a reject control.
  await expect(page.locator("#onetrust-banner-sdk")).toBeVisible();
  await expect(page.locator("#onetrust-reject-all-handler")).toBeVisible();

  // (c) Several identically-labelled "Use template" buttons in titled cards.
  const useTemplate = page.getByRole("button", { name: "Use template" });
  expect(await useTemplate.count()).toBeGreaterThan(1);

  // (d) pushState routing links exist.
  await expect(page.locator("#link-templates")).toBeVisible();
});
```

- [ ] **Step 4: Create `e2e/.gitignore`:**

```
node_modules/
test-results/
playwright-report/
```

- [ ] **Step 5: Add the root convenience script** — edit `package.json` (root) `scripts` (leave `postinstall` and `build` untouched — do NOT add `e2e` to either):

```json
  "scripts": {
    "postinstall": "npm install --prefix mcp-server && npm install --prefix firefox-extension && npm install --prefix chrome-extension && npm install --prefix input-sidecar",
    "build": "nx run-many --target=build --all --parallel",
    "test:e2e": "npm --prefix e2e install && npm --prefix e2e test"
  },
```

- [ ] **Step 6: Install Playwright + the Chromium browser (one-time, local — NOT in CI)** — the exact commands:

```
cd e2e
npm install -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 7: Run the smoke spec, confirm PASS** — from the repo root:

```
npm run test:e2e
```

Expected: Playwright boots `server.mjs` on 878, runs `smoke.spec.ts`, and reports `1 passed`. (If run before Step 6, it FAILS with `Cannot find module '@playwright/test'` — that failing state is the pre-implementation red.)

- [ ] **Step 8: Confirm Playwright is OFF the release path** — grep proves no coupling:

```
grep -R "playwright\|test:e2e\|e2e/" .github/workflows/release.yml   # expect: no matches
grep -R "playwright" chrome-extension/jest.config.js firefox-extension/jest.config.js mcp-server/jest.config.js 2>/dev/null  # expect: no matches
```

- [ ] **Step 9: Commit** — `git add e2e package.json && git commit -m "test(e2e): playwright harness + smoke spec off the release path (own test:e2e script)"`

---

## Wave 1 — Content-script readiness + navigate-tab settle (spec items 1 & 2)

**Outcome:** After a navigation or SPA route change the next DOM tool no longer runs mid-nav: `navigate-tab` settles on `status:"complete"` + a live content-script probe (`waitForTabReady`) and returns the **real** final URL (`tabs.get(...).url`), with optional `waitUntil`/`waitForSelector`/`waitForText`/`waitForUrl`/`forceLoad`/`timeoutMs` and an honest mismatch report. Chrome's central `sendMessageToTab` self-heals once (re-read live url → re-check permission for the CURRENT origin → wait-ready → re-inject → retry) on an injection/permission failure; Firefox gets the analogous single re-probe-and-retry helper. All additive except the accurate-URL change (which the spec/user approved; `waitUntil:"none"` restores fire-and-forget).

**Wave-1 file-ownership note (avoid collisions):** Task 3 owns `common/` + `mcp-server/`; Tasks 4-5 own the two new `nav-ready.ts`; Task 6 owns the Chrome `sendMessageToTab` region of `chrome-extension/message-handler.ts`; Task 7 owns the Chrome `navigateTab` region + its dispatch case; Task 8 owns the Firefox `navigateTab` region + its dispatch case + wiring `execWithReadyRetry`. Tasks 6 and 7 touch the same file in **non-overlapping** regions (function at `:97-120` vs `:1352-1370`+dispatch `:260-262`) — sequence 6 → 7 to be safe.

---

### Task 3: `navigate-tab` optional params — types + server surface

**Files:**
- Modify: `common/server-messages.ts:62-66` (`NavigateTabServerMessage` — add 6 optional fields, verbatim from the Shared Contracts)
- Modify: `mcp-server/server.ts:245-260` (navigate-tab tool: extend zod schema, thread params into `browserApi.navigateTab`; output line **unchanged** — it already prints `result.url ?? url`)
- Modify: `mcp-server/browser-api.ts:461-470` (`navigateTab` — add an `opts` arg, spread into the message like `takeSnapshot`)
- Test: `mcp-server/__tests__/navigate-tab-args.test.ts` (NEW — broker round-trip, mirrors `take-snapshot-args.test.ts`)

**Interfaces:**
- Produces:
  - `NavigateTabServerMessage.{ waitUntil?: "complete" | "none"; waitForSelector?: string; waitForText?: string; waitForUrl?: string; forceLoad?: boolean; timeoutMs?: number }` (all optional, additive).
  - `BrowserAPI.navigateTab(tabId: number, url: string, opts?: { waitUntil?: "complete" | "none"; waitForSelector?: string; waitForText?: string; waitForUrl?: string; forceLoad?: boolean; timeoutMs?: number }): Promise<NavigatedExtensionMessage>`.
- Consumes: existing `NavigatedExtensionMessage.url?` (already optional; no extension-messages change). Existing `sendTool` spread pattern.

- [ ] **Step 1: Write the failing test** `mcp-server/__tests__/navigate-tab-args.test.ts` — copy the `startMockExtension` + broker harness from `take-snapshot-args.test.ts` (same file, lines 1-112) and assert the new params are forwarded and the mock's settled URL is surfaced:

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

const SECRET = "nta-secret";

function startMockExtension(
  port: number,
  onReq: (req: ServerMessageRequest) => object
): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    ws.on("open", () => {
      const hello = { type: "hello", browserId: "nta-ext", browserType: "firefox", label: "Firefox" };
      ws.send(JSON.stringify({ payload: hello, signature: createSignature(SECRET, JSON.stringify(hello)) }));
      resolve(ws);
    });
    ws.on("message", (data) => {
      const env = JSON.parse(data.toString());
      if (env?.type === "welcome" || env?.type === "rejected") return;
      const cmd = env?.payload?.cmd;
      if (typeof cmd !== "string" || cmd === "active-status") return;
      const payload = onReq(env.payload as ServerMessageRequest);
      ws.send(JSON.stringify({ payload, signature: createSignature(SECRET, JSON.stringify(payload)) }));
    });
  });
}

describe("BrowserAPI.navigateTab params over the broker", () => {
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
      // Echo the SETTLED (different) url the extension would re-read via tabs.get.
      return {
        resource: "navigated",
        correlationId: req.correlationId,
        tabId: (req as any).tabId,
        url: "https://dash.cloudflare.com/home",
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
    if (origSecret === undefined) delete process.env.EXTENSION_SECRET; else process.env.EXTENSION_SECRET = origSecret;
    if (origPort === undefined) delete process.env.EXTENSION_PORT; else process.env.EXTENSION_PORT = origPort;
  });

  it("forwards the new optional params and surfaces the settled url", async () => {
    const result = await api.navigateTab(7, "https://dash.cloudflare.com/templates", {
      waitUntil: "complete",
      waitForText: "Create Token",
      waitForUrl: "/home",
      forceLoad: true,
      timeoutMs: 12000,
    });
    expect((lastReq as any).cmd).toBe("navigate-tab");
    expect((lastReq as any).waitUntil).toBe("complete");
    expect((lastReq as any).waitForText).toBe("Create Token");
    expect((lastReq as any).waitForUrl).toBe("/home");
    expect((lastReq as any).forceLoad).toBe(true);
    expect((lastReq as any).timeoutMs).toBe(12000);
    // The tool must report the ACCURATE settled url, not the requested one.
    expect(result.url).toBe("https://dash.cloudflare.com/home");
  });

  it("still works with no opts (back-compat)", async () => {
    const result = await api.navigateTab(7, "https://dash.cloudflare.com/x");
    expect((lastReq as any).cmd).toBe("navigate-tab");
    expect((lastReq as any).waitUntil).toBeUndefined();
    expect(result.url).toBe("https://dash.cloudflare.com/home");
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd mcp-server && npx jest navigate-tab-args` → FAIL (`navigateTab` takes 2 args; opts not forwarded).

- [ ] **Step 3: Extend `NavigateTabServerMessage`** (`common/server-messages.ts:62-66`) — add the 6 optional fields (verbatim from Shared Contracts; do not reorder `cmd`/`tabId`/`url`):

```ts
export interface NavigateTabServerMessage extends ServerMessageBase {
  cmd: "navigate-tab";
  tabId: number;
  url: string;
  // NEW — all optional, additive. Settle behavior + post-settle wait conditions.
  // "complete" (default) waits for the tab to finish loading AND a live
  // content-script probe before replying with the accurate settled URL;
  // "none" restores the old fire-and-forget echo. waitFor* poll until the
  // condition holds or timeoutMs elapses (then the tool reports the mismatch).
  // forceLoad forces a real document load (defeats in-app SPA routing).
  // timeoutMs is the overall settle+condition budget (clamped under the 30s
  // navigate-tab broker cap in timeouts.ts).
  waitUntil?: "complete" | "none";
  waitForSelector?: string;
  waitForText?: string;
  waitForUrl?: string; // substring match against the settled URL
  forceLoad?: boolean;
  timeoutMs?: number;
}
```

- [ ] **Step 4: Update `browser-api.navigateTab`** (`mcp-server/browser-api.ts:461-470`) — add `opts` and spread it (mirrors `takeSnapshot` at `:453-459`):

```ts
  async navigateTab(
    tabId: number,
    url: string,
    opts?: {
      waitUntil?: "complete" | "none";
      waitForSelector?: string;
      waitForText?: string;
      waitForUrl?: string;
      forceLoad?: boolean;
      timeoutMs?: number;
    }
  ): Promise<NavigatedExtensionMessage> {
    return await this.sendTool<NavigatedExtensionMessage>({
      cmd: "navigate-tab",
      tabId,
      url,
      ...opts,
    });
  }
```

- [ ] **Step 5: Extend the server tool schema + call** (`mcp-server/server.ts:245-260`) — add the optional zod fields, pass them through as `opts`, and append one sentence to the description. The output line stays `result.url ?? url` (now accurate). New tool block:

```ts
mcpServer.tool(
  "navigate-tab",
  "Load a URL in an existing browser tab and wait for it to settle, then report the ACTUAL final URL (a client-side SPA router may land elsewhere). The URL must be https, or http only for localhost. Optional: waitForSelector / waitForText / waitForUrl poll after settle and report a mismatch if unmet; forceLoad forces a real document load to defeat in-app SPA routing; waitUntil:\"none\" restores fire-and-forget; timeoutMs bounds the wait (capped at ~30s).",
  {
    tabId: z.number(),
    url: z.string(),
    waitUntil: z.enum(["complete", "none"]).optional(),
    waitForSelector: z.string().optional(),
    waitForText: z.string().optional(),
    waitForUrl: z.string().optional(),
    forceLoad: z.boolean().optional(),
    timeoutMs: z.number().optional(),
  },
  async ({ tabId, url, waitUntil, waitForSelector, waitForText, waitForUrl, forceLoad, timeoutMs }) => {
    const result = await browserApi.navigateTab(tabId, url, {
      waitUntil,
      waitForSelector,
      waitForText,
      waitForUrl,
      forceLoad,
      timeoutMs,
    });
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
```

- [ ] **Step 6: Run tests + build** — `cd mcp-server && npx jest navigate-tab-args` → PASS; `npm run build` → compiles (the `common` field additions type-check).

- [ ] **Step 7: Commit** — `git add common/server-messages.ts mcp-server/server.ts mcp-server/browser-api.ts mcp-server/__tests__/navigate-tab-args.test.ts && git commit -m "feat(navigate-tab): optional waitUntil/waitFor*/forceLoad/timeoutMs params + accurate settled URL (server surface)"`

---

### Task 4: Firefox `waitForTabReady` + `execWithReadyRetry` — new `firefox-extension/nav-ready.ts`

**Files:**
- Create: `firefox-extension/nav-ready.ts`
- Test: `firefox-extension/__tests__/nav-ready.test.ts` (NEW)

**Interfaces:**
- Produces:
  - `waitForTabReady(tabId: number, opts?: { timeoutMs?: number }): Promise<void>` — resolves when the tab is `status:"complete"` AND a trivial `browser.tabs.executeScript({code:"1"})` probe returns `1`, OR when the (clamped, `<30000`, default `8000`) budget elapses. **Never rejects on timeout.**
  - `execWithReadyRetry(tabId: number, details: { code: string }): Promise<any[]>` — the Firefox analog of the Chrome `sendMessageToTab` harden: on an `executeScript` failure, re-read the live `tabs.get(tabId).url`, re-check host permission for the CURRENT origin, `waitForTabReady`, and retry ONCE.

- [ ] **Step 1: Write the failing test** `firefox-extension/__tests__/nav-ready.test.ts`:

```ts
import { mockBrowser } from "./setup";
import { waitForTabReady, execWithReadyRetry } from "../nav-ready";

describe("firefox nav-ready", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockBrowser as any).tabs.onUpdated = {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    };
  });

  it("waitForTabReady resolves once the tab is complete and the frame probes injectable", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ status: "complete" });
    (mockBrowser.tabs.executeScript as jest.Mock).mockResolvedValue([1]);
    await expect(waitForTabReady(5)).resolves.toBeUndefined();
    expect(mockBrowser.tabs.executeScript).toHaveBeenCalledWith(5, { code: "1" });
  });

  it("waitForTabReady NEVER rejects on timeout (best-effort)", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ status: "loading" });
    (mockBrowser.tabs.executeScript as jest.Mock).mockRejectedValue(new Error("not injectable"));
    // onUpdated never fires; short budget → resolves (does not throw) after timeout.
    await expect(waitForTabReady(5, { timeoutMs: 40 })).resolves.toBeUndefined();
  });

  it("execWithReadyRetry re-checks permission + retries once after an injection failure", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://new.example/", status: "complete" });
    (mockBrowser.permissions.contains as jest.Mock).mockResolvedValue(true);
    let firstToolCall = true;
    (mockBrowser.tabs.executeScript as jest.Mock).mockImplementation(async (_id: number, d: any) => {
      if (d.code === "1") return [1]; // waitForTabReady probe
      if (firstToolCall) { firstToolCall = false; throw new Error("can't access dead object"); }
      return [42];
    });
    const r = await execWithReadyRetry(9, { code: "document.title" });
    expect(r).toEqual([42]);
    expect(mockBrowser.permissions.contains).toHaveBeenCalledWith({ origins: ["https://new.example/*"] });
  });

  it("execWithReadyRetry throws a clear error when the new origin is unpermitted", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://blocked.example/", status: "complete" });
    (mockBrowser.permissions.contains as jest.Mock).mockResolvedValue(false);
    (mockBrowser.tabs.executeScript as jest.Mock).mockRejectedValue(new Error("mid-nav"));
    await expect(execWithReadyRetry(9, { code: "1+1" })).rejects.toThrow(/Missing host permission for "https:\/\/blocked.example"/);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd firefox-extension && npx jest nav-ready` → FAIL (module not found).

- [ ] **Step 3: Create `firefox-extension/nav-ready.ts`** (COMPLETE):

```ts
/**
 * Background-side tab-readiness for Firefox (MV2). `browser.tabs.update` resolves
 * when a navigation COMMITS, not when the document is ready — so the isolated
 * content-script world is torn down and the next DOM tool runs mid-navigation.
 * `waitForTabReady` closes that gap: it settles on status:"complete" and then
 * confirms the frame is injectable with a trivial executeScript probe. It NEVER
 * rejects on timeout — it resolves best-effort so the caller proceeds (the tool
 * dispatch that follows surfaces any genuine failure). No new permissions
 * (`tabs` is already granted); the readiness handshake mirrors the nav-race
 * convention (Firefox uses the `browser` global; Chrome's copy uses `chrome`).
 */
const POLL_MS = 100;
const READY_DEFAULT_TIMEOUT_MS = 8000;
// Clamp strictly under the 30s navigate-tab broker budget (timeouts.ts).
const READY_MAX_TIMEOUT_MS = 29000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Best-effort settle: resolve immediately if already complete, else wait for a
// tabs.onUpdated status:"complete" (or the deadline). The executeScript probe in
// waitForTabReady is the AUTHORITATIVE readiness gate, so a missed onUpdated
// event only means we fall back to the probe loop.
async function waitForComplete(tabId: number, deadline: number): Promise<void> {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab && tab.status === "complete") return;
  } catch {
    /* tab not readable yet — fall through to the listener */
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        browser.tabs.onUpdated.removeListener(listener);
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info && info.status === "complete") finish();
    };
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, Math.max(deadline - Date.now(), 0));
  });
}

export async function waitForTabReady(
  tabId: number,
  opts?: { timeoutMs?: number }
): Promise<void> {
  const budget = Math.min(
    Math.max(opts?.timeoutMs ?? READY_DEFAULT_TIMEOUT_MS, 0),
    READY_MAX_TIMEOUT_MS
  );
  const deadline = Date.now() + budget;

  await waitForComplete(tabId, deadline);

  // Confirm the frame is injectable. executeScript compiles+runs fresh each call
  // (no persistent content script on MV2), so a resolved probe means the new
  // document will accept our injected tools.
  while (Date.now() < deadline) {
    try {
      const r = await browser.tabs.executeScript(tabId, { code: "1" });
      if (r && r[0] === 1) return;
    } catch {
      /* not injectable yet — retry until the deadline */
    }
    await sleep(POLL_MS);
  }
  // Timeout: resolve best-effort (never reject) so the caller proceeds.
}

// Firefox analog of the Chrome sendMessageToTab harden: run an injected probe,
// and on a transient mid-navigation / new-origin failure re-check host
// permission for the CURRENT origin, wait for readiness, and retry ONCE.
export async function execWithReadyRetry(
  tabId: number,
  details: { code: string }
): Promise<any[]> {
  try {
    return await browser.tabs.executeScript(tabId, details);
  } catch {
    const live = await browser.tabs.get(tabId);
    if (live && live.url) {
      const origin = new URL(live.url).origin;
      const granted = await browser.permissions.contains({
        origins: [`${origin}/*`],
      });
      if (!granted) {
        throw new Error(
          `Missing host permission for "${origin}" after navigation. Ask the user to grant access to this domain, then retry.`
        );
      }
    }
    await waitForTabReady(tabId, { timeoutMs: 8000 });
    return await browser.tabs.executeScript(tabId, details);
  }
}
```

- [ ] **Step 4: Run tests** — `cd firefox-extension && npx jest nav-ready` → PASS.

- [ ] **Step 5: Commit** — `git add firefox-extension/nav-ready.ts firefox-extension/__tests__/nav-ready.test.ts && git commit -m "feat(nav-ready): firefox waitForTabReady + execWithReadyRetry (best-effort, never rejects on timeout)"`

---

### Task 5: Chrome `waitForTabReady` — new `chrome-extension/nav-ready.ts` (mirror, probe delta)

**Files:**
- Create: `chrome-extension/nav-ready.ts` (SAME logic as Firefox's, swapping the `browser` global → `chrome` per the nav-race convention, and the MV2 `tabs.executeScript({code:"1"})` probe → the MV3 `scripting.executeScript(files) + {type:"ping"}` handshake against the existing `content-script.ts:274-276` responder)
- Test: `chrome-extension/__tests__/nav-ready.test.ts` (NEW)
- **No change to `chrome-extension/content-script.ts`** — the `case "ping": sendResponse({ ok: true })` responder (`:274-276`) and the listener's `return true` (`:443`) already satisfy the handshake; this task only *consumes* the dead responder. (Verified during exploration; see the note in Step 4.)

**Interfaces:**
- Produces: `waitForTabReady(tabId: number, opts?: { timeoutMs?: number }): Promise<void>` — identical signature/contract to Firefox's; Chrome-specific readiness probe.
- Consumes: `chrome.scripting.executeScript`, `chrome.tabs.sendMessage`, `chrome.tabs.get`, `chrome.tabs.onUpdated`; the existing `content-script.ts` ping responder.

- [ ] **Step 1: Write the failing test** `chrome-extension/__tests__/nav-ready.test.ts`:

```ts
import { mockBrowser } from "./setup";
import { waitForTabReady } from "../nav-ready";

describe("chrome nav-ready", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockBrowser as any).tabs.onUpdated = {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    };
  });

  it("waitForTabReady injects the content script then pings the responder", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ status: "complete" });
    (mockBrowser.scripting.executeScript as jest.Mock).mockResolvedValue([]);
    (mockBrowser.tabs.sendMessage as jest.Mock).mockResolvedValue({ ok: true });
    await expect(waitForTabReady(5)).resolves.toBeUndefined();
    expect(mockBrowser.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 5 },
      files: ["dist/content-script.js"],
    });
    expect(mockBrowser.tabs.sendMessage).toHaveBeenCalledWith(5, { type: "ping" });
  });

  it("waitForTabReady NEVER rejects on timeout", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ status: "loading" });
    (mockBrowser.scripting.executeScript as jest.Mock).mockResolvedValue([]);
    (mockBrowser.tabs.sendMessage as jest.Mock).mockRejectedValue(new Error("no receiver"));
    await expect(waitForTabReady(5, { timeoutMs: 40 })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd chrome-extension && npx jest nav-ready` → FAIL (module not found).

- [ ] **Step 3: Create `chrome-extension/nav-ready.ts`** — SAME structure as Firefox's `nav-ready.ts` (Task 4), with exactly these deltas (COMPLETE file below):
  - `browser.*` → `chrome.*` throughout (nav-race convention; the setup mock backs both globals with one object, so tests are unaffected).
  - The readiness probe body: MV2 `tabs.executeScript({code:"1"})` → MV3 `scripting.executeScript({target,files})` (re-inject) followed by `tabs.sendMessage(tabId,{type:"ping"})` polled until `{ok:true}` (repurposes the dead `content-script.ts:274-276` responder).
  - `execWithReadyRetry` is **Firefox-only** (Chrome's analog is the `sendMessageToTab` harden in Task 6) — do NOT port it here.

```ts
/**
 * Background-side tab-readiness for Chrome/Edge (MV3). `browser.tabs.update`
 * resolves on navigation COMMIT, not document-ready, and Chrome injects the DOM
 * content script lazily — so the next DOM tool can run mid-navigation with no
 * live content script. `waitForTabReady` settles on status:"complete", then
 * proactively injects `dist/content-script.js` and pings the (previously dead)
 * `case "ping"` responder until it answers {ok:true}. It NEVER rejects on
 * timeout — best-effort resolve so the caller proceeds. No new permissions
 * (`tabs`/`scripting` already granted). Mirrors firefox-extension/nav-ready.ts;
 * per the nav-race convention this copy uses the `chrome` global.
 */
const POLL_MS = 100;
const READY_DEFAULT_TIMEOUT_MS = 8000;
// Clamp strictly under the 30s navigate-tab broker budget (timeouts.ts).
const READY_MAX_TIMEOUT_MS = 29000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForComplete(tabId: number, deadline: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.status === "complete") return;
  } catch {
    /* tab not readable yet — fall through to the listener */
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, Math.max(deadline - Date.now(), 0));
  });
}

export async function waitForTabReady(
  tabId: number,
  opts?: { timeoutMs?: number }
): Promise<void> {
  const budget = Math.min(
    Math.max(opts?.timeoutMs ?? READY_DEFAULT_TIMEOUT_MS, 0),
    READY_MAX_TIMEOUT_MS
  );
  const deadline = Date.now() + budget;

  await waitForComplete(tabId, deadline);

  // Re-establish the content script, then confirm it answers the ping.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["dist/content-script.js"],
    });
  } catch {
    /* already injected / mid-nav — the ping poll below is the real gate */
  }
  while (Date.now() < deadline) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: "ping" });
      if (pong && pong.ok) return;
    } catch {
      /* content script not live yet — retry until the deadline */
    }
    await sleep(POLL_MS);
  }
  // Timeout: resolve best-effort (never reject) so the caller proceeds.
}
```

- [ ] **Step 4: Confirm no `content-script.ts` change is needed** — the ping responder and async-channel return already exist:

```
grep -n 'case "ping"' chrome-extension/content-script.ts      # expect :274 sendResponse({ ok: true })
grep -n "return true; // Keep channel open" chrome-extension/content-script.ts  # expect :443
```

If both grep hits are present (they are), `waitForTabReady`'s `{type:"ping"}` handshake works against the existing responder — **make no edit** to `content-script.ts`.

- [ ] **Step 5: Run tests** — `cd chrome-extension && npx jest nav-ready` → PASS.

- [ ] **Step 6: Commit** — `git add chrome-extension/nav-ready.ts chrome-extension/__tests__/nav-ready.test.ts && git commit -m "feat(nav-ready): chrome waitForTabReady (inject + ping the repurposed responder; best-effort)"`

---

### Task 6: Harden Chrome `sendMessageToTab` — re-read url, re-check permission, retry once

**Files:**
- Modify: `chrome-extension/message-handler.ts:96-120` (`sendMessageToTab` — add `export` for a focused unit test; broaden the retry trigger to permission failures; re-read live url + re-check permission + `waitForTabReady` + re-inject + retry once)
- Modify: `chrome-extension/message-handler.ts` (top imports) — `import { waitForTabReady } from "./nav-ready";`
- Test: `chrome-extension/__tests__/send-message-to-tab.test.ts` (NEW — mocks `../nav-ready` so `waitForTabReady` is a no-op, then drives the free function directly)

**Interfaces:**
- Consumes: `waitForTabReady` (Task 5).
- Produces: `export async function sendMessageToTab(tabId: number, message: any): Promise<any>` (behavior widened; signature unchanged — the `export` is added for testability).

- [ ] **Step 1: Write the failing test** `chrome-extension/__tests__/send-message-to-tab.test.ts`:

```ts
// Mock nav-ready so waitForTabReady is a deterministic no-op (its own path is
// covered by nav-ready.test.ts). This test isolates the harden's control flow.
jest.mock("../nav-ready", () => ({
  waitForTabReady: jest.fn().mockResolvedValue(undefined),
}));
// Defensive module-load mocks, mirroring the message-handler.test.ts header, so
// importing message-handler never touches a real socket / debugger.
jest.mock("../native-input-client", () => ({
  NativeInputClient: jest.fn().mockImplementation(() => ({ sendGesture: jest.fn() })),
}));
jest.mock("../cdp-eval", () => ({ cdpEval: jest.fn() }));

import { mockBrowser } from "./setup";
import { sendMessageToTab } from "../message-handler";
import { waitForTabReady } from "../nav-ready";

describe("chrome sendMessageToTab harden", () => {
  beforeEach(() => jest.clearAllMocks());

  it("re-reads the live url, re-checks permission, and retries once on a permission failure", async () => {
    let call = 0;
    (mockBrowser.tabs.sendMessage as jest.Mock).mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error("Missing host permission for the tab");
      return { ok: true, tree: "x" };
    });
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://new.example/page" });
    (mockBrowser.permissions.contains as jest.Mock).mockResolvedValue(true);
    (mockBrowser.scripting.executeScript as jest.Mock).mockResolvedValue([]);

    const r = await sendMessageToTab(7, { type: "buildSnapshot" });
    expect(r).toEqual({ ok: true, tree: "x" });
    expect(mockBrowser.permissions.contains).toHaveBeenCalledWith({ origins: ["https://new.example/*"] });
    expect(waitForTabReady).toHaveBeenCalledWith(7, { timeoutMs: 8000 });
    expect(mockBrowser.scripting.executeScript).toHaveBeenCalled();
  });

  it("throws a clear error when the CURRENT origin is unpermitted after nav", async () => {
    (mockBrowser.tabs.sendMessage as jest.Mock).mockRejectedValue(new Error("Missing host permission for the tab"));
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://blocked.example/" });
    (mockBrowser.permissions.contains as jest.Mock).mockResolvedValue(false);
    await expect(sendMessageToTab(7, { type: "buildSnapshot" })).rejects.toThrow(
      /Missing host permission for "https:\/\/blocked.example"/
    );
  });

  it("still passes through a first-try success unchanged", async () => {
    (mockBrowser.tabs.sendMessage as jest.Mock).mockResolvedValue({ ok: true });
    const r = await sendMessageToTab(7, { type: "ping" });
    expect(r).toEqual({ ok: true });
    expect(mockBrowser.scripting.executeScript).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd chrome-extension && npx jest send-message-to-tab` → FAIL (`sendMessageToTab` not exported; permission-failure path not handled).

- [ ] **Step 3: Add the import** at the top of `chrome-extension/message-handler.ts` (with the other imports): `import { waitForTabReady } from "./nav-ready";`

- [ ] **Step 4: Replace `sendMessageToTab`** (`chrome-extension/message-handler.ts:96-120`) with the hardened, exported version (COMPLETE):

```ts
// Ensure content script is loaded in a tab, then send a message. Exported for a
// focused unit test (send-message-to-tab.test.ts). On an injection OR permission
// failure — both of which appear right after a navigation / SPA route change,
// when the content script is gone AND the tab may have moved to a new origin
// before <all_urls> coverage is confirmed — self-heal ONCE: re-read the LIVE
// url, re-check host permission against the CURRENT origin (the pre-dispatch
// check may have validated a stale mid-nav url), wait for readiness, re-inject,
// and retry.
export async function sendMessageToTab(tabId: number, message: any): Promise<any> {
  const checkResult = (result: any): any => {
    if (result && typeof result === "object" && result.error && result.ok === false) {
      throw new Error(result.error);
    }
    return result;
  };
  try {
    const result = await browser.tabs.sendMessage(tabId, message);
    return checkResult(result);
  } catch (e: any) {
    const msg = (e && e.message) || "";
    const isConnErr =
      msg.includes("Receiving end does not exist") ||
      msg.includes("Could not establish connection");
    const isPermErr = msg.includes("Missing host permission");
    if (!isConnErr && !isPermErr) {
      throw e;
    }
    // Re-check host permission for the CURRENT origin.
    const live = await browser.tabs.get(tabId);
    if (live && live.url) {
      const origin = new URL(live.url).origin;
      const granted = await browser.permissions.contains({
        origins: [`${origin}/*`],
      });
      if (!granted) {
        throw new Error(
          `Missing host permission for "${origin}" after navigation. Ask the user to grant access to this domain, then retry.`
        );
      }
    }
    // Wait for the tab to be ready, re-inject the content script, retry ONCE.
    await waitForTabReady(tabId, { timeoutMs: 8000 });
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["dist/content-script.js"],
    });
    const result = await browser.tabs.sendMessage(tabId, message);
    return checkResult(result);
  }
}
```

- [ ] **Step 5: Run tests + build** — `cd chrome-extension && npx jest send-message-to-tab` → PASS; `npx jest message-handler` → still PASS (no behavior change on the success path); `npm run build` → compiles.

- [ ] **Step 6: Commit** — `git add chrome-extension/message-handler.ts chrome-extension/__tests__/send-message-to-tab.test.ts && git commit -m "feat(readiness): chrome sendMessageToTab re-checks permission + waits-ready + retries once on nav/permission failure"`

---

### Task 7: Chrome `navigate-tab` — settle + real final URL + wait conditions

**Files:**
- Modify: `chrome-extension/message-handler.ts:1352-1370` (`navigateTab` — settle via `waitForTabReady`, re-read `tabs.get(...).url`, `forceLoad`, `waitUntil`, and post-settle condition polling with mismatch reporting)
- Modify: `chrome-extension/message-handler.ts:260-262` (the `navigate-tab` dispatch `case` — thread the new params)
- Modify: `chrome-extension/message-handler.ts` (top imports — `waitForTabReady` already imported by Task 6; add nothing new)
- Test: `chrome-extension/__tests__/navigate-tab.test.ts` (NEW — mocks `../nav-ready`)

**Interfaces:**
- Consumes: `waitForTabReady` (Task 5); the request's new optional fields off `NavigateTabServerMessage` (Task 3).
- Produces: `navigated` reply with `url: finalTab.url` (accurate), or `url: "<finalUrl> — expected \"<x>\" not found"` on an unmet wait condition (encoded in `url` so the server's existing `result.url ?? url` prints it — **no extension-messages type change**, per spec §B).

- [ ] **Step 1: Write the failing test** `chrome-extension/__tests__/navigate-tab.test.ts`:

```ts
jest.mock("../nav-ready", () => ({
  waitForTabReady: jest.fn().mockResolvedValue(undefined),
}));
// Defensive module-load mocks (mirror message-handler.test.ts header).
jest.mock("../native-input-client", () => ({
  NativeInputClient: jest.fn().mockImplementation(() => ({ sendGesture: jest.fn() })),
}));
jest.mock("../cdp-eval", () => ({ cdpEval: jest.fn() }));

import { mockBrowser } from "./setup";
import { MessageHandler } from "../message-handler";
import type { ExtensionTransport } from "../transport";
import type { ServerMessageRequest } from "@foxpilot/common";

function makeTransport(): jest.Mocked<ExtensionTransport> {
  return {
    sendResourceToServer: jest.fn().mockResolvedValue(undefined),
    sendErrorToServer: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ExtensionTransport>;
}

describe("chrome navigate-tab settle", () => {
  let handler: MessageHandler;
  let transport: jest.Mocked<ExtensionTransport>;

  beforeEach(() => {
    jest.clearAllMocks();
    transport = makeTransport();
    handler = new MessageHandler(transport);
    // navigate-tab is in AUTOMATION_COMMANDS → automationMode MUST be true, else
    // handleDecodedMessage throws "requires Automation Mode". Unset tool ids
    // default to allowed, so toolSettings can stay empty.
    (mockBrowser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], domainDenyList: [], auditLog: [], toolSettings: {}, automationMode: true },
    });
    (mockBrowser as any).tabs.onUpdated = { addListener: jest.fn(), removeListener: jest.fn() };
    (mockBrowser.tabs.update as jest.Mock).mockResolvedValue(undefined);
  });

  it("returns the ACTUAL settled url (not the requested one)", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://dash.cloudflare.com/home", status: "complete" });
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/templates", correlationId: "c1",
    } as any;
    await handler.handleDecodedMessage(req);
    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated", correlationId: "c1", tabId: 7, url: "https://dash.cloudflare.com/home",
    });
  });

  it("reports a mismatch when a waitFor* condition is unmet within timeout", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://dash.cloudflare.com/home", status: "complete" });
    (mockBrowser.scripting.executeScript as jest.Mock).mockResolvedValue([{ result: false }]);
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/x",
      waitForText: "Create Token", timeoutMs: 0, correlationId: "c2",
    } as any;
    await handler.handleDecodedMessage(req);
    const sent = (transport.sendResourceToServer as jest.Mock).mock.calls[0][0];
    expect(sent.url).toContain("https://dash.cloudflare.com/home");
    expect(sent.url).toContain('expected text "Create Token" not found');
  });

  it("waitUntil:none restores fire-and-forget (echoes the requested url, no settle)", async () => {
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/y", waitUntil: "none", correlationId: "c3",
    } as any;
    await handler.handleDecodedMessage(req);
    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated", correlationId: "c3", tabId: 7, url: "https://dash.cloudflare.com/y",
    });
    // No settle re-read on the fire-and-forget path.
    expect(mockBrowser.tabs.get).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd chrome-extension && npx jest navigate-tab` → FAIL (handler echoes the requested url; no opts).

- [ ] **Step 3: Replace `navigateTab`** (`chrome-extension/message-handler.ts:1352-1370`) with the settling version + a condition-polling helper (COMPLETE):

```ts
  private async navigateTab(
    correlationId: string,
    tabId: number,
    url: string,
    opts?: {
      waitUntil?: "complete" | "none";
      waitForSelector?: string;
      waitForText?: string;
      waitForUrl?: string;
      forceLoad?: boolean;
      timeoutMs?: number;
    }
  ): Promise<void> {
    if (!isNavigableUrl(url)) {
      throw new Error("Invalid URL (must be https, or http for localhost)");
    }
    if (await isDomainInDenyList(url)) {
      throw new Error("Domain in user defined deny list");
    }

    // Force a real document load to defeat in-app SPA routing (reload if the tab
    // is already at the target url, else navigate to it).
    if (opts?.forceLoad) {
      let current: { url?: string } | undefined;
      try {
        current = await browser.tabs.get(tabId);
      } catch {
        current = undefined;
      }
      if (current && current.url === url) {
        await browser.tabs.reload(tabId, {});
      } else {
        await browser.tabs.update(tabId, { url });
      }
    } else {
      await browser.tabs.update(tabId, { url });
    }

    // waitUntil:"none" restores the old fire-and-forget echo.
    if (opts?.waitUntil === "none") {
      await this.client.sendResourceToServer({
        resource: "navigated",
        correlationId,
        tabId,
        url,
      });
      return;
    }

    const budget = Math.min(Math.max(opts?.timeoutMs ?? 15000, 0), 29000);
    await waitForTabReady(tabId, { timeoutMs: Math.min(budget, 8000) });
    const mismatch = await this.awaitNavConditions(tabId, opts, budget);

    let finalUrl = url;
    try {
      const finalTab = await browser.tabs.get(tabId);
      if (finalTab && finalTab.url) finalUrl = finalTab.url;
    } catch {
      /* keep the requested url as a best-effort fallback */
    }

    await this.client.sendResourceToServer({
      resource: "navigated",
      correlationId,
      tabId,
      url: mismatch ? `${finalUrl} — ${mismatch}` : finalUrl,
    });
  }

  // Poll the post-settle wait conditions until all hold or the budget elapses.
  // Returns a human-readable mismatch string for the first unmet condition, or
  // undefined when everything is satisfied (or nothing was requested). DOM
  // predicates run in the isolated world via scripting.executeScript (func) —
  // CSP-immune; waitForUrl is a pure background tabs.get substring match.
  private async awaitNavConditions(
    tabId: number,
    opts:
      | { waitForSelector?: string; waitForText?: string; waitForUrl?: string }
      | undefined,
    timeoutMs: number
  ): Promise<string | undefined> {
    if (!opts) return undefined;
    const { waitForSelector, waitForText, waitForUrl } = opts;
    if (!waitForSelector && !waitForText && !waitForUrl) return undefined;
    const deadline = Date.now() + timeoutMs;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    while (true) {
      let selOk = true;
      let textOk = true;
      let urlOk = true;
      if (waitForUrl) {
        try {
          const t = await browser.tabs.get(tabId);
          urlOk = !!(t && t.url && t.url.includes(waitForUrl));
        } catch {
          urlOk = false;
        }
      }
      if (waitForSelector) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            func: (s: string) => !!document.querySelector(s),
            args: [waitForSelector],
          });
          selOk = !!(r && r[0] && (r[0] as { result?: unknown }).result);
        } catch {
          selOk = false;
        }
      }
      if (waitForText) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            func: (t: string) => (document.body?.innerText || "").includes(t),
            args: [waitForText],
          });
          textOk = !!(r && r[0] && (r[0] as { result?: unknown }).result);
        } catch {
          textOk = false;
        }
      }
      if (selOk && textOk && urlOk) return undefined;
      if (Date.now() >= deadline) {
        if (!urlOk) return `expected url "${waitForUrl}" not found`;
        if (!selOk) return `expected selector "${waitForSelector}" not found`;
        return `expected text "${waitForText}" not found`;
      }
      await sleep(200);
    }
  }
```

- [ ] **Step 4: Thread the params in the dispatch case** (`chrome-extension/message-handler.ts:260-262`):

```ts
      case "navigate-tab":
        await this.navigateTab(req.correlationId, req.tabId, req.url, {
          waitUntil: req.waitUntil,
          waitForSelector: req.waitForSelector,
          waitForText: req.waitForText,
          waitForUrl: req.waitForUrl,
          forceLoad: req.forceLoad,
          timeoutMs: req.timeoutMs,
        });
        break;
```

- [ ] **Step 5: Run tests + build** — `cd chrome-extension && npx jest navigate-tab` → PASS; `npx jest` (full suite) → green; `npm run build` → compiles.

- [ ] **Step 6: Commit** — `git add chrome-extension/message-handler.ts chrome-extension/__tests__/navigate-tab.test.ts && git commit -m "feat(navigate-tab): chrome settle + accurate final URL + waitFor*/forceLoad/waitUntil"`

---

### Task 8: Firefox `navigate-tab` — settle + real final URL + wait conditions

**Files:**
- Modify: `firefox-extension/message-handler.ts:1578-1599` (`navigateTab` — mirror of Task 7, using `waitForTabReady` + `execWithReadyRetry` for the DOM condition probes; `browser` global)
- Modify: `firefox-extension/message-handler.ts:271-273` (the `navigate-tab` dispatch `case` — thread the new params)
- Modify: `firefox-extension/message-handler.ts` (top imports) — `import { waitForTabReady, execWithReadyRetry } from "./nav-ready";`
- Test: `firefox-extension/__tests__/navigate-tab.test.ts` (NEW — mocks `../nav-ready`)

**Interfaces:**
- Consumes: `waitForTabReady`, `execWithReadyRetry` (Task 4); the request's new optional fields (Task 3).
- Produces: same `navigated` reply contract as Chrome (accurate `url`, or mismatch-suffixed `url`).

- [ ] **Step 1: Write the failing test** `firefox-extension/__tests__/navigate-tab.test.ts`:

```ts
jest.mock("../nav-ready", () => ({
  waitForTabReady: jest.fn().mockResolvedValue(undefined),
  execWithReadyRetry: jest.fn(),
}));

import { mockBrowser } from "./setup";
import { MessageHandler } from "../message-handler";
import { execWithReadyRetry } from "../nav-ready";
import type { ExtensionTransport } from "../transport";
import type { ServerMessageRequest } from "@foxpilot/common";

function makeTransport(): jest.Mocked<ExtensionTransport> {
  return {
    sendResourceToServer: jest.fn().mockResolvedValue(undefined),
    sendErrorToServer: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ExtensionTransport>;
}

describe("firefox navigate-tab settle", () => {
  let handler: MessageHandler;
  let transport: jest.Mocked<ExtensionTransport>;

  beforeEach(() => {
    jest.clearAllMocks();
    transport = makeTransport();
    handler = new MessageHandler(transport);
    // navigate-tab requires automation mode (see the Chrome navigate-tab test note).
    (mockBrowser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], domainDenyList: [], auditLog: [], toolSettings: {}, automationMode: true },
    });
    (mockBrowser as any).tabs.onUpdated = { addListener: jest.fn(), removeListener: jest.fn() };
    (mockBrowser.tabs.update as jest.Mock).mockResolvedValue(undefined);
  });

  it("returns the ACTUAL settled url", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://dash.cloudflare.com/home", status: "complete" });
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/templates", correlationId: "c1",
    } as any;
    await handler.handleDecodedMessage(req);
    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated", correlationId: "c1", tabId: 7, url: "https://dash.cloudflare.com/home",
    });
  });

  it("reports a mismatch when waitForText is unmet, via execWithReadyRetry", async () => {
    (mockBrowser.tabs.get as jest.Mock).mockResolvedValue({ url: "https://dash.cloudflare.com/home", status: "complete" });
    (execWithReadyRetry as jest.Mock).mockResolvedValue([false]);
    const req: ServerMessageRequest = {
      cmd: "navigate-tab", tabId: 7, url: "https://dash.cloudflare.com/x",
      waitForText: "Create Token", timeoutMs: 0, correlationId: "c2",
    } as any;
    await handler.handleDecodedMessage(req);
    const sent = (transport.sendResourceToServer as jest.Mock).mock.calls[0][0];
    expect(sent.url).toContain('expected text "Create Token" not found');
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd firefox-extension && npx jest navigate-tab` → FAIL.

- [ ] **Step 3: Add the import** at the top of `firefox-extension/message-handler.ts` (next to the `nav-race` import at `:23`): `import { waitForTabReady, execWithReadyRetry } from "./nav-ready";`

- [ ] **Step 4: Replace `navigateTab`** (`firefox-extension/message-handler.ts:1578-1599`) with the settling version + condition helper (COMPLETE; identical control flow to Chrome's Task 7, `browser` global, DOM probes via `execWithReadyRetry`):

```ts
  private async navigateTab(
    correlationId: string,
    tabId: number,
    url: string,
    opts?: {
      waitUntil?: "complete" | "none";
      waitForSelector?: string;
      waitForText?: string;
      waitForUrl?: string;
      forceLoad?: boolean;
      timeoutMs?: number;
    }
  ): Promise<void> {
    if (!isNavigableUrl(url)) {
      throw new Error("Invalid URL (must be https, or http for localhost)");
    }

    if (await isDomainInDenyList(url)) {
      throw new Error("Domain in user defined deny list");
    }

    if (opts?.forceLoad) {
      let current: { url?: string } | undefined;
      try {
        current = await browser.tabs.get(tabId);
      } catch {
        current = undefined;
      }
      if (current && current.url === url) {
        await browser.tabs.reload(tabId, {});
      } else {
        await browser.tabs.update(tabId, { url });
      }
    } else {
      await browser.tabs.update(tabId, { url });
    }

    if (opts?.waitUntil === "none") {
      await this.client.sendResourceToServer({
        resource: "navigated",
        correlationId,
        tabId,
        url,
      });
      return;
    }

    const budget = Math.min(Math.max(opts?.timeoutMs ?? 15000, 0), 29000);
    await waitForTabReady(tabId, { timeoutMs: Math.min(budget, 8000) });
    const mismatch = await this.awaitNavConditions(tabId, opts, budget);

    let finalUrl = url;
    try {
      const finalTab = await browser.tabs.get(tabId);
      if (finalTab && finalTab.url) finalUrl = finalTab.url;
    } catch {
      /* keep the requested url as a best-effort fallback */
    }

    await this.client.sendResourceToServer({
      resource: "navigated",
      correlationId,
      tabId,
      url: mismatch ? `${finalUrl} — ${mismatch}` : finalUrl,
    });
  }

  // Post-settle wait conditions. DOM predicates run in the ISOLATED world via
  // execWithReadyRetry (executeScript compiles the source — CSP-immune, and it
  // self-heals once if the frame is briefly not injectable after the nav).
  // waitForUrl is a pure background tabs.get substring match.
  private async awaitNavConditions(
    tabId: number,
    opts:
      | { waitForSelector?: string; waitForText?: string; waitForUrl?: string }
      | undefined,
    timeoutMs: number
  ): Promise<string | undefined> {
    if (!opts) return undefined;
    const { waitForSelector, waitForText, waitForUrl } = opts;
    if (!waitForSelector && !waitForText && !waitForUrl) return undefined;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      let selOk = true;
      let textOk = true;
      let urlOk = true;
      if (waitForUrl) {
        try {
          const t = await browser.tabs.get(tabId);
          urlOk = !!(t && t.url && t.url.includes(waitForUrl));
        } catch {
          urlOk = false;
        }
      }
      if (waitForSelector) {
        try {
          const r = await execWithReadyRetry(tabId, {
            code: `!!document.querySelector(${JSON.stringify(waitForSelector)})`,
          });
          selOk = !!(r && r[0]);
        } catch {
          selOk = false;
        }
      }
      if (waitForText) {
        try {
          const r = await execWithReadyRetry(tabId, {
            code: `((document.body&&document.body.innerText)||"").indexOf(${JSON.stringify(
              waitForText
            )})!==-1`,
          });
          textOk = !!(r && r[0]);
        } catch {
          textOk = false;
        }
      }
      if (selOk && textOk && urlOk) return undefined;
      if (Date.now() >= deadline) {
        if (!urlOk) return `expected url "${waitForUrl}" not found`;
        if (!selOk) return `expected selector "${waitForSelector}" not found`;
        return `expected text "${waitForText}" not found`;
      }
      await sleep(200);
    }
  }
```

(Note: `sleep` is the module-level helper at `firefox-extension/message-handler.ts:61` — reuse it, do not redeclare.)

- [ ] **Step 5: Thread the params in the dispatch case** (`firefox-extension/message-handler.ts:271-273`):

```ts
      case "navigate-tab":
        await this.navigateTab(req.correlationId, req.tabId, req.url, {
          waitUntil: req.waitUntil,
          waitForSelector: req.waitForSelector,
          waitForText: req.waitForText,
          waitForUrl: req.waitForUrl,
          forceLoad: req.forceLoad,
          timeoutMs: req.timeoutMs,
        });
        break;
```

- [ ] **Step 6: Run tests + build** — `cd firefox-extension && npx jest navigate-tab` → PASS; `npx jest` (full suite, incl. `self-containment.test.ts`) → green; `npm run build` → compiles.

- [ ] **Step 7: Commit** — `git add firefox-extension/message-handler.ts firefox-extension/__tests__/navigate-tab.test.ts && git commit -m "feat(navigate-tab): firefox settle + accurate final URL + waitFor*/forceLoad/waitUntil (execWithReadyRetry probes)"`

---

### Wave 1 — cross-task verification (run after Tasks 3-8)

- [ ] **Full suites** — `cd chrome-extension && npx jest` ; `cd firefox-extension && npx jest` ; `cd mcp-server && npx jest`. All green (`self-containment.test.ts` unaffected — `nav-ready.ts` is a background helper, NOT injected, so it is not in `INJECTED_FUNCTIONS`).
- [ ] **Build all** — `npm run build` (root nx) + `npm run package --prefix chrome-extension`.
- [ ] **No new permissions** — `git diff --stat -- chrome-extension/manifest.json firefox-extension/manifest.json` → no changes.
- [ ] **`timeouts.ts` unchanged** — the existing `"navigate-tab": 30000` (`mcp-server/timeouts.ts:13`) is the ceiling the in-handler clamp (`< 29000`) respects; no edit needed.


## Wave 2 — Snapshot enrichment

**Spec:** §C (`docs/superpowers/specs/2026-07-08-foxpilot-cloudflare-fixes-design.md`). Implements the always-on **full 3-slot grammar** on every snapshot row. All work is in the two byte-identical `injected/snapshot-script.ts` copies (helpers are **inner functions** of `buildSnapshot`, so self-containment is preserved and `buildSnapshot` needs no new registration in `self-containment.test.ts`). Firefox is authored first (Tasks 11–14); Chrome is byte-mirrored and its suite updated last (Task 15).

### Confirmed current "before" state (from source)

- **Base-pass row builder** — `firefox-extension/injected/snapshot-script.ts:445-449` (Chrome `:445-449`, byte-identical):
  ```js
  let line = role + ' "' + name + '" [uid=' + uid + "]";
  if (flags.length > 0) {
    line += " (" + flags.join(", ") + ")";
  }
  lines.push(line);
  ```
- **Pointer-pass row builder** — Firefox `:538-542` (Chrome `:538-542`): hard-codes `'clickable "' + name + '" [uid=' + uid + "]"` + optional ` (flags)`.
- Constants: `UID_ATTR = "data-bcmcp-uid"` (`:47`), `NAME_MAX = 120` (`:48`). Inner helpers already present and reused: `collapseWhitespace` (`:52`), `clip` (`:56`), `getRole` (`:90`), `getAccessibleName` (`:214`, placeholder tail at `:248-262`), `getStateFlags` (`:266`), `nameFromLabelledBy` (`:190`). The Firefox and Chrome `buildSnapshot` **bodies are already byte-identical** (only the file's leading doc-comment differs).

### The new grammar (LOCKED — Wave 3 / tests must match byte-for-byte)

```
<role> "<name>" | <valueSlot> | <sectionSlot> [uid=eN] (flags)
```

Assembled in `makeRow` as exactly:
```js
role + ' "' + nameSlot + '" | ' + valueSlot + ' | ' + sectionSlot + " [uid=" + uid + "]"
```
(then optional ` (` + `flags.join(", ")` + `)`), where:
- The inter-slot delimiter is ` | ` (**space, pipe, space**), emitted **unconditionally** on every row.
- `valueSlot` = `"` + cleaned-value + `"` (double-quoted) when a current value exists **and differs from the name**; empty string otherwise.
- `sectionSlot` = cleaned breadcrumb text (**unquoted**) when a section title exists; empty string otherwise.
- ` [uid=eN]` keeps its single leading space (unchanged from today).
- An **empty slot renders as the empty string**, so consecutive delimiters collapse to two spaces.

**Canonical byte-exact examples** (used verbatim in tests):
| DOM | Emitted line |
|---|---|
| `<a href="/home">Home</a>` | `link "Home" \|  \|  [uid=e1]` |
| `<button>Sign in</button>` inside an "Account" card | `button "Sign in" \|  \| Account [uid=e15]` |
| `<select aria-label="Country"><option>US</option></select>` | `combobox "Country" \| "US" \|  [uid=e1]` |
| react-select "Country" showing "United States", in "Billing" card | `combobox "Country" \| "United States" \| Billing [uid=e7]` |

> Note the whitespace: when the **value** slot is empty there are **two** spaces between the two pipes (`\|  \|`); when the **section** slot is empty there are **two** spaces before `[uid` (`\|  [uid`). When a slot is present there is exactly one space around it. This is the mechanical result of always emitting ` | ` + `""` + ` | ` and is exactly the approved preview `button "Sign in" |  | Account [uid=e15]`.

### jsdom caveat (keeps Wave 2 fully unit-testable)

`buildSnapshot` deliberately avoids layout APIs (`getBoundingClientRect`, `getComputedStyle` cascade, `offsetParent`) — jsdom has no layout engine. **All Wave-2 enrichment is attribute/DOM-structure based** (`.value`, `.selectedOptions`, `.textContent`, `.closest`, `.querySelector`, `.previousElementSibling`, `[class*=...]`), every one of which jsdom supports (verified). The only pre-existing jsdom-limited path is the pointer pass's inline `cursor:pointer` read, which already works for inline-styled elements. So Tasks 11–15 are driven entirely through `buildSnapshot(document, {...})` on a `document.body.innerHTML` fixture, asserting the exact `tree` line.

---

### Task 11: `makeRow` + `formatSlot` + `getCurrentValue` (native) + base-pass grammar swap (Firefox)

Introduces the 3-slot grammar on the **base pass** with the value slot wired for native `<input>`/`<textarea>`/`<select>`. The section arg is passed as the literal `""` here (real `getSection` lands in Task 13); the custom-combobox value branch and react-select name probing land in Task 12.

**Files:**
- Modify: `firefox-extension/injected/snapshot-script.ts` — add inner helpers after `getStateFlags` (before the `--- 1. clear stale uids` comment at `:307`); swap the base-pass line assembly (`:445-449`).
- Test: `firefox-extension/__tests__/snapshot-script.test.ts`.

**Interfaces:**
- Produces (all inner to `buildSnapshot`):
  - `formatSlot(s: string, max: number): string` — collapse whitespace, replace `|`→`/`, clip to `max`.
  - `getCurrentValue(el: Element, role: string): string` — native branch only in this task (textarea/input/select); returns `""` for everything else.
  - `makeRow(el: Element, role: string, name: string, value: string, section: string, flags: string[], uid: string): string` — the single row assembler with value-vs-name dedup. `el` is part of the shared signature both passes call through; slots are precomputed by callers, so `el` is not read (neither tsconfig enables `noUnusedParameters`; `strict` does not include it — confirmed, so this compiles clean).
  - New consts `VALUE_MAX = 80`, `SECTION_MAX = 60`.
- Consumes: `collapseWhitespace`, `clip`, `NAME_MAX`, `UID_ATTR`.

- [ ] **Step 1: Write the failing tests.** Append to `firefox-extension/__tests__/snapshot-script.test.ts` (uses the file's existing `build()` helper). These assert the new empty-slot grammar, native value slots, and delimiter sanitization:

```ts
  describe("3-slot grammar (Wave 2)", () => {
    it("emits empty value and section slots for a plain link", () => {
      document.body.innerHTML = `<a href="/home">Home</a>`;
      const { tree } = build();
      expect(tree).toContain('link "Home" |  |  [uid=e1]');
    });

    it("emits empty slots for a plain button", () => {
      document.body.innerHTML = `<button>Sign in</button>`;
      const { tree } = build();
      expect(tree).toContain('button "Sign in" |  |  [uid=e1]');
    });

    it("shows a text input's current value in the value slot", () => {
      document.body.innerHTML = `<input type="text" aria-label="Search" value="hello world" />`;
      const { tree } = build();
      expect(tree).toContain('textbox "Search" | "hello world" |  [uid=e1]');
    });

    it("shows a native select's selected option in the value slot", () => {
      document.body.innerHTML = `<select aria-label="Country"><option>US</option><option>UK</option></select>`;
      const { tree } = build();
      expect(tree).toContain('combobox "Country" | "US" |  [uid=e1]');
    });

    it("leaves the value slot empty for a checkbox (state is in flags, not value)", () => {
      document.body.innerHTML = `<input type="checkbox" aria-label="Agree" checked />`;
      const { tree } = build();
      expect(tree).toContain('checkbox "Agree" |  |  [uid=e1] (checked)');
    });

    it("collapses a literal pipe in slot text to a slash so the delimiter stays unambiguous", () => {
      document.body.innerHTML = `<button>Save | Exit</button>`;
      const { tree } = build();
      expect(tree).toContain('button "Save / Exit" |  |  [uid=e1]');
    });
  });
```

- [ ] **Step 2: Run, confirm FAIL** — `cd firefox-extension && npx jest __tests__/snapshot-script.test.ts -t "3-slot grammar"` → FAIL (old grammar has no ` | ` slots).

- [ ] **Step 3: Add the inner helpers.** Insert this block immediately after `getStateFlags` returns (after `:305`, before the `// --- 1. clear stale uids` comment at `:307`):

```ts
  const VALUE_MAX = 80;
  const SECTION_MAX = 60;

  function formatSlot(s: string, max: number): string {
    // Collapse whitespace, neutralize the slot delimiter (a literal "|" inside a
    // slot would make the row ambiguous — collapse it to "/"), then clip to the
    // slot budget.
    const cleaned = collapseWhitespace(s).replace(/\|/g, "/");
    if (cleaned.length > max) {
      return cleaned.slice(0, max);
    }
    return cleaned;
  }

  function getCurrentValue(el: Element, role: string): string {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") {
      return (el as HTMLTextAreaElement).value || "";
    }
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      // Checkbox/radio carry their state in flags; button/file/hidden/image have
      // no displayable value. Only text-entry inputs contribute a value slot.
      if (
        type === "checkbox" ||
        type === "radio" ||
        type === "button" ||
        type === "submit" ||
        type === "reset" ||
        type === "hidden" ||
        type === "file" ||
        type === "image"
      ) {
        return "";
      }
      return (el as HTMLInputElement).value || "";
    }
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const opts = sel.selectedOptions;
      if (opts && opts.length > 0 && opts[0].textContent) {
        return opts[0].textContent;
      }
      const idx = sel.selectedIndex;
      if (
        idx >= 0 &&
        sel.options &&
        sel.options[idx] &&
        sel.options[idx].textContent
      ) {
        return sel.options[idx].textContent as string;
      }
      return "";
    }
    // Custom-combobox handling is added in Task 12.
    return "";
  }

  function makeRow(
    el: Element,
    role: string,
    name: string,
    value: string,
    section: string,
    flags: string[],
    uid: string
  ): string {
    // el is part of the shared signature both the base and pointer passes call
    // through; every slot is precomputed by the caller, so el is not read here.
    const nameSlot = formatSlot(name, NAME_MAX);
    const valueClean = formatSlot(value, VALUE_MAX);
    const sectionSlot = formatSlot(section, SECTION_MAX);
    // Drop a value that merely repeats the name (a bare custom combobox whose
    // only signal is its placeholder ends up in both — show it once, as name).
    const valueSlot =
      valueClean && valueClean !== nameSlot ? '"' + valueClean + '"' : "";
    let line =
      role +
      ' "' +
      nameSlot +
      '" | ' +
      valueSlot +
      " | " +
      sectionSlot +
      " [uid=" +
      uid +
      "]";
    if (flags.length > 0) {
      line += " (" + flags.join(", ") + ")";
    }
    return line;
  }
```

- [ ] **Step 4: Swap the base-pass assembly.** Replace the base-pass line builder (`:445-449`) — from:
```ts
    let line = role + ' "' + name + '" [uid=' + uid + "]";
    if (flags.length > 0) {
      line += " (" + flags.join(", ") + ")";
    }
    lines.push(line);
```
to:
```ts
    lines.push(
      makeRow(el, role, name, getCurrentValue(el, role), "", flags, uid)
    );
```
(The `const flags = getStateFlags(el, role);` line just above is unchanged.)

- [ ] **Step 5: Update the base-pass assertions that included `[uid=` immediately after the name** (they now have ` |  | ` between name and `[uid=`). Apply these edits in `snapshot-script.test.ts`:
  - L22: `'link "Home" [uid=e1]'` → `'link "Home" |  |  [uid=e1]'`
  - L28: `'button "Sign in" [uid=e1]'` → `'button "Sign in" |  |  [uid=e1]'`
  - L37: `'textbox "Email" [uid='` → `'textbox "Email" |  |  [uid='`
  - L59: `'tab "Settings" [uid='` → `'tab "Settings" |  |  [uid='`
  - L128: `'textbox "Email" [uid=e1] (required)'` → `'textbox "Email" |  |  [uid=e1] (required)'`
  - L129: `/checkbox "Agree" \[uid=e\d+\] \(checked\)/` → `/checkbox "Agree" \|  \|  \[uid=e\d+\] \(checked\)/`
  - L130: `/button "Submit" \[uid=e\d+\] \(disabled\)/` → `/button "Submit" \|  \|  \[uid=e\d+\] \(disabled\)/`
  - L148: `/button "Nope" \[uid=e\d+\] \(disabled\)/` → `/button "Nope" \|  \|  \[uid=e\d+\] \(disabled\)/`
  - L182: `'textbox "Full name" [uid='` → `'textbox "Full name" |  |  [uid='`
  - L375 (selector mode, base pass): `/textbox "Message input" \[uid=e\d+\]/` → `/textbox "Message input" \|  \|  \[uid=e\d+\]/`
  - L405 (textContains mode, base pass): `/clickable "Open" \[uid=e\d+\]/` → `/clickable "Open" \|  \|  \[uid=e\d+\]/`

- [ ] **Step 6: Rewrite the native-select "does not absorb" test (L291-304)** — the option text now legitimately appears in the **value** slot; the intent (name not polluted) is preserved:
```ts
  it("keeps the wrapping-label name in the name slot and shows the selected option in the value slot", () => {
    document.body.innerHTML = `
      <label>Country
        <select>
          <option>United States</option>
          <option>Canada</option>
        </select>
      </label>
    `;
    const { tree } = build();
    // Name slot is the label text only; the selected option surfaces in VALUE.
    expect(tree).toContain('combobox "Country" | "United States" |');
    // The name slot must NOT absorb the option text.
    expect(tree).not.toContain('combobox "Country United States"');
    // Value is shown once (dedup does not fire here — name != value).
    expect(tree).not.toContain('| "United States" | "United States"');
    // Canada is not selected → must not appear anywhere.
    expect(tree).not.toContain("Canada");
  });
```

- [ ] **Step 7: Run, confirm PASS** — `cd firefox-extension && npx jest __tests__/snapshot-script.test.ts` → PASS. Also `npx jest __tests__/self-containment.test.ts` → PASS (new inner helpers introduce no forbidden tokens).

- [ ] **Step 8: Commit** — `git add firefox-extension/injected/snapshot-script.ts firefox-extension/__tests__/snapshot-script.test.ts && git commit -m "feat(snapshot): 3-slot grammar + makeRow + native getCurrentValue (firefox base pass)"`

---

### Task 12: react-select name probing (FIX 1/2) + custom-combobox value branch (Firefox)

Makes a `<div role="combobox">` (react-select) nameable and value-bearing: probe **child** placeholder/value nodes for the name, widen the textContent fallback to combobox/textbox (explicit-role only), and read the current value from ARIA / `singleValue` / placeholder children.

**Files:**
- Modify: `firefox-extension/injected/snapshot-script.ts` — add `childValueText` inner helper; edit `getAccessibleName` tail (`:248-262`); add the custom-combobox branch to `getCurrentValue` (before its final `return "";`).
- Test: `firefox-extension/__tests__/snapshot-script.test.ts`.

**Interfaces:**
- Produces: `childValueText(el: Element): string` (inner) — text of a child `[class*="singleValue"]` / `[class*="single-value"]`, else child `[class*="placeholder"]`, else `""`.
- Modifies: `getAccessibleName` (name FIX 1 + FIX 2), `getCurrentValue` (custom-combobox branch).
- Consumes: `collapseWhitespace`, `clip`.

- [ ] **Step 1: Write the failing tests:**
```ts
  describe("custom combobox (react-select) enrichment (Wave 2)", () => {
    it("names a bare react-select from its placeholder child and shows it once (dedup)", () => {
      document.body.innerHTML = `
        <div role="combobox">
          <div class="Select__placeholder">Select a country...</div>
        </div>`;
      const { tree } = build();
      // Placeholder is the only signal → it names the control; the value slot is
      // deduped away (value === name) so it appears exactly once.
      expect(tree).toContain('combobox "Select a country..." |  |  [uid=e1]');
    });

    it("shows the selected value (singleValue child) in the value slot", () => {
      document.body.innerHTML = `
        <div role="combobox" aria-label="Country">
          <div class="Select__single-value">United States</div>
        </div>`;
      const { tree } = build();
      expect(tree).toContain('combobox "Country" | "United States" |  [uid=e1]');
    });

    it("reads aria-valuetext as the value when present", () => {
      document.body.innerHTML = `<div role="combobox" aria-label="Plan" aria-valuetext="Enterprise"></div>`;
      const { tree } = build();
      expect(tree).toContain('combobox "Plan" | "Enterprise" |  [uid=e1]');
    });

    it("widens the textContent fallback to an explicit-role combobox with no attrs/children", () => {
      document.body.innerHTML = `<div role="combobox">Account-scoped</div>`;
      const { tree } = build();
      expect(tree).toContain('combobox "Account-scoped" |  |  [uid=e1]');
    });
  });
```

- [ ] **Step 2: Run, confirm FAIL** — `cd firefox-extension && npx jest __tests__/snapshot-script.test.ts -t "custom combobox"` → FAIL.

- [ ] **Step 3: Add `childValueText`** into the inner-helper block (next to `getCurrentValue`):
```ts
  function childValueText(el: Element): string {
    // react-select / Downshift render the selected value or placeholder in CHILD
    // nodes rather than an attribute; surface them so a bare combobox is nameable.
    const single = el.querySelector(
      '[class*="singleValue"], [class*="single-value"]'
    );
    if (single && collapseWhitespace(single.textContent || "")) {
      return single.textContent || "";
    }
    const ph = el.querySelector('[class*="placeholder"]');
    if (ph && collapseWhitespace(ph.textContent || "")) {
      return ph.textContent || "";
    }
    return "";
  }
```

- [ ] **Step 4: Edit `getAccessibleName` tail** (`:248-262`) — replace from the `placeholder` attribute check through the trailing `return "";` with:
```ts
    const placeholder = el.getAttribute("placeholder");
    if (placeholder && collapseWhitespace(placeholder)) {
      return clip(placeholder);
    }

    // FIX 1: custom comboboxes (react-select) keep their label/value/placeholder
    // in CHILD nodes, not attributes — probe them for combobox/textbox roles.
    if (role === "combobox" || role === "textbox") {
      const childName = childValueText(el);
      if (collapseWhitespace(childName)) {
        return clip(childName);
      }
    }

    // Only fall back to raw textContent for roles where the text is the label
    // (avoid dumping the contents of large containers). FIX 2 widens this to
    // custom (explicit-role) combobox/textbox — but NEVER native
    // select/textarea/input, whose textContent is option/child noise.
    const hasExplicitRole = !!el.getAttribute("role");
    if (
      role === "link" ||
      role === "button" ||
      role === "heading" ||
      ((role === "combobox" || role === "textbox") && hasExplicitRole)
    ) {
      const text = el.textContent || "";
      if (collapseWhitespace(text)) {
        return clip(text);
      }
    }

    return "";
```

- [ ] **Step 5: Add the custom-combobox branch to `getCurrentValue`** — replace its final `// Custom-combobox handling is added in Task 12.\n    return "";` tail with:
```ts
    // Custom combobox (react-select and similar): value in ARIA or child nodes.
    if (role === "combobox") {
      const valueText = el.getAttribute("aria-valuetext");
      if (valueText && collapseWhitespace(valueText)) {
        return valueText;
      }
      const valueNow = el.getAttribute("aria-valuenow");
      if (valueNow && collapseWhitespace(valueNow)) {
        return valueNow;
      }
      const single = el.querySelector(
        '[class*="singleValue"], [class*="single-value"]'
      );
      if (single && collapseWhitespace(single.textContent || "")) {
        return single.textContent || "";
      }
      // Nothing selected → the placeholder identifies the empty control.
      const ph = el.querySelector('[class*="placeholder"]');
      if (ph && collapseWhitespace(ph.textContent || "")) {
        return ph.textContent || "";
      }
      const phAttr = el.getAttribute("placeholder");
      if (phAttr && collapseWhitespace(phAttr)) {
        return phAttr;
      }
    }
    return "";
```

- [ ] **Step 6: Run, confirm PASS** — `cd firefox-extension && npx jest __tests__/snapshot-script.test.ts` → PASS (new suite green; the existing `region`/`prefers aria-label` tests are unaffected — FIX 1/2 are gated to combobox/textbox roles, and the placeholder attribute still is NOT read into the value slot for native text inputs). Also `npx jest __tests__/self-containment.test.ts` → PASS.

- [ ] **Step 7: Commit** — `git add firefox-extension/injected/snapshot-script.ts firefox-extension/__tests__/snapshot-script.test.ts && git commit -m "feat(snapshot): react-select name child-probe + custom-combobox value slot (firefox)"`

---

### Task 13: `getSection` breadcrumb + wire into base pass (Firefox)

Fills the third slot: nearest titled context (fieldset legend → titled container → ancestor heading walk). This is what disambiguates the repeated "Use template" buttons and Account-vs-Zone resources.

**Files:**
- Modify: `firefox-extension/injected/snapshot-script.ts` — add `isHeading` + `getSection` inner helpers; change the base-pass `makeRow` call's section arg from `""` to `getSection(el)`.
- Test: `firefox-extension/__tests__/snapshot-script.test.ts`.

**Interfaces:**
- Produces: `isHeading(el: Element): boolean`; `getSection(el: Element): string` (inner).
- Consumes: `collapseWhitespace`, `nameFromLabelledBy` (reused on the matched container element).

- [ ] **Step 1: Write the failing tests:**
```ts
  describe("section breadcrumb slot (Wave 2)", () => {
    it("uses a fieldset legend as the breadcrumb", () => {
      document.body.innerHTML = `
        <fieldset>
          <legend>Billing address</legend>
          <input type="text" aria-label="Street" />
        </fieldset>`;
      const { tree } = build();
      expect(tree).toContain('textbox "Street" |  | Billing address [uid=e1]');
    });

    it("uses a titled card's heading as the breadcrumb (disambiguates repeats)", () => {
      document.body.innerHTML = `
        <div class="card"><h3>Zone resources</h3><button>Use template</button></div>
        <div class="card"><h3>Account resources</h3><button>Use template</button></div>`;
      const { tree } = build();
      expect(tree).toContain('button "Use template" |  | Zone resources [uid=e1]');
      expect(tree).toContain('button "Use template" |  | Account resources [uid=e2]');
    });

    it("uses aria-labelledby on a titled container", () => {
      document.body.innerHTML = `
        <h2 id="sec">API tokens</h2>
        <div role="group" aria-labelledby="sec"><button>Create</button></div>`;
      const { tree } = build();
      expect(tree).toContain('button "Create" |  | API tokens [uid=');
    });

    it("walks ancestors + previous siblings to the nearest heading when no container matches", () => {
      document.body.innerHTML = `
        <h2>Account settings</h2>
        <div><button>Save</button></div>`;
      const { tree } = build();
      expect(tree).toContain('button "Save" |  | Account settings [uid=e1]');
    });

    it("leaves the breadcrumb empty when there is no titled context", () => {
      document.body.innerHTML = `<button>Standalone</button>`;
      const { tree } = build();
      expect(tree).toContain('button "Standalone" |  |  [uid=e1]');
    });
  });
```

- [ ] **Step 2: Run, confirm FAIL** — `cd firefox-extension && npx jest __tests__/snapshot-script.test.ts -t "section breadcrumb"` → FAIL (section arg is still `""`).

- [ ] **Step 3: Add `isHeading` + `getSection`** into the inner-helper block:
```ts
  function isHeading(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      return true;
    }
    return el.getAttribute("role") === "heading";
  }

  function getSection(el: Element): string {
    // 1. fieldset > legend
    const fs = el.closest("fieldset");
    if (fs) {
      const legend = fs.querySelector("legend");
      if (legend && collapseWhitespace(legend.textContent || "")) {
        return legend.textContent || "";
      }
    }
    // 2. nearest titled container: section / role=group / *card* / labelledby.
    const container = el.closest(
      'section,[role="group"],[class*="card"],[aria-labelledby]'
    );
    if (container) {
      const labelled = nameFromLabelledBy(container);
      if (collapseWhitespace(labelled)) {
        return labelled;
      }
      const heading = container.querySelector(
        'h1,h2,h3,h4,h5,h6,[role="heading"]'
      );
      if (heading && collapseWhitespace(heading.textContent || "")) {
        return heading.textContent || "";
      }
    }
    // 3. ancestor + previousElementSibling walk for the nearest heading.
    let node: Element | null = el.parentElement;
    while (node) {
      let sib: Element | null = node.previousElementSibling;
      while (sib) {
        if (isHeading(sib) && collapseWhitespace(sib.textContent || "")) {
          return sib.textContent || "";
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  }
```

- [ ] **Step 4: Wire it into the base pass.** Change the base-pass `makeRow` call (from Task 11) so the section arg is `getSection(el)`:
```ts
    lines.push(
      makeRow(el, role, name, getCurrentValue(el, role), getSection(el), flags, uid)
    );
```

- [ ] **Step 5: Run, confirm PASS** — `cd firefox-extension && npx jest __tests__/snapshot-script.test.ts` → PASS. The Task-11 empty-section fixtures (link/button with no titled ancestor) still render `|  |  [uid=` because `getSection` returns `""` for them; no earlier assertion regresses. Also `npx jest __tests__/self-containment.test.ts` → PASS.

- [ ] **Step 6: Commit** — `git add firefox-extension/injected/snapshot-script.ts firefox-extension/__tests__/snapshot-script.test.ts && git commit -m "feat(snapshot): getSection breadcrumb slot wired into base pass (firefox)"`

---

### Task 14: pointer-pass grammar swap (Firefox)

Route the second (cursor:pointer) pass through the same `makeRow`, so `<div onClick>` clickables get identical grammar (value/section slots too).

**Files:**
- Modify: `firefox-extension/injected/snapshot-script.ts` — swap the pointer-pass line assembly (`:538-542`).
- Test: `firefox-extension/__tests__/snapshot-script.test.ts`.

**Interfaces:** consumes `makeRow`, `getCurrentValue`, `getSection` (Tasks 11–13). Produces no new symbol.

- [ ] **Step 1: Update the breaking pointer-pass assertions** (they matched the old inline `clickable "name" [uid=` grammar):
  - L336 (`includePointer` default): `/clickable "Open" \[uid=e\d+\]/` → `/clickable "Open" \|  \|  \[uid=e\d+\]/`
  - L570-573 (both the verbose and default lines): `/clickable "Click me" \[uid=e\d+\]/` → `/clickable "Click me" \|  \|  \[uid=e\d+\]/`
  - L579: `/clickable "Open menu" \[uid=e\d+\]/` → `/clickable "Open menu" \|  \|  \[uid=e\d+\]/`
  - L610: `/clickable "Outer" \[uid=e\d+\]/` → `/clickable "Outer" \|  \|  \[uid=e\d+\]/`
  - L638: `/clickable "Toggle" \[uid=e\d+\] \(expanded\)/` → `/clickable "Toggle" \|  \|  \[uid=e\d+\] \(expanded\)/`
  (Prefix-only pointer assertions — `/clickable "P\d"/g` at L358, the negative `not.toMatch(/clickable ""/)` / `/clickable "Wrapper text"/` / `/clickable "Only Once"/` — are unaffected and stay as-is.)

- [ ] **Step 2: Add a pointer-pass grammar test** to make the swap observable directly:
```ts
    it("emits full 3-slot grammar for a cursor:pointer clickable", () => {
      document.body.innerHTML = `<div class="card"><h3>Templates</h3><div style="cursor: pointer">Use this</div></div>`;
      const { tree } = build(true);
      expect(tree).toContain('clickable "Use this" |  | Templates [uid=');
    });
```

- [ ] **Step 3: Run, confirm FAIL** — `cd firefox-extension && npx jest __tests__/snapshot-script.test.ts -t "3-slot grammar for a cursor"` → FAIL (pointer pass still emits old grammar).

- [ ] **Step 4: Swap the pointer-pass assembly** (`:538-542`) — from:
```ts
      let line = 'clickable "' + name + '" [uid=' + uid + "]";
      if (flags.length > 0) {
        line += " (" + flags.join(", ") + ")";
      }
      lines.push(line);
```
to:
```ts
      lines.push(
        makeRow(
          el,
          "clickable",
          name,
          getCurrentValue(el, "clickable"),
          getSection(el),
          flags,
          uid
        )
      );
```
(The preceding `const flags = getStateFlags(el, "clickable");`, `uidCounter += 1;`, `const uid = ...`, `el.setAttribute(UID_ATTR, uid);`, `added += 1;` lines are unchanged.)

- [ ] **Step 5: Run, confirm PASS** — `cd firefox-extension && npx jest __tests__/snapshot-script.test.ts` → PASS. Also `npx jest __tests__/self-containment.test.ts` → PASS.

- [ ] **Step 6: Commit** — `git add firefox-extension/injected/snapshot-script.ts firefox-extension/__tests__/snapshot-script.test.ts && git commit -m "feat(snapshot): pointer pass uses shared makeRow grammar (firefox)"`

---

### Task 15: byte-identical mirror to Chrome + Chrome test update + full verify

Paste the identical helper/edit bodies into the Chrome copy and update the Chrome suite. This is the reconciliation step that restores the byte-identical-body invariant between the two `injected/snapshot-script.ts` files.

**Files:**
- Modify: `chrome-extension/injected/snapshot-script.ts` (byte-identical body edits — the file's leading doc-comment may stay Chrome-specific).
- Modify: `chrome-extension/__tests__/snapshot-script.test.ts`.
- Verify (no edit): `firefox-extension/__tests__/self-containment.test.ts`.

**Interfaces:** none new — mirror only.

- [ ] **Step 1: Paste the identical bodies into `chrome-extension/injected/snapshot-script.ts`.** Apply Tasks 11–14 verbatim at the matching Chrome line numbers (they are the same, offset by the 1-line-shorter header): the inner-helper block (`VALUE_MAX`/`SECTION_MAX`/`formatSlot`/`getCurrentValue`/`childValueText`/`makeRow`/`isHeading`/`getSection`) after `getStateFlags` (Chrome `:305`); the `getAccessibleName` tail edit (Chrome `:248-262`); the base-pass assembly swap (Chrome `:445-449`); the pointer-pass assembly swap (Chrome `:538-542`). **The function bodies must be byte-identical to Firefox's** (only the top-of-file doc-comment differs).

- [ ] **Step 2: Update the Chrome suite** (`chrome-extension/__tests__/snapshot-script.test.ts`) breaking assertions:
  - L14: `/clickable "Open" \[uid=e\d+\]/` → `/clickable "Open" \|  \|  \[uid=e\d+\]/`
  - L30: `'link "Home" [uid=e1]'` → `'link "Home" |  |  [uid=e1]'`
  - L31: `'button "Go" [uid=e2]'` → `'button "Go" |  |  [uid=e2]'`
  - L46: `/textbox "Message input" \[uid=e\d+\]/` → `/textbox "Message input" \|  \|  \[uid=e\d+\]/`
  - L76: `/clickable "Open" \[uid=e\d+\]/` → `/clickable "Open" \|  \|  \[uid=e\d+\]/`
  (L48 `not.toContain('button "Send"')`, L94-96, L111, the paging/error blocks are prefix/negative/substring assertions and stay as-is.)

- [ ] **Step 3: Add parity tests to the Chrome suite** (mirror the Firefox grammar/value/section coverage so the byte-identical body is exercised on both sides):
```ts
  describe("3-slot grammar parity (Wave 2)", () => {
    it("emits empty value/section slots on a plain button", () => {
      document.body.innerHTML = `<button>Sign in</button>`;
      const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
      expect(tree).toContain('button "Sign in" |  |  [uid=e1]');
    });
    it("shows a native select's selected option in the value slot", () => {
      document.body.innerHTML = `<select aria-label="Country"><option>US</option></select>`;
      const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
      expect(tree).toContain('combobox "Country" | "US" |  [uid=e1]');
    });
    it("shows a react-select singleValue and a card breadcrumb", () => {
      document.body.innerHTML = `
        <div class="card"><h3>Billing</h3>
          <div role="combobox" aria-label="Country"><div class="Select__single-value">United States</div></div>
        </div>`;
      const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
      expect(tree).toContain('combobox "Country" | "United States" | Billing [uid=');
    });
  });
```

- [ ] **Step 4: Run both suites + self-containment** — `cd chrome-extension && npx jest __tests__/snapshot-script.test.ts` → PASS; `cd firefox-extension && npx jest` → PASS (all suites incl. `self-containment.test.ts`). Optionally diff the two bodies to confirm byte-identity: `diff <(sed -n '/export function buildSnapshot/,$p' firefox-extension/injected/snapshot-script.ts) <(sed -n '/export function buildSnapshot/,$p' chrome-extension/injected/snapshot-script.ts)` → empty.

- [ ] **Step 5: Build both extensions** — `cd firefox-extension && npm run build`; `cd chrome-extension && npm run build` → compile clean.

- [ ] **Step 6: Commit** — `git add chrome-extension/injected/snapshot-script.ts chrome-extension/__tests__/snapshot-script.test.ts && git commit -m "feat(snapshot): byte-identical 3-slot grammar mirror to chrome + tests"`

---

### Wave 2 self-review

- **Grammar locked:** `role "name" | valueSlot | sectionSlot [uid=eN] (flags)`, delimiter ` | ` always emitted, empty slots empty. Matches the approved preview `button "Sign in" |  | Account [uid=e15]` byte-for-byte.
- **`makeRow` signature** exactly `makeRow(el, role, name, value, section, flags, uid)` per spec §C. `el` unused (reserved) — compiles because neither tsconfig enables `noUnusedParameters` and `strict` does not include it.
- **Self-containment:** every new helper is an inner function of `buildSnapshot`; no forbidden tokens (`require(`/`import `/`exports.`/`module.exports`/`__name`/…) appear in the code or comments. `buildSnapshot` stays registered in `INJECTED_FUNCTIONS` (no edit).
- **jsdom-testable:** all logic is attribute/DOM-structure based; verified `.value`, `.selectedOptions`, `.closest`, `[class*=...]` child queries work under jsdom.
- **Byte-identical:** Firefox authored (11–14), Chrome mirrored + verified via `diff` (15).
- **Value-vs-name dedup** prevents `combobox "Select..." | "Select..." | …` for bare react-selects.


## Wave 3a — Click interception detection

**Outcome:** Before dispatching a `click-element`, FoxPilot hit-tests the target's center with `document.elementFromPoint`. When a **foreign** element (an overlay/cookie-banner/modal) is the topmost node covering the target, the result carries an additive `intercepted` descriptor and the `click-element` tool text shows a prominent `⚠ click may be intercepted by <selector> — consider dismiss-overlays` note. The click still fires and stays `ok:true` by default; an opt-in `failIfIntercepted:true` turns it into a hard `ok:false` naming the covering selector. The decision logic is a **pure** `classifyHit(target, topmost)` (elementFromPoint is called by the caller and the node handed in), so it is jsdom-unit-testable with fabricated nodes; the real geometry is Playwright-covered.

**Scope guard (overlap with Wave 3b):** Wave 3a and Wave 3b (`select-option`/`dismiss-overlays`) both edit `injected/action-script.ts`? No — 3b adds NEW injected files, but they DO share `common/extension-messages.ts` (`ActionResultExtensionMessage`), both `message-handler.ts`, and `mcp-server/server.ts`. Wave 3a touches ONLY: the `click-element` arm of `performInputAction`, the `click-element` dispatch case + `runInputAction` forwarding, the `click-element` server tool, `ClickElementServerMessage`, and `ActionResultExtensionMessage.intercepted?`. It does **not** touch `select-option`/`dismiss-overlays`, the cmd union, `extension-config.ts`, or `browser-api` methods other than `clickElement`. Add `ActionResultExtensionMessage.intercepted?` as the FIRST new optional after the existing `navigated?`; Wave 3b appends `selected?`/`dismissed?`/`method?` AFTER it (append-only, no reorder).

> Branch: the wave executes on the shared cloudflare-fixes feature branch. Commit after every task. Run tests per package: `cd firefox-extension && npx jest`, `cd chrome-extension && npx jest`, `cd mcp-server && npx jest`. Playwright runs via its own `npm run test:e2e` (Wave 0), NOT the release-blocking jest path.

---

### Task 21: Pure `classifyHit` classifier + jsdom unit tests (both extensions)

**Files:**
- Modify: `firefox-extension/injected/action-script.ts` (append an exported `classifyHit` after `performInputAction`, ~after line 393)
- Modify: `chrome-extension/injected/action-script.ts` (byte-identical append after `performInputAction`, ~after line 392)
- Modify (test): `firefox-extension/__tests__/action-script.test.ts` (add a `classifyHit` describe block)
- Create (test): `chrome-extension/__tests__/action-script.test.ts` (NEW — Chrome has no action-script suite today; mirror the `classifyHit` tests against Chrome's copy so its byte-identical export is independently guarded, matching the existing chrome `point-action-script.test.ts` / `snapshot-script.test.ts` mirrors)

**Interfaces:**
- Produces: `export function classifyHit(target: Element | null, topmost: Element | null): "self" | "ancestor" | "descendant" | "unrelated"` — pure, no `elementFromPoint`. Consumed by the unit tests here and mirrored as an inner twin inside `performInputAction` in Task 22.
- Consumes: nothing.

**Notes:**
- `classifyHit` is NOT injected — do **not** add it to `firefox-extension/__tests__/self-containment.test.ts` `INJECTED_FUNCTIONS`. Only `performInputAction` (which will carry an inner twin) is stringified into pages; the exported `classifyHit` exists purely so unit tests can exercise the decision logic directly (jsdom has no `elementFromPoint`, so testing it through `performInputAction` would require stubbing layout — the pure helper sidesteps that).
- `Element.prototype.contains(x)` returns true when `x === node` OR `x` is a descendant, so the ordered checks below classify cleanly.

- [ ] **Step 1: Write the failing test.** In `firefox-extension/__tests__/action-script.test.ts`, add the import and a new describe block (place after the existing `describe("performInputAction", …)` or as a sibling top-level block):

```ts
import { performInputAction, classifyHit } from "../injected/action-script";

describe("classifyHit (pure interception classifier)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns 'self' when topmost IS the target", () => {
    document.body.innerHTML = `<button>Go</button>`;
    const btn = document.querySelector("button")!;
    expect(classifyHit(btn, btn)).toBe("self");
  });

  it("returns 'descendant' when topmost is inside the target (inner label)", () => {
    document.body.innerHTML = `<button><span>Go</span></button>`;
    const btn = document.querySelector("button")!;
    const span = document.querySelector("span")!;
    expect(classifyHit(btn, span)).toBe("descendant");
  });

  it("returns 'ancestor' when the target is inside topmost (own wrapper/shadow host)", () => {
    document.body.innerHTML = `<div class="wrap"><button>Go</button></div>`;
    const wrap = document.querySelector(".wrap")!;
    const btn = document.querySelector("button")!;
    expect(classifyHit(btn, wrap)).toBe("ancestor");
  });

  it("returns 'unrelated' when topmost is a foreign overlay in a different subtree", () => {
    document.body.innerHTML =
      `<button>Go</button><div id="onetrust-banner-sdk">cookies</div>`;
    const btn = document.querySelector("button")!;
    const overlay = document.querySelector("#onetrust-banner-sdk")!;
    expect(classifyHit(btn, overlay)).toBe("unrelated");
  });

  it("returns 'self' (no false positive) when a node is null/indeterminate", () => {
    document.body.innerHTML = `<button>Go</button>`;
    const btn = document.querySelector("button")!;
    expect(classifyHit(btn, null)).toBe("self");
    expect(classifyHit(null, btn)).toBe("self");
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd firefox-extension && npx jest action-script` → FAIL (`classifyHit` is not exported).

- [ ] **Step 3: Add the exported `classifyHit`.** Append to the END of `firefox-extension/injected/action-script.ts` (after the closing brace of `performInputAction`):

```ts
/**
 * Pure hit-test classifier for click-interception detection. Given the intended
 * click `target` and the `topmost` element document.elementFromPoint returned at
 * the target's center, classify their DOM relationship. elementFromPoint is
 * deliberately NOT called here — the CALLER passes `topmost` in — so this stays a
 * pure function that jsdom unit tests exercise with fabricated nodes (jsdom has
 * no layout / no elementFromPoint). Only "unrelated" (a foreign overlay covering
 * the target) counts as an interception.
 *
 *   "self"        topmost IS the target.
 *   "descendant"  topmost is inside the target (e.g. an inner label) — the click
 *                 still lands on the target's own subtree; NOT intercepted.
 *   "ancestor"    the target is inside topmost (topmost is the target's own
 *                 wrapper / shadow host) — same subtree; NOT intercepted.
 *   "unrelated"   topmost is in a DIFFERENT subtree — a foreign overlay covers
 *                 the target. THIS is an interception.
 *
 * DUPLICATION NOTE: `performInputAction` carries a byte-identical INNER copy of
 * this body (it is stringified-and-injected and may not reference module scope).
 * Keep the two in sync.
 */
export function classifyHit(
  target: Element | null,
  topmost: Element | null
): "self" | "ancestor" | "descendant" | "unrelated" {
  if (!target || !topmost) {
    return "self";
  }
  if (topmost === target) {
    return "self";
  }
  if (target.contains(topmost)) {
    return "descendant";
  }
  if (topmost.contains(target)) {
    return "ancestor";
  }
  return "unrelated";
}
```

- [ ] **Step 4: Run it, confirm it passes** — `cd firefox-extension && npx jest action-script` → PASS.

- [ ] **Step 5: Mirror the export to Chrome (byte-identical).** Append the SAME `classifyHit` (identical body; the doc-comment header may differ but keep it identical for simplicity) to the END of `chrome-extension/injected/action-script.ts`.

- [ ] **Step 6: Create the Chrome mirror test** `chrome-extension/__tests__/action-script.test.ts` with the SAME `classifyHit` describe block from Step 1 (import `{ classifyHit }` from `../injected/action-script`). This is a new file because Chrome has no action-script suite; keep it minimal (the `classifyHit` block only — the full `performInputAction` behavior is guarded by the Firefox suite + byte-identical mirroring, per the existing project posture).

- [ ] **Step 7: Run both, confirm PASS** — `cd chrome-extension && npx jest action-script` → PASS; `cd firefox-extension && npx jest action-script` → PASS. Confirm `cd firefox-extension && npx jest self-containment` still PASSES (unchanged — `classifyHit` is not injected).

- [ ] **Step 8: Commit** — `git add firefox-extension/injected/action-script.ts chrome-extension/injected/action-script.ts firefox-extension/__tests__/action-script.test.ts chrome-extension/__tests__/action-script.test.ts && git commit -m "feat(interception): pure classifyHit hit-test classifier + jsdom unit tests"`

---

### Task 22: Wire `elementFromPoint` + `intercepted` into the click arm; thread `failIfIntercepted` through both extensions

**Files:**
- Modify: `common/extension-messages.ts:102-110` (`ActionResultExtensionMessage` — add `intercepted?`)
- Modify: `common/server-messages.ts:93-98` (`ClickElementServerMessage` — add `failIfIntercepted?`)
- Modify: `firefox-extension/injected/action-script.ts` (`performInputAction` signature + click arm ~185-193 + inner helpers)
- Modify: `chrome-extension/injected/action-script.ts` (byte-identical mirror of the `performInputAction` edits)
- Modify: `chrome-extension/message-handler.ts:49-56` (`InputActionArgs` click arm), `:285-291` (click-element dispatch case), `:682-711` (`runInputAction` types + forward)
- Modify: `firefox-extension/message-handler.ts:296-302` (click-element dispatch case), `:765-794` (`runInputAction` types + forward)
- Modify (test): `firefox-extension/__tests__/action-script.test.ts` (add a `click interception` integration describe, stubbing `elementFromPoint`)
- Modify (test): `chrome-extension/__tests__/action-script.test.ts` (mirror the same integration describe)

**Interfaces:**
- Produces: `performInputAction`'s click arm now returns `{ ok: boolean; error?: string; intercepted?: { tag: string; id?: string; classes?: string; role?: string; name?: string } }`; the click-arg union arm gains `failIfIntercepted?: boolean`. `ActionResultExtensionMessage.intercepted?` and `ClickElementServerMessage.failIfIntercepted?` (contract verbatim). `runInputAction` forwards `intercepted` on `action-result`.
- Consumes: exported `classifyHit` semantics from Task 21 (re-stated as a byte-identical inner twin — the inner copy is what actually runs in the page).

- [ ] **Step 1: Add `intercepted?` to `ActionResultExtensionMessage`** (`common/extension-messages.ts`), immediately after `navigated?` (line 109), append-only:

```ts
export interface ActionResultExtensionMessage extends ExtensionMessageBase {
  resource: "action-result";
  ok: boolean;
  error?: string;
  // Set true when the input dispatched but the page began navigating before the
  // content-script ack could return (the click worked; the ack was lost to
  // page teardown). Append-only.
  navigated?: boolean;
  // Set (WITH ok:true — the click still dispatched) when a hit-test BEFORE the
  // click found a FOREIGN element covering the target's center: an overlay
  // (cookie banner, modal) is likely intercepting the click. `failIfIntercepted`
  // on the request turns this into ok:false instead. `classes` is the space-
  // joined class list; the server derives a selector for its warning. Append-
  // only. (Wave 3a. Wave 3b appends selected?/dismissed?/method? AFTER this.)
  intercepted?: {
    tag: string;
    id?: string;
    classes?: string;
    role?: string;
    name?: string;
  };
}
```

- [ ] **Step 2: Add `failIfIntercepted?` to `ClickElementServerMessage`** (`common/server-messages.ts:93-98`), append-only:

```ts
export interface ClickElementServerMessage extends ServerMessageBase {
  cmd: "click-element";
  tabId: number;
  uid: string;
  doubleClick?: boolean;
  // Opt-in: when true, a click whose target is covered by a foreign overlay
  // returns ok:false ("click intercepted by <selector>") instead of clicking
  // through. Default false → detect + report via action-result.intercepted but
  // still perform the click. (Wave 3a.)
  failIfIntercepted?: boolean;
}
```

- [ ] **Step 3: Write the failing integration test** in `firefox-extension/__tests__/action-script.test.ts` (inside `describe("performInputAction", …)` or as a sibling). jsdom has no `elementFromPoint` and returns zero rects, so stub BOTH:

```ts
describe("click interception (integration through performInputAction)", () => {
  // jsdom has no layout: stub elementFromPoint + a non-zero rect so the click
  // arm's hit-test path runs. The pure decision logic is unit-tested separately.
  function withHitTest(topmost: Element | null) {
    (document as unknown as {
      elementFromPoint: (x: number, y: number) => Element | null;
    }).elementFromPoint = () => topmost;
    jest.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 20, height: 20,
      right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
  }
  afterEach(() => {
    jest.restoreAllMocks();
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("flags intercepted (ok:true, still clicks) when a foreign overlay is topmost", () => {
    document.body.innerHTML =
      `<button>Go</button><div id="onetrust-banner-sdk" class="ot-sdk-row">cookies</div>`;
    const btn = document.querySelector("button")!;
    const overlay = document.querySelector("#onetrust-banner-sdk")!;
    btn.setAttribute(UID_ATTR, "e1");
    const onClick = jest.fn();
    btn.addEventListener("click", onClick);
    withHitTest(overlay);

    const res = performInputAction(document, { action: "click", uid: "e1" });

    expect(res.ok).toBe(true);
    expect(onClick).toHaveBeenCalled();               // default: clicks through
    expect(res.intercepted).toMatchObject({ tag: "div", id: "onetrust-banner-sdk" });
  });

  it("does NOT flag when the target itself is topmost", () => {
    document.body.innerHTML = `<button>Go</button>`;
    const btn = document.querySelector("button")!;
    btn.setAttribute(UID_ATTR, "e1");
    withHitTest(btn);
    const res = performInputAction(document, { action: "click", uid: "e1" });
    expect(res.ok).toBe(true);
    expect(res.intercepted).toBeUndefined();
  });

  it("does NOT flag when topmost is an inner descendant of the target", () => {
    document.body.innerHTML = `<button><span>Go</span></button>`;
    const btn = document.querySelector("button")!;
    const span = document.querySelector("span")!;
    btn.setAttribute(UID_ATTR, "e1");
    withHitTest(span);
    const res = performInputAction(document, { action: "click", uid: "e1" });
    expect(res.intercepted).toBeUndefined();
  });

  it("returns ok:false and does NOT click when failIfIntercepted is set and covered", () => {
    document.body.innerHTML =
      `<button>Go</button><div id="onetrust-banner-sdk">cookies</div>`;
    const btn = document.querySelector("button")!;
    const overlay = document.querySelector("#onetrust-banner-sdk")!;
    btn.setAttribute(UID_ATTR, "e1");
    const onClick = jest.fn();
    btn.addEventListener("click", onClick);
    withHitTest(overlay);

    const res = performInputAction(document, {
      action: "click",
      uid: "e1",
      failIfIntercepted: true,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("click intercepted by #onetrust-banner-sdk");
    expect(res.intercepted).toMatchObject({ id: "onetrust-banner-sdk" });
    expect(onClick).not.toHaveBeenCalled();           // hard-fail dispatches nothing
  });
});
```

- [ ] **Step 4: Run it, confirm it fails** — `cd firefox-extension && npx jest action-script` → FAIL (`failIfIntercepted` not accepted; `res.intercepted` undefined).

- [ ] **Step 5: Edit `performInputAction` in `firefox-extension/injected/action-script.ts`.** Three edits, all byte-identical to Chrome later.

  **(5a) Signature — widen the click-arg arm and the return type** (lines 22-32). Change the `"click"` union arm and the return annotation:

```ts
export function performInputAction(
  doc: Document,
  args:
    | { action: "click"; uid: string; doubleClick?: boolean; failIfIntercepted?: boolean }
    | { action: "hover"; uid: string }
    | { action: "fill"; uid: string; value: string }
    | { action: "fill-form"; fields: { uid: string; value: string }[] }
    | { action: "type"; text: string; submit?: boolean }
    | { action: "press-key"; key: string; modifiers?: string[] }
    | { action: "drag"; fromUid: string; toUid: string }
): {
  ok: boolean;
  error?: string;
  intercepted?: {
    tag: string;
    id?: string;
    classes?: string;
    role?: string;
    name?: string;
  };
} {
```

  **(5b) Add the interception inner helpers** (place inside the function body among the other inner helpers — e.g. immediately after `dispatchClickSequence`, before `isCheckable`, ~after line 99). The inner `classifyHit` body is byte-identical to Task 21's exported one:

```ts
    // --- interception hit-test helpers (inner; classifyHit is a byte-identical
    //     twin of the exported module-scope classifyHit the unit tests import) ---

    function classifyHit(
      target: Element | null,
      topmost: Element | null
    ): "self" | "ancestor" | "descendant" | "unrelated" {
      if (!target || !topmost) {
        return "self";
      }
      if (topmost === target) {
        return "self";
      }
      if (target.contains(topmost)) {
        return "descendant";
      }
      if (topmost.contains(target)) {
        return "ancestor";
      }
      return "unrelated";
    }

    function describeIntercept(el: Element): {
      tag: string;
      id?: string;
      classes?: string;
      role?: string;
      name?: string;
    } {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? el.id : undefined;
      const clsAttr = (el.getAttribute("class") || "")
        .replace(/\s+/g, " ")
        .trim();
      const classes = clsAttr ? clsAttr : undefined;
      const role = el.getAttribute("role") || undefined;
      const ariaLabel = el.getAttribute("aria-label");
      const rawName =
        ariaLabel || (el.textContent || "").replace(/\s+/g, " ").trim();
      const name = rawName ? rawName.slice(0, 80) : undefined;
      return {
        tag: tag,
        ...(id ? { id: id } : {}),
        ...(classes ? { classes: classes } : {}),
        ...(role ? { role: role } : {}),
        ...(name ? { name: name } : {}),
      };
    }

    function selectorFor(desc: {
      tag: string;
      id?: string;
      classes?: string;
      role?: string;
      name?: string;
    }): string {
      if (desc.id) {
        return "#" + desc.id;
      }
      if (desc.classes) {
        return desc.tag + "." + desc.classes.split(" ")[0];
      }
      return desc.tag;
    }
```

  **(5c) Rewrite the `"click"` arm** (lines 185-193) to hit-test before dispatch:

```ts
    if (args.action === "click") {
      const el = resolve(args.uid);
      if (!el) {
        return notFound(args.uid);
      }
      scrollTo(el);
      // Interception hit-test BEFORE dispatch. elementFromPoint is called HERE
      // (the caller); the topmost node is handed to the PURE classifyHit, so the
      // decision logic is unit-testable. jsdom has no layout (elementFromPoint
      // undefined, zero rects) so this whole block no-ops there — existing click
      // tests are unaffected; real geometry is Playwright-covered.
      let intercepted:
        | {
            tag: string;
            id?: string;
            classes?: string;
            role?: string;
            name?: string;
          }
        | undefined;
      const efp = (doc as {
        elementFromPoint?: (x: number, y: number) => Element | null;
      }).elementFromPoint;
      if (typeof efp === "function") {
        try {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const topmost = efp.call(doc, cx, cy);
            if (topmost && classifyHit(el, topmost) === "unrelated") {
              intercepted = describeIntercept(topmost);
            }
          }
        } catch (e) {
          /* no layout / detached — skip the hit-test, never throw */
        }
      }
      if (intercepted && args.failIfIntercepted) {
        return {
          ok: false,
          intercepted: intercepted,
          error: "click intercepted by " + selectorFor(intercepted),
        };
      }
      dispatchClickSequence(el, args.doubleClick);
      return intercepted ? { ok: true, intercepted: intercepted } : { ok: true };
    }
```

  (Note the `r.width > 0 && r.height > 0` guard: an unrendered/zero-rect element would otherwise hit-test at (0,0) and false-positive on whatever sits at the viewport origin.)

- [ ] **Step 6: Run the Firefox tests** — `cd firefox-extension && npx jest action-script` → PASS; `cd firefox-extension && npx jest self-containment` → PASS (the inner helpers are still inner; no forbidden tokens). `cd firefox-extension && npm run build` → compiles.

- [ ] **Step 7: Mirror all three edits (5a/5b/5c) into `chrome-extension/injected/action-script.ts` — byte-identical bodies.** Everything from `export function performInputAction(` onward must match Firefox's file exactly (verify with `diff <(sed -n '22,$p' firefox-extension/injected/action-script.ts) <(sed -n '21,$p' chrome-extension/injected/action-script.ts)` → only the pre-`export` header comment differs). Add the SAME `click interception` integration describe (Step 3) to `chrome-extension/__tests__/action-script.test.ts`. Run `cd chrome-extension && npx jest action-script` → PASS.

- [ ] **Step 8: Extend Chrome's local `InputActionArgs`** (`chrome-extension/message-handler.ts:49-56`) — the click arm is a hand-maintained duplicate of `performInputAction`'s arg union (Firefox derives via `Parameters<>`, so Firefox needs no change here):

```ts
type InputActionArgs =
  | { action: "click"; uid: string; doubleClick?: boolean; failIfIntercepted?: boolean }
  | { action: "hover"; uid: string }
  | { action: "fill"; uid: string; value: string }
  | { action: "fill-form"; fields: { uid: string; value: string }[] }
  | { action: "type"; text: string; submit?: boolean }
  | { action: "press-key"; key: string; modifiers?: string[] }
  | { action: "drag"; fromUid: string; toUid: string };
```

- [ ] **Step 9: Pass `failIfIntercepted` in both click-element dispatch cases.** Chrome (`chrome-extension/message-handler.ts:285-291`) and Firefox (`firefox-extension/message-handler.ts:296-302`), identical shape:

```ts
      case "click-element":
        await this.runInputAction(req.correlationId, req.tabId, {
          action: "click",
          uid: req.uid,
          doubleClick: req.doubleClick,
          failIfIntercepted: req.failIfIntercepted,
        });
        break;
```

- [ ] **Step 10: Forward `intercepted` in Chrome `runInputAction`** (`chrome-extension/message-handler.ts:682-711`). Widen the `dispatchPromise` type (682-686) and the `result` type (700-701), then add an `intercepted` spread to the `action-result` send (leave the existing `navigated` cast-spread untouched):

```ts
    let dispatchPromise: Promise<{
      ok: boolean;
      error?: string;
      navigated?: boolean;
      intercepted?: {
        tag: string;
        id?: string;
        classes?: string;
        role?: string;
        name?: string;
      };
    }>;
    // ...(mode branches unchanged)...
    const result: {
      ok: boolean;
      error?: string;
      navigated?: boolean;
      intercepted?: {
        tag: string;
        id?: string;
        classes?: string;
        role?: string;
        name?: string;
      };
    } = await raceInputAgainstNavigation(tabId, dispatchPromise);

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: result.ok,
      error: result.error,
      ...((result as { navigated?: boolean }).navigated !== undefined
        ? { navigated: (result as { navigated?: boolean }).navigated }
        : {}),
      ...(result.intercepted !== undefined
        ? { intercepted: result.intercepted }
        : {}),
    });
```

  (`sendMessageToTab` returns `Promise<any>` and `runHumanInputAction`/`runNativeInputAction` return `Promise<any>`, so the widened `dispatchPromise` annotation assigns cleanly; `raceInputAgainstNavigation<T>` returns `T | {ok:true;navigated:true}`, both assignable to the widened `result` type. The default synthetic path routes the click's authoritative mutation through `performInputAction` via `runHumanInput`'s `deps.instant`, so `intercepted` is present at runtime; native-OS click uses a real sidecar gesture and simply carries no `intercepted` — additive, no regression.)

- [ ] **Step 11: Forward `intercepted` in Firefox `runInputAction`** (`firefox-extension/message-handler.ts:765-794`). Same widening; Firefox's result send already uses clean `result.navigated` access, so add the matching clean spread:

```ts
    let dispatchPromise: Promise<{
      ok: boolean;
      error?: string;
      navigated?: boolean;
      intercepted?: {
        tag: string;
        id?: string;
        classes?: string;
        role?: string;
        name?: string;
      };
    }>;
    // ...(mode branches unchanged; off-mode's `results[0] as StepResult` stays —
    //     StepResult is assignable to the widened type and the runtime object
    //     carries intercepted, read via the widened `result` annotation)...
    const result: {
      ok: boolean;
      error?: string;
      navigated?: boolean;
      intercepted?: {
        tag: string;
        id?: string;
        classes?: string;
        role?: string;
        name?: string;
      };
    } = await raceInputAgainstNavigation(tabId, dispatchPromise);

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: result.ok,
      error: result.error,
      ...(result.navigated !== undefined
        ? { navigated: result.navigated }
        : {}),
      ...(result.intercepted !== undefined
        ? { intercepted: result.intercepted }
        : {}),
    });
```

- [ ] **Step 12: Run both extensions + builds** — `cd firefox-extension && npx jest` → PASS; `cd chrome-extension && npx jest` → PASS; `cd firefox-extension && npm run build` and `cd chrome-extension && npm run build` → compile (the `common` union changes type-check; the `req.failIfIntercepted` in the dispatch cases resolves against the new `ClickElementServerMessage` field).

- [ ] **Step 13: Commit** — `git add common/extension-messages.ts common/server-messages.ts firefox-extension/injected/action-script.ts chrome-extension/injected/action-script.ts firefox-extension/message-handler.ts chrome-extension/message-handler.ts firefox-extension/__tests__/action-script.test.ts chrome-extension/__tests__/action-script.test.ts && git commit -m "feat(interception): hit-test the click arm, thread failIfIntercepted + intercepted through both extensions"`

---

### Task 23: Server surface — `browser-api.clickElement` + `click-element` tool output note + Playwright interception spec

**Files:**
- Modify: `mcp-server/browser-api.ts:513-530` (`clickElement`)
- Modify: `mcp-server/server.ts:402-420` (`click-element` tool schema + output + description)
- Create (test): `e2e/click-interception.spec.ts` (Playwright — the `e2e/` dir, `playwright.config.ts`, `test:e2e` script, and the `test-fixtures/spa-widgets/` fixture are created by Wave 0)
- Test: `cd mcp-server && npx jest` (type/build check — the server tool is not unit-tested in isolation; the ⚠ selector rule is covered end-to-end by the Playwright spec + manual regression)

**Interfaces:**
- Produces: `BrowserAPI.clickElement(tabId, uid, doubleClick?, failIfIntercepted?): Promise<{ navigated?: boolean; intercepted?: { tag; id?; classes?; role?; name? } }>`; the `click-element` tool text appends `⚠ click may be intercepted by <selector> — consider dismiss-overlays`.
- Consumes: `ActionResultExtensionMessage.intercepted?` (Task 22), `ClickElementServerMessage.failIfIntercepted?` (Task 22).

- [ ] **Step 1: Extend `browser-api.clickElement`** (`mcp-server/browser-api.ts:513-530`) — add the `failIfIntercepted` param, thread it, and return `intercepted`:

```ts
  async clickElement(
    tabId: number,
    uid: string,
    doubleClick?: boolean,
    failIfIntercepted?: boolean
  ): Promise<{
    navigated?: boolean;
    intercepted?: {
      tag: string;
      id?: string;
      classes?: string;
      role?: string;
      name?: string;
    };
  }> {
    const message = await this.sendTool<ActionResultExtensionMessage>({
      cmd: "click-element",
      tabId,
      uid,
      doubleClick,
      failIfIntercepted,
    });
    if (!message.ok) {
      // On a hard failure (failIfIntercepted:true + covered), the extension sets
      // error to "click intercepted by <selector>", so the throw already names
      // the overlay. A stale-uid failure throws its own message as before.
      throw new Error(message.error ?? "Action failed");
    }
    return { navigated: message.navigated, intercepted: message.intercepted };
  }
```

- [ ] **Step 2: Extend the `click-element` tool** (`mcp-server/server.ts:402-420`) — schema field, description sentence, and the ⚠ output note:

```ts
mcpServer.tool(
  "click-element",
  "Click an element on a page. Pass a 'uid' from a recent take-snapshot (e.g. e12). Set doubleClick to fire a double-click. Set failIfIntercepted:true to FAIL (instead of clicking through) when a foreign overlay covers the target — the result then names the covering selector so you can dismiss-overlays first. If the uid is stale, this returns an error asking you to take a fresh snapshot.",
  {
    tabId: z.number(),
    uid: z.string(),
    doubleClick: z.boolean().optional(),
    failIfIntercepted: z.boolean().optional(),
  },
  async ({ tabId, uid, doubleClick, failIfIntercepted }) => {
    const { navigated, intercepted } = await browserApi.clickElement(
      tabId,
      uid,
      doubleClick,
      failIfIntercepted
    );
    const verb = doubleClick ? "Double-clicked" : "Clicked";
    let text = navigated
      ? `${verb} element ${uid} (page navigated)`
      : `${verb} element ${uid}`;
    if (intercepted) {
      // Selector rule mirrors the injected selectorFor(): #id → tag.firstClass → tag.
      const sel = intercepted.id
        ? `#${intercepted.id}`
        : intercepted.classes
          ? `${intercepted.tag}.${intercepted.classes.split(" ")[0]}`
          : intercepted.tag;
      text += `\n⚠ click may be intercepted by ${sel} — consider dismiss-overlays`;
    }
    return { content: [{ type: "text", text }] };
  }
);
```

- [ ] **Step 3: Build the server** — `cd mcp-server && npm run build` → compiles (the `common` field additions type-check `browserApi.clickElement`'s return and the `intercepted` read). `cd mcp-server && npx jest` → PASS (no server unit test regressions).

- [ ] **Step 4: Write the Playwright interception spec** `e2e/click-interception.spec.ts`. It loads the Wave-0 `test-fixtures/spa-widgets/` fixture (which bundles the `#onetrust-banner-sdk` full-screen overlay over titled "Use template" cards), injects `performInputAction` into the page via Playwright's CDP-backed `page.evaluate` (CSP-immune, so it works even under the fixture's strict CSP — unlike `addScriptTag`), and asserts real interception geometry:

```ts
import { test, expect } from "@playwright/test";
import { performInputAction } from "../firefox-extension/injected/action-script";

// performInputAction is byte-identical between the two extensions; importing the
// Firefox copy exercises the shared body. UID attr must match the injected code.
const UID_ATTR = "data-bcmcp-uid";
const SRC = performInputAction.toString();

// Stamp `selector`'s first match with uid e1, then run performInputAction in-page.
async function clickInPage(
  page: import("@playwright/test").Page,
  selector: string,
  args: Record<string, unknown>
) {
  return page.evaluate(
    ({ src, uidAttr, selector, args }) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) throw new Error("fixture selector not found: " + selector);
      el.setAttribute(uidAttr, "e1");
      // eslint-disable-next-line no-eval
      const fn = (0, eval)("(" + src + ")");
      return fn(document, { action: "click", uid: "e1", ...args });
    },
    { src: SRC, uidAttr: UID_ATTR, selector, args }
  );
}

test.describe("click-element interception (real-browser hit-test)", () => {
  test("flags the foreign overlay covering a button (ok:true, still clicks)", async ({ page }) => {
    await page.goto("/"); // Wave-0 webServer serves the spa-widgets fixture
    await expect(page.locator("#onetrust-banner-sdk")).toBeVisible();

    const res = await clickInPage(page, "button.use-template", {});
    expect(res.ok).toBe(true);
    expect(res.intercepted).toBeTruthy();
    expect(res.intercepted.id).toBe("onetrust-banner-sdk");
  });

  test("failIfIntercepted returns ok:false naming the covering selector", async ({ page }) => {
    await page.goto("/");
    const res = await clickInPage(page, "button.use-template", { failIfIntercepted: true });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("click intercepted by #onetrust-banner-sdk");
  });

  test("no interception once the overlay is removed", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => document.querySelector("#onetrust-banner-sdk")?.remove());
    const res = await clickInPage(page, "button.use-template", {});
    expect(res.ok).toBe(true);
    expect(res.intercepted).toBeFalsy();
  });
});
```

  (Selectors `button.use-template` and `#onetrust-banner-sdk` must match the Wave-0 fixture markup; the scaffold specifies the overlay id `#onetrust-banner-sdk` and "Use template" buttons inside titled cards. If Wave 0 uses a different button class, update this spec's selector to match.)

- [ ] **Step 5: Run the Playwright spec** — `npm run test:e2e` (or `npx playwright test e2e/click-interception.spec.ts`) → PASS. This is NOT part of the release-blocking jest path.

- [ ] **Step 6: Commit** — `git add mcp-server/browser-api.ts mcp-server/server.ts e2e/click-interception.spec.ts && git commit -m "feat(interception): click-element failIfIntercepted + intercepted warning note + Playwright spec"`

---

### Wave 3a — done criteria
- `classifyHit` is exported + unit-tested (both extensions) and mirrored as an inner twin inside `performInputAction`.
- A `click-element` over a foreign overlay returns `ok:true` with `intercepted` and the tool shows `⚠ … — consider dismiss-overlays`; `failIfIntercepted:true` returns `ok:false` naming the selector and dispatches nothing.
- All jest suites green in `firefox-extension`, `chrome-extension`, `mcp-server`; `self-containment.test.ts` green; both extension builds + server build compile; the Playwright interception spec passes off the release path.
- Files touched stay within the 3a scope; `ActionResultExtensionMessage.intercepted?` is the first optional after `navigated?` (leaving room for Wave 3b's `selected?`/`dismissed?`/`method?`).


## Wave 3b — select-option + dismiss-overlays

**Spec:** §D (item 4, `select-option`) + §E part (b) (item 5b, `dismiss-overlays`).

Two NEW page tools, each a new `cmd`. **ONE implementer owns both cmds** — they share `common/server-messages.ts` (union), both `extension-config.ts`, `mcp-server/server.ts`, and `mcp-server/browser-api.ts`, so parallelizing them would collide. Tasks are ordered so **`select-option` lands fully wired + green (Tasks 26–27) before `dismiss-overlays` starts (Tasks 28–29)**; Task 30 adds the Playwright e2e specs. Each new `cmd` is wired **atomically** inside one task because the two compile-time tripwires (`switch(req.cmd)` `_exhaustiveCheck: never` + `COMMAND_TO_TOOL_ID: Record<ServerMessageRequest["cmd"], string>`) make the build RED between "add cmd to union" and "add both switch cases + both map entries" — you cannot split those across commits.

> **Source-verified corrections to the scaffold's Shared-Contracts block (both apply here):**
> 1. **`AVAILABLE_TOOLS` entry shape is `{ id: string; name: string; description: string }`** (`ToolInfo`), NOT "label + default-enabled". Default-enabled is derived (`getDefaultToolSettings()` sets every id `true`; `isToolEnabled` defaults `true`). Confirmed at `chrome-extension/extension-config.ts:37-228` and `firefox-extension/extension-config.ts:36-228`.
> 2. **`COMMAND_TO_TOOL_ID` values are kebab-case tool-ids equal to the cmd** (e.g. `"scroll-into-view": "scroll-into-view"`), NOT camelCase. So the entries are `"select-option": "select-option"` and `"dismiss-overlays": "dismiss-overlays"` — **not** `"selectOption"`/`"dismissOverlays"`. Confirmed at both `extension-config.ts:231-273`.

> **Async-injected-fn safety (verified):** `selectOption` is the first **async** stringified-and-injected function. esbuild builds with **no `--target`** (default `esnext`) and **no `keepNames`**, and both extension tsconfigs (used by ts-jest) target **ES2022** — so `.toString()` yields native `async function … await …` with **no `__awaiter`/`__generator`/`__async` helper leak**, in both the shipped build and the `self-containment.test.ts` guard. Firefox's **native** `browser.tabs.executeScript` awaits a trailing Promise and resolves to its value (the repo uses the raw `browser` global, not `webextension-polyfill`, so the polyfill caveat does not apply). Task 26 adds an explicit guard test locking this invariant.

---

### Task 26: Injected `selectOption` (both extensions) + jsdom unit tests + self-containment registration

**Files:**
- Create: `firefox-extension/injected/select-option-script.ts` (full body — authoring source)
- Create: `chrome-extension/injected/select-option-script.ts` (byte-identical body; header may differ)
- Create: `firefox-extension/__tests__/select-option-script.test.ts` (jsdom)
- Create: `chrome-extension/__tests__/select-option-script.test.ts` (jsdom; mirror)
- Modify: `firefox-extension/__tests__/self-containment.test.ts:41-77` (import + register `selectOption` in `INJECTED_FUNCTIONS`; add async-preservation guard)

**Interfaces:**
- Produces (verbatim per scaffold contract):
  ```ts
  export async function selectOption(
    doc: Document,
    args: { uid: string; option: string; exact?: boolean }
  ): Promise<{ ok: boolean; selected?: string; error?: string }>;
  ```
- Consumes: none (fully self-contained; mirrors `snapshot-script.ts` `isLeafTextMatch` deepest-wins pattern, `action-script.ts` `dispatchClickSequence`/`nativeSetValue`, `point-action-script.ts` `type-at` native-setter typing — all re-implemented as inner helpers).

- [ ] **Step 1: Write the failing jsdom test** — `firefox-extension/__tests__/select-option-script.test.ts`. Native `<select>` path + custom-combobox (pre-rendered option) path + deepest-wins leaf matching resolve synchronously (no 300ms sleeps hit when the option already exists at iter 0):

```ts
import { selectOption } from "../injected/select-option-script";

function mount(html: string): void {
  document.body.innerHTML = html;
}

test("native <select>: matches option by visible text, fires change, returns selected", async () => {
  mount(`<select data-bcmcp-uid="e1">
    <option value="us">United States</option>
    <option value="in">India</option>
  </select>`);
  const sel = document.querySelector("select")!;
  let changed = false;
  sel.addEventListener("change", () => { changed = true; });
  const r = await selectOption(document, { uid: "e1", option: "india" });
  expect(r.ok).toBe(true);
  expect((sel as HTMLSelectElement).value).toBe("in");
  expect(r.selected).toBe("India");
  expect(changed).toBe(true);
});

test("native <select>: matches by option value too", async () => {
  mount(`<select data-bcmcp-uid="e1"><option value="us">United States</option></select>`);
  const r = await selectOption(document, { uid: "e1", option: "us", exact: true });
  expect(r.ok).toBe(true);
  expect((document.querySelector("select") as HTMLSelectElement).value).toBe("us");
});

test("native <select>: no matching option → ok:false naming the control", async () => {
  mount(`<select data-bcmcp-uid="e1"><option value="us">United States</option></select>`);
  const r = await selectOption(document, { uid: "e1", option: "Zimbabwe" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("e1");
});

test("stale/missing uid → recoverable ok:false", async () => {
  mount(`<div></div>`);
  const r = await selectOption(document, { uid: "nope", option: "x" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("take a fresh snapshot");
});

test("custom combobox: clicks the leaf-matching [role=option] already in the DOM and re-reads value", async () => {
  // Trigger + an already-open portal listbox (option present at iter 0 → no sleep).
  mount(`
    <div data-bcmcp-uid="e1" role="combobox"><span class="select__singleValue"></span></div>
    <div role="listbox">
      <div role="option"><span>United States</span></div>
      <div role="option"><span>India</span></div>
    </div>`);
  const india = Array.from(document.querySelectorAll('[role="option"]'))
    .find((o) => (o.textContent || "").includes("India"))!;
  let clicked = false;
  india.addEventListener("click", () => {
    clicked = true;
    // Simulate the widget writing the chosen value into the singleValue child.
    (document.querySelector(".select__singleValue") as HTMLElement).textContent = "India";
  });
  const r = await selectOption(document, { uid: "e1", option: "India" });
  expect(clicked).toBe(true);
  expect(r.ok).toBe(true);
  expect(r.selected).toBe("India");
});

test("custom combobox: deepest-wins — a parent listbox row containing the needle is NOT matched over its leaf", async () => {
  mount(`
    <div data-bcmcp-uid="e1" role="combobox"></div>
    <ul role="listbox">
      <li role="option"><span>India</span><small>region</small></li>
    </ul>`);
  const leafClicks: string[] = [];
  document.querySelectorAll('[role="option"]').forEach((o) =>
    o.addEventListener("click", () => leafClicks.push("li"))
  );
  const r = await selectOption(document, { uid: "e1", option: "India" });
  expect(r.ok).toBe(true);
  expect(leafClicks).toEqual(["li"]); // the <li role=option> leaf (no descendant option) is the match
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd firefox-extension && npx jest select-option-script` → FAIL (module not found).

- [ ] **Step 3: Create `firefox-extension/injected/select-option-script.ts`** (COMPLETE, self-contained; no `import `/`require(`/`exports.` tokens):

```ts
/**
 * select-option injected executor (ISOLATED world, CSP-immune, async).
 *
 * Drives BOTH a native <select> and a custom combobox (react-select / Downshift /
 * Radix-shaped: a role="combobox"/button trigger that opens a role="listbox" of
 * role="option" items, often in a portal appended to <body>). Used two ways like
 * the other injected fns: (a) imported + unit-tested in jsdom; (b) run in the
 * isolated content-script world — Chrome imports and awaits it in
 * content-script.ts, Firefox stringifies it via `.toString()` and injects it
 * with executeScript (native Firefox executeScript awaits the returned Promise).
 * MUST stay fully self-contained: inner helpers only, no imports / module refs
 * (guarded by self-containment.test.ts). Async is preserved by esbuild(esnext)
 * and the ES2022 tsconfig — no __awaiter/__generator helper appears in .toString().
 */
export async function selectOption(
  doc: Document,
  args: { uid: string; option: string; exact?: boolean }
): Promise<{ ok: boolean; selected?: string; error?: string }> {
  const UID_ATTR = "data-bcmcp-uid";
  const wantExact = args.exact === true;
  const rawWant = args.option == null ? "" : String(args.option);
  const want = rawWant.replace(/\s+/g, " ").trim().toLowerCase();

  function norm(s: string | null | undefined): string {
    return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  }
  function textMatches(candidate: string): boolean {
    const c = norm(candidate).toLowerCase();
    if (c.length === 0) {
      return false;
    }
    return wantExact ? c === want : c.indexOf(want) !== -1;
  }
  // Deepest-wins leaf match (mirrors snapshot-script.ts isLeafTextMatch): the
  // element contains the needle AND no descendant element also contains it.
  function isLeafTextMatch(el: Element): boolean {
    if (!textMatches(el.textContent || "")) {
      return false;
    }
    const kids = el.querySelectorAll("*");
    for (let k = 0; k < kids.length; k++) {
      if (textMatches(kids[k].textContent || "")) {
        return false;
      }
    }
    return true;
  }
  function sleep(ms: number): Promise<void> {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  try {
    const win = doc.defaultView as (Window & typeof globalThis) | null;
    const el = doc.querySelector("[" + UID_ATTR + '="' + args.uid + '"]');
    if (!el) {
      return {
        ok: false,
        error:
          "Element uid '" +
          args.uid +
          "' not found — take a fresh snapshot (uids are reassigned each snapshot).",
      };
    }

    try {
      (el as { scrollIntoView?: (opts?: unknown) => void }).scrollIntoView?.({
        block: "center",
      });
    } catch (e) {
      /* jsdom lacks a layout engine — never throw on scroll */
    }

    function mouseEvt(type: string): Event {
      return new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: win as Window,
      });
    }
    function activate(node: Element): void {
      node.dispatchEvent(mouseEvt("pointerdown"));
      node.dispatchEvent(mouseEvt("mousedown"));
      node.dispatchEvent(mouseEvt("mouseup"));
      try {
        (node as { focus?: () => void }).focus?.();
      } catch (e) {
        /* not focusable */
      }
      try {
        (node as { click?: () => void }).click?.();
      } catch (e) {
        /* ignore activation errors */
      }
    }

    // --- native <select> ---
    if (el.tagName === "SELECT") {
      const opts = (el as HTMLSelectElement).options;
      let chosen: HTMLOptionElement | null = null;
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i];
        if (textMatches(o.textContent || "") || textMatches(o.value || "")) {
          chosen = o;
          break;
        }
      }
      if (!chosen) {
        return {
          ok: false,
          error:
            'No <option> matching "' +
            rawWant +
            '" in the native <select> uid ' +
            args.uid +
            ".",
        };
      }
      (el as HTMLSelectElement).value = chosen.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, selected: norm(chosen.textContent || chosen.value) };
    }

    // --- custom combobox ---
    // 1. Open the menu.
    activate(el);

    // 2. If a search <input> appears (react-select/Downshift render one), type
    //    the wanted text to filter (framework-safe native setter + input event,
    //    the type-at pattern). The menu is often portaled, so look inside the
    //    control first, then across the document.
    function findSearchInput(): HTMLInputElement | null {
      const local = el.querySelector(
        'input:not([type="hidden"])'
      ) as HTMLInputElement | null;
      if (local) {
        return local;
      }
      const globals = doc.querySelectorAll(
        'input[role="combobox"], input[aria-autocomplete="list"], input[type="search"], .select__input input'
      );
      for (let i = 0; i < globals.length; i++) {
        const gi = globals[i] as HTMLInputElement;
        if ((gi as HTMLElement).offsetParent !== null || gi.value === "") {
          return gi;
        }
      }
      return (globals[0] as HTMLInputElement) || null;
    }
    const search = findSearchInput();
    if (search) {
      try {
        (search as { focus?: () => void }).focus?.();
      } catch (e) {
        /* ignore */
      }
      const proto = win!.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = descriptor && descriptor.set;
      if (setter) {
        setter.call(search, rawWant);
      } else {
        (search as { value?: string }).value = rawWant;
      }
      search.dispatchEvent(new Event("input", { bubbles: true }));
      for (let i = 0; i < rawWant.length; i++) {
        const ch = rawWant.charAt(i);
        search.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
        search.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      }
    }

    // 3. Poll for a matching option to render (portal menus mount async). Bounded:
    //    ≤ 15 iterations × 300ms. First check is at iter 0 (no sleep) so an
    //    already-open menu resolves immediately.
    function findOption(): Element | null {
      const nodes = doc.querySelectorAll(
        '[role="option"], [role="listbox"] li, li[role="option"], .select__option'
      );
      for (let i = 0; i < nodes.length; i++) {
        if (isLeafTextMatch(nodes[i])) {
          return nodes[i];
        }
      }
      return null;
    }
    let optionEl: Element | null = null;
    for (let iter = 0; iter < 15; iter++) {
      optionEl = findOption();
      if (optionEl) {
        break;
      }
      await sleep(300);
    }
    if (!optionEl) {
      return {
        ok: false,
        error:
          'No option matching "' +
          rawWant +
          '" appeared in the dropdown for uid ' +
          args.uid +
          " (opened the menu but the option never rendered — it may be a virtualized list, or the trigger is not a supported combobox).",
      };
    }

    // 4. Click the option.
    try {
      (optionEl as { scrollIntoView?: (o?: unknown) => void }).scrollIntoView?.({
        block: "center",
      });
    } catch (e) {
      /* ignore */
    }
    activate(optionEl);

    // 5. Re-read the control's displayed value: react-select shows it in a
    //    [class*="singleValue"] child; else aria-valuetext; else trigger text.
    await sleep(60);
    function readDisplayed(): string {
      const single = el.querySelector(
        '[class*="singleValue"], [class*="single-value"]'
      );
      if (single && norm(single.textContent || "")) {
        return norm(single.textContent || "");
      }
      const vt = el.getAttribute("aria-valuetext");
      if (vt && norm(vt)) {
        return norm(vt);
      }
      return norm(el.textContent || "");
    }
    const shown = readDisplayed();
    return { ok: true, selected: shown || norm(optionEl.textContent || "") };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
```

- [ ] **Step 4: Run tests** — `cd firefox-extension && npx jest select-option-script` → PASS.

- [ ] **Step 5: Mirror to Chrome** — create `chrome-extension/injected/select-option-script.ts` with a body **byte-identical** to the Firefox file past `export async function selectOption(` (header/doc-comment may differ — swap "Firefox stringifies … executeScript" line for "Chrome imports and awaits it in content-script.ts"). Copy the Firefox `__tests__/select-option-script.test.ts` to `chrome-extension/__tests__/select-option-script.test.ts` unchanged. Run `cd chrome-extension && npx jest select-option-script` → PASS.

- [ ] **Step 6: Register in self-containment** (`firefox-extension/__tests__/self-containment.test.ts`). Add the import (`:41-52` block) and the `INJECTED_FUNCTIONS` entry (`:68-77`):

```ts
import { selectOption } from "../injected/select-option-script";
// ...
const INJECTED_FUNCTIONS: ReadonlyArray<[string, (...args: any[]) => any]> = [
  ["buildSnapshot", buildSnapshot as unknown as (...args: any[]) => any],
  ["performInputAction", performInputAction as unknown as (...args: any[]) => any],
  ["performPointAction", performPointAction as unknown as (...args: any[]) => any],
  ["scrollWindowTo", scrollWindowTo as unknown as (...args: any[]) => any],
  ["scrollElementIntoView", scrollElementIntoView as unknown as (...args: any[]) => any],
  ["dispatchMouseMoveStep", dispatchMouseMoveStep as unknown as (...args: any[]) => any],
  ["typeCharStep", typeCharStep as unknown as (...args: any[]) => any],
  ["readElementScreenRect", readElementScreenRect as unknown as (...args: any[]) => any],
  ["selectOption", selectOption as unknown as (...args: any[]) => any],
];
```

Then append a dedicated guard that locks async-preservation (the FORBIDDEN_TOKENS list does not include `__awaiter`/`__generator`, so assert explicitly):

```ts
describe("selectOption stays natively async (no down-levelled helper leak)", () => {
  const src = selectOption.toString();
  it("stringifies as a native async function using await", () => {
    expect(src).toMatch(/async\s+function/);
    expect(src).toContain("await ");
  });
  it("contains no transpiler async helper reference", () => {
    for (const t of ["__awaiter", "__generator", "__async", "regeneratorRuntime"]) {
      expect(src).not.toContain(t);
    }
  });
});
```

- [ ] **Step 7: Run self-containment + both suites** — `cd firefox-extension && npx jest self-containment select-option-script` → PASS; `cd chrome-extension && npx jest select-option-script` → PASS.

- [ ] **Step 8: Commit** — `git add firefox-extension/injected/select-option-script.ts chrome-extension/injected/select-option-script.ts firefox-extension/__tests__/select-option-script.test.ts chrome-extension/__tests__/select-option-script.test.ts firefox-extension/__tests__/self-containment.test.ts && git commit -m "feat(select-option): self-contained selectOption injected fn (both extensions) + jsdom + self-containment"`

---

### Task 27: Wire the `select-option` cmd end-to-end (atomic)

> **Atomic:** the union member + both switch cases + both `COMMAND_TO_TOOL_ID` entries must land together or the build is RED. Do the schema test first, then all edits, then build/test green, then ONE commit.

**Files:**
- Modify: `common/server-messages.ts:62-66` (add `SelectOptionServerMessage`), `:438-479` (add to `ServerMessage` union)
- Modify: `common/extension-messages.ts:102-110` (add `selected?` to `ActionResultExtensionMessage`)
- Modify: `firefox-extension/message-handler.ts:4-10` (import), `~:335` (switch `case`), new `runSelectOption` method after `runPointAction` (`~:854`)
- Modify: `chrome-extension/message-handler.ts` (switch `case` `~:331`), new `runSelectOption` method after `runPointAction` (`~:753`)
- Modify: `chrome-extension/content-script.ts:20-24` (import), `~:305` (onMessage `case "selectOption"`)
- Modify: `chrome-extension/extension-config.ts` + `firefox-extension/extension-config.ts` (`AVAILABLE_TOOLS` `:~227`, `COMMAND_TO_TOOL_ID` `:~272`, `AUTOMATION_COMMANDS` `:~312`)
- Modify: `mcp-server/server.ts` (new `select-option` tool, near the coordinate tools `~:680`)
- Modify: `mcp-server/browser-api.ts` (new `selectOption` method after `fillElement` `~:658`)
- Modify: `mcp-server/timeouts.ts:11-27` (add `"select-option": 15000`)
- Test: `mcp-server/__tests__/select-option-schema.test.ts` (co-locate with existing server tests; check `mcp-server/__tests__/` first)

**Interfaces:**
- Produces: `SelectOptionServerMessage` (`cmd:"select-option"; tabId; uid; option; exact?`); `ActionResultExtensionMessage.selected?: string`; `BrowserAPI.selectOption(tabId, uid, option, exact?) → Promise<ActionResultExtensionMessage>`; `COMMAND_TO_TOOL_ID["select-option"] = "select-option"`; `AVAILABLE_TOOLS` id `"select-option"`; timeout `"select-option": 15000`.
- Consumes: `selectOption` injected fn (Task 26); `raceInputAgainstNavigation` (existing `nav-race.ts`); `sendMessageToTabRaw` (Chrome, `message-handler.ts:125`).

- [ ] **Step 1: Write the failing schema test** — `mcp-server/__tests__/select-option-schema.test.ts`:

```ts
import { z } from "zod";
const selectArgs = z.object({
  tabId: z.number(),
  uid: z.string(),
  option: z.string(),
  exact: z.boolean().optional(),
});
test("select-option schema accepts uid+option (+optional exact)", () => {
  expect(selectArgs.parse({ tabId: 1, uid: "e5", option: "India" }))
    .toMatchObject({ uid: "e5", option: "India" });
  expect(selectArgs.parse({ tabId: 1, uid: "e5", option: "IN", exact: true }).exact).toBe(true);
});
```
Run: `cd mcp-server && npx jest select-option-schema` → PASS on the standalone schema (this test pins the shape; it FAILS only if the file is absent). Its real purpose is to lock the arg contract the tool uses in Step 6.

- [ ] **Step 2: Add `SelectOptionServerMessage` + union** (`common/server-messages.ts`). After `ScrollIntoViewServerMessage` (`:436`):

```ts
// Select an option in a dropdown identified by a snapshot uid. Drives BOTH a
// native <select> and a custom combobox (react-select/Downshift/Radix): opens
// the menu, types into its search box when present, waits for the option to
// render, clicks it, and reports the control's resulting displayed value.
// `option` is the desired visible text; `exact` (default false) toggles exact
// vs. normalized (trim/lowercase) substring matching. Runs in the ISOLATED
// content-script world (CSP-immune). Replies with the shared action-result +
// additive `selected`.
export interface SelectOptionServerMessage extends ServerMessageBase {
  cmd: "select-option";
  tabId: number;
  uid: string;
  option: string;
  exact?: boolean;
}
```
Add `| SelectOptionServerMessage` to the `ServerMessage` union (`:438-479`).

- [ ] **Step 3: Add `selected?` to `ActionResultExtensionMessage`** (`common/extension-messages.ts:102-110`), append-only after `navigated?`:

```ts
export interface ActionResultExtensionMessage extends ExtensionMessageBase {
  resource: "action-result";
  ok: boolean;
  error?: string;
  navigated?: boolean;
  // select-option: the control's resulting displayed value after the pick.
  selected?: string;
}
```
> **Overlap note (Wave 3a):** Wave 3a adds `intercepted?: {...}` to this SAME interface. Both are additive/append-only and do not reorder existing fields, so they compose. If 3a already landed, add `selected?` after its `intercepted?`; if not, add it after `navigated?` and 3a appends `intercepted?` later. Task 29 appends `dismissed?`/`method?` here too.

- [ ] **Step 4: Firefox message-handler** (`firefox-extension/message-handler.ts`). Add the import (extend the `:6-10` point-action-script import group or add a new import line):

```ts
import { selectOption } from "./injected/select-option-script";
```
Add the switch `case` (after `drag-element`, `~:342`):
```ts
      case "select-option":
        await this.runSelectOption(req.correlationId, req.tabId, {
          uid: req.uid,
          option: req.option,
          exact: req.exact,
        });
        break;
```
Add the handler method (place it right after `runPointAction`, `~:854`). `selectOption` is async; native Firefox `executeScript` awaits the returned Promise → `results[0]` is the resolved `{ok, selected, error}`. Wrap in `raceInputAgainstNavigation` (selecting can navigate):
```ts
  // select-option executor. Injects the self-contained async selectOption into
  // the ISOLATED world; Firefox's native executeScript awaits the returned
  // Promise. Raced against tab navigation (a select can navigate) exactly like
  // runPointAction. A stale uid / unmatched option is a legitimate ok:false.
  private async runSelectOption(
    correlationId: string,
    tabId: number,
    args: { uid: string; option: string; exact?: boolean }
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);

    const dispatch = browser.tabs
      .executeScript(tabId, {
        code: `(${selectOption.toString()})(document, ${JSON.stringify(args)})`,
      })
      .then(
        (results) =>
          (results && results[0]) || {
            ok: false,
            error:
              "select-option produced no result (the content script may not be loaded in this tab — reload the page and retry).",
          }
      );
    const result: {
      ok: boolean;
      selected?: string;
      error?: string;
      navigated?: boolean;
    } = await raceInputAgainstNavigation(tabId, dispatch);

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: !!result.ok,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.selected !== undefined ? { selected: result.selected } : {}),
      ...(result.navigated !== undefined ? { navigated: result.navigated } : {}),
    });
  }
```

- [ ] **Step 5: Chrome message-handler** (`chrome-extension/message-handler.ts`). Add the switch `case` (after `drag-element`, `~:331`) — identical to Firefox's case block above. Add the handler (after `runPointAction`, `~:753`). Chrome dispatches to the content script via `sendMessageToTabRaw` (the content script imports+awaits `selectOption`):
```ts
  // select-option executor. Forwards to the ISOLATED content-script world
  // (content-script.ts awaits selectOption) and races against tab navigation.
  private async runSelectOption(
    correlationId: string,
    tabId: number,
    args: { uid: string; option: string; exact?: boolean }
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);

    const result =
      (await raceInputAgainstNavigation(
        tabId,
        sendMessageToTabRaw(tabId, { type: "selectOption", args })
      )) || { ok: false, error: "select-option produced no result." };

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: !!(result && result.ok),
      ...(result && result.error !== undefined ? { error: result.error } : {}),
      ...(result && (result as { selected?: string }).selected !== undefined
        ? { selected: (result as { selected?: string }).selected }
        : {}),
      ...(result && (result as { navigated?: boolean }).navigated !== undefined
        ? { navigated: (result as { navigated?: boolean }).navigated }
        : {}),
    });
  }
```

- [ ] **Step 6: Chrome content-script** (`chrome-extension/content-script.ts`). Extend the point-action-script import group (`:20-24`) or add:
```ts
import { selectOption } from "./injected/select-option-script";
```
Add the onMessage `case` (after `performPointAction`, `~:305`) — `selectOption` is async, so `await` it (the listener already `return true`s to keep the channel open):
```ts
          case "selectOption": {
            const result = await selectOption(document, message.args);
            sendResponse(result);
            break;
          }
```

- [ ] **Step 7: Both `extension-config.ts`** (apply the SAME three edits to `chrome-extension/extension-config.ts` AND `firefox-extension/extension-config.ts`).
  `AVAILABLE_TOOLS` — append before the closing `]` (`~:227`), using the confirmed `{id,name,description}` shape:
```ts
  ,{
    id: "select-option",
    name: "Select Option",
    description: "Allows the MCP server to select an option in a native <select> or a custom dropdown on a page by snapshot uid"
  }
```
  `COMMAND_TO_TOOL_ID` — add (kebab tool-id, matching every other entry) before the closing `}` (`~:272`):
```ts
  "select-option": "select-option",
```
  `AUTOMATION_COMMANDS` — add (it controls a page) before the closing `]` (`~:312`):
```ts
  "select-option",
```

- [ ] **Step 8: `mcp-server/browser-api.ts`** — add after `fillElement` (`~:658`). Returned unchanged (NOT thrown on `!ok`) so the tool can report `selected` on success and the "option not found / never rendered" error on failure:
```ts
  async selectOption(
    tabId: number,
    uid: string,
    option: string,
    exact?: boolean
  ): Promise<ActionResultExtensionMessage> {
    return await this.sendTool<ActionResultExtensionMessage>({
      cmd: "select-option",
      tabId,
      uid,
      option,
      exact,
    });
  }
```

- [ ] **Step 9: `mcp-server/server.ts`** — add the tool near the coordinate tools (`~:680`):
```ts
mcpServer.tool(
  "select-option",
  "Select an option in a dropdown by snapshot uid — works for BOTH a native <select> AND a custom combobox (react-select/Downshift/Radix and similar, which take-snapshot shows as `combobox` and which click-element/fill-element cannot drive). Pass the visible option text as \"option\"; by default it matches case-insensitively as a trimmed substring, or set exact:true for an exact match. For a custom dropdown it opens the menu, types into the menu's search box if there is one, waits for the option to render, clicks it, and returns the control's resulting displayed value. Get the uid from take-snapshot first.",
  {
    tabId: z.number(),
    uid: z.string(),
    option: z.string(),
    exact: z.boolean().optional(),
  },
  async ({ tabId, uid, option, exact }) => {
    const result = await browserApi.selectOption(tabId, uid, option, exact);
    if (!result.ok) {
      return {
        content: [
          { type: "text", text: `select-option failed: ${result.error ?? "unknown error"}` },
        ],
        isError: true,
      };
    }
    const parts = [`Selected option in uid ${uid}`];
    if (result.selected) {
      parts.push(`— current value: "${result.selected}"`);
    }
    if (result.navigated) {
      parts.push("(page navigated)");
    }
    return { content: [{ type: "text", text: parts.join(" ") }] };
  }
);
```

- [ ] **Step 10: `mcp-server/timeouts.ts`** — add to `COMMAND_TIMEOUTS` (`:11-27`). select-option polls ≤ 15×300ms plus open/type overhead; give it a 15s broker→extension budget (well under the 60s `REQUEST_TIMEOUT_MS` mcp→broker leg):
```ts
  // select-option polls a custom dropdown's menu (≤ 15 × 300ms) before it can
  // click the option — give it more than the 5s default.
  "select-option": 15000,
```

- [ ] **Step 11: Build + test** — `cd mcp-server && npm run build` (the `common` union change type-checks; exhaustiveness satisfied in both extensions) ; `cd firefox-extension && npm run build && npx jest` ; `cd chrome-extension && npm run build && npx jest` ; `cd mcp-server && npx jest` → all GREEN. If `tsc` reports the `_exhaustiveCheck: never` error, a switch `case` is missing in one extension — add it.

- [ ] **Step 12: Commit** — `git add -A && git commit -m "feat(select-option): new tool + cmd wired end-to-end (union, both handlers/config, server, browser-api, timeouts)"`

---

### Task 28: Injected `dismissOverlays` (both extensions) + jsdom unit tests + self-containment registration

**Files:**
- Create: `firefox-extension/injected/dismiss-overlays-script.ts` (full body — authoring source)
- Create: `chrome-extension/injected/dismiss-overlays-script.ts` (byte-identical body; header may differ)
- Create: `firefox-extension/__tests__/dismiss-overlays-script.test.ts` (jsdom)
- Create: `chrome-extension/__tests__/dismiss-overlays-script.test.ts` (jsdom; mirror)
- Modify: `firefox-extension/__tests__/self-containment.test.ts` (import + register `dismissOverlays`)

**Interfaces:**
- Produces (verbatim per scaffold contract):
  ```ts
  export function dismissOverlays(
    doc: Document
  ): { ok: boolean; dismissed: string[]; method?: "reject" | "remove"; error?: string };
  ```
- Consumes: none (self-contained, synchronous, `querySelectorAll`-only).

- [ ] **Step 1: Write the failing jsdom test** — `firefox-extension/__tests__/dismiss-overlays-script.test.ts`:

```ts
import { dismissOverlays } from "../injected/dismiss-overlays-script";

afterEach(() => { document.body.innerHTML = ""; document.documentElement.style.overflow = ""; });

test("OneTrust: prefers the reject-all control (method:reject), does not remove nodes", () => {
  document.body.innerHTML = `
    <div id="onetrust-consent-sdk">
      <div id="onetrust-banner-sdk">
        <button id="onetrust-reject-all-handler">Reject All</button>
      </div>
    </div>`;
  let clicked = false;
  document.querySelector("#onetrust-reject-all-handler")!
    .addEventListener("click", () => { clicked = true; });
  const r = dismissOverlays(document);
  expect(clicked).toBe(true);
  expect(r.ok).toBe(true);
  expect(r.method).toBe("reject");
  expect(r.dismissed).toContain("OneTrust");
  expect(document.querySelector("#onetrust-consent-sdk")).not.toBeNull(); // reject, not removed
});

test("text-based reject inside a known container when no id button exists", () => {
  document.body.innerHTML = `
    <div id="truste-consent-track">
      <button>Accept All</button>
      <button aria-label="Decline">No thanks</button>
    </div>`;
  let declined = false;
  document.querySelectorAll("button")[1].addEventListener("click", () => { declined = true; });
  const r = dismissOverlays(document);
  expect(declined).toBe(true);
  expect(r.method).toBe("reject");
});

test("no reject control → removes the overlay node(s) and restores scroll (method:remove)", () => {
  document.documentElement.style.overflow = "hidden";
  document.body.classList.add("ot-overflow-hidden");
  document.body.innerHTML = `<div class="onetrust-pc-dark-filter"></div><div id="onetrust-consent-sdk"><p>cookies</p></div>`;
  const r = dismissOverlays(document);
  expect(r.method).toBe("remove");
  expect(document.querySelector("#onetrust-consent-sdk")).toBeNull();
  expect(document.querySelector(".onetrust-pc-dark-filter")).toBeNull();
  expect(document.documentElement.style.overflow).toBe("");
  expect(document.body.classList.contains("ot-overflow-hidden")).toBe(false);
});

test("generic aria-modal dialog with no reject → removed", () => {
  document.body.innerHTML = `<div role="dialog" aria-modal="true"><p>Subscribe</p></div>`;
  const r = dismissOverlays(document);
  expect(r.ok).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("idempotent: a second call after everything is gone returns dismissed:[]", () => {
  document.body.innerHTML = `<div id="onetrust-consent-sdk"><p>x</p></div>`;
  dismissOverlays(document);
  const r2 = dismissOverlays(document);
  expect(r2.ok).toBe(true);
  expect(r2.dismissed).toEqual([]);
  expect(r2.method).toBeUndefined();
});

test("nothing present → ok:true, empty dismissed, no method", () => {
  const r = dismissOverlays(document);
  expect(r).toEqual({ ok: true, dismissed: [], method: undefined });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd firefox-extension && npx jest dismiss-overlays-script` → FAIL (module not found).

- [ ] **Step 3: Create `firefox-extension/injected/dismiss-overlays-script.ts`** (COMPLETE, self-contained, synchronous; staged prefer-reject-then-remove; no forbidden tokens):

```ts
/**
 * dismiss-overlays injected executor (ISOLATED world, CSP-immune, synchronous).
 *
 * Clears cookie-consent banners and modal overlays. Staged, privacy-preserving:
 *   Phase 1 — click a known reject/decline control by id.
 *   Phase 2 — click a text-matched reject/decline control inside a known
 *             consent container.
 *   Phase 3 — remove known overlay node(s) + generic aria-modal dialogs +
 *             backdrops, and restore the page's scroll lock.
 * Idempotent (a second call finds nothing left → dismissed:[]). Used two ways
 * like the other injected fns: imported + unit-tested in jsdom, and run in the
 * isolated content-script world (Chrome imports it; Firefox stringifies via
 * `.toString()`). Fully self-contained: inner helpers only, no imports / module
 * refs (guarded by self-containment.test.ts).
 */
export function dismissOverlays(
  doc: Document
): { ok: boolean; dismissed: string[]; method?: "reject" | "remove"; error?: string } {
  try {
    const dismissed: string[] = [];
    const win = doc.defaultView as (Window & typeof globalThis) | null;

    function isVisible(el: Element): boolean {
      if (win && typeof win.getComputedStyle === "function") {
        try {
          const cs = win.getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") {
            return false;
          }
        } catch (e) {
          /* ignore */
        }
      }
      return true;
    }
    function clickIfPresent(selector: string): boolean {
      const btn = doc.querySelector(selector) as HTMLElement | null;
      if (btn && isVisible(btn)) {
        try {
          btn.click();
          return true;
        } catch (e) {
          return false;
        }
      }
      return false;
    }
    // A reject/decline/"necessary only" control inside `container`, by text /
    // aria-label / value.
    function clickRejectByText(container: Element): boolean {
      const rejectRe =
        /(reject|decline|refuse|deny|necessary only|only necessary|essential only|reject all|decline all|do not (accept|agree))/i;
      const controls = container.querySelectorAll(
        'button, [role="button"], a[href], input[type="button"], input[type="submit"]'
      );
      for (let i = 0; i < controls.length; i++) {
        const c = controls[i] as HTMLElement;
        const label =
          (c.textContent || "") +
          " " +
          (c.getAttribute("aria-label") || "") +
          " " +
          ((c as HTMLInputElement).value || "");
        if (rejectRe.test(label) && isVisible(c)) {
          try {
            c.click();
            return true;
          } catch (e) {
            /* try the next control */
          }
        }
      }
      return false;
    }
    function removeAll(selector: string): boolean {
      const nodes = doc.querySelectorAll(selector);
      let removed = false;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n && n.parentNode) {
          n.parentNode.removeChild(n);
          removed = true;
        }
      }
      return removed;
    }
    function restoreScroll(): void {
      const body = doc.body;
      const de = doc.documentElement;
      if (body && (body as HTMLElement).style) {
        (body as HTMLElement).style.overflow = "";
        (body as HTMLElement).style.position = "";
      }
      if (de && (de as HTMLElement).style) {
        (de as HTMLElement).style.overflow = "";
      }
      const lockClasses = [
        "ot-overflow-hidden",
        "modal-open",
        "no-scroll",
        "overflow-hidden",
      ];
      for (let i = 0; i < lockClasses.length; i++) {
        if (body) {
          body.classList.remove(lockClasses[i]);
        }
        if (de) {
          de.classList.remove(lockClasses[i]);
        }
      }
    }

    // --- Phase 1: known reject/decline controls by id ---
    const idRejects: [string, string][] = [
      ["#onetrust-reject-all-handler", "OneTrust"],
      ["#CybotCookiebotDialogBodyButtonDecline", "Cookiebot"],
      [".ot-pc-refuse-all-handler", "OneTrust-pc"],
    ];
    for (let i = 0; i < idRejects.length; i++) {
      if (clickIfPresent(idRejects[i][0])) {
        dismissed.push(idRejects[i][1]);
      }
    }
    if (dismissed.length > 0) {
      return { ok: true, dismissed, method: "reject" };
    }

    // --- Phase 2: text-based reject inside a known consent container ---
    const rejectContainers: [string, string][] = [
      ["#onetrust-banner-sdk", "OneTrust"],
      ["#onetrust-pc-sdk", "OneTrust-pc"],
      ["#truste-consent-track", "TrustArc"],
      ["#truste-consent-content", "TrustArc"],
      ["#CybotCookiebotDialog", "Cookiebot"],
      [".osano-cm-window", "Osano"],
      [".qc-cmp2-container", "Quantcast"],
      ["#qc-cmp2-container", "Quantcast"],
    ];
    for (let i = 0; i < rejectContainers.length; i++) {
      const c = doc.querySelector(rejectContainers[i][0]);
      if (c && isVisible(c) && clickRejectByText(c)) {
        dismissed.push(rejectContainers[i][1]);
        return { ok: true, dismissed, method: "reject" };
      }
    }

    // --- Phase 3: remove known overlays + generic modals + backdrops ---
    const removeGroups: [string, string][] = [
      ["#onetrust-consent-sdk", "OneTrust"],
      ["#onetrust-banner-sdk", "OneTrust-banner"],
      ["#onetrust-pc-sdk", "OneTrust-pc"],
      [".onetrust-pc-dark-filter", "OneTrust-filter"],
      ["#truste-consent-track", "TrustArc"],
      [".truste_overlay", "TrustArc-overlay"],
      ["#CybotCookiebotDialog", "Cookiebot"],
      [".osano-cm-window", "Osano"],
      [".qc-cmp2-container", "Quantcast"],
      ["#qc-cmp2-container", "Quantcast"],
    ];
    let removedAny = false;
    for (let i = 0; i < removeGroups.length; i++) {
      if (removeAll(removeGroups[i][0])) {
        dismissed.push(removeGroups[i][1]);
        removedAny = true;
      }
    }

    // Generic aria-modal dialogs (prefer a text reject; else remove).
    const modals = doc.querySelectorAll(
      '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
    );
    for (let i = 0; i < modals.length; i++) {
      const m = modals[i];
      if (!isVisible(m)) {
        continue;
      }
      if (clickRejectByText(m)) {
        dismissed.push("modal:reject");
        // A reject click on a generic modal counts as reject even amid removals;
        // still fall through to backdrop cleanup below.
        continue;
      }
      if (m.parentNode) {
        m.parentNode.removeChild(m);
        dismissed.push("modal");
        removedAny = true;
      }
    }

    // Common backdrops/scrims.
    if (
      removeAll(
        '.modal-backdrop, .backdrop, .ReactModal__Overlay, [class*="overlay"][class*="backdrop"]'
      )
    ) {
      dismissed.push("backdrop");
      removedAny = true;
    }

    if (dismissed.length === 0) {
      return { ok: true, dismissed, method: undefined };
    }
    if (removedAny) {
      restoreScroll();
    }
    // method: "reject" only when EVERY dismissal was a reject click; else "remove".
    let anyReject = false;
    let anyRemove = false;
    for (let i = 0; i < dismissed.length; i++) {
      if (dismissed[i] === "modal:reject") {
        anyReject = true;
      } else {
        anyRemove = true;
      }
    }
    return {
      ok: true,
      dismissed,
      method: anyRemove ? "remove" : anyReject ? "reject" : undefined,
    };
  } catch (e) {
    return { ok: false, dismissed: [], error: String(e) };
  }
}
```

- [ ] **Step 4: Run tests** — `cd firefox-extension && npx jest dismiss-overlays-script` → PASS.

- [ ] **Step 5: Mirror to Chrome** — create `chrome-extension/injected/dismiss-overlays-script.ts` with a body **byte-identical** past `export function dismissOverlays(` (header may differ). Copy the test to `chrome-extension/__tests__/dismiss-overlays-script.test.ts`. Run `cd chrome-extension && npx jest dismiss-overlays-script` → PASS.

- [ ] **Step 6: Register in self-containment** (`firefox-extension/__tests__/self-containment.test.ts`) — import and add to `INJECTED_FUNCTIONS`:
```ts
import { dismissOverlays } from "../injected/dismiss-overlays-script";
// ...append to INJECTED_FUNCTIONS:
  ["dismissOverlays", dismissOverlays as unknown as (...args: any[]) => any],
```

- [ ] **Step 7: Run self-containment + both suites** — `cd firefox-extension && npx jest self-containment dismiss-overlays-script` → PASS; `cd chrome-extension && npx jest dismiss-overlays-script` → PASS.

- [ ] **Step 8: Commit** — `git add firefox-extension/injected/dismiss-overlays-script.ts chrome-extension/injected/dismiss-overlays-script.ts firefox-extension/__tests__/dismiss-overlays-script.test.ts chrome-extension/__tests__/dismiss-overlays-script.test.ts firefox-extension/__tests__/self-containment.test.ts && git commit -m "feat(dismiss-overlays): self-contained dismissOverlays injected fn (both extensions) + jsdom + self-containment"`

---

### Task 29: Wire the `dismiss-overlays` cmd end-to-end (atomic)

> **Atomic** for the same tripwire reason as Task 27.

**Files:**
- Modify: `common/server-messages.ts` (add `DismissOverlaysServerMessage` + union member)
- Modify: `common/extension-messages.ts:102-110` (add `dismissed?`, `method?` to `ActionResultExtensionMessage`)
- Modify: `firefox-extension/message-handler.ts` (import; switch `case`; `runDismissOverlays` method)
- Modify: `chrome-extension/message-handler.ts` (switch `case`; `runDismissOverlays` method)
- Modify: `chrome-extension/content-script.ts` (import; onMessage `case "dismissOverlays"`)
- Modify: both `extension-config.ts` (`AVAILABLE_TOOLS`, `COMMAND_TO_TOOL_ID`, `AUTOMATION_COMMANDS`)
- Modify: `mcp-server/server.ts` (new `dismiss-overlays` tool)
- Modify: `mcp-server/browser-api.ts` (new `dismissOverlays` method)
- Test: `mcp-server/__tests__/dismiss-overlays-schema.test.ts`

**Interfaces:**
- Produces: `DismissOverlaysServerMessage` (`cmd:"dismiss-overlays"; tabId`); `ActionResultExtensionMessage.dismissed?: string[]` + `method?: "reject" | "remove"`; `BrowserAPI.dismissOverlays(tabId) → Promise<ActionResultExtensionMessage>`; `COMMAND_TO_TOOL_ID["dismiss-overlays"] = "dismiss-overlays"`; `AVAILABLE_TOOLS` id `"dismiss-overlays"`.
- Consumes: `dismissOverlays` injected fn (Task 28); `sendMessageToTabRaw` (Chrome). **No `raceInputAgainstNavigation`** — `dismissOverlays` is synchronous and a reject/decline click stays on the page (no navigation), matching the spec's synchronous contract. Uses the default 5s broker timeout (no `timeouts.ts` entry needed).

- [ ] **Step 1: Write the failing schema test** — `mcp-server/__tests__/dismiss-overlays-schema.test.ts`:
```ts
import { z } from "zod";
const dismissArgs = z.object({ tabId: z.number() });
test("dismiss-overlays schema accepts tabId", () => {
  expect(dismissArgs.parse({ tabId: 3 })).toMatchObject({ tabId: 3 });
});
```

- [ ] **Step 2: Add `DismissOverlaysServerMessage` + union** (`common/server-messages.ts`, after `SelectOptionServerMessage`):
```ts
// Dismiss cookie-consent banners and modal overlays covering the page (OneTrust,
// TrustArc, Cookiebot, Osano/Quantcast, generic aria-modal dialogs + backdrops).
// Prefers a Reject/Decline/"necessary only" control; else removes the node(s) and
// restores the scroll lock. Idempotent. Runs in the ISOLATED content-script world
// (CSP-immune). Replies with the shared action-result + additive dismissed/method.
export interface DismissOverlaysServerMessage extends ServerMessageBase {
  cmd: "dismiss-overlays";
  tabId: number;
}
```
Add `| DismissOverlaysServerMessage` to the `ServerMessage` union.

- [ ] **Step 3: Add `dismissed?` + `method?` to `ActionResultExtensionMessage`** (`common/extension-messages.ts`), append-only after `selected?` (added in Task 27):
```ts
  // dismiss-overlays: identifiers of what was dismissed, and how.
  dismissed?: string[];
  method?: "reject" | "remove";
```

- [ ] **Step 4: Firefox message-handler.** Add import:
```ts
import { dismissOverlays } from "./injected/dismiss-overlays-script";
```
Switch `case` (after `select-option`):
```ts
      case "dismiss-overlays":
        await this.runDismissOverlays(req.correlationId, req.tabId);
        break;
```
Handler method (after `runSelectOption`). Synchronous injected fn → no nav-race, no Promise-await subtlety; `executeScript` returns `[{ok, dismissed, method}]`:
```ts
  // dismiss-overlays executor. Injects the self-contained synchronous
  // dismissOverlays into the ISOLATED world and replies with the shared
  // action-result + dismissed/method. No nav-race: a reject/decline click stays
  // on the page.
  private async runDismissOverlays(
    correlationId: string,
    tabId: number
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);

    const results = await browser.tabs.executeScript(tabId, {
      code: `(${dismissOverlays.toString()})(document)`,
    });
    const result = (results && results[0]) || {
      ok: false,
      dismissed: [],
      error:
        "dismiss-overlays produced no result (the content script may not be loaded in this tab — reload the page and retry).",
    };

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: !!result.ok,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.dismissed !== undefined ? { dismissed: result.dismissed } : {}),
      ...(result.method !== undefined ? { method: result.method } : {}),
    });
  }
```

- [ ] **Step 5: Chrome message-handler.** Switch `case` (after `select-option`) — identical block to Firefox's above. Handler (after `runSelectOption`), dispatching via `sendMessageToTabRaw`:
```ts
  // dismiss-overlays executor. Forwards to the ISOLATED content-script world
  // (content-script.ts calls dismissOverlays). No nav-race (synchronous; a
  // reject click stays on the page).
  private async runDismissOverlays(
    correlationId: string,
    tabId: number
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);

    const result = (await sendMessageToTabRaw(tabId, {
      type: "dismissOverlays",
    })) || { ok: false, dismissed: [], error: "dismiss-overlays produced no result." };

    await this.client.sendResourceToServer({
      resource: "action-result",
      correlationId,
      ok: !!(result && result.ok),
      ...(result && result.error !== undefined ? { error: result.error } : {}),
      ...(result && result.dismissed !== undefined
        ? { dismissed: result.dismissed }
        : {}),
      ...(result && result.method !== undefined ? { method: result.method } : {}),
    });
  }
```

- [ ] **Step 6: Chrome content-script** (`chrome-extension/content-script.ts`). Import:
```ts
import { dismissOverlays } from "./injected/dismiss-overlays-script";
```
onMessage `case` (after `selectOption`) — synchronous, no `await` needed:
```ts
          case "dismissOverlays": {
            const result = dismissOverlays(document);
            sendResponse(result);
            break;
          }
```

- [ ] **Step 7: Both `extension-config.ts`** (SAME edits in both files).
  `AVAILABLE_TOOLS` append:
```ts
  ,{
    id: "dismiss-overlays",
    name: "Dismiss Overlays",
    description: "Allows the MCP server to dismiss cookie-consent banners and modal overlays covering a page (prefers a Reject/Decline control)"
  }
```
  `COMMAND_TO_TOOL_ID` add:
```ts
  "dismiss-overlays": "dismiss-overlays",
```
  `AUTOMATION_COMMANDS` add:
```ts
  "dismiss-overlays",
```

- [ ] **Step 8: `mcp-server/browser-api.ts`** — add after `selectOption`:
```ts
  async dismissOverlays(tabId: number): Promise<ActionResultExtensionMessage> {
    return await this.sendTool<ActionResultExtensionMessage>({
      cmd: "dismiss-overlays",
      tabId,
    });
  }
```

- [ ] **Step 9: `mcp-server/server.ts`** — add the tool near `select-option`:
```ts
mcpServer.tool(
  "dismiss-overlays",
  "Dismiss cookie-consent banners and modal overlays that cover the page (OneTrust, TrustArc, Cookiebot, Osano/Quantcast, and generic aria-modal dialogs with their backdrops). It PREFERS clicking a Reject / Decline / \"Necessary only\" control (privacy-preserving); only if none exists does it remove the overlay node(s) and restore the page's scroll lock. Idempotent and safe to re-run after an SPA route change re-mounts the banner. Reach for it when click-element reports a click may be intercepted, or when a snapshot is dominated by a consent dialog.",
  {
    tabId: z.number(),
  },
  async ({ tabId }) => {
    const result = await browserApi.dismissOverlays(tabId);
    if (!result.ok) {
      return {
        content: [
          { type: "text", text: `dismiss-overlays failed: ${result.error ?? "unknown error"}` },
        ],
        isError: true,
      };
    }
    const list = result.dismissed ?? [];
    const text =
      list.length === 0
        ? "No overlays found to dismiss."
        : `Dismissed ${list.length} overlay(s) via ${result.method ?? "remove"}: ${list.join(", ")}`;
    return { content: [{ type: "text", text }] };
  }
);
```

- [ ] **Step 10: Build + test** — `cd mcp-server && npm run build` ; both extensions `npm run build && npx jest` ; `cd mcp-server && npx jest` → all GREEN. (Confirm `_exhaustiveCheck` satisfied in both extensions.)

- [ ] **Step 11: Commit** — `git add -A && git commit -m "feat(dismiss-overlays): new tool + cmd wired end-to-end (union, both handlers/config, server, browser-api)"`

---

### Task 30: Playwright e2e — real react-select portal selection + overlay dismiss across a route change

> Runs against Wave 0's `test-fixtures/spa-widgets/` fixture and lives under Wave 0's `e2e/` with its own `npm run test:e2e` — **NOT** wired into `release.yml` or any per-project `jest`. jsdom cannot model portals, layout, `elementFromPoint`, or `pushState` re-mount, so these behaviors are Playwright-only.

**Files:**
- Create: `e2e/select-option.spec.ts`
- Create: `e2e/dismiss-overlays.spec.ts`
- (Depends on Wave 0 `e2e/playwright.config.ts` + `test-fixtures/spa-widgets/{server.mjs,index.html,app.js}` bundling the react-select-style searchable **portal** dropdown, the OneTrust-like overlay that **re-mounts on `pushState`**, and the SPA routing. If the fixture lacks the portal dropdown / re-mounting overlay, extend it here.)

**Interfaces:**
- Consumes: the injected `selectOption`/`dismissOverlays` sources (loaded via `page.addScriptTag`/`page.evaluate`, the harness the spec §Fixture describes).

- [ ] **Step 1: `e2e/select-option.spec.ts`** — load the fixture, inject `selectOption`, and assert it drives a REAL portal menu (open → filter via search input → poll for the portal-mounted `[role=option]` → click → displayed value updates):
```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const SELECT_SRC = readFileSync(
  new URL("../firefox-extension/injected/select-option-script.ts", import.meta.url),
  "utf8"
); // NOTE: config compiles TS, or point at the built dist; match Wave 0's harness.

test("select-option picks an option in a real react-select-style portal menu", async ({ page }) => {
  await page.goto("/"); // fixture server
  // Expose selectOption in the page (Wave 0 harness: addScriptTag with the compiled fn, or evaluate the source).
  const result = await page.evaluate(async () => {
    // @ts-ignore — injected by the harness
    return await window.__selectOption(document, { uid: "country-combobox", option: "India" });
  });
  expect(result.ok).toBe(true);
  expect(result.selected).toContain("India");
  await expect(page.locator('[data-bcmcp-uid="country-combobox"] [class*="singleValue"]'))
    .toHaveText(/India/);
});
```
> The exact injection mechanism (compiled-dist vs. `page.addScriptTag({content})`) must match Wave 0's chosen harness — reuse it verbatim. If Wave 0 stamps snapshot uids at runtime, take a snapshot first to assign `country-combobox`'s uid, or have the fixture pre-stamp `data-bcmcp-uid`.

- [ ] **Step 2: `e2e/dismiss-overlays.spec.ts`** — dismiss the overlay, trigger a `pushState` route change that **re-mounts** it, dismiss again, assert it **stays gone** (idempotency + re-invocation is the spec's "stays gone across a route change" property):
```ts
test("dismiss-overlays clears the consent overlay and it stays gone after a pushState re-mount", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#onetrust-banner-sdk")).toBeVisible();

  const r1 = await page.evaluate(() => (window as any).__dismissOverlays(document));
  expect(r1.ok).toBe(true);
  expect(r1.dismissed.length).toBeGreaterThan(0);
  await expect(page.locator("#onetrust-banner-sdk")).toHaveCount(0);

  // Simulate the SPA route change that re-mounts the banner.
  await page.click('[data-testid="route-link"]'); // fixture link that pushState-navigates + re-mounts OneTrust
  await expect(page.locator("#onetrust-banner-sdk")).toBeVisible();

  const r2 = await page.evaluate(() => (window as any).__dismissOverlays(document));
  expect(r2.ok).toBe(true);
  await expect(page.locator("#onetrust-banner-sdk")).toHaveCount(0);
});
```

- [ ] **Step 3: Run e2e** — `npm run test:e2e` (from Wave 0's e2e dir) → PASS. Confirm it is NOT invoked by `cd chrome-extension && npx jest` / `cd firefox-extension && npx jest` / `cd mcp-server && npx jest` (release-blocking path stays untouched).

- [ ] **Step 4: Commit** — `git add e2e/select-option.spec.ts e2e/dismiss-overlays.spec.ts && git commit -m "test(e2e): playwright specs for select-option portal pick + dismiss-overlays across pushState re-mount"`

---

## Wave 3b — assembly notes / risks / file-overlap with Wave 3a

- **File overlap with Wave 3a (must reconcile at assembly):**
  - `common/extension-messages.ts` — Wave 3a adds `intercepted?` to `ActionResultExtensionMessage`; Wave 3b adds `selected?` (Task 27) + `dismissed?`/`method?` (Task 29). All append-only, no reordering → compose cleanly. Land 3a first OR apply both as additive appends; either order compiles.
  - `firefox-extension/injected/action-script.ts` — Wave 3a MODIFIES `performInputAction` (interception detection). Wave 3b does **not** touch `action-script.ts` (new tools are separate `select-option-script.ts` / `dismiss-overlays-script.ts` files) → **no collision**.
  - `mcp-server/server.ts` — 3a edits the `click-element` handler's output; 3b **adds** two new `mcpServer.tool(...)` blocks → different regions, additive.
  - `firefox-extension/message-handler.ts` / `chrome-extension/message-handler.ts` — 3a edits the click arm; 3b adds two new switch cases + two new methods → different regions, additive.
  - `firefox-extension/__tests__/self-containment.test.ts` — 3b adds `selectOption` + `dismissOverlays` to `INJECTED_FUNCTIONS`; 3a does not add injected fns → no collision.
- **Tripwire ordering (intra-wave):** each new cmd is wired atomically (Tasks 27, 29). Do NOT commit a union addition without both switch cases + both `COMMAND_TO_TOOL_ID` entries — `tsc` fails on `_exhaustiveCheck: never` and on the `Record<ServerMessageRequest["cmd"], string>` completeness in the meantime.
- **Async-injected-fn return on Firefox `executeScript` (RESOLVED risk):** native `browser.tabs.executeScript` awaits a trailing Promise and resolves to its value; the repo uses the raw `browser` global (not `webextension-polyfill`), and both esbuild(esnext) + ES2022 tsconfig keep `async`/`await` native in `.toString()`. Task 26's guard test locks it. If a future build adds `--target=es2016` (or lower), the guard fails loudly — the fix is to keep the target ≥ es2017, not to relax the guard.
- **Portal/menu selector assumptions:** `selectOption`'s option selectors (`[role="option"]`, `[role="listbox"] li`, `li[role="option"]`, `.select__option`) and search-input selectors target react-select/Downshift/Radix-shaped menus. Exotic virtualized menus that render options only on scroll may miss → the bounded poll returns a clear `ok:false` naming the control (not a false success), per spec accepted-edge.
- **`dismissOverlays` is synchronous + not nav-raced** (deliberate, per the spec's synchronous contract): a reject/decline click stays on the page; a removal is pure DOM. If a future consent SDK navigates on reject, wrap `runDismissOverlays` in `raceInputAgainstNavigation` like `runSelectOption` (cheap follow-up) — flagged, not done.
- **`method` semantics:** returns `"reject"` when a reject/decline control was clicked (privacy-preferred path), `"remove"` when node removal was used, `undefined` when nothing matched. The staged Phase-1/2/3 order guarantees reject is tried before removal.


## Wave 4 — eval-format + xcode

**Items:** 6 (`evaluate-script` structured result) + 7 (stray Xcode-license line investigation).
**Files (disjoint from Waves 1–3b):** new `mcp-server/eval-format.ts` + `mcp-server/__tests__/eval-format.test.ts`; one-line swap in `mcp-server/server.ts` (evaluate-script handler); `CLAUDE.md` dev-notes. No extension, `common/`, or injected files — this wave cannot collide with the others.

**SDK finding (authoritative for assembly — read from `node_modules`):** the installed `@modelcontextprotocol/sdk` is **1.29.0** (`mcp-server/node_modules/@modelcontextprotocol/sdk/package.json`; `mcp-server/package.json` pins `^1.7.0`). `structuredContent` **IS** part of `CallToolResult` — `types.d.ts:2601` declares it `z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>`, i.e. the inferred field type is **`Record<string, unknown>` (object-only)**, not arbitrary values. The `tool()` callback returns `ToolCallback → CallToolResult` (`server/mcp.d.ts:261`). At runtime, `validateToolOutput` (`server/mcp.js:186-188`) **returns early when the tool has no `outputSchema`** — and `evaluate-script` declares none — so a returned `structuredContent` is **neither required nor validated nor rejected**; it passes through harmlessly (the outer `CallToolResultSchema` is `z.core.$loose`, so it serializes to the client). **Decision:** set `structuredContent` **only for non-null, non-array objects** (the type-safe, spec-faithful subset), carry every other kind (string/number/boolean/null/array) in the text block alone. This refines the scaffold's placeholder `structuredContent?: unknown` → **`structuredContent?: Record<string, unknown>`** so `return formatEvalResult(value)` type-checks against `CallToolResult` with **no cast**. (`mcp-server/tsconfig.json` is `strict: true`, `exactOptionalPropertyTypes` off, `skipLibCheck` on — the conditional-assignment build below is safe under all of these.)

---

### Task 36: `mcp-server/eval-format.ts` — `formatEvalResult` pure formatter + unit tests

Kills the double-encoding at `server.ts:608` (`text: JSON.stringify(value)`). Extracted-pure-formatter pattern, mirroring `point-format.ts` / `snapshot-format.ts` / `network-format.ts` (server.ts self-executes on import → cannot be imported into a test, so the composed tool result is exercised only through this pure function).

**Files:**
- Create: `mcp-server/eval-format.ts`
- Test: `mcp-server/__tests__/eval-format.test.ts`

**Interfaces:**
- Produces: `formatEvalResult(value: unknown): { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> }`.
  - `typeof value === "string"` → text is the string **raw/unquoted** (no `JSON.stringify` wrapping) → kills the `() => JSON.stringify(state)` double-encode.
  - else → text is `JSON.stringify(value, null, 2)` (pretty), with a `?? String(value)` guard so `undefined`/non-serializable values still yield a `string` (never `undefined`).
  - `structuredContent` set to `value` **only** when `value` is a non-null, non-array object (the SDK's `Record<string, unknown>` bound); omitted otherwise.
- Consumes: nothing (pure, no imports — like the other three formatters).

- [ ] **Step 1: Write the failing test** — `mcp-server/__tests__/eval-format.test.ts` (full file):

```ts
import { formatEvalResult } from "../eval-format";

// Pins the evaluate-script result formatter (Fix 6). Mirrors the formatPointResult
// block in coordinate-tools.test.ts and formatSnapshotResult in
// snapshot-format.test.ts: server.ts self-executes on import and cannot be
// imported into a test, so the composed MCP tool result is exercised only
// through this pure function.
describe("formatEvalResult", () => {
  type Out = {
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
  };

  it("passes a string value through RAW (unquoted) with no structuredContent", () => {
    const out = formatEvalResult("hello world") as Out;
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text).toBe("hello world");
    expect(out.structuredContent).toBeUndefined();
  });

  it("does NOT double-encode an already-serialized JSON string (the () => JSON.stringify(state) regression)", () => {
    // A page fn `() => JSON.stringify(state)` returns THIS string; the model must
    // see it verbatim — not "{\"a\":1,\"b\":[2,3]}" wrapped and backslash-escaped
    // a second time (the pre-fix server.ts:608 `JSON.stringify(value)` bug).
    const serialized = JSON.stringify({ a: 1, b: [2, 3] }); // '{"a":1,"b":[2,3]}'
    const out = formatEvalResult(serialized) as Out;
    expect(out.content[0].text).toBe(serialized);
    expect(out.content[0].text).not.toContain('\\"'); // no escaped inner quotes
    expect(out.structuredContent).toBeUndefined();
  });

  it("pretty-prints a plain object (2-space indent) and mirrors it in structuredContent", () => {
    const value = { name: "Country", selected: "US" };
    const out = formatEvalResult(value) as Out;
    expect(out.content[0].text).toBe(JSON.stringify(value, null, 2));
    expect(out.content[0].text).toContain("\n"); // multi-line = pretty printed
    expect(out.structuredContent).toEqual(value);
  });

  it("pretty-prints an array but omits structuredContent (arrays are not a Record)", () => {
    const value = [1, 2, 3];
    const out = formatEvalResult(value) as Out;
    expect(out.content[0].text).toBe(JSON.stringify(value, null, 2));
    expect(out.structuredContent).toBeUndefined();
  });

  it("renders null as the JSON text \"null\" with no structuredContent", () => {
    const out = formatEvalResult(null) as Out;
    expect(out.content[0].text).toBe("null");
    expect(out.structuredContent).toBeUndefined();
  });

  it("renders undefined safely as a string (never undefined) with no structuredContent", () => {
    // JSON.stringify(undefined) is the JS value undefined; the formatter must
    // still yield a string. (In practice the extension coerces undefined -> null
    // on the wire — page-world.ts — so the runtime server rarely sees this; the
    // guard is defensive and unit-pinned here.)
    const out = formatEvalResult(undefined) as Out;
    expect(typeof out.content[0].text).toBe("string");
    expect(out.content[0].text).toBe("undefined");
    expect(out.structuredContent).toBeUndefined();
  });

  it("renders a number as its JSON text with no structuredContent", () => {
    const out = formatEvalResult(42) as Out;
    expect(out.content[0].text).toBe("42");
    expect(out.structuredContent).toBeUndefined();
  });

  it("renders a boolean as its JSON text with no structuredContent", () => {
    const out = formatEvalResult(true) as Out;
    expect(out.content[0].text).toBe("true");
    expect(out.structuredContent).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `cd mcp-server && npx jest __tests__/eval-format.test.ts` → **FAIL** (module `../eval-format` not found — "Cannot find module").

- [ ] **Step 3: Create `mcp-server/eval-format.ts`** (full file):

```ts
// Formats an evaluate-script result for the MCP tool. Extracted from server.ts
// — which self-executes on import (it constructs the BrowserAPI, connects stdio,
// and wires process exit, so it cannot be imported into a test) — for the same
// reason formatPointResult lives in point-format.ts, formatSnapshotResult in
// snapshot-format.ts, and formatNetworkHeaders in network-format.ts.
//
// Fix 6: the old handler did `text: JSON.stringify(value)`, which DOUBLE-encodes
// a value that is already a string. A page function returning a pre-serialized
// string — e.g. `() => JSON.stringify(state)` — reached the model as
// "{\"a\":1}" (a quoted, backslash-escaped blob it had to unescape by hand).
// Here a string passes through RAW/unquoted (killing the double-escape); a
// non-string is pretty-printed. When the value is a plain object we ALSO set
// structuredContent so structured MCP clients get the typed value (additive —
// the text block stays the primary channel). structuredContent on CallToolResult
// is typed Record<string, unknown> in @modelcontextprotocol/sdk 1.29.0, so it is
// set ONLY for non-null, non-array objects; every other kind (string, number,
// boolean, null, array) is carried by the text block alone. evaluate-script
// declares no outputSchema, so the SDK neither requires nor validates
// structuredContent — it passes through harmlessly (server/mcp.js
// validateToolOutput returns early when the tool has no outputSchema).
export function formatEvalResult(value: unknown): {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
} {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2) ?? String(value);
  const out: {
    content: { type: "text"; text: string }[];
    structuredContent?: Record<string, unknown>;
  } = { content: [{ type: "text" as const, text }] };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    out.structuredContent = value as Record<string, unknown>;
  }
  return out;
}
```

- [ ] **Step 4: Run it, confirm it passes** — `cd mcp-server && npx jest __tests__/eval-format.test.ts` → **PASS** (8 tests green). Also `cd mcp-server && npx tsc --noEmit` (or `npm run build`) compiles — the explicit return type pins `type: "text"` and the `?? String(value)` guard keeps `text: string` total.

- [ ] **Step 5: Commit** — `git add mcp-server/eval-format.ts mcp-server/__tests__/eval-format.test.ts && git commit -m "feat(eval-format): formatEvalResult — raw strings, pretty non-strings, structuredContent for objects"`

---

### Task 37: Wire `formatEvalResult` into the `evaluate-script` handler (`server.ts`)

The one intentional behavior change of this wave (eval text shape — user-approved, spec §F). Verification is the **build**: it proves `formatEvalResult`'s return (incl. `structuredContent?: Record<string, unknown>`) is assignable to the SDK's `CallToolResult` with no cast — the integration proof that the SDK accepts the field.

**Files:**
- Modify: `mcp-server/server.ts` — add import after the sibling formatter imports (`:7-9`); swap the handler return (`:607-609`, inside the `evaluate-script` `tool()` callback at `:589-611`).
- Test: none new (server.ts can't be imported/unit-tested — see Task 36 rationale); the pure logic is covered by `eval-format.test.ts`, the wiring by `npm run build` type-check + the manual smoke below.

**Interfaces:**
- Consumes: `formatEvalResult` (Task 36).
- Produces: `evaluate-script` tool now returns raw strings / pretty non-strings / object `structuredContent` instead of `JSON.stringify(value)`. Same tool, same schema, same `browserApi.evaluateScript` call — only the result-shaping line changes.

- [ ] **Step 1: Add the import.** After `server.ts:9` (`import { formatSnapshotResult } from "./snapshot-format";`) add:

```ts
import { formatEvalResult } from "./eval-format";
```

- [ ] **Step 2: Swap the handler return.** In the `evaluate-script` callback (`server.ts:599-610`), replace the trailing return:

```ts
  async ({ tabId, function: functionSource, args, world, engine }) => {
    const value = await browserApi.evaluateScript(
      tabId,
      functionSource,
      args,
      world,
      engine
    );
    return formatEvalResult(value);
  }
```

(Delete the old `return { content: [{ type: "text", text: JSON.stringify(value) }] };` block at `:607-609`. `browserApi.evaluateScript` already returns the raw `message.value` — `browser-api.ts:786` — so `value` is exactly what the page returned; the extension leg is unchanged.)

- [ ] **Step 3: Build, confirm it type-checks** — `cd mcp-server && npm run build` → compiles. This is the integration proof: the callback's inferred return `{ content: {type:"text";text:string}[]; structuredContent?: Record<string,unknown> }` is assignable to `ToolCallback`'s `CallToolResult`. If it did NOT compile, the fallback (per spec §F: "if the SDK/`tool()` return type doesn't accept it, drop it, no behavior loss") is to delete the `structuredContent` field from `eval-format.ts` and keep only `content` — but with SDK 1.29.0 confirmed above, this compiles as-is and no fallback is needed.

- [ ] **Step 4: Manual smoke (optional but recommended)** — after the standard rebuild ritual (`npm run build` → `mcpkit runtime stop foxpilot` → reload/reinstall extension per Global Constraints), drive a tab and confirm:
  - `evaluate-script '{"tabId":<id>,"function":"() => JSON.stringify({a:1,b:[2,3]})"}'` → text is `{"a":1,"b":[2,3]}` **verbatim** (no `\"` escaping, no wrapping quotes).
  - `evaluate-script '{"tabId":<id>,"function":"() => ({name:\"Country\",value:\"US\"})"}'` → pretty 2-space JSON text **and** a `structuredContent` object on the result.
  - `evaluate-script '{"tabId":<id>,"function":"() => document.title"}'` → the title as a **bare** string (previously `"<title>"` quoted).

- [ ] **Step 5: Commit** — `git add mcp-server/server.ts && git commit -m "feat(evaluate-script): return formatEvalResult (raw strings, no double-encode, structuredContent for objects)"`

---

### Task 38: Investigate the stray "You have not agreed to the Xcode license agreements" line (item 7)

**This is an INVESTIGATION, not a speculative code change.** Per spec §G, the deliverable **may be documentation-only, and that is acceptable** — add a code change **only if** FoxPilot is proven to pollute the MCP server's stdout (it should not; the "test" below is a verification checklist, not TDD). Do NOT over-scope into a code change on hypothesis.

**Confirmed pre-investigation facts (from source, to be reproduced not assumed):**
- The native trigger is under **`input-sidecar`**: it depends on `@nut-tree-fork/nut-js` (`input-sidecar/package.json`), which pulls `@nut-tree-fork/libnut` → the platform binding **`@nut-tree-fork/libnut-darwin`**. That binding compiles a native addon with **cmake-js** (its `package.json` scripts: `build:release: cmake-js rebuild …`) into `input-sidecar/node_modules/@nut-tree-fork/libnut-darwin/build/Release/libnut.node` (**present on disk** = a native compile ran at install). cmake-js drives **clang**, and clang/xcodebuild on macOS prints `"You have not agreed to the Xcode license agreements"` when the Command Line Tools license is unaccepted. This fires during the root `postinstall` chain (`package.json`: `… && npm install --prefix input-sidecar`).
- **Runtime stdout is structurally clean** and must be *confirmed*, not assumed: the server/broker run **esbuild bundles** (`dist/server.js`, `dist/broker-main.js`) with **no native build at startup**; the input-sidecar auto-spawn is **opt-in** (`ensureSidecar` no-ops unless `INPUT_SIDECAR_ENTRY` is set — `browser-api.ts:174-178`) and even when set spawns **detached with `stdio:"ignore"`** (`browser-api.ts:180-189`); the broker spawns the same way (`:216-227`); all server diagnostics use `console.error` → **stderr** (e.g. `browser-api.ts:191`); stdout is owned exclusively by `StdioServerTransport` (`server.ts:1181`) for JSON-RPC.

**Files:**
- Modify (expected): `CLAUDE.md` (add a dev-notes bullet).
- Modify (ONLY IF a stdout leak is proven — not expected): the offending child-spawn stdio wiring to redirect its stderr away from the parent's stdout.

**Verification checklist (the task's "test"):**

- [ ] **Step 1: Reproduce and pin the emitter.** From a clean tree, capture stderr:

```bash
cd /Users/balakumar/personal/browser-control-mcp
rm -rf node_modules */node_modules
npm install 1>/tmp/foxpilot-install.out 2>/tmp/foxpilot-install.err
grep -n "Xcode license" /tmp/foxpilot-install.err /tmp/foxpilot-install.out
```

Expected: the match is on **stderr** during the `input-sidecar` install (the `@nut-tree-fork/libnut-darwin` cmake-js/clang native build). Record which subproject and step actually emitted it (confirm it is install-time, not runtime). If it does **not** reproduce (license already accepted), note that and still complete Steps 2–5 to lock in the confirmation + docs.

- [ ] **Step 2: Confirm it is local CLT-license state (not a repo bug).**

```bash
xcode-select -p                 # CLT/Xcode path
xcodebuild -license status      # or: sudo xcodebuild -license check
```

Expected: the license is unaccepted (or CLT-only). This confirms the line is machine state, independent of FoxPilot source.

- [ ] **Step 3: CRITICALLY confirm the server's stdout (the JSON-RPC channel) is never polluted.** Two parts:
  - **Static:** re-confirm the four facts above by reading `browser-api.ts:174-193` (`ensureSidecar` opt-in + detached `stdio:"ignore"`), `:216-227` (broker spawn, same), and that no runtime path shells out to a compiler. Confirm every diagnostic is `console.error` (stderr), not `console.log`/`process.stdout.write`.
  - **Dynamic smoke:** with a built server + running broker + connected extension, capture the server's stdout in isolation and confirm it carries **only** JSON-RPC. Preferred: `mcpkit call foxpilot list-browsers` (or `list-tabs`) returns **clean JSON** with no leading/trailing prose. If reproducing the raw stdout stream is easier out-of-band: `node mcp-server/dist/server.js < /dev/null 1>/tmp/foxpilot.stdout 2>/tmp/foxpilot.stderr` for a moment, then `grep -c "Xcode\|license\|>" /tmp/foxpilot.stdout` → expect the Xcode/license string count to be **0** (stdout holds only protocol frames).

- [ ] **Step 4: Remediate the local state.**

```bash
sudo xcodebuild -license accept
```

Then re-run Step 1's `npm install` and confirm the line is **gone** from stderr.

- [ ] **Step 5: Document in `CLAUDE.md` dev-notes.** Add this bullet under the Gotchas/Dev-notes list (ready to paste):

```markdown
- **Stray "You have not agreed to the Xcode license agreements" during `npm install`:** emitted by the **`input-sidecar`** native binding build (`@nut-tree-fork/nut-js` → `@nut-tree-fork/libnut-darwin`, compiled by cmake-js/clang into `build/Release/libnut.node`) when the macOS Command Line Tools license hasn't been accepted. It is **local toolchain state, not a FoxPilot bug**, and is **install-time only** — at runtime the server/broker run esbuild bundles (`dist/*.js`, no native compile), the input-sidecar auto-spawn is opt-in (`INPUT_SIDECAR_ENTRY`, default off) and spawns **detached with `stdio:"ignore"`**, and all server diagnostics go to `console.error` (stderr) — so it **never reaches the MCP server's stdout** (the JSON-RPC channel). Fix once with `sudo xcodebuild -license accept`. (Native input is optional; even a failed build only degrades native input to the synthetic path.)
```

(`CLAUDE.md` is tracked — no `git add -f` needed, unlike the gitignored `docs/`.)

- [ ] **Step 6: Code change — ONLY IF Step 3 proved stdout pollution (NOT expected).** If, and only if, the smoke shows the Xcode/license text on the server's *stdout*, add the minimal fix: ensure the offending child process's `stderr` is not inherited to the parent's stdout (the spawns already use `stdio:"ignore"`, so this should be a no-op) — do **not** change `console.error` sites (stderr is correct). Otherwise, the deliverable is **documentation only**.

- [ ] **Step 7: Commit** — documentation-only path: `git add CLAUDE.md && git commit -m "docs(xcode): document install-time Xcode-license line (input-sidecar native build) + stdout-cleanliness (item 7)"`. (If a code change was genuinely required in Step 6, use `fix(input-sidecar): keep child stderr off server stdout` and include the touched file.)

---

### Wave 4 gate

- `cd mcp-server && npx jest` fully green (incl. new `eval-format.test.ts`); `cd mcp-server && npm run build` compiles (proves `structuredContent` is `CallToolResult`-assignable under SDK 1.29.0).
- Item 7 closed as **documentation** unless the stdout smoke proves otherwise.
- No extension/`common`/injected files touched → nothing to mirror, `self-containment.test.ts` unaffected. Feeds into the single final spec-review + quality-review pass (wave-mode discipline), not a per-task review.


---

## Final review pass (after all waves)

Per the v1.0.14 wave-mode discipline, run ONE consolidated review after all waves land — not per task:

1. **Build the whole monorepo:** `npm run build` (nx) + `npm run package --prefix chrome-extension`. Both green (the release workflow builds chrome-extension explicitly, so it must pass on its own).
2. **Full unit suites:** `cd firefox-extension && npx jest`, `cd chrome-extension && npx jest`, `cd mcp-server && npx jest` — all green.
3. **Byte-identical parity** for every edited/new injected module: `diff <(sed -n '/export .*function/,$p' firefox-extension/injected/X.ts) <(sed -n '/export .*function/,$p' chrome-extension/injected/X.ts)` → empty for `snapshot-script.ts`, `action-script.ts`, `select-option-script.ts`, `dismiss-overlays-script.ts` (bodies only; header comments may differ).
4. **self-containment** green: new `selectOption`/`dismissOverlays` registered in `INJECTED_FUNCTIONS`; no `FORBIDDEN_TOKENS`; the async `selectOption` stringifies without `__awaiter`/`__generator` (esbuild `esnext` + ES2022 tsconfig keep `async`/`await` native).
5. **Playwright e2e:** `npm run test:e2e` (Chromium) — enriched snapshot grammar/values/breadcrumbs; `select-option` real portal pick; `dismiss-overlays` clears + survives a `pushState` route change; `click-element` interception when covered. Off the release path.
6. **Spec coverage:** every spec §A–§G item maps to a landed task (map below).
7. **Quality review** (`superpowers:requesting-code-review`): correctness + reuse/simplification across the whole diff; verify **no new browser permission** crept into either manifest; verify **no page-world `<script>` injection** was added for anything that should be CSP-immune (snapshot/click/select/dismiss stay isolated-world).
8. **Manual smoke** (the ritual in Global Constraints): `cd mcp-server && npm run build` → `mcpkit runtime stop foxpilot` → reload/reinstall the extension → drive `test-fixtures/spa-widgets/` (and optionally the live `dash.cloudflare.com` token flow) through `mcpkit call foxpilot …` for each new/changed tool.

### Spec-coverage map

| Spec item | Tasks |
|---|---|
| A — content-script readiness after nav | 4, 5, 6, 8 |
| B — navigate-tab settle + real URL | 3, 7, 8 |
| C — snapshot 3-slot grammar | 11, 12, 13, 14, 15 |
| D — select-option (native + custom) | 26, 27, 30 |
| E(a) — click interception detection | 21, 22, 23 |
| E(b) — dismiss-overlays | 28, 29, 30 |
| F — evaluate-script structured result | 36, 37 |
| G — Xcode-line investigation | 38 |
| Fixture + Playwright harness | 1, 2 (e2e specs added in 23, 30) |
