# FoxPilot

[![Firefox Add-on](https://img.shields.io/amo/v/foxpilot?label=Firefox%20Add-on&logo=firefoxbrowser)](https://addons.mozilla.org/en-US/firefox/addon/foxpilot/)
[![npm](https://img.shields.io/npm/v/foxpilot-mcp?logo=npm&label=foxpilot-mcp)](https://www.npmjs.com/package/foxpilot-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

An MCP server paired with a Firefox or Chrome/Edge browser extension that lets AI assistants drive your browser — tab/window management, browsing history, and webpage content by default, plus a full opt-in **Automation Mode** for page interaction, scripting, screenshots, and console/network inspection.

## Features

### Tab, window & history
- Open, close, reorder, and group tabs; list open tabs; get the active tab; resize the window
- Read and search the browser's history

### Reading & inspecting pages
- Read a webpage's text content and links (requires user consent)
- Find and highlight text in a tab (requires user consent)
- Take an accessibility snapshot — interactive elements tagged with stable uids
- Navigate a tab to a URL or through its history; wait for text to appear

### Automation Mode (opt-in)
These powerful tools require enabling **Automation Mode** in the extension:
- Page interaction: click, hover, fill fields, fill forms, type text, press keys, drag elements
- Upload files into file inputs
- Evaluate JavaScript in the page and return the result
- Take screenshots (viewport, full page, or a single element)
- Capture console messages and network requests
- Handle native dialogs; emulate geolocation / user agent

## Example use-cases:

### Tab management
- *"Close all non-work-related tabs in my browser."*
- *"Group all development related tabs in my browser into a new group called 'Development'."*
- *"Rearrange tabs in my browser in an order that makes sense."*
- *"Close all tabs in my browser that haven't been accessed within the past 24 hours"*

### Browser history search
- *"Help me find an article in my browser history about the Milford track in NZ."*
- *"Open all the articles about AI that I visited during the last week, up to 10 articles, avoid duplications."*

### Browsing and research 
- *"Open hackernews in my browser, then open the top story, read it, also read the comments. Do the comments agree with the story?"*
- *"In my browser, use Google Scholar to search for papers about L-theanine in the last 3 years. Open the 3 most cited papers. Read them and summarize them for me."*
- *"Use Google search in my browser to look for flower shops. Open the 10 most relevant results. Show me a table of each flower shop with location and opening hours."*

## Security & design

FoxPilot is built to run safely against your **personal** Firefox profile rather than a throwaway automation browser:

* **Privacy-first defaults.** Page interaction, scripting, screenshots, and console/network capture are off until you explicitly turn on **Automation Mode** in the extension — and it can be turned back off at any time.
* **Per-domain consent.** Reading webpage content requires your explicit consent in the browser for each domain, enforced at the extension's manifest level.
* **Local-only.** Communication uses a local-only (loopback) connection between the MCP server and the extension. The extension pairs automatically — the local broker only admits browser-extension connections that arrive over loopback, so there's no secret for you to copy or manage. No remote data collection or tracking.
* **Auditable.** The extension keeps an audit log of tool calls and lets you enable/disable individual tools.
* **No runtime third-party dependencies** in the extension.

**Important note**: FoxPilot is still experimental. Use at your own risk. Practice caution as with any other MCP server, and authorize/monitor tool calls carefully — especially with Automation Mode enabled.

## Installation

### Option 1: Install the browser and Claude Desktop extensions

FoxPilot is **zero-config**: install the MCP server and the browser add-on, and they pair automatically over a local-only connection — there's no secret to copy or paste.

1. **Install the MCP server (Claude Desktop DXT).** Download [foxpilot-mcp.dxt](https://github.com/balakumardev/foxpilot/releases/latest/download/foxpilot-mcp.dxt), then open it or drag it into Claude Desktop's settings window. Make sure to enable the DXT extension after installing it. This only works with the latest versions of Claude Desktop. (If you'd rather run the MCP server yourself via `npx`/`node`/Docker, see the MCP configuration below.)
2. **Install the browser add-on.** The Firefox add-on is [available on addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/foxpilot/); the Chrome/Edge extension is on the Chrome Web Store. You can also download the latest pre-built extension from this repository's [releases](https://github.com/balakumardev/foxpilot/releases/latest) ([foxpilot-extension.zip](https://github.com/balakumardev/foxpilot/releases/latest/download/foxpilot-extension.zip)). Complete the installation based on the instructions in the "Manage extension" page, which will open automatically after installation.

That's it — the extension connects to the local server automatically. It might take a few seconds for the connection to establish.

### Option 2: Build from code

To build from code, clone this repository, then run the following commands in the main repository directory to build both the MCP server and the browser extension.
```
npm install
npm run build
```

#### Installing a Firefox Temporary Add-on 

To install the extension on Firefox as a Temporary Add-on:

1. Type `about:debugging` in the Firefox URL bar
2. Click on "This Firefox"
3. click on "Load Temporary Add-on..."
4. Select the `manifest.json` file under the `firefox-extension` folder in this project
5. The extension's preferences page will open. No secret to copy — once the MCP server is running, the extension pairs with it automatically over the local connection.

Alternatively, to install a permanent add-on, you can install the [FoxPilot on addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/foxpilot/) and then run the MCP Server as detailed below.

If you prefer not to run the extension on your personal Firefox browser, an alternative is to download a separate Firefox instance (such as Firefox Developer Edition, available at https://www.mozilla.org/en-US/firefox/developer/).


#### MCP Server configuration

Add FoxPilot to your `mcpServers` configuration (e.g. `claude_desktop_config.json` for Claude Desktop). The easiest way is via `npx` — no local checkout or build required. No secret is required: when `EXTENSION_SECRET` is omitted, the browser extension pairs automatically (the broker only admits extension connections that arrive over loopback):
```json
{
    "mcpServers": {
        "foxpilot": {
            "command": "npx",
            "args": ["-y", "foxpilot-mcp"],
            "env": {
                "EXTENSION_PORT": "8089"
            }
        }
    }
}
```

Or, if you built from source, point `node` at the built server instead (replace `/path/to/repo`):
```json
{
    "mcpServers": {
        "foxpilot": {
            "command": "node",
            "args": [
                "/path/to/repo/mcp-server/dist/server.js"
            ],
            "env": {
                "EXTENSION_PORT": "8089"
            }
        }
    }
}
```

`EXTENSION_PORT` is optional and specifies the port that the MCP server will use to communicate with the extension (default is 8089).

`EXTENSION_SECRET` is **optional** and only needed for advanced/remote deployments — see [Remote / containerized deployments](#configure-the-mcp-server-with-docker) below. For normal local use, omit it and rely on zero-config pairing.

It might take a few seconds for the MCP server to connect to the extension.

#### Migration from earlier versions

Nothing to do. If you already have `EXTENSION_SECRET` set in your MCP config from an earlier release, it keeps working unchanged — the extension that shares that secret continues to authenticate over the signed path. New users don't need to set anything: just install the MCP server and the extension and they pair automatically.

##### Configure the MCP server with Docker

Alternatively, you can use a Docker-based configuration. To do so, build the mcp-server Docker image:
```
docker build -t foxpilot .
```

and use the following mcpServers configuration:

```json
{
    "mcpServers": {
        "foxpilot": {
            "command": "docker",
            "args": [
                "run",
                "--rm",
                "-i",
                "-p", "127.0.0.1:8089:8089",
                "-e", "EXTENSION_SECRET=<your_chosen_secret>",
                "-e", "CONTAINERIZED=true",
                "foxpilot"
            ]
        }
    }
}
```

In a containerized (`CONTAINERIZED=true`) or remote setup the extension's connection does not arrive over loopback with a recognizable browser-extension Origin, so zero-config pairing does not apply. Here `EXTENSION_SECRET` is **required**: choose any secret, set it on the `docker run` command above, and set the **same** secret in the extension's **Advanced** settings so the two can authenticate.

## Author

FoxPilot is built and maintained by **Bala Kumar** — [@balakumardev](https://github.com/balakumardev) · mail@balakumar.dev

Licensed under the [MIT License](./LICENSE).

