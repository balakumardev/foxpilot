import { WebsocketClient } from "./client";
import { LongPollClient } from "./longpoll-client";
import { ExtensionTransport } from "./transport";
import { MessageHandler } from "./message-handler";
import { getConfig, generateSecret, getTransport } from "./extension-config";
import { initConsoleCapture } from "./console-capture";
import { initNetworkCapture } from "./network-capture";
import { initEmulate } from "./emulate";

// The transport the "Make this browser active" button forwards its request
// through. Points at the most recently initialized client (in the common
// single-port deployment there is exactly one).
let activeClientRef: ExtensionTransport | null = null;

function initClient(port: number, secret: string, transport: "websocket" | "longpoll") {
  const client: ExtensionTransport =
    transport === "longpoll"
      ? new LongPollClient(port, secret)
      : new WebsocketClient(port, secret);
  const messageHandler = new MessageHandler(client);

  client.connect();

  // Reflect the broker's ACTIVE/STANDBY push on the toolbar badge and relay it
  // to any open options page so its badge stays live.
  if (client.addStatusListener) {
    client.addStatusListener((active) => {
      try {
        browser.browserAction?.setBadgeText({ text: active ? "ON" : "" });
        browser.browserAction?.setBadgeBackgroundColor?.({ color: "#4caf50" });
      } catch {
        /* browserAction may be unavailable in some contexts */
      }
      // Relay to any open options page (best-effort; ignore "no receiver").
      browser.runtime.sendMessage({ type: "active-status", active }).catch(() => {});
    });
  }
  activeClientRef = client;

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

// Forward the options page's "Make this browser active" request to the broker
// via the live client (it sends the signed select-active frame).
browser.runtime.onMessage.addListener((msg: any) => {
  if (
    msg?.type === "select-this-browser" &&
    activeClientRef &&
    activeClientRef.sendSelectActive
  ) {
    activeClientRef.sendSelectActive(msg.browserId).catch((e) =>
      console.error("select-this-browser failed:", e)
    );
  }
});

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
    // Start background console capture once (browser-wide, not per-port). It
    // registers its runtime/tabs/storage listeners and, if Automation Mode is
    // on, the document_start page-console capture script.
    initConsoleCapture();
    // Start background network capture once (browser-wide). It registers its
    // tabs/storage listeners and, if Automation Mode is on, the webRequest
    // listeners that feed the per-tab network ring buffer.
    initNetworkCapture();
    // Start background UA emulation once (browser-wide). It registers its
    // tabs/storage listeners and, if Automation Mode is on, the blocking
    // onBeforeSendHeaders listener that rewrites the User-Agent header for tabs
    // with an active override (set by the `emulate` tool).
    initEmulate();

    const transport = await getTransport();
    for (const port of portList) {
      initClient(port, secret, transport);
    }
    console.log("Browser extension initialized");
  })
  .catch((error) => {
    console.error("Error initializing extension:", error);
  });
