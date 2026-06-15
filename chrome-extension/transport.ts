import type {
  ExtensionMessage,
  ServerMessageRequest,
} from "@foxpilot/common";

/**
 * Honest connection state reported by a transport, replacing the old boolean
 * "is the socket open?" liveness signal.
 *
 *  - "connected"    — the broker ADMITTED this browser (a `welcome` frame
 *                     arrived, or a long-poll round-trip succeeded). Only this
 *                     state means tools can actually flow.
 *  - "disconnected" — the socket closed/errored, or the long-poll failed,
 *                     WITHOUT a prior admission. Practically: the broker/server
 *                     is not running (or not reachable).
 *  - "blocked"      — the broker REJECTED this browser (`rejected` frame); the
 *                     server is running but refused admission. `detail.reason`
 *                     carries the broker's reason (e.g. "origin_not_allowed").
 *
 * A socket that opens but never receives `welcome` is NOT connected — it stays
 * disconnected until admission, so the status never lies about reachability.
 */
export type ConnectionState = "connected" | "disconnected" | "blocked";

export interface ConnectionStateDetail {
  /** Broker-supplied reason, present for the "blocked" state. */
  reason?: string;
}

export type ConnectionStateCallback = (
  state: ConnectionState,
  detail?: ConnectionStateDetail
) => void;

/** Roster entry mirrored from the broker's BrowserInfo (broker-protocol.ts). */
export interface BrokerBrowserInfo {
  browserId: string;
  label: string;
  type: "chrome" | "firefox";
  connected: boolean;
  active: boolean;
}

/**
 * Result of a Test-Connection probe. `serverReachable` is true only when the
 * broker actually answered; the broker's own snapshot is surfaced as-is so the
 * options page can report "server reachable? this browser admitted? N browsers
 * connected? active or standby?".
 */
export interface HealthcheckResult {
  serverReachable: boolean;
  extensionConnected: boolean;
  browsers: BrokerBrowserInfo[];
  activeBrowserId: string | null;
}

/**
 * Common interface for the extension's connection to the broker. Implemented
 * by both the WebSocket client (`client.ts`) and the HTTP long-poll fallback
 * (`longpoll-client.ts`), so the message handler is transport-agnostic.
 */
export interface ExtensionTransport {
  connect(): void;
  addMessageListener(callback: (data: ServerMessageRequest) => void): void;
  /** Optional: receive broker active-status pushes (ACTIVE/STANDBY). */
  addStatusListener?(callback: (active: boolean) => void): void;
  /** Optional: ask the broker to make THIS browser the active driver. */
  sendSelectActive?(browserId: string): Promise<void>;
  /**
   * Optional: probe the broker and resolve with its roster snapshot. Resolves
   * (never rejects) with `serverReachable:false` when the broker is not running
   * or does not answer in time.
   */
  healthcheck?(): Promise<HealthcheckResult>;
  /**
   * Optional: the most recent browser roster the broker reported (from the last
   * `welcome`), plus this browser's id. Lets the options page list the other
   * connected browsers without a round-trip. null until the first welcome.
   */
  getLastRoster?(): { browsers: BrokerBrowserInfo[]; browserId: string } | null;
  sendResourceToServer(resource: ExtensionMessage): Promise<void>;
  sendErrorToServer(correlationId: string, errorMessage: string): Promise<void>;
  disconnect(): void;
  // Keepalive surface (consumed by `keepalive.ts` on each MV3 alarm wake). Both
  // transports must implement these so the SW keepalive is type-safe and future
  // transports are compiler-checked rather than cast around.
  isClosed(): boolean;
  ping(): void;
}
