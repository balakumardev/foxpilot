/**
 * Resolves the secret used to authenticate the broker's CONTROL leg
 * (MCP server <-> broker). The extension leg no longer uses a user-facing
 * secret (it is origin-gated), so this value is internal and auto-managed:
 *
 *   1. If EXTENSION_SECRET is set in the environment, use it verbatim. This
 *      preserves manual/containerized setups and keeps every process that
 *      inherits the env in agreement.
 *   2. Otherwise read (or create) a persistent secret at
 *      ~/.foxpilot/control-secret (0600), so every local MCP-server process and
 *      the broker they spawn converge on the same value with no user action.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * The FoxPilot state directory. Everything this project persists outside the
 * repo lives here — the control secret below, and the broker's log file — so
 * the path and its 0700 bits are defined once instead of re-derived per caller.
 */
export function foxpilotDir(): string {
  return path.join(os.homedir(), ".foxpilot");
}

/**
 * Creates the state directory if absent and returns it. Deliberately throws on
 * failure (read-only or sandboxed HOME) so each caller can pick its own
 * degraded mode rather than inheriting one: getControlSecret falls back to an
 * in-memory secret, the broker log falls back to a discarded fd.
 */
export function ensureFoxpilotDir(dir: string = foxpilotDir()): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function getControlSecret(opts: { dir?: string } = {}): string {
  const envSecret = process.env.EXTENSION_SECRET;
  // Ignore an unexpanded manifest placeholder (e.g. a host that didn't
  // substitute "${user_config.extension_secret}"): it would otherwise be used
  // verbatim as the control secret, which is confusing to diagnose.
  if (envSecret && envSecret.length > 0 && !envSecret.includes("${")) {
    return envSecret;
  }
  const dir = opts.dir ?? foxpilotDir();
  const file = path.join(dir, "control-secret");

  const readExisting = (): string | null => {
    try {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (existing.length > 0) {
        // Harden perms on a file that may have been created with looser bits.
        try {
          fs.chmodSync(file, 0o600);
        } catch {
          /* best effort */
        }
        return existing;
      }
    } catch {
      /* not created yet */
    }
    return null;
  };

  const existing = readExisting();
  if (existing) {
    return existing;
  }

  const secret = crypto.randomUUID();
  try {
    ensureFoxpilotDir(dir);
    try {
      // Atomic create: the "wx" flag fails if another process won the race.
      fs.writeFileSync(file, secret, { mode: 0o600, flag: "wx" });
      return secret;
    } catch {
      // Lost the create race (EEXIST) or a transient error — prefer the
      // already-persisted value so concurrent cold starts converge.
      const raced = readExisting();
      if (raced) {
        return raced;
      }
      fs.writeFileSync(file, secret, { mode: 0o600 });
      return secret;
    }
  } catch {
    // Read-only / sandboxed HOME: the secret can't be persisted. Fall back to an
    // in-memory value rather than aborting init — the MCP server passes this same
    // secret to the broker it spawns via EXTENSION_SECRET, so the control leg
    // still agrees within this process tree (it just won't survive a restart).
    return secret;
  }
}
