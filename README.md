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

### Remote link (opt-in)
- Drive this browser from a FoxPilot server in a cloud workspace or on another machine, end-to-end encrypted. See [Remote link](#remote-link-drive-this-browser-from-a-cloud-workspace).

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
* **Local-only.** Communication uses a local-only (loopback) connection between the MCP server and the extension unless you turn on the optional [remote link](#remote-link-drive-this-browser-from-a-cloud-workspace), which is end-to-end encrypted. The extension pairs automatically — the local broker only admits browser-extension connections that arrive over loopback, so there's no secret for you to copy or manage. No remote data collection or tracking.
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

## Remote link: drive this browser from a cloud workspace

A FoxPilot MCP server running in a cloud workspace (Claude Code on the web, GitHub Codespaces, a remote VM, or a dev container) can drive the browser on your computer. Local FoxPilot sessions continue to work at the same time, sharing tab leases and active-browser selection through the local broker. All traffic is end-to-end encrypted through a relay that routes messages by room id without reading commands or page data.

### Set up on your computer

Run this command on the computer where your browser is open with the FoxPilot extension:

```bash
npx foxpilot-mcp link
```

This creates `~/.foxpilot/link.json` (mode 0600) with a random 32-byte secret, starts the local broker, and connects to the relay. It prints a link token starting with `fpl1.` and the exact configuration commands for the remote workspace. Keep the browser open with the FoxPilot extension. While the link is on, the local broker does not idle-exit. Up to 8 remote sessions can connect at once.

### Set up on the remote side

#### Claude Code CLI

```bash
claude mcp add foxpilot -e FOXPILOT_LINK=<token> -- npx -y foxpilot-mcp@latest
```

#### MCP client JSON

```json
{
  "mcpServers": {
    "foxpilot": {
      "command": "npx",
      "args": ["-y", "foxpilot-mcp@latest"],
      "env": {
        "FOXPILOT_LINK": "<token>"
      }
    }
  }
}
```

#### Claude Code on the web and shared repositories

Do not commit the token to version control. Add `FOXPILOT_LINK` as an environment variable or secret in your cloud workspace settings, and reference it in `.mcp.json`:

```json
{
  "mcpServers": {
    "foxpilot": {
      "command": "npx",
      "args": ["-y", "foxpilot-mcp@latest"],
      "env": {
        "FOXPILOT_LINK": "${FOXPILOT_LINK}"
      }
    }
  }
}
```

Allow outbound network access to the relay host `foxpilot-relay.ghostwriter-api.workers.dev` in the environment settings, or use full network access. `HTTPS_PROXY` and `NO_PROXY` are detected and handled automatically.

Optional environment variables on the remote machine:
- `FOXPILOT_LINK_LABEL`: sets the session name displayed on your computer. Defaults to the remote hostname.
- `FOXPILOT_RELAY_URL`: overrides the relay URL encoded in the token.

The `upload-file` tool reads file paths on the remote machine where the MCP server runs.

### Manage and turn off

On your computer:

```bash
npx foxpilot-mcp link status    # relay connection and the remote sessions connected now
npx foxpilot-mcp link off       # turn it off and disconnect every remote session
npx foxpilot-mcp link           # turn it back on (same token)
npx foxpilot-mcp link rotate    # new token; the old one stops working at once
npx foxpilot-mcp link token     # print only the token, e.g. | gh secret set FOXPILOT_LINK
npx foxpilot-mcp broker status  # what the local broker is doing
npx foxpilot-mcp broker stop    # stop the broker (it restarts on demand)
```

In the browser: open the FoxPilot options page and click **Test Connection**. It shows `Remote link: on (N remote session(s))` and lists the remote sessions by name. **Turn off remote link** disconnects them all and turns the link off.

### Self-host the relay

The default relay runs at `wss://foxpilot-relay.ghostwriter-api.workers.dev` on Cloudflare Workers. It stores and logs nothing. You can run your own relay:

```bash
npx foxpilot-mcp relay --port 8787 --host 0.0.0.0
```

Put it behind a TLS reverse proxy (Caddy, nginx) and point your computer's link at it. The token carries the relay address, so the remote side needs no extra setting:

```bash
npx foxpilot-mcp link --relay wss://relay.example.com
```

Over a private network, VPN, or Tailscale:

```bash
npx foxpilot-mcp link --relay ws://192.168.1.50:8787
```

Plain `ws://` is accepted only for loopback, RFC 1918 private subnets, and Tailscale addresses (`100.64.0.0/10` and `*.ts.net`).

### Security

- The link token controls access to your browser. Anyone with the token can drive the browser while the link is active.
- Traffic is end-to-end encrypted with an X25519 key exchange authenticated by the token, followed by AES-256-GCM in each direction. Directional sequence numbers protect against message replay and reordering. Ephemeral keys provide forward secrecy.
- The relay pairs the two sides using a one-way room id derived via HKDF from the token. The relay never sees the token, encryption keys, commands, or page content.
- All extension security settings remain in effect: Automation Mode opt-in, per-domain consent dialogs, individual tool toggles, and the local audit log.
- Rotate the token with `npx foxpilot-mcp link rotate` if it leaks, and run `npx foxpilot-mcp link off` when remote access is not needed.

### Troubleshooting

- **"Your computer's FoxPilot is not connected to the relay"**: Run `npx foxpilot-mcp link` on your computer and keep the browser open with the FoxPilot extension.
- **"Your computer's FoxPilot did not accept this link token"**: The token was rotated or the link was turned off. Run `npx foxpilot-mcp link` on your computer to view the active token and update `FOXPILOT_LINK` on the remote workspace.
- **"Could not reach the FoxPilot relay"**: Check the remote environment network settings. If the environment uses an egress proxy, set `HTTPS_PROXY`. If domain restrictions apply, allow `foxpilot-relay.ghostwriter-api.workers.dev`.
- **`link` says the running broker is an older version**: an older FoxPilot broker is still running on your computer. Stop it with the command `link` prints, then run `npx foxpilot-mcp link` again.

## Author

FoxPilot is built and maintained by **Bala Kumar** — [@balakumardev](https://github.com/balakumardev) · mail@balakumar.dev

Licensed under the [MIT License](./LICENSE).

