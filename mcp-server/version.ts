/**
 * The version of this FoxPilot build, from mcp-server/package.json.
 *
 * Read with require rather than an import so the CommonJS build needs no
 * resolveJsonModule; esbuild inlines the JSON into dist/*.js, which is all the
 * npm tarball ships. The release workflow bumps package.json before it builds,
 * so this always matches the published version.
 *
 * Broker and remote link report it so a mismatched pair (an old broker still
 * running after an upgrade, or a remote session on another release) can be
 * named instead of guessed at.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg: { version?: unknown } = require("./package.json");

export const FOXPILOT_VERSION: string =
  typeof pkg.version === "string" ? pkg.version : "0.0.0";
