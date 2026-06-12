# FoxPilot

[![Firefox Add-on](./.github/addon_badge.svg)](https://addons.mozilla.org/en-US/firefox/addon/foxpilot/)

An MCP server paired with a Firefox browser extension that lets AI assistants drive your browser — tab/window management, browsing history, and webpage content by default, plus a full opt-in **Automation Mode** for page interaction, scripting, screenshots, and console/network inspection.

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
* **Local-only.** Communication uses a local-only connection secured by a shared secret between the MCP server and the extension. No remote data collection or tracking.
* **Auditable.** The extension keeps an audit log of tool calls and lets you enable/disable individual tools.
* **No runtime third-party dependencies** in the extension.

**Important note**: FoxPilot is still experimental. Use at your own risk. Practice caution as with any other MCP server, and authorize/monitor tool calls carefully — especially with Automation Mode enabled.

## Installation

### Option 1: Install the Firefox and Claude Desktop extensions

The Firefox extension / add-on is [available on addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/foxpilot/). You can also download and open the latest pre-built version from this GitHub repository: [foxpilot-1.5.0.xpi](https://github.com/balakumardev/foxpilot/releases/download/v1.5.0/foxpilot-1.5.0.xpi). Complete the installation based on the instructions in the "Manage extension" page, which will open automatically after installation.

The add-on's "Manage extension" page will include a link to the Claude Desktop DXT file. You can also download it here: [mcp-server-v1.5.1.dxt](
https://github.com/balakumardev/foxpilot/releases/download/v1.5.1/mcp-server-v1.5.1.dxt). After downloading the file, open it or drag it into Claude Desktop's settings window. Make sure to enable the DXT extension after installing it. This will only work with the latest versions of Claude Desktop. If you wish to install the MCP server locally, see the MCP configuration below.

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
5. The extension's preferences page will open. Copy the secret key to your clipboard. It will be used to configure the MCP server.

Alternatively, to install a permanent add-on, you can install the [FoxPilot on addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/foxpilot/) and then configure the MCP Server as detailed below.

If you prefer not to run the extension on your personal Firefox browser, an alternative is to download a separate Firefox instance (such as Firefox Developer Edition, available at https://www.mozilla.org/en-US/firefox/developer/).


#### MCP Server configuration

After installing the browser extension, add the following configuration to your mcpServers configuration (e.g. `claude_desktop_config.json` for Claude Desktop):
```json
{
    "mcpServers": {
        "foxpilot": {
            "command": "node",
            "args": [
                "/path/to/repo/mcp-server/dist/server.js"
            ],
            "env": {
                "EXTENSION_SECRET": "<secret_on_firefox_extension_options_page>",
                "EXTENSION_PORT": "8089" 
            }
        }
    }
}
```
Replace `/path/to/repo` with the correct path.

Set the EXTENSION_SECRET to the value shown on the extension's preferences page in Firefox (you can access it at `about:addons`). You can also set the EXTENSION_PORT environment variable to specify the port that the MCP server will use to communicate with the extension (default is 8089).

It might take a few seconds for the MCP server to connect to the extension.

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
                "-e", "EXTENSION_SECRET=<secret_from_extension>",
                "-e", "CONTAINERIZED=true",
                "foxpilot"
            ]
        }
    }
}
```

## Author

FoxPilot is built and maintained by **Bala Kumar** — [@balakumardev](https://github.com/balakumardev) · mail@balakumar.dev

Licensed under the [MIT License](./LICENSE).

