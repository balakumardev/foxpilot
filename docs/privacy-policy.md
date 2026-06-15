# Privacy Policy — FoxPilot

**Last updated:** June 2026

## What this extension does

FoxPilot connects your browser to a **Model Context Protocol (MCP) server running on your own computer** (localhost). This lets an AI assistant that you run and control perform browser actions you ask for — managing tabs, reading recent history and page content, and opt-in page automation (clicks, form fills, screenshots, console/network capture).

## Data collection

**This extension does not collect, store, or transmit any personal data to the developer or to any third party.**

- No analytics or tracking of any kind
- No telemetry, crash reports, or usage statistics
- No data is sent to any remote/third-party server

## Data flow

1. The extension connects only to a server running on **your own machine** (default: `127.0.0.1` / `localhost`, port `8089`), authenticated with a secret that only you hold.
2. Commands originate from your local MCP client (the AI assistant you run). In response, the extension may read tab information, browsing history, or page content, and perform automation actions.
3. Any such data is returned **only to your local server**. Nothing leaves your computer beyond the normal web requests the pages you visit would make anyway.
4. The extension has no remote backend operated by the developer.

## Permissions

| Permission | Why it's needed |
|------------|-----------------|
| `tabs` | List, open, close, reorder and read tabs on request |
| `history` | Return recent browsing history when you explicitly ask |
| `storage` | Save local connection settings (port, shared secret) and preferences |
| `webRequest` | Capture network request metadata for a tab when you enable automation/debugging |
| `scripting` | Inject content scripts to read page content and perform requested automation |
| `tabGroups` | Organize tabs into groups when requested |
| `activeTab` | Act on the currently active tab for user-initiated commands |
| `offscreen` | Maintain the WebSocket connection to the local server (Manifest V3) |
| `alarms` | Keep the service worker alive and reconnect to the local server |
| `declarativeNetRequest` | Apply request-header rules needed for the local automation bridge |

## Host permissions

| Host | Why it's needed |
|------|-----------------|
| `http://localhost/*`, `http://127.0.0.1/*` | Communicate with the local MCP server |
| `<all_urls>` (optional) | Requested **only** when you opt in to automating or reading arbitrary pages; without opt-in, the extension communicates only with localhost |

## Remote code

The `evaluate-script` capability runs JavaScript supplied **at runtime by your own local MCP server** to automate pages on your explicit command. This code originates solely from your local machine (127.0.0.1) — never from a third-party or remote web server — and runs only when you issue such a command.

## Local storage

The extension stores only:
- **Connection settings** — the server port and shared secret you configure
- **Preferences** — local UI/automation preferences

## Contact

For questions or concerns, open an issue at [github.com/balakumardev/foxpilot](https://github.com/balakumardev/foxpilot/issues) or email [mail@balakumar.dev](mailto:mail@balakumar.dev).
