import * as path from "path";
import { BrokerControlClient } from "./broker-control";
import { probeBroker, spawnBroker } from "./broker-launch";
import { BrokerControlResult, LinkStatus } from "./broker-protocol";
import { getControlSecret } from "./control-secret";
import {
  LinkConfig,
  createLinkConfig,
  linkToken,
  readLinkConfig,
  writeLinkConfig,
} from "./link-config";
import { generateLinkSecret } from "./link-crypto";
import { DEFAULT_RELAY_URL, isAllowedRelayUrl } from "./relay-protocol";
import { RelayServer } from "./relay-server";
import { FOXPILOT_VERSION } from "./version";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const CLI_COMMANDS = new Set([
  "link",
  "relay",
  "broker",
  "help",
  "--help",
  "-h",
  "version",
  "--version",
  "-v",
]);

export function isCliInvocation(args: string[]): boolean {
  if (args.length === 0) {
    return false;
  }
  return CLI_COMMANDS.has(args[0]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp(out: (line: string) => void): void {
  out("FoxPilot MCP server & remote-link CLI");
  out("");
  out("Usage:");
  out("  npx foxpilot-mcp link [on] [--relay <url>]           Turn on remote link and show setup token");
  out("  npx foxpilot-mcp link status                         Show remote link status");
  out("  npx foxpilot-mcp link off                            Turn off remote link");
  out("  npx foxpilot-mcp link rotate                         Rotate link secret & generate a new token");
  out("  npx foxpilot-mcp link token                          Print current token only");
  out("  npx foxpilot-mcp relay [--port <n>] [--host <addr>]  Run a relay server");
  out("  npx foxpilot-mcp broker status                       Show broker health & status");
  out("  npx foxpilot-mcp broker stop                         Stop the running broker daemon");
  out("  npx foxpilot-mcp help                                Show this help message");
  out("  npx foxpilot-mcp version                             Show FoxPilot version");
}

function printSetupBlock(
  out: (line: string) => void,
  config: LinkConfig,
  linkStatus?: LinkStatus,
  brokerVersion?: string
): void {
  const relayStatus = linkStatus?.relayConnected
    ? "connected"
    : `NOT connected yet: ${linkStatus?.lastError ?? "connecting"}`;

  const sessionsText =
    !linkStatus?.sessions || linkStatus.sessions.length === 0
      ? "none"
      : `${linkStatus.sessions.length} connected (${linkStatus.sessions
          .map((s) => s.label)
          .join(", ")})`;

  let brokerText = `FoxPilot ${brokerVersion ?? FOXPILOT_VERSION}`;
  if (brokerVersion && brokerVersion !== FOXPILOT_VERSION) {
    brokerText += ` — this CLI is ${FOXPILOT_VERSION}; restart the broker to update it: npx foxpilot-mcp broker stop`;
  }

  const token = linkToken(config);

  out("FoxPilot remote link is ON");
  out(`  relay:     ${config.relayUrl} (${relayStatus})`);
  out(`  sessions:  ${sessionsText}`);
  out(`  broker:    ${brokerText}`);
  out("");
  out(
    "On the remote machine (cloud workspace, VM, container), add FoxPilot with this token:"
  );
  out("");
  out("  Claude Code:");
  out(
    `    claude mcp add foxpilot -e FOXPILOT_LINK=${token} -- npx -y foxpilot-mcp@latest`
  );
  out("");
  out("  Any MCP client (JSON config):");
  out(
    `    "foxpilot": { "command": "npx", "args": ["-y", "foxpilot-mcp@latest"], "env": { "FOXPILOT_LINK": "${token}" } }`
  );
  out("");
  out(
    "  Prefer a secret store for the token: set FOXPILOT_LINK as an environment secret and reference it"
  );
  out('  (Claude Code .mcp.json supports "${FOXPILOT_LINK}").');
  out("");
  out(
    "The token is a password for this browser: whoever has it can drive the browser while the link is on."
  );
  out(
    "Keep this computer's browser (with the FoxPilot extension) open; the link stays up while the FoxPilot broker runs."
  );
  out(
    "Turn it off: npx foxpilot-mcp link off      New token (revokes this one): npx foxpilot-mcp link rotate"
  );
}

interface BrokerReloadResult {
  ok: boolean;
  linkStatus?: LinkStatus;
  brokerVersion?: string;
  exitCode?: number;
}

async function ensureBrokerAndReload(
  port: number,
  secret: string,
  errOut: (line: string) => void
): Promise<BrokerReloadResult> {
  let probe = await probeBroker(port);
  if (!probe.reachable) {
    spawnBroker({ port, secret });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await delay(200);
      probe = await probeBroker(port);
      if (probe.reachable) {
        break;
      }
    }
    if (!probe.reachable) {
      errOut(
        `Could not connect to or start the FoxPilot broker on port ${port}.`
      );
      return { ok: false, exitCode: 1 };
    }
  }

  let client: BrokerControlClient;
  try {
    client = await BrokerControlClient.connect(port, secret, 5000);
  } catch (err) {
    errOut(
      `Failed to connect to FoxPilot broker on port ${port}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return { ok: false, exitCode: 1 };
  }

  let reloadRes: BrokerControlResult;
  try {
    reloadRes = await client.request({ control: "link-reload" });
  } catch (err) {
    client.close();
    errOut(
      `Failed to reload link configuration on broker: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return { ok: false, exitCode: 1 };
  }

  if (
    !reloadRes.ok &&
    (reloadRes.error?.includes("Unknown control") ||
      reloadRes.error?.toLowerCase().includes("no remote-link support"))
  ) {
    client.close();
    const isWin = process.platform === "win32";
    const killCmd = isWin
      ? `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /PID %a /F`
      : `lsof -nP -iTCP:${port} -sTCP:LISTEN -t | xargs kill`;
    errOut(
      `The running FoxPilot broker on port ${port} is an older version that must be restarted.\n` +
        `Stop it with:\n` +
        `  ${killCmd}\n` +
        `Then rerun: npx foxpilot-mcp link`
    );
    return { ok: false, exitCode: 1 };
  }

  let statusRes = reloadRes;
  if (!statusRes.link?.relayConnected) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await delay(500);
      try {
        statusRes = await client.request({ control: "link-status" });
        if (statusRes.link?.relayConnected) {
          break;
        }
      } catch {
        break;
      }
    }
  }
  client.close();

  return {
    ok: true,
    linkStatus: statusRes.link,
    brokerVersion: statusRes.version,
  };
}

export async function runCli(
  args: string[],
  io?: CliIo,
  env?: NodeJS.ProcessEnv,
  abortSignal?: AbortSignal
): Promise<number> {
  const actualIo: CliIo = {
    out: io?.out ?? ((line: string) => console.log(line)),
    err: io?.err ?? ((line: string) => console.error(line)),
  };

  const envActual = env ?? process.env;
  const port =
    envActual.EXTENSION_PORT && !Number.isNaN(Number(envActual.EXTENSION_PORT))
      ? Number(envActual.EXTENSION_PORT)
      : 8089;
  const configDir = envActual.HOME
    ? path.join(envActual.HOME, ".foxpilot")
    : undefined;
  const secret =
    envActual.EXTENSION_SECRET || getControlSecret({ dir: configDir });

  if (args.length === 0) {
    actualIo.err("No command provided. Run 'npx foxpilot-mcp help' for usage.");
    return 2;
  }

  const cmd = args[0];
  const subArgs = args.slice(1);

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp(actualIo.out);
    return 0;
  }

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    actualIo.out(FOXPILOT_VERSION);
    return 0;
  }

  if (cmd === "link") {
    let mode = "on";
    let flagArgs = subArgs;

    if (subArgs.length > 0 && !subArgs[0].startsWith("--")) {
      mode = subArgs[0];
      flagArgs = subArgs.slice(1);
    }

    if (mode === "on") {
      let flagRelay: string | undefined;
      for (let i = 0; i < flagArgs.length; i++) {
        const arg = flagArgs[i];
        if (arg === "--relay") {
          if (i + 1 >= flagArgs.length || flagArgs[i + 1].startsWith("--")) {
            actualIo.err(
              "Missing value for --relay flag.\nUsage: npx foxpilot-mcp link [on] [--relay <url>]"
            );
            return 2;
          }
          flagRelay = flagArgs[++i];
        } else if (arg.startsWith("--relay=")) {
          flagRelay = arg.slice("--relay=".length);
        } else {
          actualIo.err(
            `Unknown flag or argument: ${arg}\nUsage: npx foxpilot-mcp link [on] [--relay <url>]`
          );
          return 2;
        }
      }

      let relayUrl = flagRelay;
      if (!relayUrl) {
        const existing = readLinkConfig(configDir);
        if (existing?.relayUrl) {
          relayUrl = existing.relayUrl;
        } else if (envActual.FOXPILOT_RELAY_URL) {
          relayUrl = envActual.FOXPILOT_RELAY_URL;
        } else {
          relayUrl = DEFAULT_RELAY_URL;
        }
      }

      if (!isAllowedRelayUrl(relayUrl)) {
        actualIo.err(
          `Invalid relay URL: "${relayUrl}". wss:// is required outside private networks.`
        );
        return 2;
      }

      let config = readLinkConfig(configDir);
      if (config) {
        config = {
          ...config,
          relayUrl,
          enabled: true,
        };
      } else {
        config = createLinkConfig(relayUrl);
      }
      writeLinkConfig(config, configDir);

      const reloadResult = await ensureBrokerAndReload(
        port,
        secret,
        actualIo.err
      );
      if (!reloadResult.ok) {
        return reloadResult.exitCode ?? 1;
      }

      if (!reloadResult.linkStatus?.relayConnected) {
        actualIo.err(
          `Warning: Remote link relay is not connected yet${
            reloadResult.linkStatus?.lastError
              ? `: ${reloadResult.linkStatus.lastError}`
              : ""
          }`
        );
      }

      printSetupBlock(
        actualIo.out,
        config,
        reloadResult.linkStatus,
        reloadResult.brokerVersion
      );
      return 0;
    }

    if (mode === "status") {
      if (flagArgs.length > 0) {
        actualIo.err(
          "Unexpected arguments for 'link status'.\nUsage: npx foxpilot-mcp link status"
        );
        return 2;
      }

      const config = readLinkConfig(configDir);
      if (!config) {
        actualIo.out("Remote link is not configured (no link.json).");
        actualIo.out("Turn it on with: npx foxpilot-mcp link");
        return 0;
      }

      const statusStr = config.enabled ? "ON" : "OFF";
      actualIo.out(`FoxPilot remote link is ${statusStr}`);
      actualIo.out(`  configured: yes (enabled: ${config.enabled})`);

      const probe = await probeBroker(port);
      if (!probe.reachable) {
        actualIo.out(`  relay:     ${config.relayUrl}`);
        actualIo.out(
          `  broker:    not running on port ${port} (run 'npx foxpilot-mcp link' to start it)`
        );
        return 0;
      }

      try {
        const client = await BrokerControlClient.connect(port, secret, 3000);
        const res = await client.request({ control: "link-status" });
        client.close();

        const relayText = res.link?.relayConnected
          ? "connected"
          : `NOT connected yet: ${res.link?.lastError ?? "connecting"}`;
        actualIo.out(`  relay:     ${config.relayUrl} (${relayText})`);

        if (!res.link?.sessions || res.link.sessions.length === 0) {
          actualIo.out("  sessions:  none");
        } else {
          const now = Date.now();
          const sessionsStr = res.link.sessions
            .map((s) => {
              const mins = Math.max(
                0,
                Math.floor((now - s.connectedAt) / 60000)
              );
              return `${s.label} (FoxPilot ${s.version}, connected ${mins}m ago)`;
            })
            .join(", ");
          actualIo.out(
            `  sessions:  ${res.link.sessions.length} connected (${sessionsStr})`
          );
        }

        let brokerText = `FoxPilot ${res.version ?? FOXPILOT_VERSION}`;
        if (res.version && res.version !== FOXPILOT_VERSION) {
          brokerText += ` — this CLI is ${FOXPILOT_VERSION}; restart the broker to update it: npx foxpilot-mcp broker stop`;
        }
        actualIo.out(`  broker:    ${brokerText}`);
      } catch (err) {
        actualIo.out(`  relay:     ${config.relayUrl}`);
        actualIo.out(
          `  broker:    running on port ${port}, but could not query link status: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      return 0;
    }

    if (mode === "off") {
      if (flagArgs.length > 0) {
        actualIo.err(
          "Unexpected arguments for 'link off'.\nUsage: npx foxpilot-mcp link off"
        );
        return 2;
      }

      const config = readLinkConfig(configDir);
      if (!config) {
        actualIo.out("Remote link is not set up.");
        return 0;
      }

      config.enabled = false;
      writeLinkConfig(config, configDir);

      const probe = await probeBroker(port);
      if (probe.reachable) {
        try {
          const client = await BrokerControlClient.connect(port, secret, 3000);
          await client.request({ control: "link-reload" });
          client.close();
        } catch {
          /* best effort */
        }
      }

      actualIo.out(
        "FoxPilot remote link is OFF. Remote sessions were disconnected. Turn it back on (same token): npx foxpilot-mcp link"
      );
      return 0;
    }

    if (mode === "rotate") {
      if (flagArgs.length > 0) {
        actualIo.err(
          "Unexpected arguments for 'link rotate'.\nUsage: npx foxpilot-mcp link rotate"
        );
        return 2;
      }

      let config = readLinkConfig(configDir);
      if (!config) {
        // Behaves like link
        return runCli(["link"], actualIo, envActual, abortSignal);
      }

      const newSecret = generateLinkSecret().toString("base64url");
      config = {
        ...config,
        secret: newSecret,
        enabled: true,
      };
      writeLinkConfig(config, configDir);

      const reloadResult = await ensureBrokerAndReload(
        port,
        secret,
        actualIo.err
      );
      if (!reloadResult.ok) {
        return reloadResult.exitCode ?? 1;
      }

      if (!reloadResult.linkStatus?.relayConnected) {
        actualIo.err(
          `Warning: Remote link relay is not connected yet${
            reloadResult.linkStatus?.lastError
              ? `: ${reloadResult.linkStatus.lastError}`
              : ""
          }`
        );
      }

      actualIo.out("The old token no longer works.");
      printSetupBlock(
        actualIo.out,
        config,
        reloadResult.linkStatus,
        reloadResult.brokerVersion
      );
      return 0;
    }

    if (mode === "token") {
      if (flagArgs.length > 0) {
        actualIo.err(
          "Unexpected arguments for 'link token'.\nUsage: npx foxpilot-mcp link token"
        );
        return 2;
      }

      const config = readLinkConfig(configDir);
      if (!config) {
        actualIo.err(
          "Remote link is not configured. Run 'npx foxpilot-mcp link' first."
        );
        return 1;
      }

      actualIo.out(linkToken(config));
      return 0;
    }

    actualIo.err(
      `Unknown link subcommand: ${mode}\nUsage: npx foxpilot-mcp link [on|status|off|rotate|token]`
    );
    return 2;
  }

  if (cmd === "relay") {
    let relayPort = 8787;
    let relayHost = "127.0.0.1";

    for (let i = 0; i < subArgs.length; i++) {
      const arg = subArgs[i];
      if (arg === "--port") {
        if (i + 1 >= subArgs.length || subArgs[i + 1].startsWith("--")) {
          actualIo.err(
            "Missing value for --port flag.\nUsage: npx foxpilot-mcp relay [--port <n>] [--host <addr>]"
          );
          return 2;
        }
        const val = Number(subArgs[++i]);
        if (Number.isNaN(val) || val < 0 || val > 65535) {
          actualIo.err(
            `Invalid port "${subArgs[i]}". Must be an integer between 0 and 65535.`
          );
          return 2;
        }
        relayPort = val;
      } else if (arg.startsWith("--port=")) {
        const val = Number(arg.slice("--port=".length));
        if (Number.isNaN(val) || val < 0 || val > 65535) {
          actualIo.err(
            `Invalid port "${arg.slice("--port=".length)}". Must be an integer between 0 and 65535.`
          );
          return 2;
        }
        relayPort = val;
      } else if (arg === "--host") {
        if (i + 1 >= subArgs.length || subArgs[i + 1].startsWith("--")) {
          actualIo.err(
            "Missing value for --host flag.\nUsage: npx foxpilot-mcp relay [--port <n>] [--host <addr>]"
          );
          return 2;
        }
        relayHost = subArgs[++i];
      } else if (arg.startsWith("--host=")) {
        relayHost = arg.slice("--host=".length);
      } else {
        actualIo.err(
          `Unknown flag: ${arg}\nUsage: npx foxpilot-mcp relay [--port <n>] [--host <addr>]`
        );
        return 2;
      }
    }

    const relay = new RelayServer({
      port: relayPort,
      host: relayHost,
      log: (line) => actualIo.err(line),
    });

    try {
      await relay.listen();
    } catch (err) {
      actualIo.err(
        `Failed to start relay server: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return 1;
    }

    const boundPort = relay.getPort();
    actualIo.out(`FoxPilot relay listening on ws://${relayHost}:${boundPort}`);
    actualIo.out(
      `Point a link at it with: npx foxpilot-mcp link --relay ws://<this machine's private address>:${boundPort}  (use wss:// behind a TLS proxy when it is reachable from the internet)`
    );

    return new Promise<number>((resolve) => {
      let closed = false;
      const finish = async () => {
        if (closed) return;
        closed = true;
        process.removeListener("SIGINT", finish);
        process.removeListener("SIGTERM", finish);
        if (abortSignal) {
          abortSignal.removeEventListener("abort", finish);
        }
        try {
          await relay.close();
        } catch {
          /* ignore */
        }
        resolve(0);
      };

      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      if (abortSignal) {
        if (abortSignal.aborted) {
          finish();
        } else {
          abortSignal.addEventListener("abort", finish);
        }
      }
    });
  }

  if (cmd === "broker") {
    if (subArgs.length === 0) {
      actualIo.err(
        "Missing broker subcommand.\nUsage: npx foxpilot-mcp broker [status|stop]"
      );
      return 2;
    }

    const sub = subArgs[0];
    const extraArgs = subArgs.slice(1);

    if (sub === "status") {
      if (extraArgs.length > 0) {
        actualIo.err(
          "Unexpected arguments for 'broker status'.\nUsage: npx foxpilot-mcp broker status"
        );
        return 2;
      }

      const probe = await probeBroker(port);
      if (!probe.reachable || !probe.health) {
        actualIo.out(`No FoxPilot broker is running on port ${port}.`);
        return 0;
      }

      const h = probe.health;
      actualIo.out(`FoxPilot broker on port ${port}:`);
      actualIo.out(`  version:            ${h.version ?? "unknown"}`);
      actualIo.out(
        `  extensionConnected: ${h.extensionConnected ? "yes" : "no"}`
      );
      actualIo.out(`  browsers:           ${h.browsers ?? 0}`);
      actualIo.out(`  clients:            ${h.clients ?? 0}`);
      actualIo.out(`  remoteClients:      ${h.remoteClients ?? 0}`);
      if (h.link && typeof h.link === "object") {
        const l = h.link as Record<string, unknown>;
        actualIo.out(
          `  link:               enabled=${l.enabled}, relayConnected=${l.relayConnected}, sessions=${l.sessions}`
        );
      }
      return 0;
    }

    if (sub === "stop") {
      if (extraArgs.length > 0) {
        actualIo.err(
          "Unexpected arguments for 'broker stop'.\nUsage: npx foxpilot-mcp broker stop"
        );
        return 2;
      }

      const probe = await probeBroker(port);
      if (!probe.reachable) {
        actualIo.out(`No FoxPilot broker is running on port ${port}.`);
        return 0;
      }

      let client: BrokerControlClient;
      try {
        client = await BrokerControlClient.connect(port, secret, 3000);
      } catch (err) {
        actualIo.err(
          `Failed to connect to FoxPilot broker on port ${port}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return 1;
      }

      let res: BrokerControlResult;
      try {
        res = await client.request({ control: "shutdown" });
      } catch (err) {
        client.close();
        actualIo.err(
          `Failed to send shutdown command to broker: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return 1;
      }
      client.close();

      if (!res.ok) {
        if (res.error?.includes("Unknown control")) {
          const isWin = process.platform === "win32";
          const killCmd = isWin
            ? `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /PID %a /F`
            : `lsof -nP -iTCP:${port} -sTCP:LISTEN -t | xargs kill`;
          actualIo.err(
            `The running FoxPilot broker on port ${port} does not support graceful shutdown.\n` +
              `Stop it with:\n` +
              `  ${killCmd}`
          );
          return 1;
        }
        actualIo.err(`Failed to stop broker: ${res.error ?? "unknown error"}`);
        return 1;
      }

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const check = await probeBroker(port, 200);
        if (!check.reachable) {
          break;
        }
        await delay(100);
      }

      actualIo.out(
        `Stopped the FoxPilot broker on port ${port}. It restarts on demand (any local FoxPilot session or \`npx foxpilot-mcp link\`).`
      );
      return 0;
    }

    actualIo.err(
      `Unknown broker subcommand: ${sub}\nUsage: npx foxpilot-mcp broker [status|stop]`
    );
    return 2;
  }

  actualIo.err(`Unknown command or flag: ${cmd}`);
  actualIo.err("Run 'npx foxpilot-mcp help' for usage.");
  return 2;
}
