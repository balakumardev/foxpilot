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

export function getControlSecret(opts: { dir?: string } = {}): string {
  const envSecret = process.env.EXTENSION_SECRET;
  if (envSecret && envSecret.length > 0) {
    return envSecret;
  }
  const dir = opts.dir ?? path.join(os.homedir(), ".foxpilot");
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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
}
