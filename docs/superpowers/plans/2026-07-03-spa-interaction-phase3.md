# FoxPilot SPA Interaction — Phase 3 (Opt-in CDP Trusted Coordinate Tier + Credential Un-redaction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the opt-in, NOT-covert Phase 3 of the CSP-strict-SPA interaction design (spec §8): (#1) the four coordinate tools `click-at` / `type-at` / `hover-at` / `scroll-at` gain an optional `engine?: "synthetic" | "cdp"` param — default `"synthetic"` keeps Phase-2 behavior **byte-unchanged**, while `engine:"cdp"` (Chrome/Edge only) dispatches **guaranteed-trusted** (`isTrusted:true`) `Input.*` events via `chrome.debugger` at viewport `{x,y}` and reads back the same `point-action-result` element descriptor; and (#5) `get-network-requests` gains `includeCredentials?: boolean` (default false) that un-redacts `Cookie`/`Authorization`/`Set-Cookie` header values. Both default off. Underneath #1 is the load-bearing refactor: the existing `chrome.debugger` attach (today network-only, used by `capture-response-bodies`) is generalized into a **per-tab purpose refcount** (`network` | `input`) so a CDP input dispatch and response-body capture coexist on one tab without either tearing the other down. Plus the mcpkit skill docs. Builds directly on Phase 2 (already implemented on `feat/spa-interaction`, the branch this phase continues on). No sidecar work; the `debugger` manifest permission is already present (no new permission).

**Architecture:** Phase 3 adds **NO new `cmd`** — the four `-at` tools already exist and are fully wired (union entry, `COMMAND_TO_TOOL_ID`, `AVAILABLE_TOOLS`, `AUTOMATION_COMMANDS`, both `_exhaustiveCheck: never` switches). So the tool-adding chain is untouched; the work is: (a) an optional `engine` field on the four `*ServerMessage` interfaces + `z.enum(["synthetic","cdp"]).optional()` on the four tools + a client-method pass-through; (b) a new Chrome-only `chrome-extension/cdp-input.ts` (the `Input.*` dispatchers); (c) a purpose-refcount refactor of `chrome-extension/network-capture.ts`'s `attachDebugger`/`detachDebugger`; (d) an `engine` branch in each extension's existing `runPointAction` (Chrome → CDP dispatch + isolated-world descriptor read; Firefox → a clear `ok:false` "not supported on Firefox"); and (e) a server-side-only un-redact flag on `get-network-requests`. The CDP dispatch itself is **Chrome-only**; the `engine` param and the Firefox `cdp` error branch are mirrored. The trusted events are dispatched from the extension background (service worker) via `chrome.debugger.sendCommand`; the element descriptor after the action is read from the **ISOLATED** content-script world via a new read-only `describe-at` action added to the (byte-identical) `injected/point-action-script.ts`.

**Tech Stack:** TypeScript, esbuild, Jest (ts-jest + jsdom), Nx monorepo.

## Global Constraints
- **Node** `>=22` (mcp-server `engines.node`); extensions target the browser runtime. **zod 4.3.6** — for any map param use the two-arg `z.record(z.string(), z.string())`. **Phase 3 needs none**: `engine` is `z.enum(...)`, `includeCredentials` is `z.boolean()`.
- **`engine` default is `"synthetic"` and Phase-2 behavior is BYTE-UNCHANGED.** `engine` is an OPTIONAL field added to the existing `ClickAtServerMessage`/`TypeAtServerMessage`/`HoverAtServerMessage`/`ScrollAtServerMessage`. When it is absent or `"synthetic"`, `runPointAction` takes the exact Phase-2 isolated-world path. There is **NO new `cmd`**, so do **NOT** edit `COMMAND_TO_TOOL_ID`, `AVAILABLE_TOOLS`, `AUTOMATION_COMMANDS`, or the two `_exhaustiveCheck: never` switches — only add the optional field, thread it through, and branch on it.
- **CDP tier is Chrome/Edge ONLY.** `engine:"cdp"` on Firefox → a clear `ok:false` `point-action-result` ("CDP engine not supported on Firefox — use the default synthetic engine"), returned BEFORE any injection. On Chrome it attaches `chrome.debugger` (refcounted), dispatches trusted `Input.*` at viewport CSS-px `{x,y}` (native coords — no screen mapping, no DPR), then reads the descriptor from the isolated world. It shows the "started debugging this browser" banner (documented, opt-in) and does **not** move the OS cursor. The `chrome-extension/cdp-input.ts` module is imported ONLY by the Chrome extension.
- **Debugger attach is purpose-refcounted (`network` | `input`).** `attachDebugger(tabId, purpose="network")` attaches once per tab and runs `Network.enable` only for the `network` purpose; `detachDebugger(tabId, purpose="network")` really detaches only when the LAST purpose releases. The `purpose` parameter **defaults to `"network"`**, so every existing one-arg call site (`capture-response-bodies` and all of `network-capture.test.ts`) keeps working unchanged. The covert `webRequest` suppression guard flips from "any debugger attached" to "the **network** purpose is attached" so an input-only CDP attach does NOT suppress covert capture. All three auto-detach triggers (tab close, Automation-off, external `onDetach`) release EVERY purpose via a new `forceDetachDebugger`.
- **`includeCredentials` is server-side-only** (exactly like `includeHeaders`): headers are always captured; the flag only controls printing. It touches `mcp-server/server.ts` (+ an extracted pure `network-format.ts` helper) and a unit test — NO wire/message/extension change.
- **Mirror both extensions** for the `engine` field + the Firefox `cdp` error branch + the byte-identical `describe-at` action in `injected/point-action-script.ts`. The CDP dispatch (`cdp-input.ts`) is Chrome-only.
- **jsdom caveat.** The `chrome.debugger` mock in `chrome-extension/__tests__/setup.ts` (`attach`/`detach`/`sendCommand`/`onEvent`/`onDetach` as `jest.fn`) exercises the CDP path — tests assert the `Input.dispatchMouseEvent`/`insertText`/`dispatchKeyEvent` `sendCommand` calls and the refcount attach/detach. `document.elementFromPoint` is stubbed for the `describe-at` descriptor read (jsdom has no layout: it returns `null` and rects are zero — never assert rect values).
- **Backward compatible.** No existing tool loses a param or changes default behavior. New fields are optional and conditionally spread. `engine` omitted ⇒ Phase-2 output identical; `includeCredentials` omitted ⇒ redacted output identical.

## File Structure

Legend: **[C]** create, **[M]** modify.

| Path | Task(s) | Responsibility |
|------|---------|----------------|
| `chrome-extension/network-capture.ts` | 1 [M] | `attachDebugger`/`detachDebugger` → purpose refcount (`Map<tabId,Set<"network"\|"input">>`); `Network.enable` only for `network`; `forceDetachDebugger`; `hasNetworkPurpose` guards; `onDetach`/tab-close/automation-off clear all purposes |
| `chrome-extension/message-handler.ts` | 1,2,3,4 [M] | `setResponseBodyCapture` passes `"network"`; import `cdp-input`; `runPointAction` gains `engine` + `dispatchCdpPointAction`; forward `req.engine` in the 4 `-at` cases |
| `chrome-extension/cdp-input.ts` | 2,3,4 [C] | `cdpInputClick` (2), `cdpInputType` (3), `cdpInputHover`/`cdpInputScroll` (4) — refcounted `"input"` attach → `Input.*` → release |
| `common/server-messages.ts` | 2 [M] | optional `engine?: "synthetic"\|"cdp"` on `ClickAt`/`TypeAt`/`HoverAt`/`ScrollAt` `ServerMessage` interfaces |
| `chrome-extension/injected/point-action-script.ts` | 2 [M] | add read-only `describe-at` action (byte-identical to Firefox copy) |
| `firefox-extension/injected/point-action-script.ts` | 2 [M] | identical `describe-at` addition |
| `firefox-extension/message-handler.ts` | 2 [M] | `runPointAction` gains `engine`; `engine:"cdp"` → `ok:false` Firefox-unsupported error; forward `req.engine` in the 4 `-at` cases |
| `mcp-server/server.ts` | 2,5 [M] | `engine` param on the 4 coordinate tools + descriptions; `get-network-requests` `includeCredentials` param + description; use `network-format` helper |
| `mcp-server/browser-api.ts` | 2 [M] | `clickAt`/`typeAt`/`hoverAt`/`scrollAt` forward `engine` |
| `mcp-server/network-format.ts` | 5 [C] | pure, importable `SENSITIVE_HEADER` + `formatNetworkHeaders(label, headers, includeCredentials)` (extracted from `server.ts`) |
| `chrome-extension/__tests__/network-capture.test.ts` | 1 [M] | new refcount describe block (existing CDP block passes unchanged) |
| `chrome-extension/__tests__/cdp-input.test.ts` | 2,3,4 [C] | `chrome.debugger`-mock tests for the `Input.*` sequences + refcount coexistence |
| `chrome-extension/__tests__/point-action-script.test.ts` | 2 [M] | `describe-at` read-only descriptor test |
| `firefox-extension/__tests__/point-action-script.test.ts` | 2 [M] | identical `describe-at` test |
| `chrome-extension/__tests__/message-handler.test.ts` | 2,3,4 [M] | CDP-engine routing tests (dispatch + descriptor read + attach-fail ok:false + synthetic-unchanged) |
| `firefox-extension/__tests__/message-handler.test.ts` | 2 [M] | `engine:"cdp"` → ok:false Firefox error; synthetic still injects |
| `mcp-server/__tests__/coordinate-tools.test.ts` | 2 [M] | broker round-trip: `engine:"cdp"` rides the `click-at` frame |
| `mcp-server/__tests__/network-format.test.ts` | 5 [C] | `formatNetworkHeaders` redacts by default, un-redacts on `includeCredentials` |
| `~/.claude/skills/mcpkit-foxpilot/SKILL.md` | 6 [M] | mcpkit skill docs for `engine` + `includeCredentials` (outside the repo) |

---

### Task 1 — Purpose-refcount the `chrome.debugger` attach (`network` | `input`) so CDP input coexists with response-body capture (#1 infra)

Generalize `chrome-extension/network-capture.ts`'s single `debuggerAttached: Set<number>` into a per-tab purpose set `Map<number, Set<"network"|"input">>`. Attach once per tab; run `Network.enable` only for the `network` purpose; really detach only when the last purpose releases. The covert-suppression guard flips from "debugger attached" to "**network** purpose attached" so an input-only attach (the CDP `-at` tier, Task 2+) never suppresses covert capture. `purpose` **defaults to `"network"`**, so `capture-response-bodies` and every existing test keep working with zero edits; Task 1 only ADDS refcount tests and makes `setResponseBodyCapture` pass `"network"` explicitly (behavior-identical). **Chrome only** (Firefox has no `chrome.debugger`).

**Files:**
- Modify `chrome-extension/network-capture.ts` — the debugger section (const at line ~43; `isDebuggerAttached` ~53; guards in `onBeforeRequestRecord` ~98 / `onCompletedRecord` ~147 / `onErrorOccurredRecord` ~173; `attachDebugger` ~481; `detachDebugger` ~493; `onDebuggerEvent` guard ~511; `onDebuggerDetach` ~611; `initNetworkCapture` triggers ~624 and ~645).
- Modify `chrome-extension/message-handler.ts` — `setResponseBodyCapture` (~1347-1352) passes `"network"`.
- Modify `chrome-extension/__tests__/network-capture.test.ts` — add a refcount describe block.

**Interfaces:**
- `type DebuggerPurpose = "network" | "input"`.
- `attachDebugger(tabId: number, purpose?: DebuggerPurpose /* = "network" */) => Promise<void>`.
- `detachDebugger(tabId: number, purpose?: DebuggerPurpose /* = "network" */) => Promise<void>`.
- `forceDetachDebugger(tabId: number) => Promise<void>` (NEW export; full teardown for the auto-detach triggers).
- `isDebuggerAttached(tabId) => boolean` unchanged semantics = "the **network** purpose holds the tab" (drives `bodyCaptureSupported`).

**Steps:**

1. - [ ] **Failing test (refcount semantics).** In `chrome-extension/__tests__/network-capture.test.ts`, add a new top-level describe block (after the existing `describe("chrome.debugger (CDP) deep-capture path", ...)`). It reuses the file's already-imported `attachDebugger`/`detachDebugger`/`isDebuggerAttached`/`onBeforeRequestRecord`/`onCompletedRecord`/`getNetworkRequests`/`clearAllNetworkState` and the local `details(...)` helper, and `require`s the new `forceDetachDebugger`:
     ```ts
     describe("debugger attach purpose-refcounting (Phase 3)", () => {
       let dbg: any;
       const T = [910, 911, 912, 913];

       beforeEach(() => {
         dbg = (chrome as any).debugger;
         jest.clearAllMocks();
         clearAllNetworkState();
         dbg.attach.mockReset().mockResolvedValue(undefined);
         dbg.detach.mockReset().mockResolvedValue(undefined);
         dbg.sendCommand.mockReset().mockResolvedValue({});
       });

       afterEach(async () => {
         const { forceDetachDebugger } = require("../network-capture");
         for (const t of T) await forceDetachDebugger(t);
         clearAllNetworkState();
       });

       it("an input-purpose attach does NOT enable the Network domain and is not 'network attached'", async () => {
         await attachDebugger(910, "input");
         expect(dbg.attach).toHaveBeenCalledWith({ tabId: 910 }, "1.3");
         expect(dbg.sendCommand).not.toHaveBeenCalledWith(
           { tabId: 910 },
           "Network.enable"
         );
         expect(isDebuggerAttached(910)).toBe(false); // network purpose absent
       });

       it("an input-only attach does NOT suppress the covert webRequest path", async () => {
         await attachDebugger(911, "input");
         onBeforeRequestRecord(details({ requestId: "wr2", tabId: 911 }));
         onCompletedRecord(details({ requestId: "wr2", tabId: 911, statusCode: 200 }));
         expect(getNetworkRequests(911)).toHaveLength(1);
       });

       it("two purposes on one tab attach ONCE and detach only after both release", async () => {
         await attachDebugger(912, "network");
         await attachDebugger(912, "input");
         expect(dbg.attach).toHaveBeenCalledTimes(1);
         await detachDebugger(912, "input");
         expect(dbg.detach).not.toHaveBeenCalled();
         expect(isDebuggerAttached(912)).toBe(true);
         await detachDebugger(912, "network");
         expect(dbg.detach).toHaveBeenCalledWith({ tabId: 912 });
         expect(isDebuggerAttached(912)).toBe(false);
       });

       it("runs Network.enable exactly once even if the network purpose is added twice", async () => {
         await attachDebugger(913, "network");
         await attachDebugger(913, "network");
         const enables = (dbg.sendCommand as jest.Mock).mock.calls.filter(
           (c: any[]) => c[1] === "Network.enable"
         );
         expect(enables).toHaveLength(1);
         expect(dbg.attach).toHaveBeenCalledTimes(1);
       });

       it("forceDetachDebugger tears down every purpose at once", async () => {
         await attachDebugger(910, "network");
         await attachDebugger(910, "input");
         const { forceDetachDebugger } = require("../network-capture");
         await forceDetachDebugger(910);
         expect(dbg.detach).toHaveBeenCalledWith({ tabId: 910 });
         expect(isDebuggerAttached(910)).toBe(false);
       });
     });
     ```

2. - [ ] **Run-to-fail:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/network-capture.test.ts -t "purpose-refcounting"
     ```
     Expected: FAIL — `attachDebugger` takes one arg today (`"input"` is ignored), always runs `Network.enable`, and `forceDetachDebugger` does not exist.

3. - [ ] **Impl — refcount state + guards.** In `chrome-extension/network-capture.ts`, replace the single-set declaration (currently `const debuggerAttached = new Set<number>();`, line ~43) with the purpose map + a network-purpose predicate:
     ```ts
     // Purpose-refcounted chrome.debugger attach. A tab's debugger can be held by
     // more than one PURPOSE at once: "network" (response-body deep-capture, which
     // runs Network.enable) and "input" (the engine:"cdp" trusted coordinate tools,
     // which dispatch Input.* and never enable the Network domain). We attach once,
     // run Network.enable only for the network purpose, and only really detach when
     // the LAST purpose releases — so a CDP click on a tab that is already capturing
     // response bodies does not tear the capture down, and vice-versa.
     type DebuggerPurpose = "network" | "input";
     const attachedPurposes = new Map<number, Set<DebuggerPurpose>>();

     // True when the NETWORK purpose holds the debugger for this tab — i.e. response
     // bodies are being deep-captured. The covert webRequest path is suppressed only
     // for such tabs (an input-only CDP attach must NOT suppress covert capture,
     // since it never enables the Network domain).
     function hasNetworkPurpose(tabId: number): boolean {
       const s = attachedPurposes.get(tabId);
       return !!s && s.has("network");
     }
     ```
     Replace `isDebuggerAttached` (lines ~53-55) so its meaning ("response-body capture attached") maps to the network purpose:
     ```ts
     export function isDebuggerAttached(tabId: number): boolean {
       return hasNetworkPurpose(tabId);
     }
     ```
     In the three covert-path guards, change `debuggerAttached.has(details.tabId)` → `hasNetworkPurpose(details.tabId)`:
     - `onBeforeRequestRecord` (line ~98): `if (hasNetworkPurpose(details.tabId)) { return; }`
     - `onCompletedRecord` (line ~147): `if (typeof details.tabId === "number" && hasNetworkPurpose(details.tabId)) { return; }`
     - `onErrorOccurredRecord` (line ~173): `if (typeof details.tabId === "number" && hasNetworkPurpose(details.tabId)) { return; }`

4. - [ ] **Impl — attach/detach/forceDetach.** In `chrome-extension/network-capture.ts`, replace `attachDebugger` (lines ~481-487) and `detachDebugger` (lines ~493-500) and add `forceDetachDebugger` immediately after:
     ```ts
     /**
      * Attach the chrome.debugger (CDP) path to a tab under a PURPOSE and, for the
      * network purpose, enable the Network domain. Shows the "started debugging this
      * browser" banner on the first purpose. `purpose` defaults to "network" so
      * existing one-arg callers (capture-response-bodies) are unchanged. A rejection
      * (DevTools already open / another debugger attached) propagates so the caller
      * can surface ok:false.
      */
     export async function attachDebugger(
       tabId: number,
       purpose: DebuggerPurpose = "network"
     ): Promise<void> {
       const dbg = (chrome as any).debugger;
       registerDebuggerListeners();
       let set = attachedPurposes.get(tabId);
       if (!set || set.size === 0) {
         // First purpose on this tab — actually attach (this shows the banner).
         await dbg.attach({ tabId }, "1.3");
         set = new Set<DebuggerPurpose>();
         attachedPurposes.set(tabId, set);
       }
       // Enable the Network domain only for the network purpose, and only the first
       // time it is added (avoids a redundant Network.enable round-trip).
       if (purpose === "network" && !set.has("network")) {
         await dbg.sendCommand({ tabId }, "Network.enable");
       }
       set.add(purpose);
     }

     /**
      * Release a PURPOSE's hold on the debugger. Really detaches (and drops the
      * tab's in-flight CDP records) only when the LAST purpose releases. `purpose`
      * defaults to "network" for back-compat. Idempotent.
      */
     export async function detachDebugger(
       tabId: number,
       purpose: DebuggerPurpose = "network"
     ): Promise<void> {
       const set = attachedPurposes.get(tabId);
       if (set && set.has(purpose)) {
         set.delete(purpose);
         if (set.size === 0) {
           // Last purpose released — really detach (the banner goes away).
           attachedPurposes.delete(tabId);
           const dbg = (chrome as any).debugger;
           await dbg.detach({ tabId }).catch(() => {});
         }
       }
       // Drop stray CDP in-flight records once the tab is no longer attached for ANY
       // purpose (idempotent — matches the old always-cleanup for the fully-detached
       // case; a still-attached tab keeps its in-flight records).
       if (!attachedPurposes.has(tabId)) {
         dropCdpTab(tabId);
       }
     }

     /**
      * Fully tear down the debugger for a tab regardless of how many purposes hold
      * it — used by the auto-detach triggers (tab closed, Automation Mode turned
      * off) where every purpose must be released at once. Detaches (if attached),
      * clears all purposes, and drops the tab's in-flight CDP records.
      */
     export async function forceDetachDebugger(tabId: number): Promise<void> {
       const set = attachedPurposes.get(tabId);
       attachedPurposes.delete(tabId);
       if (set && set.size > 0) {
         const dbg = (chrome as any).debugger;
         await dbg.detach({ tabId }).catch(() => {});
       }
       dropCdpTab(tabId);
     }
     ```

5. - [ ] **Impl — event guard + external detach + auto-detach triggers.** In `chrome-extension/network-capture.ts`:
     - `onDebuggerEvent` guard (line ~511): change `!debuggerAttached.has(tabId)` → `!hasNetworkPurpose(tabId)`:
       ```ts
       if (typeof tabId !== "number" || !hasNetworkPurpose(tabId)) {
         return;
       }
       ```
     - `onDebuggerDetach` (lines ~611-618): clear EVERY purpose (the debugger is gone for the tab):
       ```ts
       function onDebuggerDetach(source: { tabId?: number }, _reason: string): void {
         const tabId = source?.tabId;
         if (typeof tabId !== "number") {
           return;
         }
         // External detach (banner dismissed / DevTools closed / target crashed)
         // tears down every purpose at once.
         attachedPurposes.delete(tabId);
         dropCdpTab(tabId);
       }
       ```
     - `initNetworkCapture` tab-close (line ~624): `void detachDebugger(tabId);` → `void forceDetachDebugger(tabId);`
     - `initNetworkCapture` automation-off loop (lines ~645-647): iterate the purpose map and force-detach each:
       ```ts
       for (const attachedTabId of Array.from(attachedPurposes.keys())) {
         void forceDetachDebugger(attachedTabId);
       }
       ```

6. - [ ] **Impl — `setResponseBodyCapture` passes `"network"` explicitly.** In `chrome-extension/message-handler.ts`, in `setResponseBodyCapture` (lines ~1348-1352), make the purpose explicit (behavior-identical to the default, but self-documenting):
     ```ts
       if (req.enabled) {
         await attachDebugger(req.tabId, "network");
       } else {
         await detachDebugger(req.tabId, "network");
       }
     ```

7. - [ ] **Run-to-pass (refcount + existing debugger tests untouched):**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/network-capture.test.ts __tests__/message-handler.test.ts
     ```
     Expected: all PASS — the new refcount block is green; the **existing** `chrome.debugger (CDP) deep-capture path` block (its `attachDebugger(999)` / `detachDebugger(t)` / `isDebuggerAttached(...)` one-arg calls default to `"network"`) and the `capture-response-bodies command` block (asserts `dbg.attach` / `sendCommand("Network.enable")` / `dbg.detach`) pass **unchanged**.

8. - [ ] Commit:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     git add chrome-extension
     git commit -m "refactor(network-capture): purpose-refcount chrome.debugger attach (network|input) so CDP input coexists with response-body capture"
     ```

---

### Task 2 — `cdp-input.ts` (`cdpInputClick`) + `engine` param plumbing + `click-at` CDP tier + `describe-at` descriptor read (#1)

The heavy task: add the optional `engine` field to all four coordinate `ServerMessage` interfaces (uniform plumbing — they share `runPointAction`), the `z.enum` on the four tools + browser-api pass-through, the new Chrome-only `cdp-input.ts` with `cdpInputClick`, the read-only `describe-at` action in the byte-identical `injected/point-action-script.ts`, and the `engine` branch in each extension's `runPointAction` (Chrome → CDP dispatch + descriptor read; Firefox → Firefox-unsupported `ok:false`). Ships `click-at` on CDP; Tasks 3–4 add the other three dispatch functions + `dispatchCdpPointAction` cases.

**Files:**
- Create `chrome-extension/cdp-input.ts`.
- Modify `common/server-messages.ts` — `engine?` on the 4 interfaces.
- Modify `chrome-extension/injected/point-action-script.ts` and `firefox-extension/injected/point-action-script.ts` — `describe-at` action (identical).
- Modify `chrome-extension/message-handler.ts` — import `cdpInputClick` + `PointElementDescriptor`; `runPointAction` `engine` param; `dispatchCdpPointAction`; forward `req.engine` in the 4 cases.
- Modify `firefox-extension/message-handler.ts` — `runPointAction` `engine` param → cdp error; forward `req.engine` in the 4 cases.
- Modify `mcp-server/browser-api.ts` — `engine` on `clickAt`/`typeAt`/`hoverAt`/`scrollAt`.
- Modify `mcp-server/server.ts` — `engine` zod + descriptions on the 4 tools.
- Create `chrome-extension/__tests__/cdp-input.test.ts`.
- Modify both `__tests__/point-action-script.test.ts`; both `__tests__/message-handler.test.ts`; `mcp-server/__tests__/coordinate-tools.test.ts`.

**Interfaces:**
- Consumes (MCP): `click-at { tabId, x, y, doubleClick?, button?, engine?: "synthetic"|"cdp" }` (and the same `engine?` on the other three).
- Produces (extension): the existing `PointActionResultExtensionMessage { resource:"point-action-result"; ok; error?; element? }`.
- Internal: `cdpInputClick(tabId, x, y, button, doubleClick) => Promise<void>`; `performPointAction(doc, { action:"describe-at", x, y }) => { ok; error?; element? }`.

**Steps:**

1. - [ ] **Impl — `engine` on the 4 server-message interfaces.** In `common/server-messages.ts`, add `engine?: "synthetic" | "cdp";` to each of `ClickAtServerMessage` (line ~348), `TypeAtServerMessage` (~362), `HoverAtServerMessage` (~375), `ScrollAtServerMessage` (~389). Add this line to the top of each interface body (after `cmd`), with a shared comment on the first one:
     ```ts
     export interface ClickAtServerMessage extends ServerMessageBase {
       cmd: "click-at";
       // Dispatch engine. "synthetic" (default) runs covertly in the isolated world
       // (isTrusted:false). "cdp" (Chrome/Edge only) dispatches TRUSTED Input.*
       // events via chrome.debugger (isTrusted:true; shows the debugger banner;
       // errors on Firefox). Back-compat default is "synthetic".
       engine?: "synthetic" | "cdp";
       tabId: number;
       x: number;
       y: number;
       doubleClick?: boolean;
       button?: "left" | "middle" | "right";
     }
     ```
     For `TypeAtServerMessage`/`HoverAtServerMessage`/`ScrollAtServerMessage`, add just `engine?: "synthetic" | "cdp";` (a one-line `// See ClickAtServerMessage.engine.` comment is enough).

2. - [ ] **Failing test — `describe-at` (Firefox jsdom).** In `firefox-extension/__tests__/point-action-script.test.ts`, add:
     ```ts
     describe("describe-at (Phase 3 — read-only descriptor for the CDP engine)", () => {
       afterEach(() => {
         document.body.innerHTML = "";
         (document as any).elementFromPoint = undefined;
       });

       it("returns the element descriptor WITHOUT dispatching any event", () => {
         document.body.innerHTML = `<div id="card" role="button" class="a b">Open</div>`;
         const el = document.getElementById("card")!;
         (document as any).elementFromPoint = jest.fn(() => el);
         const onClick = jest.fn();
         el.addEventListener("click", onClick);

         const res = performPointAction(document, { action: "describe-at", x: 3, y: 4 });

         expect((document as any).elementFromPoint).toHaveBeenCalledWith(3, 4);
         expect(onClick).not.toHaveBeenCalled(); // read-only
         expect(res.ok).toBe(true);
         expect(res.element).toMatchObject({
           tag: "div",
           id: "card",
           role: "button",
           name: "Open",
         });
       });

       it("returns ok:false off-point", () => {
         (document as any).elementFromPoint = jest.fn(() => null);
         const res = performPointAction(document, { action: "describe-at", x: 1, y: 2 });
         expect(res.ok).toBe(false);
         expect(res.error).toMatch(/No element at point/);
       });
     });
     ```
     Copy the same describe block into `chrome-extension/__tests__/point-action-script.test.ts`. Then:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/point-action-script.test.ts -t "describe-at"
     ```
     Expected: FAIL — `describe-at` is not a valid action yet (TS union rejects it / falls through to "Unknown point action").

3. - [ ] **Impl — `describe-at` action (both copies, byte-identical).** In BOTH `chrome-extension/injected/point-action-script.ts` and `firefox-extension/injected/point-action-script.ts`, add the `describe-at` member to the `performPointAction` arg union (after the `scroll-at` member, line ~40):
     ```ts
         | { action: "scroll-at"; x: number; y: number; dx?: number; dy?: number }
         | { action: "describe-at"; x: number; y: number }
     ```
     and add its branch just before the final `return { ok: false, error: "Unknown point action" };` (line ~334):
     ```ts
     if (args.action === "describe-at") {
       // Read-only: describe the element under the point WITHOUT acting on it.
       // Used by the CDP engine to return the same descriptor shape as the
       // synthetic path AFTER it has dispatched the trusted Input.* events.
       const el = elementAt(args.x, args.y);
       if (!el) {
         return offPoint(args.x, args.y);
       }
       return { ok: true, element: describeElement(el) };
     }
     ```
     No `self-containment.test.ts` change is needed — `performPointAction` is already registered, and `describe-at` is an inner branch (no new function). The Chrome `content-script.ts` `case "performPointAction"` already forwards `message.args` to `performPointAction`, so it handles `describe-at` with no change. Re-run step 2's command (both extensions) → PASS:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/point-action-script.test.ts -t "describe-at"
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/point-action-script.test.ts -t "describe-at"
     ```

4. - [ ] **Failing test — `cdpInputClick` (Chrome, `chrome.debugger` mock).** Create `chrome-extension/__tests__/cdp-input.test.ts`:
     ```ts
     import { cdpInputClick } from "../cdp-input";
     import {
       attachDebugger,
       detachDebugger,
       isDebuggerAttached,
     } from "../network-capture";

     // Uses the chrome.debugger mock from __tests__/setup.ts. Asserts the trusted
     // Input.* sendCommand sequence AND that the refcounted "input" purpose attaches
     // and releases around each call (coexisting with a simulated "network" hold).
     describe("cdpInputClick (Phase 3)", () => {
       let dbg: any;

       beforeEach(() => {
         dbg = (chrome as any).debugger;
         dbg.attach.mockReset().mockResolvedValue(undefined);
         dbg.detach.mockReset().mockResolvedValue(undefined);
         dbg.sendCommand.mockReset().mockResolvedValue({});
       });

       afterEach(async () => {
         const { forceDetachDebugger } = require("../network-capture");
         await forceDetachDebugger(3);
         await forceDetachDebugger(4);
       });

       it("attaches 'input', dispatches a trusted press/release pair, and detaches", async () => {
         await cdpInputClick(3, 100, 200, "left", false);
         expect(dbg.attach).toHaveBeenCalledWith({ tabId: 3 }, "1.3");
         const mouse = (dbg.sendCommand as jest.Mock).mock.calls.filter(
           (c: any[]) => c[1] === "Input.dispatchMouseEvent"
         );
         expect(mouse).toHaveLength(2);
         expect(mouse[0][2]).toMatchObject({
           type: "mousePressed",
           x: 100,
           y: 200,
           button: "left",
           clickCount: 1,
         });
         expect(mouse[1][2]).toMatchObject({
           type: "mouseReleased",
           x: 100,
           y: 200,
           button: "left",
           clickCount: 1,
         });
         // input-only attach never enables the Network domain.
         expect(dbg.sendCommand).not.toHaveBeenCalledWith(
           { tabId: 3 },
           "Network.enable"
         );
         expect(dbg.detach).toHaveBeenCalledWith({ tabId: 3 });
       });

       it("emits a second clickCount:2 pair for a double-click", async () => {
         await cdpInputClick(3, 5, 6, "left", true);
         const mouse = (dbg.sendCommand as jest.Mock).mock.calls.filter(
           (c: any[]) => c[1] === "Input.dispatchMouseEvent"
         );
         expect(mouse).toHaveLength(4);
         expect(mouse[3][2]).toMatchObject({ type: "mouseReleased", clickCount: 2 });
       });

       it("does NOT detach when a network capture is already holding the tab", async () => {
         await attachDebugger(4, "network"); // simulate capture-response-bodies
         dbg.detach.mockClear();
         await cdpInputClick(4, 1, 2, "left", false);
         expect(dbg.detach).not.toHaveBeenCalled(); // network purpose still holds it
         expect(isDebuggerAttached(4)).toBe(true);
       });
     });
     ```
     Then:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/cdp-input.test.ts
     ```
     Expected: FAIL — `../cdp-input` does not exist.

5. - [ ] **Impl — `cdp-input.ts` (Chrome only).** Create `chrome-extension/cdp-input.ts`:
     ```ts
     /**
      * Chrome/Edge-only TRUSTED coordinate input via chrome.debugger (CDP). Backs the
      * engine:"cdp" tier of the -at tools: it dispatches Input.* events at viewport
      * CSS-pixel {x,y}, which the renderer delivers as isTrusted:true (so strict
      * rich-text editors that ignore synthetic events accept them). It does NOT move
      * the OS cursor and needs no sidecar — its only cost is the "started debugging
      * this browser" banner (documented, opt-in). The debugger attach is REFCOUNTED
      * under the "input" purpose (see network-capture.ts) so it coexists with
      * response-body capture on the same tab: each call attaches "input", dispatches,
      * and releases "input" in a finally.
      *
      * Coordinates are native viewport CSS px — no screen mapping, no DPR multiply.
      * Firefox has no CDP; the Firefox message handler rejects engine:"cdp" before
      * reaching this module (this file is imported ONLY by the Chrome extension).
      */
     import { attachDebugger, detachDebugger } from "./network-capture";

     type MouseButton = "left" | "middle" | "right";

     // Attach the "input" purpose, run the dispatch, and ALWAYS release it. Attach is
     // outside the try so a failed attach (DevTools already open) does not trigger a
     // spurious detach — nothing was attached.
     async function withInputAttach(
       tabId: number,
       fn: (dbg: any) => Promise<void>
     ): Promise<void> {
       const dbg = (chrome as any).debugger;
       await attachDebugger(tabId, "input");
       try {
         await fn(dbg);
       } finally {
         await detachDebugger(tabId, "input");
       }
     }

     export async function cdpInputClick(
       tabId: number,
       x: number,
       y: number,
       button: MouseButton,
       doubleClick: boolean
     ): Promise<void> {
       await withInputAttach(tabId, async (dbg) => {
         // First (and, for a single click, only) trusted press/release pair.
         await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
           type: "mousePressed",
           x,
           y,
           button,
           clickCount: 1,
         });
         await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
           type: "mouseReleased",
           x,
           y,
           button,
           clickCount: 1,
         });
         if (doubleClick) {
           // A trusted dblclick is a second pair with clickCount:2 (Chrome then
           // synthesizes the dblclick event itself).
           await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
             type: "mousePressed",
             x,
             y,
             button,
             clickCount: 2,
           });
           await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
             type: "mouseReleased",
             x,
             y,
             button,
             clickCount: 2,
           });
         }
       });
     }
     ```
     Re-run step 4's command → PASS.

6. - [ ] **Failing test — Chrome CDP routing (message handler).** In `chrome-extension/__tests__/message-handler.test.ts`, add a new describe block (model on the existing `coordinate tools (Task 2+)` block; `baseConfig`/`transport`/`messageHandler` are already in scope):
     ```ts
     describe("coordinate tools — CDP engine (Phase 3)", () => {
       const automationConfig = { ...baseConfig, automationMode: true };
       let dbg: any;

       beforeEach(() => {
         (browser.storage.local.get as jest.Mock).mockResolvedValue({
           config: automationConfig,
         });
         (browser.tabs.get as jest.Mock).mockResolvedValue({
           id: 8,
           url: "https://example.com",
         });
         (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
         dbg = (chrome as any).debugger;
         dbg.attach.mockReset().mockResolvedValue(undefined);
         dbg.detach.mockReset().mockResolvedValue(undefined);
         dbg.sendCommand.mockReset().mockResolvedValue({});
         // The isolated-world descriptor read that follows the CDP dispatch.
         (browser.tabs.sendMessage as jest.Mock).mockResolvedValue({
           ok: true,
           element: {
             tag: "div",
             id: "card",
             classes: [],
             rect: { x: 0, y: 0, w: 0, h: 0 },
             editable: false,
           },
         });
       });

       afterEach(async () => {
         const { forceDetachDebugger } = require("../network-capture");
         await forceDetachDebugger(8);
       });

       it("click-at engine:cdp dispatches trusted Input.* then reads the descriptor via describe-at", async () => {
         await messageHandler.handleDecodedMessage({
           cmd: "click-at",
           tabId: 8,
           x: 100,
           y: 200,
           engine: "cdp",
           correlationId: "cdpc",
         } as ServerMessageRequest);

         expect(dbg.attach).toHaveBeenCalledWith({ tabId: 8 }, "1.3");
         const mouse = (dbg.sendCommand as jest.Mock).mock.calls.filter(
           (c: any[]) => c[1] === "Input.dispatchMouseEvent"
         );
         expect(mouse[0][2]).toMatchObject({ type: "mousePressed", x: 100, y: 200 });
         expect(mouse[1][2]).toMatchObject({ type: "mouseReleased", x: 100, y: 200 });
         // Descriptor read is a read-only describe-at in the isolated world.
         expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
           type: "performPointAction",
           args: { action: "describe-at", x: 100, y: 200 },
         });
         expect(transport.sendResourceToServer).toHaveBeenCalledWith({
           resource: "point-action-result",
           correlationId: "cdpc",
           ok: true,
           element: {
             tag: "div",
             id: "card",
             classes: [],
             rect: { x: 0, y: 0, w: 0, h: 0 },
             editable: false,
           },
         });
         expect(dbg.detach).toHaveBeenCalledWith({ tabId: 8 });
       });

       it("reports ok:false (not a throw) when the debugger attach fails", async () => {
         dbg.attach.mockRejectedValue(
           new Error("Another debugger is already attached")
         );
         await messageHandler.handleDecodedMessage({
           cmd: "click-at",
           tabId: 8,
           x: 10,
           y: 20,
           engine: "cdp",
           correlationId: "cdpe",
         } as ServerMessageRequest);

         const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
           (c: any[]) => c[0].correlationId === "cdpe"
         );
         expect(call[0].ok).toBe(false);
         expect(call[0].error).toMatch(/CDP input dispatch failed/);
       });

       it("synthetic (default engine) still routes to the isolated performPointAction, never CDP", async () => {
         await messageHandler.handleDecodedMessage({
           cmd: "click-at",
           tabId: 8,
           x: 3,
           y: 4,
           correlationId: "syn",
         } as ServerMessageRequest);
         expect(dbg.attach).not.toHaveBeenCalled();
         expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
           type: "performPointAction",
           args: { action: "click-at", x: 3, y: 4, doubleClick: undefined, button: undefined },
         });
       });
     });
     ```
     Then:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/message-handler.test.ts -t "CDP engine"
     ```
     Expected: FAIL — `runPointAction` ignores `engine`; there is no CDP branch yet.

7. - [ ] **Impl — Chrome `runPointAction` engine branch + `dispatchCdpPointAction`.** In `chrome-extension/message-handler.ts`, extend the point-action import (line ~44) to also bring the descriptor type, and add the cdp-input import:
     ```ts
     import { performPointAction, type PointElementDescriptor } from "./injected/point-action-script";
     import { cdpInputClick } from "./cdp-input";
     ```
     Replace `runPointAction` (lines ~674-696) with an engine-aware version, and add `dispatchCdpPointAction` right after it:
     ```ts
     private async runPointAction(
       correlationId: string,
       tabId: number,
       args: PointActionArgs,
       engine?: "synthetic" | "cdp"
     ): Promise<void> {
       const tab = await browser.tabs.get(tabId);
       if (tab.url && (await isDomainInDenyList(tab.url))) {
         throw new Error(`Domain in tab URL is in the deny list`);
       }
       await this.checkForUrlPermission(tab.url);

       const result =
         engine === "cdp"
           ? await this.dispatchCdpPointAction(tabId, args)
           : await sendMessageToTabRaw(tabId, { type: "performPointAction", args });

       await this.client.sendResourceToServer({
         resource: "point-action-result",
         correlationId,
         ok: !!(result && result.ok),
         ...(result && result.error !== undefined ? { error: result.error } : {}),
         ...(result && result.element !== undefined ? { element: result.element } : {}),
       });
     }

     // engine:"cdp" (Chrome/Edge only): dispatch the action as TRUSTED CDP Input
     // events (refcounted "input" debugger attach — coexists with response-body
     // capture), then read the element descriptor from the isolated world so the
     // reply shape matches the synthetic path. A debugger-attach failure (DevTools
     // already open) is a reported ok:false, not a thrown tool-error. type-at /
     // hover-at / scroll-at CDP dispatch land in Tasks 3–4.
     private async dispatchCdpPointAction(
       tabId: number,
       args: PointActionArgs
     ): Promise<{ ok: boolean; error?: string; element?: PointElementDescriptor }> {
       try {
         switch (args.action) {
           case "click-at":
             await cdpInputClick(
               tabId,
               args.x,
               args.y,
               args.button ?? "left",
               !!args.doubleClick
             );
             break;
           default:
             return {
               ok: false,
               error: `The CDP engine does not support "${args.action}" yet.`,
             };
         }
       } catch (e) {
         return {
           ok: false,
           error:
             "CDP input dispatch failed — could not attach the debugger (is DevTools open on this tab, or another debugger already attached?): " +
             String((e as { message?: unknown })?.message ?? e),
         };
       }
       // Best-effort confirmation: describe what is under the point now, in the
       // isolated content-script world (same descriptor the synthetic path returns).
       const desc = await sendMessageToTabRaw(tabId, {
         type: "performPointAction",
         args: { action: "describe-at", x: args.x, y: args.y },
       });
       if (desc && desc.ok === false) {
         return {
           ok: false,
           ...(desc.error !== undefined ? { error: desc.error } : {}),
           ...(desc.element !== undefined ? { element: desc.element } : {}),
         };
       }
       return {
         ok: true,
         ...(desc && desc.element !== undefined ? { element: desc.element } : {}),
       };
     }
     ```
     Then forward `req.engine` in the four `-at` cases (lines ~329-362) by adding it as the 4th arg to each `runPointAction` call — e.g.:
     ```ts
     case "click-at":
       await this.runPointAction(
         req.correlationId,
         req.tabId,
         {
           action: "click-at",
           x: req.x,
           y: req.y,
           doubleClick: req.doubleClick,
           button: req.button,
         },
         req.engine
       );
       break;
     ```
     Do the same for `case "type-at"`, `case "hover-at"`, and `case "scroll-at"` (append `, req.engine` after the args object). Re-run step 6's command → the three tests PASS.

8. - [ ] **Failing test — Firefox rejects CDP (message handler).** In `firefox-extension/__tests__/message-handler.test.ts`, add a new describe block (config modeled on `input action commands`; `mockClient`/`messageHandler` are in scope):
     ```ts
     describe("coordinate tools — CDP engine rejected on Firefox (Phase 3)", () => {
       const automationConfig = {
         secret: "test-secret",
         ports: [8089],
         domainDenyList: [] as string[],
         auditLog: [],
         automationMode: true,
         inputRealismMode: "off",
       };

       beforeEach(() => {
         (browser.storage.local.get as jest.Mock).mockResolvedValue({
           config: automationConfig,
         });
         (browser.tabs.get as jest.Mock).mockResolvedValue({
           id: 123,
           url: "https://example.com",
         });
         (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
       });

       it("click-at engine:cdp replies ok:false with the Firefox-unsupported error and never injects", async () => {
         await messageHandler.handleDecodedMessage({
           cmd: "click-at",
           tabId: 123,
           x: 1,
           y: 2,
           engine: "cdp",
           correlationId: "fxcdp",
         } as ServerMessageRequest);

         expect(browser.tabs.executeScript).not.toHaveBeenCalled();
         expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
           resource: "point-action-result",
           correlationId: "fxcdp",
           ok: false,
           error: expect.stringMatching(/not supported on Firefox/),
         });
       });

       it("synthetic (default) still injects performPointAction", async () => {
         (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
           { ok: true, element: { tag: "div", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, editable: false } },
         ]);
         await messageHandler.handleDecodedMessage({
           cmd: "click-at",
           tabId: 123,
           x: 1,
           y: 2,
           correlationId: "fxsyn",
         } as ServerMessageRequest);
         expect(browser.tabs.executeScript).toHaveBeenCalled();
       });
     });
     ```
     Then:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/message-handler.test.ts -t "CDP engine rejected"
     ```
     Expected: FAIL — Firefox `runPointAction` ignores `engine` and injects regardless.

9. - [ ] **Impl — Firefox `runPointAction` engine branch.** In `firefox-extension/message-handler.ts`, replace `runPointAction` (lines ~762-788) so a `"cdp"` engine short-circuits to a clear error BEFORE any injection (the rest of the body is the unchanged Phase-2 synthetic path):
     ```ts
     private async runPointAction(
       correlationId: string,
       tabId: number,
       args: PointActionArgs,
       engine?: "synthetic" | "cdp"
     ): Promise<void> {
       if (engine === "cdp") {
         // Firefox has no chrome.debugger / CDP — the trusted engine is Chrome-only.
         await this.client.sendResourceToServer({
           resource: "point-action-result",
           correlationId,
           ok: false,
           error:
             'CDP engine not supported on Firefox — use the default synthetic engine (omit engine, or pass engine:"synthetic").',
         });
         return;
       }
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
     Then forward `req.engine` in the four `-at` cases (lines ~342-375), appending `, req.engine` after the args object of each `runPointAction` call (identical shape to the Chrome edit in step 7). Re-run step 8's command → PASS.

10. - [ ] **Impl — browser-api pass-through.** In `mcp-server/browser-api.ts`, thread `engine` through the four coordinate methods (lines ~529-598):
      ```ts
      async clickAt(
        tabId: number,
        x: number,
        y: number,
        opts?: {
          doubleClick?: boolean;
          button?: "left" | "middle" | "right";
          engine?: "synthetic" | "cdp";
        }
      ): Promise<PointActionResultExtensionMessage> {
        return await this.sendTool<PointActionResultExtensionMessage>({
          cmd: "click-at",
          tabId,
          x,
          y,
          doubleClick: opts?.doubleClick,
          button: opts?.button,
          engine: opts?.engine,
        });
      }

      async typeAt(
        tabId: number,
        x: number,
        y: number,
        text: string,
        submit?: boolean,
        engine?: "synthetic" | "cdp"
      ): Promise<PointActionResultExtensionMessage> {
        return await this.sendTool<PointActionResultExtensionMessage>({
          cmd: "type-at",
          tabId,
          x,
          y,
          text,
          submit,
          engine,
        });
      }

      async hoverAt(
        tabId: number,
        x: number,
        y: number,
        engine?: "synthetic" | "cdp"
      ): Promise<PointActionResultExtensionMessage> {
        return await this.sendTool<PointActionResultExtensionMessage>({
          cmd: "hover-at",
          tabId,
          x,
          y,
          engine,
        });
      }

      async scrollAt(
        tabId: number,
        x: number,
        y: number,
        opts?: { dx?: number; dy?: number; engine?: "synthetic" | "cdp" }
      ): Promise<PointActionResultExtensionMessage> {
        return await this.sendTool<PointActionResultExtensionMessage>({
          cmd: "scroll-at",
          tabId,
          x,
          y,
          dx: opts?.dx,
          dy: opts?.dy,
          engine: opts?.engine,
        });
      }
      ```

11. - [ ] **Impl — the four tools' `engine` zod + descriptions.** In `mcp-server/server.ts`, add `engine: z.enum(["synthetic", "cdp"]).optional()` to each of the four coordinate tools' shapes, forward it, and extend each description. `click-at` (lines ~629-643):
      ```ts
      mcpServer.tool(
        "click-at",
        "Click at viewport pixel coordinates {x,y} (origin = top-left of the visible viewport, as used by document.elementFromPoint). Reach for this when take-snapshot did NOT surface a clickable element (e.g. a custom-React <div onClick> with no role/tabindex) but you can see where it is — e.g. from take-screenshot. Runs covertly in the isolated world (no automation banner, no debugger) by default. Set engine:\"cdp\" (Chrome/Edge only) to dispatch a TRUSTED (isTrusted:true) click via the debugger instead — reach for it only when the default click is ignored by a strict handler; it shows a 'started debugging this browser' banner (detectable) and errors on Firefox. Set doubleClick for a double-click, or button to 'middle'/'right'. Returns a descriptor of the element that was under the point (or an error if the point hit nothing).",
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
      ```
      `type-at` (lines ~645-659) — add `engine` to the shape, forward it, and note CDP is the reliable path for strict editors:
      ```ts
      mcpServer.tool(
        "type-at",
        "Type text into the element at viewport pixel coordinates {x,y}. Clicks the point to focus it first, then types — works for <input>/<textarea> AND custom <div contenteditable> chat inputs that take-snapshot may not expose as textboxes. Set submit:true to press Enter afterward (and submit the form if there is one). Runs covertly (synthetic) by default. Set engine:\"cdp\" (Chrome/Edge only) to type via TRUSTED events through the debugger — this is the reliable path for strict rich-text editors (Lexical/ProseMirror/Slate) that ignore synthetic keystrokes; it shows a debugging banner and errors on Firefox. Returns a descriptor of the element that was typed into.",
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
      ```
      `hover-at` (lines ~661-669):
      ```ts
      mcpServer.tool(
        "hover-at",
        "Hover at viewport pixel coordinates {x,y} to reveal hover-triggered UI (dropdown menus, tooltips) before a follow-up snapshot/click. Runs covertly in the isolated world via synthetic pointer events by default (fires the page's JS mouseover/mouseenter listeners, which open most such menus, but does NOT activate CSS :hover styling). Set engine:\"cdp\" (Chrome/Edge only) to move a TRUSTED pointer via the debugger (shows a banner; errors on Firefox). Returns a descriptor of the element under the point.",
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
      ```
      `scroll-at` (lines ~671-685):
      ```ts
      mcpServer.tool(
        "scroll-at",
        "Scroll the NEAREST SCROLLABLE CONTAINER under viewport pixel coordinates {x,y} by (dx, dy) pixels — this scrolls an inner panel (e.g. a chat message list) rather than the whole window, which press-key PageUp cannot do. Omit dx/dy to scroll one container-viewport down. Falls back to the window when nothing under the point scrolls. Runs covertly (synthetic) by default. Set engine:\"cdp\" (Chrome/Edge only) to dispatch a TRUSTED wheel event via the debugger for sites that honor real wheel events exclusively (shows a banner; errors on Firefox). Returns a descriptor of the container that was scrolled.",
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
      ```

12. - [ ] **Failing/passing test — `engine` rides the wire (broker round-trip).** In `mcp-server/__tests__/coordinate-tools.test.ts`, add an `it` to the existing `describe("BrowserAPI coordinate tools over the broker", ...)` block:
      ```ts
      it("forwards engine:'cdp' on the click-at frame", async () => {
        await api.clickAt(2, 100, 200, { engine: "cdp" });
        expect((lastReq as any).cmd).toBe("click-at");
        expect((lastReq as any).engine).toBe("cdp");
      });
      ```

13. - [ ] **Run-to-pass + build (all packages):**
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/coordinate-tools.test.ts && npm run build
      cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/cdp-input.test.ts __tests__/point-action-script.test.ts __tests__/message-handler.test.ts __tests__/network-capture.test.ts
      cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest __tests__/point-action-script.test.ts __tests__/message-handler.test.ts __tests__/self-containment.test.ts
      ```
      Expected: all PASS; `npm run build` (esbuild bundle of `server.ts` + `broker-main.ts`) completes with no type/emit error. (`self-containment.test.ts` still passes — `describe-at` added no new injected function.)

14. - [ ] Commit:
      ```bash
      cd /Users/balakumar/personal/browser-control-mcp
      git add common chrome-extension firefox-extension mcp-server
      git commit -m "feat(coordinate-tools): engine:'cdp' trusted tier — cdp-input click-at + describe-at descriptor read; Firefox errors clearly"
      ```

---

### Task 3 — `type-at` on the CDP engine — trusted focus-click + `Input.insertText` (+Enter on submit) (#1)

Add `cdpInputType` to `cdp-input.ts` and wire the `type-at` case in `dispatchCdpPointAction`. **Focus/caret is established by a trusted click:** a `mousePressed`+`mouseReleased` pair at `{x,y}` runs the editor's own focus/selection logic and places the caret AT the point (CDP has no "focus at coordinate" command — the trusted click IS the mechanism). `Input.insertText` then commits the text at that caret (a trusted IME-style commit that fires real `beforeinput`/`input`, which is exactly what strict editors require). `submit:true` appends a trusted Enter `Input.dispatchKeyEvent` pair.

**Files:**
- Modify `chrome-extension/cdp-input.ts` — add `cdpInputType`.
- Modify `chrome-extension/message-handler.ts` — import `cdpInputType`; add the `type-at` case to `dispatchCdpPointAction`.
- Modify `chrome-extension/__tests__/cdp-input.test.ts` — `cdpInputType` sequence test.
- Modify `chrome-extension/__tests__/message-handler.test.ts` — `type-at engine:cdp` routing test.

**Interfaces:**
- `cdpInputType(tabId, x, y, text, submit) => Promise<void>`.

**Steps:**

1. - [ ] **Failing test — `cdpInputType` sequence.** In `chrome-extension/__tests__/cdp-input.test.ts`, add:
     ```ts
     describe("cdpInputType (Phase 3)", () => {
       let dbg: any;
       beforeEach(() => {
         dbg = (chrome as any).debugger;
         dbg.attach.mockReset().mockResolvedValue(undefined);
         dbg.detach.mockReset().mockResolvedValue(undefined);
         dbg.sendCommand.mockReset().mockResolvedValue({});
       });
       afterEach(async () => {
         const { forceDetachDebugger } = require("../network-capture");
         await forceDetachDebugger(3);
       });

       it("focus-clicks at {x,y}, then inserts text (no Enter without submit)", async () => {
         await cdpInputType(3, 40, 50, "hello", false);
         const calls = (dbg.sendCommand as jest.Mock).mock.calls;
         const mouse = calls.filter((c: any[]) => c[1] === "Input.dispatchMouseEvent");
         // A single trusted press/release pair establishes focus + caret.
         expect(mouse).toHaveLength(2);
         expect(mouse[0][2]).toMatchObject({ type: "mousePressed", x: 40, y: 50, button: "left", clickCount: 1 });
         expect(mouse[1][2]).toMatchObject({ type: "mouseReleased", x: 40, y: 50, button: "left", clickCount: 1 });
         const insert = calls.filter((c: any[]) => c[1] === "Input.insertText");
         expect(insert).toHaveLength(1);
         expect(insert[0][2]).toEqual({ text: "hello" });
         expect(calls.some((c: any[]) => c[1] === "Input.dispatchKeyEvent")).toBe(false);
         expect(dbg.detach).toHaveBeenCalledWith({ tabId: 3 });
       });

       it("appends a trusted Enter key pair when submit is true", async () => {
         await cdpInputType(3, 1, 2, "hi", true);
         const keys = (dbg.sendCommand as jest.Mock).mock.calls.filter(
           (c: any[]) => c[1] === "Input.dispatchKeyEvent"
         );
         expect(keys).toHaveLength(2);
         expect(keys[0][2]).toMatchObject({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
         expect(keys[1][2]).toMatchObject({ type: "keyUp", key: "Enter" });
       });

       it("skips insertText for empty text but still focus-clicks", async () => {
         await cdpInputType(3, 5, 6, "", false);
         const calls = (dbg.sendCommand as jest.Mock).mock.calls;
         expect(calls.filter((c: any[]) => c[1] === "Input.dispatchMouseEvent")).toHaveLength(2);
         expect(calls.some((c: any[]) => c[1] === "Input.insertText")).toBe(false);
       });
     });
     ```
     Add `cdpInputType` to the file's top import:
     ```ts
     import { cdpInputClick, cdpInputType } from "../cdp-input";
     ```
     Then:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/cdp-input.test.ts -t "cdpInputType"
     ```
     Expected: FAIL — `cdpInputType` does not exist.

2. - [ ] **Impl — `cdpInputType`.** In `chrome-extension/cdp-input.ts`, add after `cdpInputClick`:
     ```ts
     export async function cdpInputType(
       tabId: number,
       x: number,
       y: number,
       text: string,
       submit: boolean
     ): Promise<void> {
       await withInputAttach(tabId, async (dbg) => {
         // A trusted click at {x,y} is how CDP establishes focus + caret: the real
         // click runs the editor's own focus/selection logic and places the caret at
         // the point (there is no CDP "focus at coordinate" command — the click is
         // the mechanism). Input.insertText then commits text AT that caret.
         await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
           type: "mousePressed",
           x,
           y,
           button: "left",
           clickCount: 1,
         });
         await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
           type: "mouseReleased",
           x,
           y,
           button: "left",
           clickCount: 1,
         });
         if (text.length > 0) {
           // insertText delivers the whole string as a trusted IME-style commit —
           // fires real beforeinput/input, which is what strict editors require.
           await dbg.sendCommand({ tabId }, "Input.insertText", { text });
         }
         if (submit) {
           await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
             type: "keyDown",
             key: "Enter",
             code: "Enter",
             windowsVirtualKeyCode: 13,
             text: "\r",
           });
           await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
             type: "keyUp",
             key: "Enter",
             code: "Enter",
             windowsVirtualKeyCode: 13,
           });
         }
       });
     }
     ```
     Re-run step 1's command → PASS.

3. - [ ] **Impl — wire `type-at` into `dispatchCdpPointAction`.** In `chrome-extension/message-handler.ts`, extend the cdp-input import:
     ```ts
     import { cdpInputClick, cdpInputType } from "./cdp-input";
     ```
     and add a `type-at` case to the `dispatchCdpPointAction` switch (before `default`):
     ```ts
           case "type-at":
             await cdpInputType(tabId, args.x, args.y, args.text, !!args.submit);
             break;
     ```

4. - [ ] **Failing/passing test — `type-at engine:cdp` routing.** In `chrome-extension/__tests__/message-handler.test.ts`, inside the `coordinate tools — CDP engine (Phase 3)` describe, add:
     ```ts
     it("type-at engine:cdp focus-clicks + inserts text then reads the descriptor", async () => {
       await messageHandler.handleDecodedMessage({
         cmd: "type-at",
         tabId: 8,
         x: 40,
         y: 50,
         text: "hi there",
         submit: true,
         engine: "cdp",
         correlationId: "cdpt",
       } as ServerMessageRequest);

       expect((dbg.sendCommand as jest.Mock).mock.calls).toEqual(
         expect.arrayContaining([
           [{ tabId: 8 }, "Input.insertText", { text: "hi there" }],
         ])
       );
       const keys = (dbg.sendCommand as jest.Mock).mock.calls.filter(
         (c: any[]) => c[1] === "Input.dispatchKeyEvent"
       );
       expect(keys).toHaveLength(2); // Enter down + up
       expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
         type: "performPointAction",
         args: { action: "describe-at", x: 40, y: 50 },
       });
       const call = (transport.sendResourceToServer as jest.Mock).mock.calls.find(
         (c: any[]) => c[0].correlationId === "cdpt"
       );
       expect(call[0].ok).toBe(true);
     });
     ```
     Then:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/cdp-input.test.ts __tests__/message-handler.test.ts
     ```
     Expected: all PASS.

5. - [ ] **Build + commit:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npm run build
     cd /Users/balakumar/personal/browser-control-mcp
     git add chrome-extension
     git commit -m "feat(type-at): CDP engine — trusted focus-click + Input.insertText (+Enter on submit)"
     ```

---

### Task 4 — `hover-at` + `scroll-at` on the CDP engine — `Input` mouseMoved / mouseWheel (#1)

Add `cdpInputHover` (a trusted `mouseMoved` at `{x,y}`) and `cdpInputScroll` (a trusted `mouseWheel {deltaX,deltaY}` at `{x,y}`) to `cdp-input.ts`, and wire their `dispatchCdpPointAction` cases — completing the CDP engine across all four `-at` tools. Unlike the synthetic scroll (which measures the container and defaults `dy` to its `clientHeight`), the CDP wheel is dispatched at the OS/renderer level, so an omitted delta defaults to a fixed one-page step (600 px).

**Files:**
- Modify `chrome-extension/cdp-input.ts` — add `cdpInputHover`, `cdpInputScroll`.
- Modify `chrome-extension/message-handler.ts` — import both; add the `hover-at` + `scroll-at` cases to `dispatchCdpPointAction`.
- Modify `chrome-extension/__tests__/cdp-input.test.ts` — sequence tests.
- Modify `chrome-extension/__tests__/message-handler.test.ts` — routing tests.

**Interfaces:**
- `cdpInputHover(tabId, x, y) => Promise<void>`.
- `cdpInputScroll(tabId, x, y, dx?, dy?) => Promise<void>`.

**Steps:**

1. - [ ] **Failing test — `cdpInputHover` / `cdpInputScroll`.** In `chrome-extension/__tests__/cdp-input.test.ts`, add:
     ```ts
     describe("cdpInputHover + cdpInputScroll (Phase 3)", () => {
       let dbg: any;
       beforeEach(() => {
         dbg = (chrome as any).debugger;
         dbg.attach.mockReset().mockResolvedValue(undefined);
         dbg.detach.mockReset().mockResolvedValue(undefined);
         dbg.sendCommand.mockReset().mockResolvedValue({});
       });
       afterEach(async () => {
         const { forceDetachDebugger } = require("../network-capture");
         await forceDetachDebugger(3);
       });

       it("cdpInputHover dispatches a single trusted mouseMoved at {x,y}", async () => {
         await cdpInputHover(3, 12, 34);
         const moves = (dbg.sendCommand as jest.Mock).mock.calls.filter(
           (c: any[]) => c[1] === "Input.dispatchMouseEvent"
         );
         expect(moves).toHaveLength(1);
         expect(moves[0][2]).toMatchObject({ type: "mouseMoved", x: 12, y: 34 });
         expect(dbg.detach).toHaveBeenCalledWith({ tabId: 3 });
       });

       it("cdpInputScroll dispatches a trusted mouseWheel with the given deltas", async () => {
         await cdpInputScroll(3, 10, 20, 5, 250);
         const wheel = (dbg.sendCommand as jest.Mock).mock.calls.filter(
           (c: any[]) => c[1] === "Input.dispatchMouseEvent"
         );
         expect(wheel[0][2]).toMatchObject({ type: "mouseWheel", x: 10, y: 20, deltaX: 5, deltaY: 250 });
       });

       it("cdpInputScroll defaults an omitted deltaY to a one-page step (600) and deltaX to 0", async () => {
         await cdpInputScroll(3, 10, 20);
         const wheel = (dbg.sendCommand as jest.Mock).mock.calls.find(
           (c: any[]) => c[1] === "Input.dispatchMouseEvent"
         );
         expect(wheel[2]).toMatchObject({ type: "mouseWheel", deltaX: 0, deltaY: 600 });
       });
     });
     ```
     Extend the file's top import:
     ```ts
     import { cdpInputClick, cdpInputType, cdpInputHover, cdpInputScroll } from "../cdp-input";
     ```
     Then:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/cdp-input.test.ts -t "cdpInputHover"
     ```
     Expected: FAIL — the functions do not exist.

2. - [ ] **Impl — `cdpInputHover` + `cdpInputScroll`.** In `chrome-extension/cdp-input.ts`, add after `cdpInputType`:
     ```ts
     export async function cdpInputHover(
       tabId: number,
       x: number,
       y: number
     ): Promise<void> {
       await withInputAttach(tabId, async (dbg) => {
         await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
           type: "mouseMoved",
           x,
           y,
         });
       });
     }

     export async function cdpInputScroll(
       tabId: number,
       x: number,
       y: number,
       dx?: number,
       dy?: number
     ): Promise<void> {
       await withInputAttach(tabId, async (dbg) => {
         // A trusted wheel event at {x,y}. Unlike the synthetic engine (which
         // measures the container and defaults to its clientHeight), CDP dispatches
         // a raw wheel at the OS/renderer level, so an omitted delta defaults to a
         // fixed one-page step (600 px) rather than a measured container height.
         await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
           type: "mouseWheel",
           x,
           y,
           deltaX: typeof dx === "number" ? dx : 0,
           deltaY: typeof dy === "number" ? dy : 600,
         });
       });
     }
     ```
     Re-run step 1's command (and the sibling `cdpInputScroll` tests) → PASS.

3. - [ ] **Impl — wire `hover-at` + `scroll-at` into `dispatchCdpPointAction`.** In `chrome-extension/message-handler.ts`, extend the cdp-input import:
     ```ts
     import { cdpInputClick, cdpInputType, cdpInputHover, cdpInputScroll } from "./cdp-input";
     ```
     and add the two cases to the `dispatchCdpPointAction` switch (before `default`):
     ```ts
           case "hover-at":
             await cdpInputHover(tabId, args.x, args.y);
             break;
           case "scroll-at":
             await cdpInputScroll(tabId, args.x, args.y, args.dx, args.dy);
             break;
     ```

4. - [ ] **Test — `hover-at` / `scroll-at` engine:cdp routing.** In `chrome-extension/__tests__/message-handler.test.ts`, inside the `coordinate tools — CDP engine (Phase 3)` describe, add:
     ```ts
     it("hover-at engine:cdp dispatches a trusted mouseMoved then reads the descriptor", async () => {
       await messageHandler.handleDecodedMessage({
         cmd: "hover-at",
         tabId: 8,
         x: 12,
         y: 34,
         engine: "cdp",
         correlationId: "cdph",
       } as ServerMessageRequest);
       const move = (dbg.sendCommand as jest.Mock).mock.calls.find(
         (c: any[]) => c[1] === "Input.dispatchMouseEvent"
       );
       expect(move[2]).toMatchObject({ type: "mouseMoved", x: 12, y: 34 });
       expect(browser.tabs.sendMessage).toHaveBeenCalledWith(8, {
         type: "performPointAction",
         args: { action: "describe-at", x: 12, y: 34 },
       });
     });

     it("scroll-at engine:cdp dispatches a trusted mouseWheel with the deltas", async () => {
       await messageHandler.handleDecodedMessage({
         cmd: "scroll-at",
         tabId: 8,
         x: 10,
         y: 20,
         dx: 0,
         dy: 250,
         engine: "cdp",
         correlationId: "cdps",
       } as ServerMessageRequest);
       const wheel = (dbg.sendCommand as jest.Mock).mock.calls.find(
         (c: any[]) => c[1] === "Input.dispatchMouseEvent"
       );
       expect(wheel[2]).toMatchObject({ type: "mouseWheel", x: 10, y: 20, deltaX: 0, deltaY: 250 });
     });
     ```
     Then:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest __tests__/cdp-input.test.ts __tests__/message-handler.test.ts
     ```
     Expected: all PASS.

5. - [ ] **Build + commit:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npm run build
     cd /Users/balakumar/personal/browser-control-mcp
     git add chrome-extension
     git commit -m "feat(hover-at,scroll-at): CDP engine — trusted Input mouseMoved / mouseWheel"
     ```

---

### Task 5 — `get-network-requests` `includeCredentials` — opt-in un-redact of Cookie/Authorization/Set-Cookie (#5)

Add an optional `includeCredentials?: boolean` (default false) to `get-network-requests`. When true, SKIP the `SENSITIVE_HEADER` redaction so raw credential values print (for replaying the app's own authenticated calls). **Server-side only** — exactly like `includeHeaders`, it never rides the wire; headers are always captured (already gated by Automation Mode + host permission at capture time), the flag only controls printing. To make the redaction unit-testable (server.ts self-executes on import and cannot be imported into a test — the same reason `formatPointResult` lives in `point-format.ts`), extract the `SENSITIVE_HEADER` regex + header formatter into a new pure module `mcp-server/network-format.ts`.

**Files:**
- Create `mcp-server/network-format.ts`.
- Modify `mcp-server/server.ts` — `get-network-requests` (lines ~836-926): import + use `formatNetworkHeaders`, add `includeCredentials` to the shape/handler, update the description.
- Create `mcp-server/__tests__/network-format.test.ts`.

**Interfaces:**
- `SENSITIVE_HEADER: RegExp`.
- `formatNetworkHeaders(label: string, headers: { name: string; value?: string }[] | undefined, includeCredentials: boolean) => string`.
- Consumes (MCP): `get-network-requests { tabId, filter?, limit?, includeHeaders?, includeCredentials?, includeBody? }`.

**Steps:**

1. - [ ] **Failing test — `formatNetworkHeaders`.** Create `mcp-server/__tests__/network-format.test.ts`:
     ```ts
     import { formatNetworkHeaders, SENSITIVE_HEADER } from "../network-format";

     describe("formatNetworkHeaders", () => {
       const headers = [
         { name: "Content-Type", value: "application/json" },
         { name: "Cookie", value: "sid=abcdef" }, // 10 chars
         { name: "Authorization", value: "Bearer xyz" }, // 10 chars
       ];

       it("redacts credential headers by default (includeCredentials false)", () => {
         const out = formatNetworkHeaders("request headers", headers, false);
         expect(out).toContain("Content-Type: application/json");
         expect(out).toContain("Cookie: <redacted:10 chars>");
         expect(out).toContain("Authorization: <redacted:10 chars>");
         expect(out).not.toContain("sid=abcdef");
         expect(out).not.toContain("Bearer xyz");
       });

       it("prints raw credential values when includeCredentials is true", () => {
         const out = formatNetworkHeaders("request headers", headers, true);
         expect(out).toContain("Cookie: sid=abcdef");
         expect(out).toContain("Authorization: Bearer xyz");
         expect(out).not.toContain("<redacted");
       });

       it("returns an empty string for no headers", () => {
         expect(formatNetworkHeaders("request headers", undefined, false)).toBe("");
         expect(formatNetworkHeaders("request headers", [], true)).toBe("");
       });

       it("SENSITIVE_HEADER matches the credential header names case-insensitively", () => {
         expect(SENSITIVE_HEADER.test("set-cookie")).toBe(true);
         expect(SENSITIVE_HEADER.test("Proxy-Authorization")).toBe(true);
         expect(SENSITIVE_HEADER.test("content-type")).toBe(false);
       });
     });
     ```
     Then:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/network-format.test.ts
     ```
     Expected: FAIL — `../network-format` does not exist.

2. - [ ] **Impl — `network-format.ts`.** Create `mcp-server/network-format.ts` (the redaction/formatting extracted verbatim from `server.ts`, plus the `includeCredentials` bypass):
     ```ts
     // Header redaction + formatting for get-network-requests, extracted from
     // server.ts (which self-executes on import) so it can be imported and
     // unit-tested directly — the same reason formatPointResult lives in
     // point-format.ts. Credential-bearing header VALUES (Cookie / Set-Cookie /
     // Authorization / Proxy-Authorization) are redacted UNLESS includeCredentials
     // is true (default false at the tool layer).
     export const SENSITIVE_HEADER =
       /^(cookie|set-cookie|authorization|proxy-authorization)$/i;

     export function formatNetworkHeaders(
       label: string,
       headers: { name: string; value?: string }[] | undefined,
       includeCredentials: boolean
     ): string {
       if (!headers || headers.length === 0) {
         return "";
       }
       const lines = headers
         .map((h) => {
           const value =
             !includeCredentials && SENSITIVE_HEADER.test(h.name)
               ? `<redacted:${(h.value ?? "").length} chars>`
               : h.value ?? "";
           return `      ${h.name}: ${value}`;
         })
         .join("\n");
       return `\n    ${label}:\n${lines}`;
     }
     ```
     Re-run step 1's command → PASS.

3. - [ ] **Impl — server.ts uses the helper + adds `includeCredentials`.** In `mcp-server/server.ts`, add the import near the top (next to the `point-format` import, line ~7):
     ```ts
     import { formatNetworkHeaders } from "./network-format";
     ```
     In the `get-network-requests` tool (lines ~836-926): update the description, add `includeCredentials` to the shape + handler destructure, delete the inline `SENSITIVE_HEADER` + `formatHeaders` (lines ~865-881), and call the helper:
     ```ts
     mcpServer.tool(
       "get-network-requests",
       "Get the network requests captured for a browser tab (URL, method, status, resource type, timing, size). Requires Automation Mode, and only captures requests made AFTER Automation Mode was enabled (reload the page if you see nothing). Pass 'filter' to keep only requests whose URL contains it (case-insensitive) or whose resource type matches it exactly, 'limit' to return only the most recent N, 'includeHeaders' to also print each request's captured request/response headers (credential-bearing values — Cookie/Authorization/Set-Cookie — are redacted by default), 'includeCredentials' to print those credential values UN-REDACTED (only meaningful with includeHeaders; WARNING: this exposes real session cookies/tokens in the tool output — use it only when you must replay the app's own authenticated calls, and never log the values), and 'includeBody' to request best-effort response-body snippets for FUTURE requests (browser-dependent: captured on Firefox; Chrome MV3 cannot capture bodies via webRequest and returns metadata only).",
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
             text += formatNetworkHeaders("request headers", req.requestHeaders, !!includeCredentials);
             text += formatNetworkHeaders("response headers", req.responseHeaders, !!includeCredentials);
           }
           if (req.requestBody) {
             const snippet =
               req.requestBody.length > 2000
                 ? `${req.requestBody.slice(0, 2000)}…`
                 : req.requestBody;
             text += `\n    request body: ${snippet}`;
           }
           if (req.body) {
             const snippet =
               req.body.length > 2000 ? `${req.body.slice(0, 2000)}…` : req.body;
             text += `\n    response body: ${snippet}`;
           }
           return { type: "text" as const, text };
         });
         if (includeBody && bodyCaptureSupported === false) {
           content.push({
             type: "text" as const,
             text: "Note: the connected browser (Chrome MV3) cannot capture response bodies; returning request metadata only.",
           });
         }
         return { content };
       }
     );
     ```

4. - [ ] **Run-to-pass + build:**
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest __tests__/network-format.test.ts && npm run build
     ```
     Expected: PASS; `npm run build` completes with no type/emit error (the inline `SENSITIVE_HEADER`/`formatHeaders` are gone; the helper is imported).

5. - [ ] Commit:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     git add mcp-server
     git commit -m "feat(get-network-requests): includeCredentials un-redacts Cookie/Authorization/Set-Cookie (default off); extract network-format helper"
     ```

---

### Task 6 — mcpkit skill docs for `engine` + `includeCredentials`

Document the new `engine` param (default `synthetic`/covert vs. `cdp` trusted+banner, Chrome-only, errors on Firefox) and `get-network-requests` `includeCredentials` in the mcpkit-foxpilot skill, and confirm the `server.ts` tool descriptions (updated in Tasks 2 & 5) are accurate. The skill file lives OUTSIDE the repo, so this task has no repo commit (mirrors Phase 1/2's docs task).

**Files:**
- Modify `~/.claude/skills/mcpkit-foxpilot/SKILL.md` (hand-edit; do NOT run `mcpkit update`).

**Steps:**

1. - [ ] **Verify server.ts descriptions are accurate (read-only).** Confirm the four coordinate tools mention `engine` (default synthetic/covert; `cdp` = trusted + banner, Chrome-only, errors on Firefox) and that `get-network-requests` mentions `includeCredentials` with the credential-exposure warning:
     ```bash
     cd /Users/balakumar/personal/browser-control-mcp
     grep -n "engine:\\\\\"cdp\\\\\"" mcp-server/server.ts
     grep -n "includeCredentials" mcp-server/server.ts
     ```
     Expected: `engine:"cdp"` appears in the click-at/type-at/hover-at/scroll-at descriptions, and `includeCredentials` appears in the get-network-requests description. (These were written in Tasks 2 & 5 — this step only confirms them.)

2. - [ ] **Edit the mcpkit skill.** In `~/.claude/skills/mcpkit-foxpilot/SKILL.md`, hand-edit the coordinate-tools section (added in Phase 2) to document the new `engine` param, and the `get-network-requests` entry to document `includeCredentials`. Add, under the coordinate tools:
     ```markdown
     **`engine` (click-at / type-at / hover-at / scroll-at)** — optional, default `"synthetic"`.
     - `"synthetic"` (default): covert isolated-world dispatch — no automation banner, no debugger, `isTrusted:false`. Works for `<div onClick>` handlers and normal inputs. **May be ignored by strict rich-text editors** (Lexical/ProseMirror/Slate).
     - `"cdp"` (Chrome/Edge only): TRUSTED `isTrusted:true` events via `chrome.debugger` at `{x,y}`. Reach for it ONLY when synthetic is ignored — chiefly typing into a strict rich-text editor. **Shows the "started debugging this browser" banner (detectable) and errors on Firefox** (`ok:false` "CDP engine not supported on Firefox"). Does not move the OS cursor.

     **`get-network-requests` → `includeCredentials`** — optional, default `false`. With `includeHeaders`, credential header values (Cookie/Authorization/Set-Cookie) are redacted (`<redacted:N chars>`). Set `includeCredentials:true` to print them RAW — only when you must replay the app's own authenticated calls. **WARNING: exposes real session tokens in tool output; never log them.**
     ```
     (No `mcpkit update`, no wire/schema regeneration — this skill is docs-only and the tool interface is already carried by `server.ts`.)

3. - [ ] **No repo commit** — the skill file is outside `/Users/balakumar/personal/browser-control-mcp`. This completes Phase 3.

---

## Phase 3 completion check

After Task 5's commit, run the full suites and builds once more to confirm the branch is green end-to-end:

```bash
cd /Users/balakumar/personal/browser-control-mcp/mcp-server && npx jest && npm run build
cd /Users/balakumar/personal/browser-control-mcp/chrome-extension && npx jest
cd /Users/balakumar/personal/browser-control-mcp/firefox-extension && npx jest
```

Expected: all suites PASS on all three packages; both `npm run build`s succeed. This validates: the debugger refcount refactor (existing capture-response-bodies + CDP-deep-capture tests still green), the CDP trusted engine on all four `-at` tools (Chrome dispatch + descriptor read; Firefox clear error), and the `includeCredentials` un-redaction — all backward-compatible (`engine` omitted ⇒ Phase-2 output byte-identical; `includeCredentials` omitted ⇒ redacted output identical).
