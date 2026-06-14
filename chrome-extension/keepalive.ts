/**
 * Service-worker keepalive for Chrome MV3.
 *
 * An MV3 service worker idles out (~30s) and an incoming WebSocket frame cannot
 * wake a dead worker, so broker -> extension commands are silently dropped until
 * an unrelated event respawns it. We register a sub-minute chrome.alarms alarm;
 * alarms wake the worker, and on each wake we reconnect any closed transport and
 * ping the open ones so the broker observes liveness. Chrome's alarm floor is
 * ~30s, so a small gap during total idle is still possible (documented
 * trade-off); this is the pragmatic primary plan: alarms + reconnect-on-wake +
 * ping.
 */

export const KEEPALIVE_ALARM_NAME = "bcmcp-keepalive";
// ~25s. Chrome clamps sub-minute periods to ~30s in practice; we ask for 0.4min
// so the worker is nudged as often as the platform allows.
const KEEPALIVE_PERIOD_MINUTES = 0.4;

/**
 * Minimal transport surface the keepalive needs. Both WebsocketClient and the
 * long-poll client satisfy `isClosed`/`connect`/`ping`.
 */
export interface KeepaliveClient {
  isClosed(): boolean;
  connect(): void;
  ping(): void;
}

/**
 * Pure reconnect-check: reconnect a closed client, otherwise ping it. Exported
 * so the decision is unit-testable without a real socket or alarm.
 */
export function ensureConnected(client: KeepaliveClient): void {
  if (client.isClosed()) {
    client.connect();
  } else {
    client.ping();
  }
}

/**
 * Registers the keepalive alarm and its handler. `getClients` returns the live
 * set of transports to keep alive (read fresh each tick so SW respawns that
 * rebuild the client list are reflected).
 */
export function initKeepalive(getClients: () => KeepaliveClient[]): void {
  browser.alarms.create(KEEPALIVE_ALARM_NAME, {
    periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
  });
  browser.alarms.onAlarm.addListener((alarm: { name?: string }) => {
    if (!alarm || alarm.name !== KEEPALIVE_ALARM_NAME) {
      return;
    }
    for (const client of getClients()) {
      ensureConnected(client);
    }
  });
}
