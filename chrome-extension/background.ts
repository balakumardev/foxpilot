import "./globals";
import { WebsocketClient } from "./client";
import { LongPollClient } from "./longpoll-client";
import { ExtensionTransport } from "./transport";
import { MessageHandler } from "./message-handler";
import {
  getConfig,
  generateSecret,
  getTransport,
  setBrokerConnected,
} from "./extension-config";
import { initConsoleCapture } from "./console-capture";
import { initNetworkCapture } from "./network-capture";
import { initEmulate } from "./emulate";
import { initKeepalive } from "./keepalive";

// Per-port client registry so a service-worker respawn that re-runs the
// bootstrap does not create duplicate clients for the same port.
const clientsByPort = new Map<number, ExtensionTransport>();

// The transport the "Make this browser active" button forwards its request
// through. Points at the most recently initialized client (in the common
// single-port deployment there is exactly one).
let activeClientRef: ExtensionTransport | null = null;

// Most-recent ACTIVE/STANDBY value the broker pushed to any client's status
// listener. Cached so a freshly-opened options page can fetch the real current
// state on load (via `get-active-status`) instead of waiting for the next push.
let lastActiveStatus: boolean = false;

// Tracks which broker ports currently have a live connection so the options
// page can show real status. We mirror the aggregate (any port connected) into
// storage, de-duping writes so a chatty long-poll loop doesn't thrash storage.
const connectedPorts = new Set<number>();
let lastBrokerConnected: boolean | null = null;

function updateBrokerConnected(port: number, connected: boolean): void {
  if (connected) {
    connectedPorts.add(port);
  } else {
    connectedPorts.delete(port);
  }
  const anyConnected = connectedPorts.size > 0;
  if (anyConnected !== lastBrokerConnected) {
    lastBrokerConnected = anyConnected;
    void setBrokerConnected(anyConnected);
  }
}

function initClient(
  port: number,
  secret: string,
  transport: "websocket" | "longpoll"
): ExtensionTransport {
  const existing = clientsByPort.get(port);
  if (existing) {
    return existing;
  }
  const onStatusChange = (connected: boolean) =>
    updateBrokerConnected(port, connected);
  const client: ExtensionTransport =
    transport === "longpoll"
      ? new LongPollClient(port, secret, onStatusChange)
      : new WebsocketClient(port, secret, onStatusChange);
  const messageHandler = new MessageHandler(client);

  client.connect();

  // Reflect the broker's ACTIVE/STANDBY push on the toolbar badge and relay it
  // to any open options page so its badge stays live.
  if (client.addStatusListener) {
    client.addStatusListener((active) => {
      // Cache the latest state so the options page can read it on open.
      lastActiveStatus = active;
      try {
        (chrome as any).action?.setBadgeText({ text: active ? "ON" : "" });
        (chrome as any).action?.setBadgeBackgroundColor?.({ color: "#4caf50" });
      } catch {
        /* action API may be unavailable in some contexts */
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

  clientsByPort.set(port, client);
  return client;
}

// Forward the options page's "Make this browser active" request to the broker
// via the live client (it sends the signed select-active frame). Also answers
// the options page's `get-active-status` probe with the cached ACTIVE/STANDBY
// value so its badge is correct immediately on open.
// `chrome.runtime.onMessage` (typed in browser-global.d.ts to accept
// `boolean | void`) is used here rather than the polyfill's stricter
// `browser.runtime.onMessage`, so the handler can both fall through (void) for
// `select-this-browser` and `return true` for the `get-active-status` reply.
chrome.runtime.onMessage.addListener(
  (msg: any, _sender: any, sendResponse: (response?: any) => void) => {
    if (
      msg?.type === "select-this-browser" &&
      activeClientRef &&
      activeClientRef.sendSelectActive
    ) {
      activeClientRef.sendSelectActive(msg.browserId).catch((e) =>
        console.error("select-this-browser failed:", e)
      );
      return;
    }
    if (msg?.type === "get-active-status") {
      sendResponse({ active: lastActiveStatus });
      return true; // keep the channel open for the (synchronous) reply
    }
  }
);

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
    // Start from a known-disconnected state; clients flip this as they connect.
    await setBrokerConnected(false);
    lastBrokerConnected = false;
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
