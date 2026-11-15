import {
  hasAllSitesAccess,
  automationToggleView,
  allSitesRequestUrl,
  allSitesMissingMessage,
  MISSING_ACCESS_WARNING,
} from "../all-sites-access";

describe("hasAllSitesAccess", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("asks the browser about <all_urls> specifically", async () => {
    (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
    await expect(hasAllSitesAccess()).resolves.toBe(true);
    expect(browser.permissions.contains).toHaveBeenCalledWith({
      origins: ["<all_urls>"],
    });
  });

  it("is false when the browser holds only specific sites", async () => {
    (browser.permissions.contains as jest.Mock).mockResolvedValue(false);
    await expect(hasAllSitesAccess()).resolves.toBe(false);
  });

  it("is false (never throws) when the permissions API rejects", async () => {
    (browser.permissions.contains as jest.Mock).mockRejectedValue(
      new Error("boom")
    );
    await expect(hasAllSitesAccess()).resolves.toBe(false);
  });
});

describe("automationToggleView", () => {
  it("shows OFF with no warning when Automation Mode is off", () => {
    expect(automationToggleView(false, false)).toEqual({
      checked: false,
      warning: null,
    });
    expect(automationToggleView(false, true)).toEqual({
      checked: false,
      warning: null,
    });
  });

  it("shows ON only when the flag AND the browser permission are both present", () => {
    expect(automationToggleView(true, true)).toEqual({
      checked: true,
      warning: null,
    });
  });

  it("shows OFF with a warning when the flag is on but the browser grant is missing", () => {
    expect(automationToggleView(true, false)).toEqual({
      checked: false,
      warning: MISSING_ACCESS_WARNING,
    });
  });
});

describe("allSitesRequestUrl", () => {
  it("points the options page at the all-sites request modal", () => {
    expect(allSitesRequestUrl("chrome-extension://abc/options.html")).toBe(
      "chrome-extension://abc/options.html?requestAllSites=1"
    );
  });
});

describe("allSitesMissingMessage", () => {
  it("names the origin, the cause and the one-click remedy", () => {
    const msg = allSitesMissingMessage("https://example.com");
    expect(msg).toContain("https://example.com");
    expect(msg).toContain("Automation Mode is on");
    expect(msg).toContain("all sites");
    expect(msg).toContain("Site access");
  });
});
