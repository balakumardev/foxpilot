/**
 * Toolbar popup: connection status, MCP-server install help when the broker is
 * not reachable, and a button to the full settings page.
 */
import { getBrokerStatus, BROKER_STATUS_STORAGE_KEY } from "./extension-config";
import type { BrokerStatus } from "./extension-config";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function render(status: BrokerStatus): void {
  const state = status.state;
  $("status").dataset.state = state;
  $("setup").hidden = state === "connected";
  if (state === "connected") {
    $("status-text").textContent = "Connected to the MCP server";
    $("status-hint").textContent = "Your AI client can drive this browser.";
  } else if (state === "blocked") {
    $("status-text").textContent = "Connection blocked";
    $("status-hint").textContent = status.reason || "The MCP server refused this browser.";
  } else {
    $("status-text").textContent = "MCP server not detected";
    $("status-hint").textContent = "";
  }
}

async function refresh(): Promise<void> {
  try {
    render(await getBrokerStatus());
  } catch {
    render({ connected: false, state: "disconnected" });
  }
}

$("open-settings").addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});

$("copy").addEventListener("click", async () => {
  const btn = $("copy");
  try {
    await navigator.clipboard.writeText($("cmd").textContent || "");
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Select the command and copy";
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[BROKER_STATUS_STORAGE_KEY]) void refresh();
});

void refresh();
