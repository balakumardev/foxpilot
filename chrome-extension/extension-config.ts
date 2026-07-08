/**
 * Configuration management for FoxPilot extension
 */

import { ServerMessageRequest } from "@foxpilot/common/server-messages";
import type { ConnectionState } from "./transport";

const DEFAULT_WS_PORT = 8089;
const DEFAULT_SIDECAR_PORT = 8090;
const AUDIT_LOG_SIZE_LIMIT = 100; // Maximum number of audit log entries to keep

// Storage key for the live broker connection status. Kept separate from the
// persisted `config` object so it never pollutes saved settings — it is a
// transient runtime flag the background service worker mirrors for the options
// page.
export const BROKER_STATUS_STORAGE_KEY = "brokerStatus";

/**
 * The live broker connection status the background mirrors for the options page.
 * `state` is the honest tri-state from the transport; `connected` is kept as a
 * derived boolean so older read paths keep working. `reason` carries the broker
 * rejection reason for the "blocked" state.
 */
export interface BrokerStatus {
  connected: boolean;
  state: ConnectionState;
  reason?: string;
}

// Define all available tools with their IDs and descriptions
export interface ToolInfo {
  id: string;
  name: string;
  description: string;
}

export const AVAILABLE_TOOLS: ToolInfo[] = [
  {
    id: "open-browser-tab",
    name: "Open Browser Tab",
    description: "Allows the MCP server to open new browser tabs"
  },
  {
    id: "close-browser-tabs",
    name: "Close Browser Tabs",
    description: "Allows the MCP server to close browser tabs"
  },
  {
    id: "get-list-of-open-tabs",
    name: "Get List of Open Tabs",
    description: "Allows the MCP server to get a list of all open tabs"
  },
  {
    id: "get-recent-browser-history",
    name: "Get Recent Browser History",
    description: "Allows the MCP server to access your recent browsing history"
  },
  {
    id: "get-tab-web-content",
    name: "Get Tab Web Content",
    description: "Allows the MCP server to read the content of web pages"
  },
  {
    id: "reorder-browser-tabs",
    name: "Reorder/Group Browser Tabs",
    description: "Allows the MCP server to reorder/group your browser tabs"
  },
  {
    id: "find-highlight-in-browser-tab",
    name: "Find and Highlight in Browser Tab",
    description: "Allows the MCP server to search for and highlight text in web pages"
  },
  {
    id: "take-snapshot",
    name: "Take Page Snapshot",
    description: "Allows the MCP server to read an accessibility snapshot of a page's interactive elements"
  },
  {
    id: "navigate-tab",
    name: "Navigate Tab",
    description: "Allows the MCP server to load a URL in an existing browser tab"
  },
  {
    id: "navigate-page-history",
    name: "Navigate Page History",
    description: "Allows the MCP server to go back/forward or reload a browser tab"
  },
  {
    id: "select-tab",
    name: "Select Tab",
    description: "Allows the MCP server to focus/activate a browser tab"
  },
  {
    id: "get-active-tab",
    name: "Get Active Tab",
    description: "Allows the MCP server to read which tab is currently active"
  },
  {
    id: "wait-for-text",
    name: "Wait for Text",
    description: "Allows the MCP server to wait until text appears on a page"
  },
  {
    id: "click-element",
    name: "Click Element",
    description: "Allows the MCP server to click elements on a page by snapshot uid"
  },
  {
    id: "hover-element",
    name: "Hover Element",
    description: "Allows the MCP server to hover over elements on a page by snapshot uid"
  },
  {
    id: "fill-element",
    name: "Fill Element",
    description: "Allows the MCP server to fill inputs and form fields on a page by snapshot uid"
  },
  {
    id: "fill-form",
    name: "Fill Form",
    description: "Allows the MCP server to fill multiple form fields on a page in one step"
  },
  {
    id: "type-text",
    name: "Type Text",
    description: "Allows the MCP server to type text into the focused element on a page"
  },
  {
    id: "press-key",
    name: "Press Key",
    description: "Allows the MCP server to press keyboard keys on a page"
  },
  {
    id: "drag-element",
    name: "Drag Element",
    description: "Allows the MCP server to drag one element onto another on a page by snapshot uid"
  },
  {
    id: "resize-window",
    name: "Resize Window",
    description: "Allows the MCP server to resize the browser window hosting a tab"
  },
  {
    id: "evaluate-script",
    name: "Evaluate Script",
    description: "Allows the MCP server to run JavaScript in a page and read its result"
  },
  {
    id: "upload-file",
    name: "Upload File",
    description: "Allows the MCP server to upload a local file into a file input on a page by snapshot uid"
  },
  {
    id: "take-screenshot",
    name: "Take Screenshot",
    description: "Allows the MCP server to capture a screenshot of a page (viewport, full page, or a single element)"
  },
  {
    id: "handle-dialog",
    name: "Handle Dialog",
    description: "Allows the MCP server to auto-accept or auto-dismiss future JavaScript dialogs (alert/confirm/prompt) on a page"
  },
  {
    id: "emulate",
    name: "Emulate Device Conditions",
    description: "Allows the MCP server to emulate geolocation and the user agent for a page"
  },
  {
    id: "get-console-messages",
    name: "Get Console Messages",
    description: "Allows the MCP server to read a page's captured console output and uncaught errors"
  },
  {
    id: "get-network-requests",
    name: "Get Network Requests",
    description: "Allows the MCP server to read a page's captured network requests (URLs, methods, status, timing)"
  },
  {
    id: "get-cookies",
    name: "Get Cookies",
    description: "Allows the MCP server to read cookies (including httpOnly) from the browser's cookie jar for a site"
  },
  {
    id: "browser-fetch",
    name: "Browser Fetch",
    description: "Allows the MCP server to make HTTP requests from the browser using its cookies and host access (bypasses page CSP)"
  },
  {
    id: "stream-fetch",
    name: "Stream Fetch",
    description: "Allows the MCP server to open a streaming/SSE request from the browser and drain its frames"
  },
  {
    id: "capture-response-bodies",
    name: "Capture Response Bodies (debugger)",
    description: "Attach the Chrome debugger to a tab to capture response bodies — shows a debugging banner and is detectable by the site (breaks covert capture)."
  },
  {
    id: "click-at",
    name: "Click at Coordinates",
    description: "Allows the MCP server to click at pixel coordinates on a page (synthetic, covert)"
  },
  {
    id: "type-at",
    name: "Type at Coordinates",
    description: "Allows the MCP server to type text into the element at pixel coordinates on a page (synthetic, covert)"
  },
  {
    id: "hover-at",
    name: "Hover at Coordinates",
    description: "Allows the MCP server to hover the pointer at pixel coordinates on a page (reveals hover menus/tooltips; synthetic, covert)"
  },
  {
    id: "scroll-at",
    name: "Scroll at Coordinates",
    description: "Allows the MCP server to scroll the nearest scrollable container under pixel coordinates (fixes inner-container scroll; synthetic, covert)"
  },
  {
    id: "scroll-to",
    name: "Scroll to Position",
    description: "Allows the MCP server to scroll the page to absolute coordinates (window.scrollTo)"
  },
  {
    id: "scroll-into-view",
    name: "Scroll Element into View",
    description: "Allows the MCP server to scroll a snapshot element into view by uid"
  },
  {
    id: "select-option",
    name: "Select Option",
    description: "Allows the MCP server to select an option in a native <select> or a custom dropdown on a page by snapshot uid"
  }
];

// Map command names to tool IDs
export const COMMAND_TO_TOOL_ID: Record<ServerMessageRequest["cmd"], string> = {
  "open-tab": "open-browser-tab",
  "close-tabs": "close-browser-tabs",
  "get-tab-list": "get-list-of-open-tabs",
  "get-browser-recent-history": "get-recent-browser-history",
  "get-tab-content": "get-tab-web-content",
  "reorder-tabs": "reorder-browser-tabs",
  "find-highlight": "find-highlight-in-browser-tab",
  "group-tabs": "reorder-browser-tabs",
  "take-snapshot": "take-snapshot",
  "navigate-tab": "navigate-tab",
  "navigate-page-history": "navigate-page-history",
  "select-tab": "select-tab",
  "get-active-tab": "get-active-tab",
  "wait-for-text": "wait-for-text",
  "click-element": "click-element",
  "hover-element": "hover-element",
  "fill-element": "fill-element",
  "fill-form": "fill-form",
  "type-text": "type-text",
  "press-key": "press-key",
  "drag-element": "drag-element",
  "resize-window": "resize-window",
  "evaluate-script": "evaluate-script",
  "upload-file": "upload-file",
  "take-screenshot": "take-screenshot",
  "handle-dialog": "handle-dialog",
  "emulate": "emulate",
  "get-console-messages": "get-console-messages",
  "get-network-requests": "get-network-requests",
  "get-cookies": "get-cookies",
  "browser-fetch": "browser-fetch",
  "stream-start": "stream-fetch",
  "stream-poll": "stream-fetch",
  "stream-close": "stream-fetch",
  "capture-response-bodies": "capture-response-bodies",
  "click-at": "click-at",
  "type-at": "type-at",
  "hover-at": "hover-at",
  "scroll-at": "scroll-at",
  "scroll-to": "scroll-to",
  "scroll-into-view": "scroll-into-view",
  "select-option": "select-option",
};

// Commands that actively control a page (navigation, input, scripting, page
// inspection) and therefore require the global Automation Mode opt-in.
// Pre-populated with all planned automation command names so each tool is
// gated as soon as it is implemented. `get-active-tab` is intentionally NOT
// here: reading the active tab id is benign, like get-tab-list.
export const AUTOMATION_COMMANDS: ReadonlySet<string> = new Set<string>([
  "navigate-tab",
  "navigate-page-history",
  "select-tab",
  "wait-for-text",
  "take-snapshot",
  "click-element",
  "hover-element",
  "fill-element",
  "fill-form",
  "type-text",
  "press-key",
  "drag-element",
  "upload-file",
  "take-screenshot",
  "handle-dialog",
  "resize-window",
  "emulate",
  "evaluate-script",
  "get-console-messages",
  "get-network-requests",
  "get-cookies",
  "browser-fetch",
  "stream-start",
  "stream-poll",
  "stream-close",
  "capture-response-bodies",
  "click-at",
  "type-at",
  "hover-at",
  "scroll-at",
  "scroll-to",
  "scroll-into-view",
  "select-option",
]);

/**
 * Returns whether a command requires Automation Mode to be enabled.
 */
export function requiresAutomationMode(cmd: string): boolean {
  return AUTOMATION_COMMANDS.has(cmd);
}

/**
 * Returns whether a command should be blocked given the current Automation
 * Mode state. Pure decision used by the message handler's gate.
 */
export function shouldBlockForAutomationMode(
  cmd: string,
  automationModeEnabled: boolean
): boolean {
  return requiresAutomationMode(cmd) && !automationModeEnabled;
}

// Storage schema for tool settings
export interface ToolSettings {
  [toolId: string]: boolean;
}

// Audit log entry interface
export interface AuditLogEntry {
  toolId: string;
  command: string;
  timestamp: number;
  url?: string;
}

// Extended config interface
export interface ExtensionConfig {
  secret: string;
  toolSettings?: ToolSettings;
  domainDenyList?: string[];
  ports: number[];
  auditLog?: AuditLogEntry[];
  automationMode?: boolean;
  transport?: "websocket" | "longpoll";
  inputRealismMode?: "off" | "synthetic" | "native";
  sidecarPort?: number;
  /** Stable per-install identity for the broker registry. */
  browserId?: string;
  /** User-editable display label; defaults to the browser type. */
  browserLabel?: string;
  /**
   * True only when the user deliberately set a secret via the options page.
   * Distinguishes an intentional advanced/remote secret from one auto-generated
   * by a pre-zero-config build (which must be migrated away — see
   * migrateStaleSecret).
   */
  userSetSecret?: boolean;
}

/**
 * Gets the default tool settings (all enabled)
 */
export function getDefaultToolSettings(): ToolSettings {
  const settings: ToolSettings = {};
  AVAILABLE_TOOLS.forEach(tool => {
    settings[tool.id] = true;
  });
  return settings;
}

/**
 * Gets the extension configuration from storage
 * @returns A Promise that resolves with the extension configuration
 */
export async function getConfig(): Promise<ExtensionConfig> {
  const configObj = await browser.storage.local.get("config");
  const config: ExtensionConfig = (configObj.config as ExtensionConfig | undefined) || { secret: "", ports: [DEFAULT_WS_PORT] };
  
  // Initialize toolSettings if it doesn't exist
  if (!config.toolSettings) {
    config.toolSettings = getDefaultToolSettings();
  }

  if (!config.ports) {
    config.ports = [DEFAULT_WS_PORT];
  }
  
  return config;
}

/**
 * Saves the extension configuration to storage
 * @param config The configuration to save
 * @returns A Promise that resolves when the configuration is saved
 */
export async function saveConfig(config: ExtensionConfig): Promise<void> {
  await browser.storage.local.set({ config });
}

/**
 * Gets the secret from storage
 * @returns A Promise that resolves with the secret
 */
export async function getSecret(): Promise<string> {
  const config = await getConfig();
  return config.secret;
}

/**
 * Generates a new secret and saves it to storage
 * @returns A Promise that resolves with the new secret
 */
export async function generateSecret(): Promise<string> {
  const config = await getConfig();
  config.secret = crypto.randomUUID();
  await saveConfig(config);
  return config.secret;
}

/**
 * Returns the stable per-install browserId, generating and persisting it once
 * via crypto.randomUUID(). Distinct from the secret so the identity survives a
 * secret change.
 */
export async function getOrCreateBrowserId(): Promise<string> {
  const config = await getConfig();
  if (config.browserId && config.browserId.length > 0) {
    return config.browserId;
  }
  config.browserId = crypto.randomUUID();
  await saveConfig(config);
  return config.browserId;
}

/**
 * Detects the browser family at runtime. Firefox (and Zen, which reports as
 * Firefox) exposes runtime.getBrowserInfo; Chrome does not.
 */
export async function getBrowserType(): Promise<"chrome" | "firefox"> {
  return typeof (browser as any).runtime.getBrowserInfo === "function"
    ? "firefox"
    : "chrome";
}

/**
 * Returns the display label, defaulting to the detected browser type when the
 * user has not set one.
 */
export async function getBrowserLabel(): Promise<string> {
  const config = await getConfig();
  if (config.browserLabel && config.browserLabel.length > 0) {
    return config.browserLabel;
  }
  return await getBrowserType();
}

/**
 * Persists a user-supplied label (used by the options "Make this browser
 * active" / identity UI).
 */
export async function setBrowserLabel(label: string): Promise<void> {
  const config = await getConfig();
  config.browserLabel = label;
  await saveConfig(config);
}

/**
 * Sets the shared secret. The user pastes the SAME secret into every browser's
 * options and into the broker's EXTENSION_SECRET env so all legs sign
 * identically. Replaces silent per-install generation.
 */
export async function setSecret(secret: string): Promise<void> {
  const config = await getConfig();
  config.secret = secret;
  // Mark a non-empty secret as user-intended so the zero-config migration never
  // clears it; clearing the field clears the flag too.
  config.userSetSecret = secret.length > 0;
  await saveConfig(config);
}

/**
 * One-time zero-config migration. Pre-zero-config builds auto-generated a
 * per-install secret, putting the extension in signed mode. The origin-gated
 * broker can't match that secret, so an upgraded install loops forever on
 * "Invalid message signature - extension and server not in sync". Clear any
 * stored secret the user did not deliberately set (tracked by userSetSecret),
 * dropping the extension back to origin mode. Idempotent and safe to call on
 * every startup: a fresh install has no secret, and a deliberately-set
 * advanced/remote secret carries the flag and is preserved.
 */
export async function migrateStaleSecret(): Promise<void> {
  const config = await getConfig();
  if (
    config.secret &&
    config.secret.length > 0 &&
    config.userSetSecret !== true
  ) {
    config.secret = "";
    await saveConfig(config);
  }
}

/**
 * Checks if a tool is enabled
 * @param toolId The ID of the tool to check
 * @returns A Promise that resolves with true if the tool is enabled, false otherwise
 */
export async function isToolEnabled(toolId: string): Promise<boolean> {
  const config = await getConfig();
  // Default to true if not explicitly set to false
  return config.toolSettings?.[toolId] !== false;
}

/**
 * Checks if a command is allowed based on the tool permissions
 * @param command The command to check
 * @returns A Promise that resolves with true if the command is allowed, false otherwise
 */
export async function isCommandAllowed(command: ServerMessageRequest["cmd"]): Promise<boolean> {
  const toolId = COMMAND_TO_TOOL_ID[command];
  if (!toolId) {
    console.error(`Unknown command: ${command}`);
    return false;
  }
  return isToolEnabled(toolId);
}

/**
 * Sets the enabled status of a tool
 * @param toolId The ID of the tool to update
 * @param enabled Whether the tool should be enabled
 * @returns A Promise that resolves when the setting is saved
 */
export async function setToolEnabled(toolId: string, enabled: boolean): Promise<void> {
  const config = await getConfig();
  
  // Update the setting
  if (!config.toolSettings) {
    config.toolSettings = getDefaultToolSettings();
  }
  config.toolSettings[toolId] = enabled;
  
  // Save back to storage
  await saveConfig(config);
}

/**
 * Gets all tool settings
 * @returns A Promise that resolves with the current tool settings
 */
export async function getAllToolSettings(): Promise<ToolSettings> {
  const config = await getConfig();
  return config.toolSettings || getDefaultToolSettings();
}

/**
 * Gets the domain deny list
 * @returns A Promise that resolves with the domain deny list
 */
export async function getDomainDenyList(): Promise<string[]> {
  const config = await getConfig();
  return config.domainDenyList || [];
}

/**
 * Sets the domain deny list
 * @param domains Array of domains to deny
 * @returns A Promise that resolves when the setting is saved
 */
export async function setDomainDenyList(domains: string[]): Promise<void> {
  const config = await getConfig();
  config.domainDenyList = domains;
  await saveConfig(config);
}

/**
 * Checks if a domain is in the deny list
 * @param url The URL to check
 * @returns A Promise that resolves with true if the domain is in the deny list, false otherwise
 */
export async function isDomainInDenyList(url: string): Promise<boolean> {
  try {
    // Extract the domain from the URL
    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    
    // Get the deny list
    const denyList = await getDomainDenyList();
    
    // Check if the domain is in the deny list
    return denyList.some(deniedDomain => 
      domain.toLowerCase() === deniedDomain.toLowerCase() || 
      domain.toLowerCase().endsWith(`.${deniedDomain.toLowerCase()}`)
    );
  } catch (error) {
    console.error(`Error checking domain in deny list: ${error}`);
    // If there's an error parsing the URL, return false
    return false;
  }
}

/**
 * Gets the WebSocket ports list
 * @returns A Promise that resolves with the ports list
 */
export async function getPorts(): Promise<number[]> {
  const config = await getConfig();
  return config.ports || [DEFAULT_WS_PORT];
}

/**
 * Sets the WebSocket ports list
 * @param ports Array of port numbers
 * @returns A Promise that resolves when the setting is saved
 */
export async function setPorts(ports: number[]): Promise<void> {
  const config = await getConfig();
  config.ports = ports;
  await saveConfig(config);
}

/**
 * Gets the configured transport. Defaults to "websocket" when unset.
 * @returns A Promise that resolves with the transport preference
 */
export async function getTransport(): Promise<"websocket" | "longpoll"> {
  const config = await getConfig();
  return config.transport === "longpoll" ? "longpoll" : "websocket";
}

/**
 * Sets the transport preference (WebSocket or HTTP long-poll).
 * @param transport The transport to use
 * @returns A Promise that resolves when the setting is saved
 */
export async function setTransport(transport: "websocket" | "longpoll"): Promise<void> {
  const config = await getConfig();
  config.transport = transport;
  await saveConfig(config);
}

/**
 * Returns the input-realism mode. Defaults to "synthetic" (human-like input on,
 * synthetic in-page events). "off" reproduces the exact instant behavior;
 * "native" is wired in Phase 2 and treated as "synthetic" until then.
 */
export async function getInputRealismMode(): Promise<
  "off" | "synthetic" | "native"
> {
  const config = await getConfig();
  const mode = config.inputRealismMode;
  if (mode === "off" || mode === "native") {
    return mode;
  }
  return "synthetic";
}

/**
 * Sets the input-realism mode.
 */
export async function setInputRealismMode(
  mode: "off" | "synthetic" | "native"
): Promise<void> {
  const config = await getConfig();
  config.inputRealismMode = mode;
  await saveConfig(config);
}

/**
 * Returns the port the extension's native-input client connects to (the
 * sidecar's signed WebSocket). Defaults to 8090 when unset.
 */
export async function getSidecarPort(): Promise<number> {
  const config = await getConfig();
  return typeof config.sidecarPort === "number"
    ? config.sidecarPort
    : DEFAULT_SIDECAR_PORT;
}

/**
 * Sets the sidecar port the native-input client connects to.
 */
export async function setSidecarPort(port: number): Promise<void> {
  const config = await getConfig();
  config.sidecarPort = port;
  await saveConfig(config);
}

/**
 * Returns whether Automation Mode is enabled. Defaults to false (disabled).
 */
export async function isAutomationModeEnabled(): Promise<boolean> {
  const config = await getConfig();
  return config.automationMode === true;
}

/**
 * Enables or disables Automation Mode.
 */
export async function setAutomationModeEnabled(enabled: boolean): Promise<void> {
  const config = await getConfig();
  config.automationMode = enabled;
  await saveConfig(config);
}

/**
 * Adds an entry to the audit log
 * @param entry The audit log entry to add
 * @returns A Promise that resolves when the entry is saved
 */
export async function addAuditLogEntry(entry: AuditLogEntry): Promise<void> {
  const config = await getConfig();
  
  if (!config.auditLog) {
    config.auditLog = [];
  }
  
  // Add the new entry at the beginning
  config.auditLog.unshift(entry);
  
  // Keep only the last AUDIT_LOG_SIZE_LIMIT entries
  if (config.auditLog.length > AUDIT_LOG_SIZE_LIMIT) {
    config.auditLog = config.auditLog.slice(0, AUDIT_LOG_SIZE_LIMIT);
  }
  
  await saveConfig(config);
}

/**
 * Gets the audit log entries
 * @returns A Promise that resolves with the audit log entries
 */
export async function getAuditLog(): Promise<AuditLogEntry[]> {
  const config = await getConfig();
  return config.auditLog || [];
}

/**
 * Clears the audit log
 * @returns A Promise that resolves when the audit log is cleared
 */
export async function clearAuditLog(): Promise<void> {
  const config = await getConfig();
  config.auditLog = [];
  await saveConfig(config);
}

/**
 * Gets the tool name by tool ID
 * @param toolId The tool ID to look up
 * @returns The tool name or the tool ID if not found
 */
export function getToolNameById(toolId: string): string {
  const tool = AVAILABLE_TOOLS.find(t => t.id === toolId);
  return tool ? tool.name : toolId;
}

/**
 * Returns the full live broker connection status (tri-state + reason) the
 * background mirrored into storage. Defaults to "disconnected" when unknown.
 */
export async function getBrokerStatus(): Promise<BrokerStatus> {
  const obj = await browser.storage.local.get(BROKER_STATUS_STORAGE_KEY);
  const stored = obj[BROKER_STATUS_STORAGE_KEY] as
    | Partial<BrokerStatus>
    | undefined;
  if (!stored) {
    return { connected: false, state: "disconnected" };
  }
  // Tolerate a legacy `{ connected }`-only record by deriving the state.
  const state: ConnectionState =
    stored.state ?? (stored.connected ? "connected" : "disconnected");
  return {
    connected: state === "connected",
    state,
    reason: stored.reason,
  };
}

/**
 * Records the live broker connection status so the options page can reflect it.
 * Stored under BROKER_STATUS_STORAGE_KEY, outside the persisted `config` object.
 * `connected` is derived from the state so existing read paths keep working.
 */
export async function setBrokerStatus(
  state: ConnectionState,
  reason?: string
): Promise<void> {
  await browser.storage.local.set({
    [BROKER_STATUS_STORAGE_KEY]: {
      connected: state === "connected",
      state,
      reason,
    },
  });
}

/**
 * Returns whether the extension is currently connected to (admitted by) the
 * local broker. Defaults to false when unknown. Kept as a thin wrapper over the
 * richer status for callers that only care about the boolean.
 */
export async function getBrokerConnected(): Promise<boolean> {
  const status = await getBrokerStatus();
  return status.connected;
}

/**
 * Records connect/disconnect as a boolean. Thin wrapper over setBrokerStatus
 * for callers that have not adopted the tri-state surface.
 */
export async function setBrokerConnected(connected: boolean): Promise<void> {
  await setBrokerStatus(connected ? "connected" : "disconnected");
}
