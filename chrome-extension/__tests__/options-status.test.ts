/** @jest-environment jsdom */
import { applyActiveStatus, selectThisBrowser } from "../options-status";

describe("options active-status UI", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="connection-badge" class="badge standby">STANDBY</div>
      <button id="make-active-btn">Make this browser active</button>
    `;
    jest.clearAllMocks();
  });

  it("flips the badge to ACTIVE when active=true", () => {
    applyActiveStatus(true);
    const badge = document.getElementById("connection-badge")!;
    expect(badge.textContent).toBe("ACTIVE");
    expect(badge.classList.contains("active")).toBe(true);
    expect(badge.classList.contains("standby")).toBe(false);
  });

  it("flips the badge to STANDBY when active=false", () => {
    applyActiveStatus(true);
    applyActiveStatus(false);
    const badge = document.getElementById("connection-badge")!;
    expect(badge.textContent).toBe("STANDBY");
    expect(badge.classList.contains("standby")).toBe(true);
    expect(badge.classList.contains("active")).toBe(false);
  });

  it("selectThisBrowser sends a setActive runtime message with the browserId", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], browserId: "bid-9" },
    });
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    (browser as any).runtime.sendMessage = sendMessage;

    await selectThisBrowser();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "select-this-browser",
      browserId: "bid-9",
    });
  });
});
