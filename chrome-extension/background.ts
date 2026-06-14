import "./globals";
import { WebsocketClient } from "./client";
import { LongPollClient } from "./longpoll-client";
import { ExtensionTransport } from "./transport";
import { MessageHandler } from "./message-handler";
import { getConfig, generateSecret, getTransport } from "./extension-config";
import { initConsoleCapture } from "./console-capture";
import { initNetworkCapture } from "./network-capture";
import { initEmulate } from "./emulate";
import { initKeepalive } from "./keepalive";

// Per-port client registry so a service-worker respawn that re-runs the
// bootstrap does not create duplicate clients for the same port.
const clientsByPort = new Map<number, ExtensionTransport>();

function initClient(
  port: number,
  secret: string,
  transport: "websocket" | "longpoll"
): ExtensionTransport {
  const existing = clientsByPort.get(port);
  if (existing) {
    return existing;
  }
  const client: ExtensionTransport =
    transport === "longpoll"
      ? new LongPollClient(port, secret)
      : new WebsocketClient(port, secret);
  const messageHandler = new MessageHandler(client);

  client.connect();

  client.addMessageListener(async (message) => {
    console.log("Message from server:", message);

    try {
      await messageHandler.handleDecodedMessage(message);
    } catch (error) {
      console.error("Error handling message:", error);
      if (error instanceof Error) {
        await client.sendErrorToServer(message.correlationId, error.message);
      }
    }
  });

  clientsByPort.set(port, client);
  return client;
}

async function initExtension() {
  let config = await getConfig();
  if (!config.secret) {
    // First run: generate a default secret so there is something to copy.
    // The user is expected to REPLACE this with the SAME secret used by the
    // broker (EXTENSION_SECRET) and every other browser, via the options
    // page (editable secret input). Open options so they can do that now.
    console.log("No secret found, generating a default one");
    await generateSecret();
    await browser.runtime.openOptionsPage();
    config = await getConfig();
  }
  return config;
}

initExtension()
  .then(async (config) => {
    const secret = config.secret;

    if (!secret) {
      console.error("Secret not found in storage - reinstall extension");
      return;
    }
    const portList = config.ports;
    if (portList.length === 0) {
      console.error("No ports configured in extension config");
      return;
    }
    // Start background console capture once (browser-wide, not per-port).
    initConsoleCapture();
    // Start background network capture once (browser-wide).
    initNetworkCapture();
    // Start background UA emulation once (browser-wide).
    initEmulate();

    const transport = await getTransport();
    for (const port of portList) {
      initClient(port, secret, transport);
    }

    // Keep the service worker's transports alive across MV3 idle timeouts. The
    // client list is read fresh each tick from the per-port registry.
    // `ExtensionTransport` structurally satisfies `KeepaliveClient`, so the
    // compiler enforces every transport implements `isClosed`/`connect`/`ping`.
    initKeepalive(() => Array.from(clientsByPort.values()));

    console.log("Browser extension initialized");
  })
  .catch((error) => {
    console.error("Error initializing extension:", error);
  });
