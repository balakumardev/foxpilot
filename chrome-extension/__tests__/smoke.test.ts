import browser from "webextension-polyfill";

describe("test harness smoke check", () => {
  it("exposes the same mock via the global and the polyfill import", () => {
    expect((global as any).browser).toBe(browser);
    expect((global as any).chrome).toBe(browser);
  });

  it("exposes the MV3 APIs the Chrome port uses", () => {
    // `offscreen` is a Chrome-only MV3 surface the webextension-polyfill `Browser`
    // type does not declare, so reach it through `any` — the same cast the
    // production call site uses (`(chrome as any).offscreen` in message-handler.ts).
    const offscreen = (browser as any).offscreen;
    expect(typeof browser.scripting.registerContentScripts).toBe("function");
    expect(typeof offscreen.createDocument).toBe("function");
    expect(typeof offscreen.hasDocument).toBe("function");
    expect(offscreen.Reason.BLOBS).toBe("BLOBS");
    expect(typeof browser.alarms.create).toBe("function");
    expect(typeof browser.declarativeNetRequest.updateSessionRules).toBe("function");
    expect(typeof browser.permissions.request).toBe("function");
    expect(typeof browser.storage.local.remove).toBe("function");
  });

  it("config helpers read from the mocked storage", async () => {
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089] },
    });
    const { getSecret } = await import("../extension-config");
    expect(await getSecret()).toBe("s");
  });
});
