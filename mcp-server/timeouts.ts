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
  // Privileged background fetch has a ~60s ceiling upstream; keep the broker
  // budget just under the 60000ms client cap so a slow response still returns.
  "browser-fetch": 45000,
  // stream-start resolves when response HEADERS arrive, not on body completion.
  "stream-start": 30000,
  // stream-poll returns promptly after draining buffered frames.
  "stream-poll": 20000,
  // select-option polls a custom dropdown's menu (≤ 15 × 300ms) before it can
  // click the option — give it more than the 5s default.
  "select-option": 15000,
  // Input actions run a covert human-like layer in the page (curved cursor
  // motion + per-character typing with jitter), so a single click/type/press
  // legitimately takes several seconds — well past the 5s default, which caused
  // spurious "Timed out waiting for response from the browser extension".
  // These wire cmd strings are the ServerMessage `cmd` values the broker sees
  // (see common/server-messages.ts), not the tool display names.
  "click-element": 15000,
  "fill-element": 15000,
  "press-key": 15000,
  "type-text": 15000,
  "drag-element": 15000,
  "hover-element": 15000,
  // Coordinate variants of the same input actions (synthetic + CDP engines).
  "click-at": 15000,
  "type-at": 15000,
  "hover-at": 15000,
  "scroll-at": 15000,
  // fill-form drives MANY fields sequentially, each with the per-char humanized
  // typing above — its budget scales with field count, so give it extra headroom.
  "fill-form": 30000,
};

/**
 * Returns the response timeout (ms) for a command, falling back to the default
 * when the command has no explicit override.
 */
export function getCommandTimeout(cmd: string): number {
  return COMMAND_TIMEOUTS[cmd] ?? DEFAULT_RESPONSE_TIMEOUT_MS;
}
