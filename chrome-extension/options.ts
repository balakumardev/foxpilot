/**
 * Options page script for FoxPilot extension
 */
import {
  getSecret,
  setSecret,
  AVAILABLE_TOOLS,
  getAllToolSettings,
  setToolEnabled,
  getDomainDenyList,
  setDomainDenyList,
  getPorts,
  setPorts,
  getAuditLog,
  clearAuditLog,
  getToolNameById,
  isAutomationModeEnabled,
  setAutomationModeEnabled,
  getTransport,
  setTransport,
  getInputRealismMode,
  setInputRealismMode,
  getSidecarPort,
} from "./extension-config";
import { NativeInputClient } from "./native-input-client";

const secretDisplay = document.getElementById(
  "secret-display"
) as HTMLDivElement;
const copyButton = document.getElementById("copy-button") as HTMLButtonElement;
const secretInput = document.getElementById(
  "secret-input"
) as HTMLInputElement;
const saveSecretButton = document.getElementById(
  "save-secret"
) as HTMLButtonElement;
const statusElement = document.getElementById("status") as HTMLDivElement;
const toolSettingsContainer = document.getElementById(
  "tool-settings-container"
) as HTMLDivElement;
const domainDenyListTextarea = document.getElementById(
  "domain-deny-list"
) as HTMLTextAreaElement;
const saveDomainListsButton = document.getElementById(
  "save-domain-lists"
) as HTMLButtonElement;
const domainStatusElement = document.getElementById(
  "domain-status"
) as HTMLDivElement;
const portsInput = document.getElementById("ports-input") as HTMLInputElement;
const savePortsButton = document.getElementById("save-ports") as HTMLButtonElement;
const portsStatusElement = document.getElementById("ports-status") as HTMLDivElement;
const auditLogContainer = document.getElementById("audit-log-container") as HTMLDivElement;
const clearAuditLogButton = document.getElementById("clear-audit-log") as HTMLButtonElement;
const auditLogStatusElement = document.getElementById("audit-log-status") as HTMLDivElement;
const automationModeToggle = document.getElementById(
  "automation-mode-toggle"
) as HTMLInputElement;
const automationModeStatus = document.getElementById(
  "automation-mode-status"
) as HTMLDivElement;
const transportSelect = document.getElementById(
  "transport-select"
) as HTMLSelectElement;
const transportStatus = document.getElementById(
  "transport-status"
) as HTMLDivElement;
const inputRealismSelect = document.getElementById(
  "input-realism-select"
) as HTMLSelectElement;
const inputRealismStatus = document.getElementById(
  "input-realism-status"
) as HTMLDivElement;

/**
 * Loads the secret from storage and displays it
 */
async function loadSecret() {
  try {
    const secret = await getSecret();

    // Check if secret exists
    if (secret) {
      secretDisplay.textContent = secret;
      secretInput.value = secret;
    } else {
      secretDisplay.textContent =
        "No secret found. Set a shared secret below (the same one the broker uses).";
      secretDisplay.style.color = "red";
      copyButton.disabled = true;
    }
  } catch (error) {
    console.error("Error loading secret:", error);
    secretDisplay.textContent =
      "Error loading secret. Please check console for details.";
    secretDisplay.style.color = "red";
    copyButton.disabled = true;
  }
}

/**
 * Persists the user-supplied shared secret. The user pastes the SAME secret
 * configured in the broker's EXTENSION_SECRET and in every other browser, so
 * all legs sign identically. The extension reconnects with the new secret on
 * its next bootstrap (a reload is the simplest way to pick it up everywhere).
 */
async function saveSecret() {
  try {
    const value = secretInput.value.trim();
    if (!value) {
      statusElement.textContent = "Secret cannot be empty";
      statusElement.style.color = "red";
      setTimeout(() => {
        statusElement.textContent = "";
        statusElement.style.color = "";
      }, 3000);
      return;
    }
    await setSecret(value);
    secretDisplay.textContent = value;
    secretDisplay.style.color = "";
    copyButton.disabled = false;
    statusElement.textContent = "Secret saved. Reload the extension to apply.";
    statusElement.style.color = "#4caf50";
    setTimeout(() => {
      statusElement.textContent = "";
      statusElement.style.color = "";
    }, 3000);
  } catch (error) {
    console.error("Error saving secret:", error);
    statusElement.textContent = "Failed to save secret";
    statusElement.style.color = "red";
    setTimeout(() => {
      statusElement.textContent = "";
      statusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Copies the secret to clipboard
 */
async function copyToClipboard(event: MouseEvent) {
  if (!event.isTrusted) {
    return;
  }
  try {
    const secret = secretDisplay.textContent;
    if (
      !secret ||
      secret === "Loading..." ||
      secret.includes("No secret found") ||
      secret.includes("Error loading")
    ) {
      return;
    }

    await navigator.clipboard.writeText(secret);

    // Show success message
    statusElement.textContent = "Secret copied to clipboard!";
    setTimeout(() => {
      statusElement.textContent = "";
    }, 3000);
  } catch (error) {
    console.error("Error copying to clipboard:", error);
    statusElement.textContent = "Failed to copy to clipboard";
    statusElement.style.color = "red";
    setTimeout(() => {
      statusElement.textContent = "";
      statusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Creates the tool settings UI
 */
async function createToolSettingsUI() {
  const toolSettings = await getAllToolSettings();

  // Clear existing content
  toolSettingsContainer.innerHTML = "";

  // Create a toggle switch for each tool
  AVAILABLE_TOOLS.forEach((tool) => {
    const isEnabled = toolSettings[tool.id] !== false; // Default to true if not set

    const toolRow = document.createElement("div");
    toolRow.className = "tool-row";

    const labelContainer = document.createElement("div");
    labelContainer.className = "tool-label-container";

    const toolName = document.createElement("div");
    toolName.className = "tool-name";
    toolName.textContent = tool.name;

    const toolDescription = document.createElement("div");
    toolDescription.className = "tool-description";
    toolDescription.textContent = tool.description;

    labelContainer.appendChild(toolName);
    labelContainer.appendChild(toolDescription);

    const toggleContainer = document.createElement("label");
    toggleContainer.className = "toggle-switch";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isEnabled;
    checkbox.dataset.toolId = tool.id;
    checkbox.addEventListener("change", handleToolToggle);

    const slider = document.createElement("span");
    slider.className = "slider";

    toggleContainer.appendChild(checkbox);
    toggleContainer.appendChild(slider);

    toolRow.appendChild(labelContainer);
    toolRow.appendChild(toggleContainer);

    toolSettingsContainer.appendChild(toolRow);
  });
}

/**
 * Handles toggling a tool on/off
 */
async function handleToolToggle(event: Event) {
  const checkbox = event.target as HTMLInputElement;
  const toolId = checkbox.dataset.toolId;
  const isEnabled = checkbox.checked;

  if (!toolId) {
    console.error("Tool ID not found");
    return;
  }

  try {
    await setToolEnabled(toolId, isEnabled);
    // No status message displayed
  } catch (error) {
    console.error("Error saving tool setting:", error);

    // Revert the checkbox state
    checkbox.checked = !isEnabled;
  }
}

/**
 * Loads the current Automation Mode state into the toggle.
 */
async function loadAutomationMode() {
  try {
    automationModeToggle.checked = await isAutomationModeEnabled();
  } catch (error) {
    console.error("Error loading automation mode:", error);
  }
}

/**
 * Handles enabling/disabling Automation Mode. Enabling requests the broad
 * host permission; if the user denies it, the toggle reverts.
 */
async function handleAutomationModeToggle(event: Event) {
  if (!event.isTrusted) {
    return;
  }
  const enabled = automationModeToggle.checked;
  try {
    if (enabled) {
      const granted = await browser.permissions.request({
        origins: ["<all_urls>"],
      });
      if (!granted) {
        automationModeToggle.checked = false;
        automationModeStatus.textContent =
          "Permission denied — Automation Mode not enabled.";
        automationModeStatus.style.color = "red";
        setTimeout(() => {
          automationModeStatus.textContent = "";
          automationModeStatus.style.color = "";
        }, 4000);
        return;
      }
      await setAutomationModeEnabled(true);
      automationModeStatus.textContent = "Automation Mode enabled.";
      automationModeStatus.style.color = "#4caf50";
    } else {
      await setAutomationModeEnabled(false);
      try {
        await browser.permissions.remove({ origins: ["<all_urls>"] });
      } catch (removeError) {
        console.error("Could not remove host permission:", removeError);
      }
      automationModeStatus.textContent = "Automation Mode disabled.";
      automationModeStatus.style.color = "#4caf50";
    }
    setTimeout(() => {
      automationModeStatus.textContent = "";
      automationModeStatus.style.color = "";
    }, 4000);
  } catch (error) {
    console.error("Error toggling automation mode:", error);
    automationModeToggle.checked = !enabled;
  }
}

/**
 * Loads the current transport preference into the selector.
 */
async function loadTransport() {
  try {
    transportSelect.value = await getTransport();
  } catch (error) {
    console.error("Error loading transport:", error);
  }
}

/**
 * Handles changing the connection transport. Persists the choice and reloads
 * the extension so the new transport takes effect (same pattern as ports).
 */
async function handleTransportChange(event: Event) {
  if (!event.isTrusted) {
    return;
  }
  const value = transportSelect.value === "longpoll" ? "longpoll" : "websocket";
  try {
    await setTransport(value);
    transportStatus.textContent = "Transport saved. Reloading extension...";
    transportStatus.style.color = "#4caf50";
    // Reload the extension so the new transport takes effect:
    browser.runtime.reload();
  } catch (error) {
    console.error("Error saving transport:", error);
    transportStatus.textContent = "Failed to save transport";
    transportStatus.style.color = "red";
    setTimeout(() => {
      transportStatus.textContent = "";
      transportStatus.style.color = "";
    }, 3000);
  }
}

/**
 * Loads the current input-realism mode into the selector.
 */
async function loadInputRealism() {
  try {
    const mode = await getInputRealismMode();
    // Reflect the stored mode directly, including "native".
    inputRealismSelect.value =
      mode === "off" ? "off" : mode === "native" ? "native" : "synthetic";
  } catch (error) {
    console.error("Error loading input realism mode:", error);
  }
}

/**
 * Persists the input-realism mode. No extension reload needed — the mode is
 * read fresh on each input action.
 */
async function handleInputRealismChange(event: Event) {
  if (!event.isTrusted) {
    return;
  }
  const raw = inputRealismSelect.value;
  const value: "off" | "synthetic" | "native" =
    raw === "off" ? "off" : raw === "native" ? "native" : "synthetic";
  try {
    await setInputRealismMode(value);
    if (value === "native") {
      // Probe the sidecar so the user learns immediately whether native input
      // is actually available (reachable + OS-permitted) or will fall back.
      inputRealismStatus.textContent = "Saved. Checking sidecar...";
      inputRealismStatus.style.color = "#4caf50";
      await probeSidecar();
      return;
    }
    inputRealismStatus.textContent = "Saved.";
    inputRealismStatus.style.color = "#4caf50";
    setTimeout(() => {
      inputRealismStatus.textContent = "";
      inputRealismStatus.style.color = "";
    }, 2000);
  } catch (error) {
    console.error("Error saving input realism mode:", error);
    inputRealismStatus.textContent = "Failed to save";
    inputRealismStatus.style.color = "red";
  }
}

/**
 * Probes the native-input sidecar and reports readiness in the status line.
 * Never throws — NativeInputClient.sendGesture resolves { ok: false } on any
 * failure (unreachable, timeout), so each branch maps to concise guidance.
 */
async function probeSidecar() {
  try {
    const client = new NativeInputClient(
      await getSidecarPort(),
      await getSecret()
    );
    const result = await client.sendGesture({ kind: "probe" });
    if (result.ok) {
      inputRealismStatus.textContent = "Native ready — sidecar reachable.";
      inputRealismStatus.style.color = "#4caf50";
    } else if (result.needsPermission) {
      inputRealismStatus.textContent =
        "Sidecar reachable but lacks OS input permission. Grant Accessibility (System Settings → Privacy & Security → Accessibility) to the process running the sidecar.";
      inputRealismStatus.style.color = "red";
    } else {
      inputRealismStatus.textContent =
        "Sidecar not running — native input falls back to human-like. Start the input-sidecar (see docs).";
      inputRealismStatus.style.color = "red";
    }
  } catch (error) {
    console.error("Error probing sidecar:", error);
    inputRealismStatus.textContent =
      "Sidecar not running — native input falls back to human-like. Start the input-sidecar (see docs).";
    inputRealismStatus.style.color = "red";
  }
}

/**
 * Loads the domain lists from storage and displays them
 */
async function loadDomainLists() {
  try {
    // Load deny list
    const denyList = await getDomainDenyList();
    domainDenyListTextarea.value = denyList.join("\n");
  } catch (error) {
    console.error("Error loading domain lists:", error);
    domainStatusElement.textContent =
      "Error loading domain lists. Please check console for details.";
    domainStatusElement.style.color = "red";
    setTimeout(() => {
      domainStatusElement.textContent = "";
      domainStatusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Saves the domain lists to storage
 */
async function saveDomainLists(event: MouseEvent) {
  if (!event.isTrusted) {
    return;
  }

  try {
    // Parse deny list (split by newlines and filter out empty lines)
    const denyListText = domainDenyListTextarea.value.trim();
    const denyList = denyListText
      ? denyListText
          .split("\n")
          .map((domain) => domain.trim())
          .filter(Boolean)
      : [];

    // Save to storage
    await setDomainDenyList(denyList);

    // Show success message
    domainStatusElement.textContent = "Domain deny list saved successfully!";
    domainStatusElement.style.color = "#4caf50";
    setTimeout(() => {
      domainStatusElement.textContent = "";
      domainStatusElement.style.color = "";
    }, 3000);
  } catch (error) {
    console.error("Error saving domain lists:", error);
    domainStatusElement.textContent = "Failed to save domain lists";
    domainStatusElement.style.color = "red";
    setTimeout(() => {
      domainStatusElement.textContent = "";
      domainStatusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Loads the ports from storage and displays them
 */
async function loadPorts() {
  try {
    const ports = await getPorts();
    portsInput.value = ports.join(", ");
  } catch (error) {
    console.error("Error loading ports:", error);
    portsStatusElement.textContent =
      "Error loading ports. Please check console for details.";
    portsStatusElement.style.color = "red";
    setTimeout(() => {
      portsStatusElement.textContent = "";
      portsStatusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Saves the ports to storage
 */
async function savePorts(event: MouseEvent) {
  if (!event.isTrusted) {
    return;
  }

  try {
    // Parse ports (split by commas and filter out empty values)
    const portsText = portsInput.value.trim();
    const portStrings = portsText
      ? portsText
          .split(",")
          .map((port) => port.trim())
          .filter(Boolean)
      : [];

    // Validate and convert to numbers
    const ports: number[] = [];
    for (const portStr of portStrings) {
      const port = parseInt(portStr, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port number: ${portStr}. Ports must be between 1 and 65535.`);
      }
      ports.push(port);
    }

    // Ensure at least one port is provided
    if (ports.length === 0) {
      throw new Error("At least one port must be specified.");
    }

    // Save to storage
    await setPorts(ports);

    // Reload the extension:
    browser.runtime.reload();
  } catch (error) {
    console.error("Error saving ports:", error);
    portsStatusElement.textContent = error instanceof Error ? error.message : "Failed to save ports";
    portsStatusElement.style.color = "red";
    setTimeout(() => {
      portsStatusElement.textContent = "";
      portsStatusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Loads the audit log from storage and displays it
 */
async function loadAuditLog() {
  try {
    const auditLog = await getAuditLog();
    
    // Clear existing content
    auditLogContainer.innerHTML = "";
    
    if (auditLog.length === 0) {
      // Show empty state
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "audit-log-empty";
      emptyDiv.textContent = "No tool usage recorded yet.";
      auditLogContainer.appendChild(emptyDiv);
      return;
    }
    
    // Create table
    const table = document.createElement("table");
    table.className = "audit-log-table";
    
    // Create header
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    
    const headers = ["Tool", "Timestamp", "Domain"];
    headers.forEach(headerText => {
      const th = document.createElement("th");
      th.textContent = headerText;
      headerRow.appendChild(th);
    });
    
    thead.appendChild(headerRow);
    table.appendChild(thead);
    
    // Create body
    const tbody = document.createElement("tbody");
    
    auditLog.forEach(entry => {
      const row = document.createElement("tr");
      
      // Tool name
      const toolCell = document.createElement("td");
      toolCell.textContent = getToolNameById(entry.toolId);
      row.appendChild(toolCell);
      
      // Timestamp
      const timestampCell = document.createElement("td");
      timestampCell.className = "audit-log-timestamp";
      const date = new Date(entry.timestamp);
      timestampCell.textContent = date.toLocaleString();
      row.appendChild(timestampCell);
      
      // URL Domain
      const urlCell = document.createElement("td");
      urlCell.className = "audit-log-url";
      if (entry.url) {
        // Show only the domain part of the URL
        try {
          const urlObj = new URL(entry.url);
          urlCell.textContent = urlObj.hostname;
        } catch (e) {
          console.error("Invalid URL in audit log entry:", e);
          urlCell.textContent = "Invalid URL";
        }
      } else {
        urlCell.textContent = "-";
      }
      row.appendChild(urlCell);
      
      tbody.appendChild(row);
    });
    
    table.appendChild(tbody);
    auditLogContainer.appendChild(table);
    
  } catch (error) {
    console.error("Error loading audit log:", error);
    auditLogContainer.innerHTML = '<div class="audit-log-empty">Error loading audit log. Please check console for details.</div>';
  }
}

/**
 * Clears the audit log
 */
async function handleClearAuditLog(event: MouseEvent) {
  if (!event.isTrusted) {
    return;
  }

  try {
    await clearAuditLog();
    
    // Reload the audit log display
    await loadAuditLog();
    
    // Show success message
    auditLogStatusElement.textContent = "Audit log cleared successfully!";
    auditLogStatusElement.style.color = "#4caf50";
    setTimeout(() => {
      auditLogStatusElement.textContent = "";
      auditLogStatusElement.style.color = "";
    }, 3000);
  } catch (error) {
    console.error("Error clearing audit log:", error);
    auditLogStatusElement.textContent = "Failed to clear audit log";
    auditLogStatusElement.style.color = "red";
    setTimeout(() => {
      auditLogStatusElement.textContent = "";
      auditLogStatusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Initializes the collapsible sections
 */
function initializeCollapsibleSections() {
  const sectionHeaders = document.querySelectorAll(".section-container > h2");

  sectionHeaders.forEach((header) => {
    // Add click event listener to toggle section visibility
    header.addEventListener("click", (event) => {
      event.preventDefault();

      // Toggle the collapsed class on the header
      header.classList.toggle("collapsed");

      // Toggle the collapsed class on the section content
      const sectionContent = header.nextElementSibling as HTMLElement;
      sectionContent.classList.toggle("collapsed");
    });
  });
}

function showPermissionRequest(url: string) {
  const domain = new URL(url).hostname;
  const origin = new URL(url).origin;

  // Show the modal and hide the main content
  const modal = document.getElementById("permission-modal") as HTMLDivElement;
  const mainContent = document.getElementById("main-content") as HTMLDivElement;
  const domainElement = document.getElementById("permission-domain") as HTMLDivElement;
  const grantBtn = document.getElementById("grant-btn") as HTMLButtonElement;
  const cancelBtn = document.getElementById("cancel-btn") as HTMLButtonElement;
  const permissionText = document.getElementById("permission-text") as HTMLParagraphElement;

  // Set the domain in the modal
  domainElement.textContent = domain;
  
  // Update permission text for URL permission
  permissionText.textContent = "This will allow the extension to interact with pages on this domain as requested by the MCP server.";

  // Show modal and blur main content
  modal.classList.remove("hidden");
  mainContent.classList.add("modal-open");

  // Handle grant permission button click
  const handleGrant = async () => {
    try {
      const granted = await browser.permissions.request({
        origins: [`${origin}/*`],
      });

      if (granted) {
        // Permission granted, close the window or redirect back
        window.close();
      } else {
        // Permission denied, hide modal and show main content
        hidePermissionModal();
      }
    } catch (error) {
      console.error("Error requesting permission:", error);
      hidePermissionModal();
    }
  };

  // Handle cancel button click
  const handleCancel = () => {
    hidePermissionModal();
  };

  // Add event listeners
  grantBtn.addEventListener("click", handleGrant);
  cancelBtn.addEventListener("click", handleCancel);

  // Store references to remove listeners later
  (window as any).permissionHandlers = {
    handleGrant,
    handleCancel,
    grantBtn,
    cancelBtn
  };
}

function showGlobalPermissionRequest(permissions: string[]) {
  // Show the modal and hide the main content
  const modal = document.getElementById("permission-modal") as HTMLDivElement;
  const mainContent = document.getElementById("main-content") as HTMLDivElement;
  const domainElement = document.getElementById("permission-domain") as HTMLDivElement;
  const grantBtn = document.getElementById("grant-btn") as HTMLButtonElement;
  const cancelBtn = document.getElementById("cancel-btn") as HTMLButtonElement;
  const permissionText = document.getElementById("permission-text") as HTMLParagraphElement;

  // Set the permissions in the modal
  domainElement.textContent = permissions.join(", ");
  
  // Update permission text for global permissions
  permissionText.textContent = "This will allow the extension to use these browser capabilities as requested by the MCP server.";

  // Show modal and blur main content
  modal.classList.remove("hidden");
  mainContent.classList.add("modal-open");

  // Handle grant permission button click
  const handleGrant = async () => {
    try {
      const granted = await browser.permissions.request({
        permissions: permissions as any,
      });

      if (granted) {
        // Permission granted, close the window or redirect back
        window.close();
      } else {
        // Permission denied, hide modal and show main content
        hidePermissionModal();
      }
    } catch (error) {
      console.error("Error requesting permission:", error);
      hidePermissionModal();
    }
  };

  // Handle cancel button click
  const handleCancel = () => {
    hidePermissionModal();
  };

  // Add event listeners
  grantBtn.addEventListener("click", handleGrant);
  cancelBtn.addEventListener("click", handleCancel);

  // Store references to remove listeners later
  (window as any).permissionHandlers = {
    handleGrant,
    handleCancel,
    grantBtn,
    cancelBtn
  };
}

function hidePermissionModal() {
  const modal = document.getElementById("permission-modal") as HTMLDivElement;
  const mainContent = document.getElementById("main-content") as HTMLDivElement;

  // Hide modal and restore main content
  modal.classList.add("hidden");
  mainContent.classList.remove("modal-open");

  // Clean up event listeners
  const handlers = (window as any).permissionHandlers;
  if (handlers) {
    handlers.grantBtn.removeEventListener("click", handlers.handleGrant);
    handlers.cancelBtn.removeEventListener("click", handlers.handleCancel);
    delete (window as any).permissionHandlers;
  }
}

// Initialize the page
copyButton.addEventListener("click", copyToClipboard);
saveSecretButton.addEventListener("click", saveSecret);
saveDomainListsButton.addEventListener("click", saveDomainLists);
savePortsButton.addEventListener("click", savePorts);
clearAuditLogButton.addEventListener("click", handleClearAuditLog);
automationModeToggle.addEventListener("change", handleAutomationModeToggle);
transportSelect.addEventListener("change", handleTransportChange);
inputRealismSelect.addEventListener("change", handleInputRealismChange);
document.addEventListener("DOMContentLoaded", () => {
  loadSecret();
  createToolSettingsUI();
  loadDomainLists();
  loadPorts();
  loadAuditLog();
  loadAutomationMode();
  loadTransport();
  loadInputRealism();
  initializeCollapsibleSections();

  // Ensure modal is hidden by default
  const modal = document.getElementById("permission-modal") as HTMLDivElement;
  const mainContent = document.getElementById("main-content") as HTMLDivElement;
  modal.classList.add("hidden");
  mainContent.classList.remove("modal-open");

  const params = new URLSearchParams(window.location.search);
  const requestUrl = params.get("requestUrl");
  const requestPermissions = params.get("requestPermissions");

  if (requestUrl) {
    // Show UI for requesting permission for this specific URL
    showPermissionRequest(requestUrl);
  } else if (requestPermissions) {
    // Show UI for requesting global permissions
    try {
      const permissions = JSON.parse(decodeURIComponent(requestPermissions));
      showGlobalPermissionRequest(permissions);
    } catch (error) {
      console.error("Error parsing requestPermissions:", error);
    }
  }

  // Add interval to refresh the audit log every 5 seconds:
  setInterval(() => {
    loadAuditLog();
  }, 5000);
});
