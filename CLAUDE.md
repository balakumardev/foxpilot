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
- Auth: shared `EXTENSION_SECRET` — the secret configured in the extension's options must match the server/broker. `EXTENSION_PORT` defaults to 8089.

### Key files
- `mcp-server/server.ts` — tool definitions; `mcp-server/broker.ts` — broker.
- `firefox-extension/message-handler.ts`, `chrome-extension/message-handler.ts` — execute browser actions.
- `firefox-extension/injected/*` — functions stringified and run in the page (`action-script`, `snapshot-script`, `page-world`, `upload-script`). Mirrored in `chrome-extension/injected/*`.
- `common/server-messages.ts`, `common/extension-messages.ts` — message types.

## Gotchas (these cost real time)
- **Isolated vs page world / CSP:** DOM ops (click, fill, snapshot, **upload-file**) run in the ISOLATED content-script world and are CSP-immune. `evaluate-script` / `handle-dialog` / `emulate` inject a page-world `<script>`, which **strict-CSP pages (e.g. chrome.google.com) block** → "Timed out waiting for in-page result" / "Invalid message signature". Don't add page-world `<script>` injection for anything that can run in the isolated world.
- **Firefox file upload:** content scripts see the page via Xray; build File/DataTransfer in the page realm via `wrappedJSObject` + `cloneInto` so `input.files` accepts the FileList (see `injected/upload-script.ts`).
- **Stale broker:** the broker is a detached persistent process holding port 8089. After rebuilding mcp-server, `pkill -f dist/broker-main.js` so a fresh broker starts. If tools report "no extension connected" or signature errors, the loaded extension is older than the rebuilt broker — **reload the extension** (Firefox: `about:debugging` → Reload).
- **`docs/` is gitignored** — use `git add -f` to commit docs (e.g. `docs/privacy-policy.md`).

## CI/CD
- `.github/workflows/release.yml`: on push to `main`, bumps + tags + cuts a GitHub Release and publishes **npm + Firefox/AMO + Chrome Web Store**. Bot bump commits are tagged `[skip ci]`. Each publish self-skips when its secrets are absent: `NPM_TOKEN`, `AMO_JWT_ISSUER`/`AMO_JWT_SECRET`, `CWS_CLIENT_ID`/`CWS_CLIENT_SECRET`/`CWS_REFRESH_TOKEN`/`CWS_EXTENSION_ID`.
- `nx run-many --all` does NOT reliably include chrome-extension — the workflow builds it explicitly via `npm run package --prefix chrome-extension`.
- A Chrome publish fails harmlessly (`ITEM_NOT_UPDATABLE`) while a version is in review; `continue-on-error` keeps the release green.

## Dev notes
- esbuild bundling; TypeScript throughout; Jest (both extensions); Nx monorepo.
- The extension requires user consent for page content by default.
