# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**FoxPilot** — AI browser automation via MCP. npm package `foxpilot-mcp`; repo `balakumardev/foxpilot`.

## Commands

```bash
npm install                          # all deps (postinstall installs every subproject)
npm run build                        # build all via nx
cd mcp-server && npm run build        # individual builds (also: firefox-extension, chrome-extension)
cd firefox-extension && npx jest      # tests (chrome-extension also has a jest suite)
cd chrome-extension && npx jest
cd mcp-server && npm start            # start MCP server (auto-starts the broker)
cd mcp-server && npm run pack-dxt     # package the .dxt
npm run package --prefix chrome-extension   # build + zip -> chrome-extension/web-ext-artifacts/foxpilot-chrome-<v>.zip
```

## Architecture

Monorepo, five projects:
1. **mcp-server** — Node MCP server (stdio to the client) plus the **broker** (`broker-main.ts` / `broker.ts` / `broker-protocol.ts`).
2. **firefox-extension** — MV2 (background script + `browser.tabs.executeScript`).
3. **chrome-extension** — MV3 (service worker + offscreen document + content-script messaging).
4. **common** — shared message interfaces (`@foxpilot/common`).
5. **input-sidecar** — native-input helper.

### Communication flow
- Client ↔ MCP server: MCP over stdio.
- MCP server ↔ extension: through a **broker** on port 8089 (WebSocket). The broker is a separate, persistent process that holds the extension connection; multiple browsers (Chrome/Firefox) can connect and one is the active driver (`list-browsers` / `select-browser`).
- Auth: zero-config by default. The broker admits an extension based on the connection being loopback with a `chrome-extension://`/`moz-extension://` Origin — no user-typed secret. The control leg (MCP server ↔ broker) is signed with an auto-managed secret the broker generates internally. A manual `EXTENSION_SECRET` is only set for remote/CONTAINERIZED deployments (where loopback+Origin gating doesn't apply); the same secret must then be set in the extension's Advanced settings. The broker binds both IPv4 and IPv6 loopback. `EXTENSION_PORT` defaults to 8089.

### Key files
- `mcp-server/server.ts` — tool definitions; `mcp-server/broker.ts` — broker.
- `firefox-extension/message-handler.ts`, `chrome-extension/message-handler.ts` — execute browser actions. Both have a `switch(req.cmd)` whose `default:` uses a `const _exhaustiveCheck: never = req` tripwire — adding a `cmd` to the `ServerMessage` union forces a matching case or compile fails.
- `firefox-extension/injected/*` — functions stringified and run in the page (`action-script`, `snapshot-script`, `page-world`, `upload-script`). Mirrored in `chrome-extension/injected/*`.
- `firefox-extension/browser-http.ts`, `chrome-extension/browser-http.ts` — background-context HTTP/cookie/stream logic for the privileged tools (auto-bundled via `background.ts` import chain).
- `common/server-messages.ts`, `common/extension-messages.ts` — message types.

## Gotchas (these cost real time)
- **Isolated vs page world / CSP:** DOM ops (click, fill, snapshot, **upload-file**) run in the ISOLATED content-script world and are CSP-immune. `evaluate-script` / `handle-dialog` / `emulate` inject a page-world `<script>`, which **strict-CSP pages (e.g. chrome.google.com) block** → "Timed out waiting for in-page result" / "Invalid message signature". Don't add page-world `<script>` injection for anything that can run in the isolated world.
- **Background-context tools exist for CSP/cookie/WAF escape** (`get-cookies`, `browser-fetch`, `stream-start`/`poll`/`close`): these run in the **extension background context** (MV3 service worker / MV2 persistent page), which is governed by the EXTENSION's CSP, not the page's, and can use the browser's real cookie jar. Use them when `evaluate-script` is blocked by a strict page `script-src` AND you need cookie-authed requests (incl. httpOnly cookies, WAFs that 403 curl). See `chrome-extension/browser-http.ts` and `firefox-extension/browser-http.ts`.
- **`Cookie` header is a forbidden `fetch` header** (Chrome MV3) and is ignored if set directly. For `useSessionCookies` on `browser-fetch`, install a **temporary `declarativeNetRequest` session rule** (modifyHeaders, `urlFilter` scope, `["xmlhttprequest","other"]` resource types) around the fetch and remove in `finally`. On Firefox MV2, use a blocking `webRequest.onBeforeSendHeaders` listener (register lazily, unregister in `finally`). Default path is plain `credentials:"include"` — the browser attaches httpOnly cookies automatically. Reserved Chrome DNR id band for cookie rules is `210000+` (clear of `emulate.ts`'s `100000` UA-rewrite band).
- **Chrome MV3 SW idle orphans DNR rules:** the service worker can be killed mid-stream (~30s idle), losing the in-memory `Map<streamId, StreamSession>` while an installed `useSessionCookies` DNR rule persists. One-shot `browser-fetch` is safe (synchronous `finally`), but streams can orphan. Mitigation: `clearStaleCookieRules()` startup sweep in `chrome-extension/browser-http.ts`, invoked from `background.ts` init — clears any rule in the reserved `210000+` band. Pattern: pick a reserved id band for any long-lived DNR rule class and sweep on SW boot.
- **Zod 4.3.6 `z.record` gotcha:** in this repo's zod 4.3.6, `z.record(z.string())` infers `Record<string, unknown>` (v4 treats the single arg as the KEY schema, value defaults to `unknown`), not the v3 `Record<string, string>`. For `Record<string, string>` you MUST use the two-arg form: `z.record(z.string(), z.string())`. Single-arg form only valid as a key-only constraint.
- **Firefox file upload:** content scripts see the page via Xray; build File/DataTransfer in the page realm via `wrappedJSObject` + `cloneInto` so `input.files` accepts the FileList (see `injected/upload-script.ts`).
- **Stale broker:** the broker is a detached persistent process holding port 8089. After rebuilding mcp-server, `pkill -f dist/broker-main.js` so a fresh broker starts. Extension admission is origin-gated (loopback + `chrome-extension://`/`moz-extension://` Origin), so a user-secret mismatch is no longer the usual failure. The common transition issue after a broker rebuild: the still-loaded extension is older than the fresh broker — if tools report "no extension connected," **reload the extension** (Firefox: `about:debugging` → Reload).
- **"`<tool>` is disabled in extension settings" usually means the extension is older than the build.** The broker routes the same error whether a tool is genuinely toggled off OR unknown to the connected extension (no entry in `COMMAND_TO_TOOL_ID`). Reloading an already-installed extension reloads its OLD code — does NOT pick up a new build. The user has to **Remove** the old extension and **Load unpacked** the new folder, then toggle Automation Mode on (fresh extension = fresh storage, toggles default to enabled but Automation Mode starts OFF). Note: mcpkit points at the working-tree `mcp-server/dist/server.js`, so the server half updates instantly after `npm run build`; the extension half is what lags.
- **`docs/` is gitignored** — use `git add -f` to commit docs (e.g. `docs/privacy-policy.md`).

## CI/CD
- `.github/workflows/release.yml`: on push to `main`, bumps + tags + cuts a GitHub Release and publishes **npm + Firefox/AMO + Chrome Web Store**. Bot bump commits are tagged `[skip ci]`. Each publish self-skips when its secrets are absent: `NPM_TOKEN`, `AMO_JWT_ISSUER`/`AMO_JWT_SECRET`, `CWS_CLIENT_ID`/`CWS_CLIENT_SECRET`/`CWS_REFRESH_TOKEN`/`CWS_EXTENSION_ID`.
- `nx run-many --all` does NOT reliably include chrome-extension — the workflow builds it explicitly via `npm run package --prefix chrome-extension`.
- A Chrome publish fails harmlessly (`ITEM_NOT_UPDATABLE`) while a version is in review; `continue-on-error` keeps the release green.

## Dev notes
- esbuild bundling; TypeScript throughout; Jest (both extensions); Nx monorepo.
- The extension requires user consent for page content by default.
