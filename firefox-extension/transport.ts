import type {
  ExtensionMessage,
  ServerMessageRequest,
} from "@browser-control-mcp/common";

/**
 * Common interface for the extension's connection to the broker. Implemented
 * by both the WebSocket client (`client.ts`) and the HTTP long-poll fallback
 * (`longpoll-client.ts`), so the message handler is transport-agnostic.
 */
export interface ExtensionTransport {
  connect(): void;
  addMessageListener(callback: (data: ServerMessageRequest) => void): void;
  sendResourceToServer(resource: ExtensionMessage): Promise<void>;
  sendErrorToServer(correlationId: string, errorMessage: string): Promise<void>;
  disconnect(): void;
}
