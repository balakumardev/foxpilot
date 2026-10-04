/**
 * Starting and probing the local broker daemon.
 *
 * Moved out of browser-api.ts so the CLI (`npx foxpilot-mcp link`) can start
 * the broker and check on it the same way an MCP session does.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { ensureFoxpilotDir } from "./control-secret";

/**
 * Size at which the broker log is rotated on open. Mirrored by broker-main.ts,
 * which caps the same file from the other end while the broker is running. The
 * two are independent checks rather than a shared contract — if they ever
 * diverge the smaller cap simply wins — but keeping them equal means the file
 * behaves the same whichever end trims it first.
 */
const BROKER_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Opens the broker's log sink and returns an fd to hand the detached child as
 * its stdout AND stderr, or null when the caller should fall back to "ignore".
 *
 * The broker is a separate process, so its console.error is stderr and can
 * never corrupt this process's JSON-RPC stdout — but spawned with
 * stdio:"ignore" that stderr goes to a discarded fd, which is worse: the idle
 * shutdown notice, the EADDRINUSE race, and the late/unknown-reply diagnostics
 * are all written and then thrown away, so the failure classes they exist to
 * expose stay invisible.
 *
 * Opened in APPEND mode on purpose. The broker trims this same file in place
 * through its inherited fd (see broker-main.ts) and only O_APPEND makes a write
 * after a truncate land at offset 0; without it the fd would keep its old
 * offset and leave a sparse hole the size of everything just discarded.
 *
 * Growth is bounded at both ends. Here, by truncating on open once the file is
 * already over the cap — the broker idle-exits and respawns, so every spawn is
 * a rotation point. That alone is not enough: a broker that stays up for days
 * under a chatty failure mode would grow without limit *between* spawns, so
 * broker-main.ts re-checks the size periodically while it runs.
 *
 * Never throws. A log we cannot open must not stop the browser automation that
 * depends on the broker, so every failure degrades to a null fd.
 */
export function openBrokerLog(): { fd: number; file: string } | null {
  try {
    const file = path.join(ensureFoxpilotDir(), "broker.log");
    let flags = "a";
    try {
      if (fs.statSync(file).size >= BROKER_LOG_MAX_BYTES) {
        flags = "w";
      }
    } catch {
      /* not created yet — "a" creates it */
    }
    return { fd: fs.openSync(file, flags, 0o600), file };
  } catch {
    return null;
  }
}

/**
 * Spawns a detached broker process running broker-main.js next to this file.
 */
export function spawnBroker(opts: { port: number; secret: string }): void {
  const brokerEntry = path.join(__dirname, "broker-main.js");
  const log = openBrokerLog();
  const child = spawn(process.execPath, [brokerEntry], {
    detached: true,
    // Both streams go to the one file: the broker writes everything through
    // console.error, and folding stdout in means a crash dump or a stray
    // library write is captured too. A plain file fd is not a libuv handle,
    // so this does not ref the event loop and detached + unref() below still
    // lets the broker outlive this session exactly as before.
    stdio: log ? ["ignore", log.fd, log.fd] : "ignore",
    env: {
      ...process.env,
      EXTENSION_SECRET: opts.secret,
      EXTENSION_PORT: String(opts.port),
    },
  });
  child.unref();
  if (log) {
    // uv_spawn has already dup'd the fd into the child, so closing our copy
    // here is safe and keeps a long-lived MCP server from leaking one fd per
    // broker respawn.
    try {
      fs.closeSync(log.fd);
    } catch {
      /* already gone; nothing to reclaim */
    }
    // Surfaced on OUR stderr (never stdout — that is the JSON-RPC channel),
    // which is where the MCP client tees server diagnostics. Printed at spawn
    // because that is the moment the file starts; a human debugging FoxPilot
    // needs to be told the path exists at all.
    console.error(`BrowserAPI: broker log -> ${log.file}`);
  }
}

function probeHost(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ reachable: boolean; health?: Record<string, unknown> }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: {
      reachable: boolean;
      health?: Record<string, unknown>;
    }) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    try {
      const formattedHost =
        host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      const req = http.get(
        `http://${formattedHost}:${port}/health`,
        { timeout: timeoutMs },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            if (
              res.statusCode !== undefined &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
              try {
                const parsed = JSON.parse(body);
                if (
                  parsed &&
                  typeof parsed === "object" &&
                  !Array.isArray(parsed)
                ) {
                  finish({
                    reachable: true,
                    health: parsed as Record<string, unknown>,
                  });
                  return;
                }
              } catch {
                /* non-JSON payload */
              }
              finish({ reachable: true });
            } else {
              finish({ reachable: false });
            }
          });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        finish({ reachable: false });
      });
      req.on("error", () => {
        finish({ reachable: false });
      });
    } catch {
      finish({ reachable: false });
    }
  });
}

/**
 * Checks whether the broker is reachable on the given port by querying /health
 * over 127.0.0.1, falling back to [::1]. Never throws.
 */
export async function probeBroker(
  port: number,
  timeoutMs: number = 1000
): Promise<{ reachable: boolean; health?: Record<string, unknown> }> {
  try {
    const v4 = await probeHost("127.0.0.1", port, timeoutMs);
    if (v4.reachable) {
      return v4;
    }
    const v6 = await probeHost("[::1]", port, timeoutMs);
    if (v6.reachable) {
      return v6;
    }
    return { reachable: false };
  } catch {
    return { reachable: false };
  }
}
