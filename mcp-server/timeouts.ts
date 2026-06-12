/**
 * Per-command response timeouts (ms) used by the broker's correlation layer.
 *
 * Replaces the old hard-coded 1000ms. Instant operations use the default;
 * content scraping, navigation, waits, snapshots and screenshots get longer
 * budgets because they legitimately take seconds.
 */

const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

const COMMAND_TIMEOUTS: Record<string, number> = {
  "get-tab-content": 30000,
  "navigate-tab": 30000,
  "navigate-page-history": 30000,
  "wait-for-text": 35000,
  "take-snapshot": 30000,
  "take-screenshot": 45000,
  "evaluate-script": 30000,
  "upload-file": 30000,
};

/**
 * Returns the response timeout (ms) for a command, falling back to the default
 * when the command has no explicit override.
 */
export function getCommandTimeout(cmd: string): number {
  return COMMAND_TIMEOUTS[cmd] ?? DEFAULT_RESPONSE_TIMEOUT_MS;
}
