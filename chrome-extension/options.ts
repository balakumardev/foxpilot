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
  getBrokerStatus,
  BrokerStatus,
  BROKER_STATUS_STORAGE_KEY,
} from "./extension-config";
import { NativeInputClient } from "./native-input-client";
import {
  applyActiveStatus,
  selectThisBrowser,
  fetchInitialActiveStatus,
} from "./options-status";
import type { HealthcheckResult } from "./transport";

const secretDisplay = document.getElementById(
  "secret-display"
) as HTMLDivElement;
const secretToggle = document.getElementById(
  "secret-toggle"
) as HTMLButtonElement;
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
const toolSearchInput = document.getElementById(
  "tool-search"
) as HTMLInputElement;
const toolCountBadge = document.getElementById("tool-count") as HTMLSpanElement;
const toolsEnableAllButton = document.getElementById(
  "tools-enable-all"
) as HTMLButtonElement;
const toolsDisableAllButton = document.getElementById(
  "tools-disable-all"
) as HTMLButtonElement;
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
const portsChip = document.getElementById("ports-chip") as HTMLSpanElement;
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
const transportChip = document.getElementById(
  "transport-chip"
) as HTMLSpanElement;
const transportStatus = document.getElementById(
  "transport-status"
) as HTMLDivElement;
const inputRealismSelect = document.getElementById(
  "input-realism-select"
) as HTMLSelectElement;
const inputRealismStatus = document.getElementById(
  "input-realism-status"
) as HTMLDivElement;
// "Make this browser active" button + its feedback line. The feedback line is
// #active-status-msg (NOT #connection-status — that id is main's topbar liveness
// span, see connectionStatusEl below). The two status systems are independent:
// connectionStatusEl = "is the broker reachable?" (Connected/Disconnected);
// the ACTIVE/STANDBY pill (#connection-badge, driven by options-status) = "is
// THIS browser the active driver?".
const makeActiveButton = document.getElementById(
  "make-active-btn"
) as HTMLButtonElement;
const activeStatusMsg = document.getElementById(
  "active-status-msg"
) as HTMLDivElement;
const connectionStatusEl = document.getElementById(
  "connection-status"
) as HTMLSpanElement;
// "Test Connection" button + its result line (Setup panel). Probes the broker
// via the background's healthcheck() and reports an honest result.
const testConnectionButton = document.getElementById(
  "test-connection-btn"
) as HTMLButtonElement | null;
const testConnectionStatus = document.getElementById(
  "test-connection-status"
) as HTMLDivElement | null;

// SVG markup for the secret reveal toggle (eye / eye-off).
const EYE_ICON =
  '<svg class="icon" viewBox="0 0 24 24"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON =
  '<svg class="icon" viewBox="0 0 24 24"><path d="M10.73 5.07A10.43 10.43 0 0 1 12 5c5 0 9.27 3.11 11 7a12.3 12.3 0 0 1-1.67 2.68"/><path d="M6.06 6.06A12.4 12.4 0 0 0 1 12c1.73 3.89 6 7 11 7a10.4 10.4 0 0 0 5.94-1.06"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>';

// Holds the real secret separately from what is displayed, so the value can be
// masked in the UI while remaining available for "Copy".
let currentSecret: string | null = null;
let secretRevealed = false;

/**
 * Renders the secret display in either masked or revealed form.
 */
function renderSecret() {
  if (!currentSecret) {
    return;
  }
  secretDisplay.textContent = secretRevealed
    ? currentSecret
    : "•".repeat(Math.min(currentSecret.length, 44));
  secretToggle.innerHTML = secretRevealed ? EYE_OFF_ICON : EYE_ICON;
  secretToggle.setAttribute(
    "aria-label",
    secretRevealed ? "Hide secret" : "Reveal secret"
  );
  secretToggle.title = secretRevealed ? "Hide" : "Reveal";
}

/**
 * Loads the secret from storage and displays it (masked by default)
 */
async function loadSecret() {
  try {
    const secret = await getSecret();

    // Check if secret exists
    if (secret) {
      currentSecret = secret;
      secretRevealed = false;
      renderSecret();
      // Prefill the editable input so the user can see/edit the current secret.
      secretInput.value = secret;
    } else {
      currentSecret = null;
      // No secret is the DEFAULT (zero-config / origin mode) — this is normal,
      // not an error. Only set a secret here for advanced/remote setups.
      secretDisplay.textContent =
        "No secret set — using zero-config pairing (recommended).";
      secretDisplay.style.color = "var(--text-muted)";
      copyButton.disabled = true;
      secretToggle.disabled = true;
    }
  } catch (error) {
    console.error("Error loading secret:", error);
    currentSecret = null;
    secretDisplay.textContent =
      "Error loading secret. Please check console for details.";
    secretDisplay.style.color = "var(--danger)";
    copyButton.disabled = true;
    secretToggle.disabled = true;
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
      statusElement.style.color = "var(--danger)";
      setTimeout(() => {
        statusElement.textContent = "";
        statusElement.style.color = "";
      }, 3000);
      return;
    }
    await setSecret(value);
    // Keep the masked display model consistent: update the cached secret and
    // re-render (masked) rather than writing the raw value into the display.
    currentSecret = value;
    secretRevealed = false;
    secretDisplay.style.color = "";
    renderSecret();
    copyButton.disabled = false;
    secretToggle.disabled = false;
    statusElement.textContent = "Secret saved — reloading…";
    statusElement.style.color = "var(--success)";
    // Reload the extension so the new secret actually takes effect: live
    // clients (ports/long-poll/WS) capture the secret at construction and keep
    // signing with the OLD one until reloaded, so every frame — including new
    // hellos — would silently fail broker verification. Matches the ports and
    // transport save handlers.
    browser.runtime.reload();
  } catch (error) {
    console.error("Error saving secret:", error);
    statusElement.textContent = "Failed to save secret";
    statusElement.style.color = "var(--danger)";
    setTimeout(() => {
      statusElement.textContent = "";
      statusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Toggles the secret between masked and revealed.
 */
function handleSecretToggle(event: MouseEvent) {
  if (!event.isTrusted || !currentSecret) {
    return;
  }
  secretRevealed = !secretRevealed;
  renderSecret();
}

/**
 * Copies the secret to clipboard
 */
async function copyToClipboard(event: MouseEvent) {
  if (!event.isTrusted) {
    return;
  }
  try {
    const secret = currentSecret;
    if (!secret) {
      return;
    }

    await navigator.clipboard.writeText(secret);

    // Show success message
    statusElement.textContent = "Secret copied to clipboard!";
    statusElement.style.color = "var(--success)";
    setTimeout(() => {
      statusElement.textContent = "";
    }, 3000);
  } catch (error) {
    console.error("Error copying to clipboard:", error);
    statusElement.textContent = "Failed to copy to clipboard";
    statusElement.style.color = "var(--danger)";
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

  updateToolCount();
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
    updateToolCount();
  } catch (error) {
    console.error("Error saving tool setting:", error);

    // Revert the checkbox state
    checkbox.checked = !isEnabled;
    updateToolCount();
  }
}

/**
 * Updates the "N of M enabled" badge from the current checkbox states.
 */
function updateToolCount() {
  const boxes = Array.from(
    toolSettingsContainer.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]"
    )
  );
  const enabled = boxes.filter((b) => b.checked).length;
  toolCountBadge.innerHTML = `<b>${enabled}</b> of ${boxes.length} enabled`;
}

/**
 * Filters the visible tool rows by a case-insensitive query.
 */
function filterTools(query: string) {
  const q = query.trim().toLowerCase();
  toolSettingsContainer
    .querySelectorAll<HTMLDivElement>(".tool-row")
    .forEach((row) => {
      const matches = !q || row.textContent!.toLowerCase().includes(q);
      row.classList.toggle("hidden", !matches);
    });
}

/**
 * Enables or disables every tool at once. Persists each change sequentially
 * (each setToolEnabled is a read-modify-write of the config object, so they
 * must not race).
 */
async function setAllTools(enabled: boolean) {
  const boxes = Array.from(
    toolSettingsContainer.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]"
    )
  );
  for (const box of boxes) {
    box.checked = enabled;
    const toolId = box.dataset.toolId;
    if (toolId) {
      try {
        await setToolEnabled(toolId, enabled);
      } catch (error) {
        console.error("Error saving tool setting:", error);
      }
    }
  }
  updateToolCount();
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
        automationModeStatus.style.color = "var(--danger)";
        setTimeout(() => {
          automationModeStatus.textContent = "";
          automationModeStatus.style.color = "";
        }, 4000);
        return;
      }
      await setAutomationModeEnabled(true);
      automationModeStatus.textContent = "Automation Mode enabled.";
      automationModeStatus.style.color = "var(--success)";
    } else {
      await setAutomationModeEnabled(false);
      try {
        await browser.permissions.remove({ origins: ["<all_urls>"] });
      } catch (removeError) {
        console.error("Could not remove host permission:", removeError);
      }
      automationModeStatus.textContent = "Automation Mode disabled.";
      automationModeStatus.style.color = "var(--success)";
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
 * Loads the current transport preference into the selector and header chip.
 */
async function loadTransport() {
  try {
    const transport = await getTransport();
    transportSelect.value = transport;
    transportChip.textContent =
      transport === "longpoll" ? "HTTP long-poll" : "WebSocket";
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
    transportStatus.style.color = "var(--success)";
    // Reload the extension so the new transport takes effect:
    browser.runtime.reload();
  } catch (error) {
    console.error("Error saving transport:", error);
    transportStatus.textContent = "Failed to save transport";
    transportStatus.style.color = "var(--danger)";
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
      inputRealismStatus.style.color = "var(--success)";
      await probeSidecar();
      return;
    }
    inputRealismStatus.textContent = "Saved.";
    inputRealismStatus.style.color = "var(--success)";
    setTimeout(() => {
      inputRealismStatus.textContent = "";
      inputRealismStatus.style.color = "";
    }, 2000);
  } catch (error) {
    console.error("Error saving input realism mode:", error);
    inputRealismStatus.textContent = "Failed to save";
    inputRealismStatus.style.color = "var(--danger)";
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
      inputRealismStatus.style.color = "var(--success)";
    } else if (result.needsPermission) {
      inputRealismStatus.textContent =
        "Sidecar reachable but lacks OS input permission. Grant Accessibility (System Settings → Privacy & Security → Accessibility) to the process running the sidecar.";
      inputRealismStatus.style.color = "var(--danger)";
    } else {
      inputRealismStatus.textContent =
        "Sidecar not running — native input falls back to human-like. Start the input-sidecar (see docs).";
      inputRealismStatus.style.color = "var(--danger)";
    }
  } catch (error) {
    console.error("Error probing sidecar:", error);
    inputRealismStatus.textContent =
      "Sidecar not running — native input falls back to human-like. Start the input-sidecar (see docs).";
    inputRealismStatus.style.color = "var(--danger)";
  }
}

/**
 * Test Connection: asks the background to run the broker healthcheck() and
 * renders a clear, honest result — server reachable? this browser admitted?
 * N browsers connected? active or standby? Mirrors probeSidecar's UX (a status
 * line that never throws). The background relays the transport's
 * HealthcheckResult, resolving serverReachable:false when nothing is listening.
 */
async function testConnection() {
  if (!testConnectionStatus) {
    return;
  }
  testConnectionStatus.textContent = "Testing…";
  testConnectionStatus.style.color = "var(--text-muted)";
  try {
    const result: HealthcheckResult | undefined =
      await browser.runtime.sendMessage({ type: "healthcheck" });
    if (!result || !result.serverReachable) {
      testConnectionStatus.textContent =
        "Server not running — start the FoxPilot MCP server (it launches the broker). This browser will connect automatically once it is up.";
      testConnectionStatus.style.color = "var(--danger)";
      return;
    }
    const connectedBrowsers = (result.browsers || []).filter(
      (b) => b.connected
    );
    const count = connectedBrowsers.length;
    const admitted = result.extensionConnected;
    // `find(b => b.active)` only ever returns an entry whose `active` is true, so
    // its mere presence means an active browser exists. A lone connected browser
    // is treated as active even before the broker marks it so.
    const hasActive = connectedBrowsers.some((b) => b.active);
    const activeWord = count <= 1 || hasActive ? "active" : "standby";
    if (!admitted) {
      testConnectionStatus.textContent =
        "Server reachable, but this browser is not admitted. If you set a custom secret, make sure it matches the broker's EXTENSION_SECRET.";
      testConnectionStatus.style.color = "var(--warning)";
      return;
    }
    const browserWord = count === 1 ? "browser" : "browsers";
    testConnectionStatus.textContent = `Connected — server reachable, this browser admitted. ${count} ${browserWord} connected; this browser is ${activeWord}.`;
    testConnectionStatus.style.color = "var(--success)";
  } catch (error) {
    console.error("Error testing connection:", error);
    testConnectionStatus.textContent =
      "Could not reach the background service worker. Try reloading the extension.";
    testConnectionStatus.style.color = "var(--danger)";
  }
}

/**
 * "Make this browser active": asks the background page to forward a
 * select-active to the broker for this browser's id. The broker then pushes the
 * new ACTIVE/STANDBY state back to every browser (this one flips ACTIVE, others
 * flip STANDBY) via the active-status relay.
 */
async function handleMakeActive(event: MouseEvent) {
  if (!event.isTrusted) return;
  try {
    await selectThisBrowser();
    activeStatusMsg.textContent = "Requested — making this browser active.";
    activeStatusMsg.style.color = "var(--success)";
    setTimeout(() => {
      activeStatusMsg.textContent = "";
      activeStatusMsg.style.color = "";
    }, 3000);
  } catch (error) {
    console.error("Error making this browser active:", error);
    activeStatusMsg.textContent = "Failed (is the broker connected?).";
    activeStatusMsg.style.color = "var(--danger)";
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
    domainStatusElement.style.color = "var(--danger)";
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
    domainStatusElement.style.color = "var(--success)";
    setTimeout(() => {
      domainStatusElement.textContent = "";
      domainStatusElement.style.color = "";
    }, 3000);
  } catch (error) {
    console.error("Error saving domain lists:", error);
    domainStatusElement.textContent = "Failed to save domain lists";
    domainStatusElement.style.color = "var(--danger)";
    setTimeout(() => {
      domainStatusElement.textContent = "";
      domainStatusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Loads the ports from storage and displays them (input + header chip)
 */
async function loadPorts() {
  try {
    const ports = await getPorts();
    portsInput.value = ports.join(", ");
    portsChip.textContent = ports.map((p) => `:${p}`).join(" ");
  } catch (error) {
    console.error("Error loading ports:", error);
    portsStatusElement.textContent =
      "Error loading ports. Please check console for details.";
    portsStatusElement.style.color = "var(--danger)";
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
    portsStatusElement.style.color = "var(--danger)";
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

// Two-step confirm state for clearing the audit log.
let clearLogArmed = false;
let clearLogTimer: number | null = null;

function setClearLogLabel(text: string) {
  const label = clearAuditLogButton.querySelector(".btn-label");
  if (label) {
    label.textContent = text;
  }
}

/**
 * Clears the audit log. First click arms a confirmation; a second click within
 * 3s actually clears it.
 */
async function handleClearAuditLog(event: MouseEvent) {
  if (!event.isTrusted) {
    return;
  }

  if (!clearLogArmed) {
    clearLogArmed = true;
    setClearLogLabel("Confirm clear?");
    clearLogTimer = window.setTimeout(() => {
      clearLogArmed = false;
      setClearLogLabel("Clear Log");
    }, 3000);
    return;
  }

  if (clearLogTimer !== null) {
    window.clearTimeout(clearLogTimer);
    clearLogTimer = null;
  }
  clearLogArmed = false;
  setClearLogLabel("Clear Log");

  try {
    await clearAuditLog();

    // Reload the audit log display
    await loadAuditLog();

    // Show success message
    auditLogStatusElement.textContent = "Audit log cleared successfully!";
    auditLogStatusElement.style.color = "var(--success)";
    setTimeout(() => {
      auditLogStatusElement.textContent = "";
      auditLogStatusElement.style.color = "";
    }, 3000);
  } catch (error) {
    console.error("Error clearing audit log:", error);
    auditLogStatusElement.textContent = "Failed to clear audit log";
    auditLogStatusElement.style.color = "var(--danger)";
    setTimeout(() => {
      auditLogStatusElement.textContent = "";
      auditLogStatusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Reflects the HONEST broker connection state in the header pill. Maps the
 * transport tri-state to the three things the user needs to tell apart:
 *  - connected     -> "Connected" (the broker admitted this browser)
 *  - blocked       -> "Blocked" + reason (server up, refused admission)
 *  - disconnected  -> "Server not running" (nothing is listening / unreachable)
 *
 * The pill's CSS knows data-state connected|disconnected|blocked.
 */
function applyConnectionStatus(status: BrokerStatus) {
  if (!connectionStatusEl) {
    return;
  }
  const label = connectionStatusEl.querySelector(".conn-label");
  connectionStatusEl.dataset.state = status.state;
  if (!label) {
    return;
  }
  if (status.state === "connected") {
    label.textContent = "Connected";
  } else if (status.state === "blocked") {
    label.textContent = status.reason
      ? `Blocked (${prettyReason(status.reason)})`
      : "Blocked";
  } else {
    // The default zero-config failure is simply: no broker is listening.
    label.textContent = "Server not running";
  }
}

/** Humanize a broker rejection reason for the status pill / Test Connection. */
function prettyReason(reason: string): string {
  if (reason === "origin_not_allowed") {
    return "extension origin not allowed";
  }
  if (reason === "longpoll-requires-secret") {
    return "long-poll needs a secret — set one in Advanced";
  }
  return reason;
}

/**
 * Loads the current broker connection state and subscribes to live updates.
 * The background script mirrors the tri-state into storage; we read it once on
 * load and then react to storage changes.
 */
async function loadConnectionStatus() {
  try {
    applyConnectionStatus(await getBrokerStatus());
  } catch (error) {
    console.error("Error loading connection status:", error);
  }
}

function initConnectionStatusWatcher() {
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    const change = changes[BROKER_STATUS_STORAGE_KEY];
    if (change) {
      const value = change.newValue as Partial<BrokerStatus> | undefined;
      const state = value?.state
        ? value.state
        : value?.connected
        ? "connected"
        : "disconnected";
      applyConnectionStatus({
        connected: state === "connected",
        state,
        reason: value?.reason,
      });
    }
  });
}

/**
 * Sets the extension version in the header from the manifest.
 */
function loadVersion() {
  try {
    const version = browser.runtime.getManifest().version;
    const el = document.getElementById("brand-version");
    if (el && version) {
      el.textContent = `v${version}`;
    }
  } catch (error) {
    console.error("Error reading version:", error);
  }
}

/**
 * Wires the sidebar navigation: click-to-scroll plus a scrollspy that
 * highlights the section currently in view. Replaces the old collapsible
 * sections behavior.
 */
function initializeSidebarNav() {
  const items = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(".nav-item")
  );
  const byId = new Map(items.map((i) => [i.dataset.target || "", i]));

  items.forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      const target = item.dataset.target;
      if (target) {
        document
          .getElementById(target)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  const setActive = (id: string) => {
    items.forEach((i) => i.classList.remove("active"));
    byId.get(id)?.classList.add("active");
  };

  const panels = Array.from(document.querySelectorAll<HTMLElement>(".panel"));
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActive(entry.target.id);
          }
        });
      },
      { rootMargin: "-90px 0px -65% 0px", threshold: 0 }
    );
    panels.forEach((panel) => observer.observe(panel));
  }

  // Default highlight: first item.
  if (items.length) {
    items[0].classList.add("active");
  }
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
secretToggle.addEventListener("click", handleSecretToggle);
copyButton.addEventListener("click", copyToClipboard);
saveSecretButton.addEventListener("click", saveSecret);
saveDomainListsButton.addEventListener("click", saveDomainLists);
savePortsButton.addEventListener("click", savePorts);
clearAuditLogButton.addEventListener("click", handleClearAuditLog);
automationModeToggle.addEventListener("change", handleAutomationModeToggle);
transportSelect.addEventListener("change", handleTransportChange);
inputRealismSelect.addEventListener("change", handleInputRealismChange);
makeActiveButton.addEventListener("click", handleMakeActive);
if (testConnectionButton) {
  testConnectionButton.addEventListener("click", testConnection);
}
// The background relays broker active-status pushes to the options page so the
// ACTIVE/STANDBY badge reflects the live "is this browser the active driver?"
// state (independent of the topbar's Connected/Disconnected liveness).
browser.runtime.onMessage.addListener((msg: any) => {
  if (msg?.type === "active-status") {
    applyActiveStatus(!!msg.active);
  }
});
toolSearchInput.addEventListener("input", () => filterTools(toolSearchInput.value));
toolsEnableAllButton.addEventListener("click", (e) => {
  if (e.isTrusted) void setAllTools(true);
});
toolsDisableAllButton.addEventListener("click", (e) => {
  if (e.isTrusted) void setAllTools(false);
});
document.addEventListener("DOMContentLoaded", () => {
  loadVersion();
  loadSecret();
  createToolSettingsUI();
  loadDomainLists();
  loadPorts();
  loadAuditLog();
  loadAutomationMode();
  loadTransport();
  loadInputRealism();
  // Topbar liveness indicator: "is the broker reachable?" (Connected/Disconnected).
  loadConnectionStatus();
  initConnectionStatusWatcher();
  initializeSidebarNav();
  // Active-browser badge: reflect the real current ACTIVE/STANDBY state on open
  // (the live relay above keeps it updated thereafter). Self-guards; never throws.
  fetchInitialActiveStatus();

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
