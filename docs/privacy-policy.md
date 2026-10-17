# Privacy Policy — FoxPilot

**Last updated:** October 2026

## What this extension does

FoxPilot connects your browser to a **Model Context Protocol (MCP) server running on your own computer** (localhost). This lets an AI assistant that you run and control perform browser actions you ask for — managing tabs, reading recent history and page content, and opt-in page automation (clicks, form fills, screenshots, console/network capture).

## Data collection

**This extension does not collect, store, or transmit any personal data to the developer or to any third party.**

- No analytics or tracking of any kind
- No telemetry, crash reports, or usage statistics
- No data is sent to any remote/third-party server, unless you turn on the optional remote link (off by default) or your AI assistant calls the optional `send-feedback` tool with your approval (both described below)

## Data flow

1. The extension connects only to a server running on **your own machine** (default: `127.0.0.1` / `localhost`, port `8089`), authenticated with a secret that only you hold.
2. Commands originate from your local MCP client (the AI assistant you run). In response, the extension may read tab information, browsing history, or page content, and perform automation actions.
3. Any such data is returned **only to your local server**. Nothing leaves your computer beyond the normal web requests the pages you visit would make anyway.
4. The extension has no remote backend. The only service the developer operates is the feedback service used by the optional `send-feedback` tool, described below.

## Optional remote link

The extension itself still connects only to the local server running on your own computer. If you turn on the optional remote link, your local FoxPilot server forwards commands and results end-to-end encrypted through a relay to a FoxPilot server you set up on another machine. The developer does not operate a relay: you run your own (a Cloudflare Worker on your own account, or a Node process on a machine you control). The relay cannot read the messages and stores nothing. The remote link is off by default.

## Optional feedback tool

The FoxPilot MCP server (not the browser extension) includes a `send-feedback` tool. Nothing is sent unless your AI assistant calls it, and the tool instructs the assistant to do so only when you ask for it or agree to it. When called, it sends one report to a feedback service operated by the developer on Cloudflare Workers, which files it as a ticket in the developer's issue tracker. The report contains: the report type, the title and description written by the assistant, the name of the FoxPilot tool involved (optional), the FoxPilot version, the MCP client's name and version, your operating system and CPU architecture, and the Node.js version. Before sending, FoxPilot removes link tokens, authorization and cookie headers, bearer tokens, common API-key formats, URL query strings and fragments, email addresses and your home-directory path from the text.

The service uses your IP address only to rate-limit submissions: it stores a keyed hash of the address, not the address itself, for up to two days. The ticket content is kept in the developer's issue tracker until the developer deletes it; to have a report removed, email [mail@balakumar.dev](mailto:mail@balakumar.dev). You can disable the tool's network call by setting `FOXPILOT_FEEDBACK=off` for the MCP server, or send reports to your own deployment instead with `FOXPILOT_FEEDBACK_URL`.

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

The `evaluate-script` capability runs JavaScript supplied at runtime to automate pages on your explicit command. This code reaches the extension only from your local server (127.0.0.1), which may relay it from a remote FoxPilot session you linked. It runs only when you issue such a command.

## Local storage

The extension stores only:
- **Connection settings** — the server port and shared secret you configure
- **Preferences** — local UI/automation preferences

## Contact

For questions or concerns, open an issue at [github.com/balakumardev/foxpilot](https://github.com/balakumardev/foxpilot/issues) or email [mail@balakumar.dev](mailto:mail@balakumar.dev).
