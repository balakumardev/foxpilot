/**
 * "Why will this tab not let FoxPilot in" through the real MessageHandler
 * (Firefox build). The same trio as the Chrome test (stale tab / ungranted host /
 * fresh tab), restricted pages refused before any permission call, and the
 * fallbacks.
 *
 * UNVERIFIED: the refusal strings Firefox itself produces were not observed (the
 * probe in test-fixtures/browser-probe drives Chromium). `Missing host permission
 * for the tab` is the long-standing Firefox text; the shared matcher is defensive
 * and a refusal it does not recognise passes through untouched, which the last
 * test pins. Hosts and tokens are fake.
 */
import { MessageHandler } from "../message-handler";
import type { ExtensionTransport } from "../transport";
import type { ServerMessageRequest } from "@foxpilot/common";

jest.mock("../native-input-client", () => ({
  NativeInputClient: jest.fn().mockImplementation(() => ({ sendGesture: jest.fn() })),
}));

const FF_REFUSAL = "Missing host permission for the tab";
const APP_URL = "https://app.example.test/dash?token=fake-token-123#access_token=fake-token-123";
const OWN = "moz-extension://11111111-2222-3333-4444-555555555555";

const loadedTab = (url = APP_URL) => ({ id: 7, windowId: 1, url, status: "complete", discarded: false });
const discardedTab = (url = APP_URL) => ({ id: 7, windowId: 1, url, status: "complete", discarded: true });

const b = () => browser as any;
const mock = (fn: unknown) => fn as jest.Mock;

/** Answers `before` until a script has been injected into the tab, then `after`. */
function afterInjection<T>(before: T, after: T | Error | "hang"): jest.Mock {
  return jest.fn(async () => {
    const answer = mock(b().tabs.executeScript).mock.calls.length > 0 ? after : before;
    if (answer === "hang") return new Promise(() => undefined);
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

describe("tab access diagnosis through the handler (firefox)", () => {
  let handler: MessageHandler;
  let transport: jest.Mocked<ExtensionTransport>;

  const config = (extra: Record<string, unknown> = {}) => ({
    config: {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      toolSettings: {},
      ...extra,
    },
  });

  const getContent = (tabId = 7, extra: Record<string, unknown> = {}) =>
    handler.handleDecodedMessage({
      cmd: "get-tab-content",
      tabId,
      correlationId: "c1",
      ...extra,
    } as ServerMessageRequest);

  beforeEach(() => {
    jest.clearAllMocks();
    for (const fn of [
      b().tabs.get,
      b().tabs.create,
      b().tabs.update,
      b().tabs.reload,
      b().tabs.executeScript,
      b().permissions.contains,
      b().runtime.getURL,
    ]) {
      mock(fn).mockReset();
    }
    mock(b().tabs.create).mockResolvedValue({ id: 500 });
    mock(b().runtime.getURL).mockImplementation((p: string) => `${OWN}/${p}`);
    mock(b().storage.local.get).mockResolvedValue(config());
    transport = {
      sendResourceToServer: jest.fn().mockResolvedValue(undefined),
      sendErrorToServer: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ExtensionTransport>;
    handler = new MessageHandler(transport);
  });

  it("FRESH TAB: the success path is unchanged and diagnoses nothing", async () => {
    mock(b().tabs.get).mockResolvedValue(loadedTab());
    mock(b().permissions.contains).mockResolvedValue(true);
    mock(b().tabs.executeScript).mockResolvedValue([
      { isTruncated: false, fullText: "hello", links: [], totalLength: 5 },
    ]);

    await getContent();

    expect(transport.sendResourceToServer).toHaveBeenCalledWith(
      expect.objectContaining({ resource: "tab-content", fullText: "hello" })
    );
    expect(b().permissions.contains).toHaveBeenCalledTimes(1);
    expect(b().tabs.executeScript).toHaveBeenCalledTimes(1);
    expect(b().tabs.create).not.toHaveBeenCalled();
  });

  it("STALE TAB: a discarded tab the browser refuses says TAB DISCARDED and reloads nothing", async () => {
    mock(b().tabs.get).mockImplementation(afterInjection(loadedTab(), discardedTab()));
    mock(b().permissions.contains).mockResolvedValue(true);
    mock(b().tabs.executeScript).mockRejectedValue(new Error(FF_REFUSAL));

    const err = await getContent().catch((e) => e);

    expect(err.message).toMatch(/^TAB DISCARDED:/);
    expect(err.message).toContain("reloading loses nothing");
    expect(err.message).toContain("activateTab:true");
    expect(err.message).toContain("https://app.example.test");
    expect(err.message).not.toContain("fake-token-123");
    expect(err.message).toContain(`Original error: ${FF_REFUSAL}`);
    expect(b().tabs.reload).not.toHaveBeenCalled();
    expect(b().tabs.update).not.toHaveBeenCalled();
    expect(b().tabs.create).not.toHaveBeenCalled();
  });

  it("STALE TAB retried with activateTab:true: the message stops recommending activateTab", async () => {
    mock(b().tabs.get).mockImplementation(afterInjection(loadedTab(), discardedTab()));
    mock(b().tabs.query).mockResolvedValue([{ id: 99 }]);
    mock(b().permissions.contains).mockResolvedValue(true);
    mock(b().tabs.executeScript).mockRejectedValue(new Error(FF_REFUSAL));

    const err = await getContent(7, { activateTab: true }).catch((e) => e);

    expect(err.message).toMatch(/^TAB DISCARDED:/);
    expect(err.message).toContain("already passed activateTab:true");
  });

  it("UNGRANTED HOST at the gate: SITE ACCESS NOT GRANTED pointing at about:addons → FoxPilot → Permissions", async () => {
    mock(b().tabs.get).mockResolvedValue(loadedTab());
    mock(b().permissions.contains).mockResolvedValue(false);

    const err = await getContent().catch((e) => e);

    expect(err.message).toMatch(/^SITE ACCESS NOT GRANTED:/);
    expect(err.message).toContain("https://app.example.test");
    expect(err.message).toContain("about:addons → FoxPilot → Permissions");
    expect(err.message).not.toContain("chrome://extensions");
    expect(err.message).not.toContain("fake-token-123");
    expect(b().tabs.executeScript).not.toHaveBeenCalled();
    expect(b().tabs.create).toHaveBeenCalledWith({
      url: `${OWN}/options.html?requestUrl=${encodeURIComponent(APP_URL)}`,
    });
  });

  it("UNGRANTED HOST found after the browser refused", async () => {
    mock(b().tabs.get).mockResolvedValue(loadedTab());
    mock(b().permissions.contains).mockImplementation(afterInjection(true, false));
    mock(b().tabs.executeScript).mockRejectedValue(new Error(FF_REFUSAL));

    const err = await getContent().catch((e) => e);

    expect(err.message).toMatch(/^SITE ACCESS NOT GRANTED:/);
    expect(err.message).toContain(`Original error: ${FF_REFUSAL}`);
  });

  it("granted but refused, tab loaded, no other cause: TAB REFUSED ACCESS DESPITE GRANT and nothing invented", async () => {
    mock(b().tabs.get).mockResolvedValue(loadedTab());
    mock(b().permissions.contains).mockResolvedValue(true);
    mock(b().tabs.executeScript).mockRejectedValue(new Error(FF_REFUSAL));

    const err = await getContent().catch((e) => e);

    expect(err.message).toMatch(/^TAB REFUSED ACCESS DESPITE GRANT:/);
    for (const invented of ["unloaded this tab", "to save memory", "still loading"]) {
      expect(err.message).not.toContain(invented);
    }
  });

  it("a Mozilla site Firefox keeps closed to extensions is named as restricted, only after the browser refused it", async () => {
    mock(b().tabs.get).mockResolvedValue(loadedTab("https://addons.mozilla.org/en-US/firefox/"));
    mock(b().permissions.contains).mockResolvedValue(true);
    mock(b().tabs.executeScript).mockRejectedValue(new Error(FF_REFUSAL));

    const err = await getContent().catch((e) => e);

    expect(err.message).toMatch(/^TAB NOT SCRIPTABLE \(restricted page\):/);
    expect(err.message).toContain("a Mozilla site that Firefox keeps closed to extensions");
    // The gate did not pre-judge it: the injection was attempted.
    expect(b().tabs.executeScript).toHaveBeenCalledTimes(1);
  });

  describe("restricted pages are refused before any permission call", () => {
    it.each([
      ["about:blank"],
      ["about:addons"],
      ["view-source:https://app.example.test/page?token=fake-token-123"],
      ["data:text/html,<p>fake-token-123</p>"],
      ["moz-extension://99999999-2222-3333-4444-555555555555/options.html"],
    ])("%s", async (url) => {
      mock(b().tabs.get).mockResolvedValue(loadedTab(url));
      mock(b().permissions.contains).mockResolvedValue(false);

      const err = await getContent().catch((e) => e);

      expect(err.message).toMatch(/^TAB NOT SCRIPTABLE \(restricted page\):/);
      expect(err.message).not.toContain("fake-token-123");
      expect(b().permissions.contains).not.toHaveBeenCalled();
      expect(b().tabs.create).not.toHaveBeenCalled();
      expect(b().tabs.executeScript).not.toHaveBeenCalled();
    });

    it("file: with file access off names the permission; with it on the call goes through", async () => {
      mock(b().tabs.get).mockResolvedValue(loadedTab("file:///tmp/page.html"));
      mock(b().permissions.contains).mockResolvedValue(false);
      const off = await getContent().catch((e) => e);
      expect(off.message).toMatch(/^TAB NOT SCRIPTABLE \(file: URL\):/);
      expect(off.message).toContain("about:addons → FoxPilot → Permissions");
      expect(b().tabs.create).not.toHaveBeenCalled();

      mock(b().permissions.contains).mockResolvedValue(true);
      mock(b().tabs.executeScript).mockResolvedValue([
        { isTruncated: false, fullText: "local", links: [], totalLength: 5 },
      ]);
      await getContent();
      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({ resource: "tab-content", fullText: "local" })
      );
    });

    it("the extension's own moz-extension page is not pre-judged as restricted (the old flow decides)", async () => {
      mock(b().tabs.get).mockResolvedValue(loadedTab(`${OWN}/options.html`));
      mock(b().permissions.contains).mockResolvedValue(true);
      mock(b().tabs.executeScript).mockResolvedValue([
        { isTruncated: false, fullText: "own", links: [], totalLength: 3 },
      ]);
      await getContent();
      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({ resource: "tab-content", fullText: "own" })
      );
    });

    it("a tab that has no URL yet is let through, as before", async () => {
      mock(b().tabs.get).mockResolvedValue({ id: 7, url: "", status: "loading" });
      mock(b().tabs.executeScript).mockResolvedValue([
        { isTruncated: false, fullText: "", links: [], totalLength: 0 },
      ]);
      await getContent();
      expect(b().permissions.contains).not.toHaveBeenCalled();
    });
  });

  describe("when the diagnosis itself cannot read the browser", () => {
    it("tabs.get rejecting: the browser's own message and a note, never a guess", async () => {
      mock(b().tabs.get).mockImplementation(afterInjection(loadedTab(), new Error("Invalid tab ID: 7")));
      mock(b().permissions.contains).mockResolvedValue(true);
      mock(b().tabs.executeScript).mockRejectedValue(new Error(FF_REFUSAL));

      const err = await getContent().catch((e) => e);

      expect(err.message).toContain(FF_REFUSAL);
      expect(err.message).toContain("could not inspect the tab");
      expect(err.message).not.toMatch(/^(TAB|SITE)/);
    });

    it("tabs.get hanging: gives up inside the budget", async () => {
      mock(b().tabs.get).mockImplementation(afterInjection(loadedTab(), "hang"));
      mock(b().permissions.contains).mockResolvedValue(true);
      mock(b().tabs.executeScript).mockRejectedValue(new Error(FF_REFUSAL));

      const started = Date.now();
      const err = await getContent().catch((e) => e);

      expect(Date.now() - started).toBeLessThan(3000);
      expect(err.message).toContain("could not inspect the tab");
    });

    it.each([
      ["rejecting", new Error("denied")],
      ["hanging", "hang" as const],
    ])("permissions.contains %s: no cause is claimed", async (_label, failure) => {
      mock(b().tabs.get).mockResolvedValue(loadedTab());
      mock(b().permissions.contains).mockImplementation(afterInjection(true, failure));
      mock(b().tabs.executeScript).mockRejectedValue(new Error(FF_REFUSAL));

      const err = await getContent().catch((e) => e);

      expect(err.message).toContain("could not inspect the tab");
      expect(err.message).not.toMatch(/^(TAB|SITE)/);
    });

    it("a refusal it does not recognise (and a closed tab) passes through as the very same object", async () => {
      mock(b().tabs.get).mockResolvedValue(loadedTab());
      mock(b().permissions.contains).mockResolvedValue(true);
      for (const message of ["Invalid tab ID: 7", "something else entirely"]) {
        const boom = new Error(message);
        mock(b().tabs.executeScript).mockRejectedValue(boom);
        await expect(getContent()).rejects.toBe(boom);
      }
    });
  });
});
