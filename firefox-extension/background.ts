import { WebsocketClient } from "./client";
import { LongPollClient } from "./longpoll-client";
import {
  ExtensionTransport,
  ConnectionState,
  ConnectionStateDetail,
} from "./transport";
import { MessageHandler } from "./message-handler";
import {
  getConfig,
  getTransport,
  setBrokerStatus,
} from "./extension-config";
import { initConsoleCapture } from "./console-capture";
import { initNetworkCapture } from "./network-capture";
import { initEmulate } from "./emulate";

// The transport the "Make this browser active" button forwards its request
// through. Points at the most recently initialized client (in the common
// single-port deployment there is exactly one).
let activeClientRef: ExtensionTransport | null = null;

// Most-recent ACTIVE/STANDBY value the broker pushed to any client's status
// listener. Cached so a freshly-opened options page can fetch the real current
// state on load (via `get-active-status`) instead of waiting for the next push.
let lastActiveStatus: boolean = false;

// Per-port honest connection state so the options page can show real status. We
// mirror the AGGREGATE across ports into storage, de-duping writes so a chatty
// long-poll loop doesn't thrash storage. Aggregation priority: any port
// "connected" wins (tools can flow); else any "blocked" (server up, refused)
// carrying its reason; else "disconnected" (server not running / unreachable).
const portStates = new Map<number, { state: ConnectionState; reason?: string }>();
let lastMirrored: { state: ConnectionState; reason?: string } | null = null;

function aggregateBrokerStatus(): { state: ConnectionState; reason?: string } {
  let blocked: { state: ConnectionState; reason?: string } | null = null;
  for (const entry of portStates.values()) {
    if (entry.state === "connected") {
      return { state: "connected" };
    }
    if (entry.state === "blocked" && !blocked) {
      blocked = { state: "blocked", reason: entry.reason };
    }
  }
  return blocked ?? { state: "disconnected" };
}

function updateBrokerState(
  port: number,
  state: ConnectionState,
  detail?: ConnectionStateDetail
): void {
  portStates.set(port, { state, reason: detail?.reason });
  const agg = aggregateBrokerStatus();
  if (
    !lastMirrored ||
    agg.state !== lastMirrored.state ||
    agg.reason !== lastMirrored.reason
  ) {
    lastMirrored = agg;
    void setBrokerStatus(agg.state, agg.reason);
  }
}

function initClient(port: number, secret: string, transport: "websocket" | "longpoll") {
  const onConnectionState = (
    state: ConnectionState,
    detail?: ConnectionStateDetail
  ) => updateBrokerState(port, state, detail);
  const client: ExtensionTransport =
    transport === "longpoll"
      ? new LongPollClient(port, secret, onConnectionState)
      : new WebsocketClient(port, secret, onConnectionState);
  const messageHandler = new MessageHandler(client);

  client.connect();

  // Reflect the broker's ACTIVE/STANDBY push on the toolbar badge and relay it
  // to any open options page so its badge stays live.
  if (client.addStatusListener) {
    client.addStatusListener((active) => {
      // Cache the latest state so the options page can read it on open.
      lastActiveStatus = active;
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
// via the live client (it sends the select-active frame). Also answers the
// options page's `get-active-status` probe with the cached ACTIVE/STANDBY value
// so its badge is correct immediately on open, and runs the broker
// healthcheck() for the options "Test Connection" button.
browser.runtime.onMessage.addListener(
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
      // Include the connected-browser roster (from the last welcome) so the
      // options page can list the other browsers and explain STANDBY. Both the
      // cached status and getLastRoster() are synchronous, so we reply inline and
      // do NOT return true (only the truly-async healthcheck branch needs that).
      const roster = activeClientRef?.getLastRoster?.() ?? null;
      sendResponse({
        active: lastActiveStatus,
        browsers: roster?.browsers ?? [],
        browserId: roster?.browserId,
      });
      return;
    }
    if (msg?.type === "healthcheck") {
      // Probe the broker over the live client and relay its snapshot to the
      // options page. Resolves (never rejects) with serverReachable:false when
      // the broker is not running, so the options page always gets a result.
      const client = activeClientRef;
      if (client && client.healthcheck) {
        client
          .healthcheck()
          .then((result) => sendResponse(result))
          .catch(() =>
            sendResponse({
              serverReachable: false,
              extensionConnected: false,
              browsers: [],
              activeBrowserId: null,
            })
          );
      } else {
        sendResponse({
          serverReachable: false,
          extensionConnected: false,
          browsers: [],
          activeBrowserId: null,
        });
      }
      return true; // async reply
    }
  }
);

async function initExtension() {
  // Zero-config: a fresh install connects with NO secret (origin mode) — the
  // broker admits this browser by its moz-extension:// Origin over loopback.
  // We do NOT auto-generate a secret or force-open the options page anymore. A
  // user who wants the legacy signed/remote setup can set a custom secret in the
  // options page's Advanced section.
  return getConfig();
}

initExtension()
  .then(async (config) => {
    // Empty secret => origin mode (default). A non-empty secret => legacy signed
    // mode. Both are valid, so do not abort on an empty secret.
    const secret = config.secret;

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
    // Start from a known-disconnected state; clients flip this as they connect.
    await setBrokerStatus("disconnected");
    lastMirrored = { state: "disconnected" };
    for (const port of portList) {
      initClient(port, secret, transport);
    }
    console.log("Browser extension initialized");
  })
  .catch((error) => {
    console.error("Error initializing extension:", error);
  });
