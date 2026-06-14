import type {
  ExtensionMessage,
  ExtensionError,
  ServerMessageRequest,
} from "@foxpilot/common";
import { getMessageSignature } from "./auth";
import { ExtensionTransport } from "./transport";
import { buildHello } from "./hello";

const RECONNECT_INTERVAL = 2000; // 2 seconds

export class WebsocketClient implements ExtensionTransport {
  private socket: WebSocket | null = null;
  private readonly port: number;
  private readonly secret: string;
  private reconnectTimer: number | null = null;
  private connectionAttempts: number = 0;
  private messageCallback: ((data: ServerMessageRequest) => void) | null = null;
  private statusCallback: ((active: boolean) => void) | null = null;

  constructor(port: number, secret: string) {
    this.port = port;
    this.secret = secret;
  }

  public connect(): void {
    console.log("Connecting to broker at port", this.port);

    // Connect to the broker daemon's extension leg. The broker owns the single
    // browser connection and fans many MCP-client sessions in/out of it.
    this.socket = new WebSocket(`ws://localhost:${this.port}/extension`);

    this.socket.addEventListener("open", async () => {
      console.log("Connected to WebSocket server at port", this.port);
      this.connectionAttempts = 0;
      // Identity first: the broker rejects any /extension socket whose first
      // frame is not a valid signed hello, so send it before anything else.
      try {
        this.socket?.send(await buildHello(this.secret));
      } catch (err) {
        console.error("Failed to send hello:", err);
      }
    });

    this.socket.addEventListener("close", () => {
      console.log("WebSocket connection closed event at port", this.port);
      this.connectionAttempts = 0;
    });

    this.socket.addEventListener("error", (event) => {
      console.error("WebSocket error:", event);
    });

    this.socket.addEventListener("message", async (event) => {
      try {
        const signedMessage = JSON.parse(event.data);
        const messageSig = await getMessageSignature(
          JSON.stringify(signedMessage.payload),
          this.secret
        );
        if (messageSig.length === 0 || messageSig !== signedMessage.signature) {
          console.error("Invalid message signature");
          // Only error back for correlated command frames; status frames carry
          // an empty correlationId and are not awaited by anyone.
          if (signedMessage.payload?.correlationId) {
            await this.sendErrorToServer(
              signedMessage.payload.correlationId,
              "Invalid message signature - extension and server not in sync"
            );
          }
          return;
        }
        // active-status is a server push, not a command — route it separately.
        if (signedMessage.payload?.cmd === "active-status") {
          this.statusCallback?.(!!signedMessage.payload.active);
          return;
        }
        if (this.messageCallback === null) {
          return;
        }
        this.messageCallback(signedMessage.payload);
      } catch (error) {
        console.error("Failed to parse message:", error);
      }
    });

    // Start reconnection timer if not already running
    if (this.reconnectTimer === null) {
      this.startReconnectTimer();
    }
  }

  public addMessageListener(
    callback: (data: ServerMessageRequest) => void
  ): void {
    this.messageCallback = callback;
  }

  public addStatusListener(callback: (active: boolean) => void): void {
    this.statusCallback = callback;
  }

  /**
   * Ask the broker to make THIS browser the active driver. Sends a signed
   * { type:"select-active", browserId } frame on the extension->broker channel
   * (symmetric to the hello); the broker verifies the signature, sets
   * activeBrowserId, and pushes the new ACTIVE/STANDBY state to every browser.
   */
  public async sendSelectActive(browserId: string): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error("Socket not open; cannot select active");
      return;
    }
    const payload = { type: "select-active", browserId };
    const signature = await getMessageSignature(
      JSON.stringify(payload),
      this.secret
    );
    this.socket.send(JSON.stringify({ payload, signature }));
  }

  private startReconnectTimer(): void {
    this.reconnectTimer = window.setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
        this.connectionAttempts++;

        if (this.connectionAttempts > 2) {
          // Avoid long retry backoff periods by resetting the connection
          this.socket.close();
        }
      }

      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
        this.connect();
      }
    }, RECONNECT_INTERVAL);
  }

  public async sendResourceToServer(resource: ExtensionMessage): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error("Socket is not open");
      return;
    }
    const signedMessage = {
      payload: resource,
      signature: await getMessageSignature(
        JSON.stringify(resource),
        this.secret
      ),
    };
    this.socket.send(JSON.stringify(signedMessage));
  }

  public async sendErrorToServer(
    correlationId: string,
    errorMessage: string
  ): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error("Socket is not open", this.socket);
      return;
    }
    const extensionError: ExtensionError = {
      correlationId,
      errorMessage: errorMessage,
    };
    this.socket.send(JSON.stringify(extensionError));
  }

  public disconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}
