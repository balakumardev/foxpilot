import type {
  ExtensionMessage,
  ServerMessageRequest,
} from "@foxpilot/common";

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
  sendResourceToServer(resource: ExtensionMessage): Promise<void>;
  sendErrorToServer(correlationId: string, errorMessage: string): Promise<void>;
  disconnect(): void;
  // Keepalive surface (consumed by `keepalive.ts` on each MV3 alarm wake). Both
  // transports must implement these so the SW keepalive is type-safe and future
  // transports are compiler-checked rather than cast around.
  isClosed(): boolean;
  ping(): void;
}
