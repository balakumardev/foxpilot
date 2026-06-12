import { WebsocketClient } from "./client";
import { LongPollClient } from "./longpoll-client";
import { ExtensionTransport } from "./transport";
import { MessageHandler } from "./message-handler";
import { getConfig, generateSecret, getTransport } from "./extension-config";
import { initConsoleCapture } from "./console-capture";
import { initNetworkCapture } from "./network-capture";

function initClient(port: number, secret: string, transport: "websocket" | "longpoll") {
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
}

async function initExtension() {
  let config = await getConfig();
  if (!config.secret) {
    console.log("No secret found, generating new one");
    await generateSecret();
    // Open the options page to allow the user to view the config:
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
    // Start background console capture once (browser-wide, not per-port). It
    // registers its runtime/tabs/storage listeners and, if Automation Mode is
    // on, the document_start page-console capture script.
    initConsoleCapture();
    // Start background network capture once (browser-wide). It registers its
    // tabs/storage listeners and, if Automation Mode is on, the webRequest
    // listeners that feed the per-tab network ring buffer.
    initNetworkCapture();

    const transport = await getTransport();
    for (const port of portList) {
      initClient(port, secret, transport);
    }
    console.log("Browser extension initialized");
  })
  .catch((error) => {
    console.error("Error initializing extension:", error);
  });
