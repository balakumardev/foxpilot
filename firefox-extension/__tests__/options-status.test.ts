/** @jest-environment jsdom */
import {
  applyActiveStatus,
  selectThisBrowser,
  fetchInitialActiveStatus,
  renderConnectedBrowsers,
  renderRemoteLink,
  remoteLinkSummary,
} from "../options-status";

describe("options active-status UI", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="connection-badge" class="badge standby">STANDBY</div>
      <button id="make-active-btn">Make this browser active</button>
      <div id="connected-browsers"></div>
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

  it("fetchInitialActiveStatus renders ACTIVE when the background replies active:true", async () => {
    const sendMessage = jest.fn().mockResolvedValue({ active: true });
    (browser as any).runtime.sendMessage = sendMessage;

    await fetchInitialActiveStatus();

    expect(sendMessage).toHaveBeenCalledWith({ type: "get-active-status" });
    const badge = document.getElementById("connection-badge")!;
    expect(badge.textContent).toBe("ACTIVE");
    expect(badge.classList.contains("active")).toBe(true);
    expect(badge.classList.contains("standby")).toBe(false);
  });

  it("fetchInitialActiveStatus renders STANDBY when the background replies active:false", async () => {
    // Start the badge ACTIVE to prove the fetch drives it back to STANDBY.
    applyActiveStatus(true);
    const sendMessage = jest.fn().mockResolvedValue({ active: false });
    (browser as any).runtime.sendMessage = sendMessage;

    await fetchInitialActiveStatus();

    const badge = document.getElementById("connection-badge")!;
    expect(badge.textContent).toBe("STANDBY");
    expect(badge.classList.contains("standby")).toBe(true);
    expect(badge.classList.contains("active")).toBe(false);
  });

  it("fetchInitialActiveStatus defaults to STANDBY when the background does not respond", async () => {
    // No receiver / background asleep -> sendMessage rejects. Must not throw and
    // must leave the badge on STANDBY.
    const sendMessage = jest.fn().mockRejectedValue(new Error("no receiver"));
    (browser as any).runtime.sendMessage = sendMessage;

    await expect(fetchInitialActiveStatus()).resolves.toBeUndefined();

    const badge = document.getElementById("connection-badge")!;
    expect(badge.textContent).toBe("STANDBY");
    expect(badge.classList.contains("standby")).toBe(true);
    expect(badge.classList.contains("active")).toBe(false);
  });

  it("fetchInitialActiveStatus renders the other connected browsers from the roster", async () => {
    const sendMessage = jest.fn().mockResolvedValue({
      active: true,
      browserId: "me",
      browsers: [
        { browserId: "me", label: "My Firefox", type: "firefox", connected: true, active: true },
        { browserId: "other", label: "Chrome", type: "chrome", connected: true, active: false },
      ],
    });
    (browser as any).runtime.sendMessage = sendMessage;

    await fetchInitialActiveStatus();

    const list = document.getElementById("connected-browsers")!;
    // The OTHER browser is listed; THIS browser is not duplicated in the list.
    expect(list.textContent).toContain("Chrome");
    expect(list.textContent).not.toContain("My Firefox");
  });

  it("fetchInitialActiveStatus shows a lone-browser hint when only this browser is connected", async () => {
    const sendMessage = jest.fn().mockResolvedValue({
      active: true,
      browserId: "me",
      browsers: [
        { browserId: "me", label: "My Firefox", type: "firefox", connected: true, active: true },
      ],
    });
    (browser as any).runtime.sendMessage = sendMessage;

    await fetchInitialActiveStatus();

    const badge = document.getElementById("connection-badge")!;
    expect(badge.textContent).toBe("ACTIVE");
    const list = document.getElementById("connected-browsers")!;
    // No other browsers — a clear "only this browser" message, not an empty box.
    expect(list.textContent!.toLowerCase()).toContain("only this browser");
  });
});

describe("renderConnectedBrowsers", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="connected-browsers"></div>`;
  });

  it("lists other connected browsers and marks the active one", () => {
    renderConnectedBrowsers(
      [
        { browserId: "me", label: "My Firefox", type: "firefox", connected: true, active: false },
        { browserId: "drv", label: "Driver Chrome", type: "chrome", connected: true, active: true },
      ],
      "me"
    );
    const list = document.getElementById("connected-browsers")!;
    expect(list.textContent).toContain("Driver Chrome");
    expect(list.textContent).not.toContain("My Firefox");
    // The active one is flagged somehow (text contains ACTIVE marker).
    expect(list.textContent!.toUpperCase()).toContain("ACTIVE");
  });

  it("renders an only-this-browser message when no others are connected", () => {
    renderConnectedBrowsers(
      [{ browserId: "me", label: "My Firefox", type: "firefox", connected: true, active: true }],
      "me"
    );
    const list = document.getElementById("connected-browsers")!;
    expect(list.textContent!.toLowerCase()).toContain("only this browser");
  });

  it("ignores disconnected roster entries", () => {
    renderConnectedBrowsers(
      [
        { browserId: "me", label: "My Firefox", type: "firefox", connected: true, active: true },
        { browserId: "gone", label: "Stale Chrome", type: "chrome", connected: false, active: false },
      ],
      "me"
    );
    const list = document.getElementById("connected-browsers")!;
    expect(list.textContent).not.toContain("Stale Chrome");
    expect(list.textContent!.toLowerCase()).toContain("only this browser");
  });
});

describe("renderRemoteLink", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="remote-link-row" hidden>
        <div class="status" id="remote-link-status"></div>
        <button class="btn btn-danger" id="remote-link-off-btn" type="button">Turn off remote link</button>
      </div>
    `;
  });

  it("hides the row when link is undefined", () => {
    const row = document.getElementById("remote-link-row") as HTMLDivElement;
    row.hidden = false; // start visible to prove it gets hidden
    renderRemoteLink(undefined);
    expect(row.hidden).toBe(true);
  });

  it("renders disabled state (enabled=false): shows row, sets text, hides button", () => {
    const row = document.getElementById("remote-link-row") as HTMLDivElement;
    const status = document.getElementById("remote-link-status") as HTMLDivElement;
    const btn = document.getElementById("remote-link-off-btn") as HTMLButtonElement;
    btn.hidden = false; // start visible to prove it gets hidden

    renderRemoteLink({
      enabled: false,
      relayConnected: false,
      sessions: [],
    });

    expect(row.hidden).toBe(false);
    expect(btn.hidden).toBe(true);
    expect(status.textContent).toBe("Remote link is off.");
  });

  it("renders enabled state with 0 sessions: shows row and button, describes relay reachable and no sessions", () => {
    const row = document.getElementById("remote-link-row") as HTMLDivElement;
    const status = document.getElementById("remote-link-status") as HTMLDivElement;
    const btn = document.getElementById("remote-link-off-btn") as HTMLButtonElement;

    renderRemoteLink({
      enabled: true,
      relayConnected: true,
      sessions: [],
    });

    expect(row.hidden).toBe(false);
    expect(btn.hidden).toBe(false);
    expect(status.textContent).toBe(
      "Remote link is on and connected to the relay. No remote sessions are connected."
    );

    // Also test when relay is not reachable
    renderRemoteLink({
      enabled: true,
      relayConnected: false,
      sessions: [],
    });
    expect(status.textContent).toBe(
      "Remote link is on, but the relay is not reachable right now. No remote sessions are connected."
    );
  });

  it("renders enabled state with 2 sessions: shows row and button, lists labels and plural count", () => {
    const row = document.getElementById("remote-link-row") as HTMLDivElement;
    const status = document.getElementById("remote-link-status") as HTMLDivElement;
    const btn = document.getElementById("remote-link-off-btn") as HTMLButtonElement;

    renderRemoteLink({
      enabled: true,
      relayConnected: true,
      sessions: [
        { label: "cloud-box", connectedAt: 100 },
        { label: "macbook", connectedAt: 200 },
      ],
    });

    expect(row.hidden).toBe(false);
    expect(btn.hidden).toBe(false);
    expect(status.textContent).toBe(
      "Remote link is on and connected to the relay. 2 remote sessions connected: cloud-box, macbook."
    );
  });

  it("renders labels containing HTML tags as plain text without creating elements", () => {
    const status = document.getElementById("remote-link-status") as HTMLDivElement;

    renderRemoteLink({
      enabled: true,
      relayConnected: true,
      sessions: [{ label: "<img src=x onerror=alert(1)>", connectedAt: 100 }],
    });

    expect(status.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(status.querySelector("img")).toBeNull();
  });
});

describe("remoteLinkSummary", () => {
  it("returns an empty string when link is undefined", () => {
    expect(remoteLinkSummary(undefined)).toBe("");
  });

  it("returns ' Remote link: off.' when link is disabled", () => {
    expect(
      remoteLinkSummary({
        enabled: false,
        relayConnected: false,
        sessions: [],
      })
    ).toBe(" Remote link: off.");
  });

  it("returns summary with session count when enabled", () => {
    expect(
      remoteLinkSummary({
        enabled: true,
        relayConnected: true,
        sessions: [],
      })
    ).toBe(" Remote link: on (0 remote session(s)).");

    expect(
      remoteLinkSummary({
        enabled: true,
        relayConnected: true,
        sessions: [
          { label: "s1", connectedAt: 1 },
          { label: "s2", connectedAt: 2 },
        ],
      })
    ).toBe(" Remote link: on (2 remote session(s)).");
  });
});
