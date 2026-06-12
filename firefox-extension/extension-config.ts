/**
 * Configuration management for FoxPilot extension
 */

import { ServerMessageRequest } from "@foxpilot/common/server-messages";

const DEFAULT_WS_PORT = 8089;
const AUDIT_LOG_SIZE_LIMIT = 100; // Maximum number of audit log entries to keep

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
  const config: ExtensionConfig = configObj.config || { secret: "" };
  
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
