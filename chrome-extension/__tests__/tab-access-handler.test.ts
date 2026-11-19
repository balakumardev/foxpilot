/**
 * "Why will this tab not let FoxPilot in" through the real MessageHandler.
 *
 * The user report: on a tab that was about 21 h old, take-snapshot and
 * evaluate-script failed with the browser's "Cannot access contents of the page.
 * Extension manifest must request permission to access the respective host." even
 * though site access was "On all sites"; a fresh tab on the same host worked. That
 * string is what a DISCARDED tab produces. These tests pin the trio that has to
 * stay apart (stale tab / ungranted host / fresh tab), the restricted pages that
 * must be refused before any permission call, and the fallbacks.
 *
 * The browser strings are the ones observed in Chromium 140
 * (test-fixtures/browser-probe/OBSERVED.json cases 1 and 5); hosts and tokens are fake.
 */
import { MessageHandler, sendMessageToTab } from "../message-handler";
import type { ExtensionTransport } from "../transport";
import type { ServerMessageRequest } from "@foxpilot/common";
import { waitForTabReady } from "../nav-ready";

jest.mock("../native-input-client", () => ({
  NativeInputClient: jest.fn().mockImplementation(() => ({ sendGesture: jest.fn() })),
}));
jest.mock("../cdp-eval", () => ({ cdpEval: jest.fn() }));
// The real readiness wait is covered by nav-ready.test.ts. Mocked here so a test can
// assert it was NOT entered (an unloaded tab has nothing to wait for).
jest.mock("../nav-ready", () => ({
  ...jest.requireActual("../nav-ready"),
  waitForTabReady: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../viewport-capture", () => ({
  ...jest.requireActual("../viewport-capture"),
  CAPTURE_MIN_GAP_MS: 0,
}));

const S1 =
  'Cannot access contents of url "https://app.example.test/dash?token=fake-token-123#access_token=fake-token-123". Extension manifest must request permission to access this host.';
const S2 =
  "Cannot access contents of the page. Extension manifest must request permission to access the respective host.";
const RECEIVING_END = "Could not establish connection. Receiving end does not exist.";

const APP_URL = "https://app.example.test/dash?token=fake-token-123#access_token=fake-token-123";
const loadedTab = (url = APP_URL) => ({ id: 7, windowId: 1, url, status: "complete", discarded: false });
const unloadedTab = (url = APP_URL) => ({ id: 7, windowId: 1, url, status: "unloaded", discarded: true });

const b = () => browser as any;
const mock = (fn: unknown) => fn as jest.Mock;

function makeTransport(): jest.Mocked<ExtensionTransport> {
  return {
    sendResourceToServer: jest.fn().mockResolvedValue(undefined),
    sendErrorToServer: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ExtensionTransport>;
}

/**
 * Answers `before` until the first command has been dispatched to the tab
 * (tabs.sendMessage called), then `after`. The audit log, the gate and the
 * diagnosis all read the tab, so a call-count based script would be brittle; the
 * state of the world is what changes. `after` may be an Error (rejects) or "hang".
 */
function afterDispatch<T>(before: T, after: T | Error | "hang"): jest.Mock {
  return jest.fn(async () => {
    const answer = mock(b().tabs.sendMessage).mock.calls.length > 0 ? after : before;
    if (answer === "hang") return new Promise(() => undefined);
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

describe("tab access diagnosis through the handler (chrome)", () => {
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

  // select-option requires Automation Mode; its gate then asks for the all-sites grant.
  const selectOption = (tabId = 7, extra: Record<string, unknown> = {}) => {
    mock(b().storage.local.get).mockResolvedValue(config({ automationMode: true }));
    return handler.handleDecodedMessage({
      cmd: "select-option",
      tabId,
      uid: "e1",
      option: "x",
      correlationId: "c2",
      ...extra,
    } as ServerMessageRequest);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    for (const fn of [
      b().tabs.get,
      b().tabs.create,
      b().tabs.update,
      b().tabs.reload,
      b().tabs.query,
      b().tabs.sendMessage,
      b().permissions.contains,
      b().scripting.executeScript,
    ]) {
      mock(fn).mockReset();
    }
    mock(b().tabs.query).mockResolvedValue([]);
    mock(b().tabs.create).mockResolvedValue({ id: 500 });
    mock(b().tabs.update).mockResolvedValue(undefined);
    mock(b().scripting.executeScript).mockResolvedValue([]);
    mock(waitForTabReady).mockResolvedValue(undefined);
    mock(b().storage.local.get).mockResolvedValue(config());
    b().tabs.onUpdated = { addListener: jest.fn(), removeListener: jest.fn() };
    transport = makeTransport();
    handler = new MessageHandler(transport);
  });

  describe("the trio: fresh tab / stale tab / ungranted host", () => {
    it("FRESH TAB: the success path is unchanged and diagnoses nothing", async () => {
      mock(b().tabs.get).mockResolvedValue(loadedTab());
      mock(b().permissions.contains).mockResolvedValue(true);
      mock(b().tabs.sendMessage).mockResolvedValue({
        isTruncated: false,
        fullText: "hello",
        links: [],
        totalLength: 5,
      });

      await getContent();

      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({ resource: "tab-content", fullText: "hello" })
      );
      // One permission lookup at the gate, no injection, no dialog, nothing diagnosed.
      expect(b().permissions.contains).toHaveBeenCalledTimes(1);
      expect(b().scripting.executeScript).not.toHaveBeenCalled();
      expect(b().tabs.create).not.toHaveBeenCalled();
    });

    it("STALE TAB: an unloaded tab with the granted host says TAB DISCARDED at once, without waiting for it", async () => {
      mock(b().tabs.get).mockResolvedValue(unloadedTab());
      mock(b().permissions.contains).mockResolvedValue(true); // "On all sites"
      mock(b().tabs.sendMessage).mockRejectedValue(new Error(RECEIVING_END));

      const err = await getContent().catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/^TAB DISCARDED:/);
      expect(err.message).toContain("reloading loses nothing");
      expect(err.message).toContain("activateTab:true");
      expect(err.message).toContain("https://app.example.test");
      expect(err.message).not.toContain("fake-token-123");
      expect(err.message).not.toContain("/dash");
      expect(err.message).toMatch(/Original error: Could not establish connection/);
      // The 8 s readiness wait is for a page that is on its way; this one is gone.
      expect(waitForTabReady).not.toHaveBeenCalled();
      expect(b().scripting.executeScript).not.toHaveBeenCalled();
      // FoxPilot never reloads or activates a tab on its own.
      expect(b().tabs.reload).not.toHaveBeenCalled();
      expect(b().tabs.update).not.toHaveBeenCalled();
      expect(b().tabs.create).not.toHaveBeenCalled();
    });

    it("STALE TAB, browser says S2 straight from the injection: the central catch reads the tab and says TAB DISCARDED", async () => {
      // Gate sees a loaded tab; by the time the browser refuses, the tab is unloaded.
      mock(b().tabs.get).mockImplementation(afterDispatch(loadedTab(), unloadedTab()));
      mock(b().permissions.contains).mockResolvedValue(true);
      mock(b().tabs.sendMessage).mockRejectedValue(new Error(RECEIVING_END));
      mock(b().scripting.executeScript).mockRejectedValue(new Error(S2));

      const err = await selectOption().catch((e) => e);

      expect(err.message).toMatch(/^TAB DISCARDED:/);
      expect(err.message).toContain(`Original error: ${S2}`);
      expect(b().tabs.reload).not.toHaveBeenCalled();
      expect(b().tabs.update).not.toHaveBeenCalled();
    });

    it("STALE TAB retried with activateTab:true that is still unloaded: the message stops recommending activateTab", async () => {
      mock(b().tabs.get).mockImplementation(afterDispatch(loadedTab(), unloadedTab()));
      mock(b().tabs.query).mockResolvedValue([{ id: 99 }]);
      mock(b().permissions.contains).mockResolvedValue(true);
      mock(b().tabs.sendMessage).mockRejectedValue(new Error(RECEIVING_END));
      mock(b().scripting.executeScript).mockRejectedValue(new Error(S2));

      const err = await selectOption(7, { activateTab: true }).catch((e) => e);

      expect(err.message).toMatch(/^TAB DISCARDED:/);
      expect(err.message).toContain("already passed activateTab:true");
    });

    it("UNGRANTED HOST at the gate: SITE ACCESS NOT GRANTED with the exact browser path, and the per-host dialog", async () => {
      mock(b().tabs.get).mockResolvedValue(loadedTab());
      mock(b().permissions.contains).mockResolvedValue(false);

      const err = await getContent().catch((e) => e);

      expect(err.message).toMatch(/^SITE ACCESS NOT GRANTED:/);
      expect(err.message).toContain("https://app.example.test");
      expect(err.message).toContain("chrome://extensions");
      expect(err.message).toContain("brave://extensions");
      expect(err.message).toContain("edge://extensions");
      expect(err.message).toContain('Site access → "On all sites"');
      expect(err.message).not.toContain("fake-token-123");
      expect(b().tabs.sendMessage).not.toHaveBeenCalled();
      expect(b().tabs.create).toHaveBeenCalledWith({
        url: "chrome-extension://test/options.html?requestUrl=" + encodeURIComponent(APP_URL),
      });
    });

    it("UNGRANTED HOST found after the browser refused (grant lost between gate and dispatch)", async () => {
      mock(b().tabs.get).mockResolvedValue(loadedTab());
      mock(b().permissions.contains).mockImplementation(afterDispatch(true, false));
      mock(b().tabs.sendMessage).mockRejectedValue(new Error(RECEIVING_END));
      mock(b().scripting.executeScript).mockRejectedValue(new Error(S1));

      const err = await selectOption().catch((e) => e);

      expect(err.message).toMatch(/^SITE ACCESS NOT GRANTED:/);
      expect(err.message).toContain("Original error: Cannot access contents of url");
      expect(err.message).not.toContain("fake-token-123");
    });

    it("granted but refused, tab loaded, no other cause: TAB REFUSED ACCESS DESPITE GRANT and nothing invented", async () => {
      mock(b().tabs.get).mockResolvedValue(loadedTab());
      mock(b().permissions.contains).mockResolvedValue(true);
      mock(b().tabs.sendMessage).mockRejectedValue(new Error(RECEIVING_END));
      mock(b().scripting.executeScript).mockRejectedValue(new Error(S1));

      const err = await selectOption().catch((e) => e);

      expect(err.message).toMatch(/^TAB REFUSED ACCESS DESPITE GRANT:/);
      expect(err.message).toContain("fresh tab on the same origin");
      for (const invented of ["Memory Saver", "unloaded this tab", "Allow access to file URLs", "still loading"]) {
        expect(err.message).not.toContain(invented);
      }
      expect(err.message).not.toContain("fake-token-123");
      expect(b().tabs.reload).not.toHaveBeenCalled();
    });

    it("a tab that is still loading says TAB STILL LOADING", async () => {
      mock(b().tabs.get).mockImplementation(
        afterDispatch(loadedTab(), { ...loadedTab(), status: "loading" })
      );
      mock(b().permissions.contains).mockResolvedValue(true);
      mock(b().tabs.sendMessage).mockRejectedValue(new Error(RECEIVING_END));
      mock(b().scripting.executeScript).mockRejectedValue(new Error(S2));

      const err = await selectOption().catch((e) => e);

      expect(err.message).toMatch(/^TAB STILL LOADING:/);
    });

    it("the browser's error page says so and is not blamed on permissions", async () => {
      mock(b().tabs.get).mockResolvedValue(loadedTab("http://127.0.0.1:1/"));
      mock(b().permissions.contains).mockResolvedValue(true);
      mock(b().tabs.sendMessage).mockRejectedValue(new Error(RECEIVING_END));
      mock(b().scripting.executeScript).mockRejectedValue(
        new Error("Frame with ID 0 is showing error page")
      );

      const err = await selectOption().catch((e) => e);

      expect(err.message).toMatch(/^TAB SHOWS A BROWSER ERROR PAGE:/);
      expect(err.message).toContain("not a permission problem");
    });
  });

  describe("restricted pages are refused before any permission call", () => {
    it.each([
      ["about:blank"],
      ["chrome://version/"],
      ["data:text/html,<p>fake-token-123</p>"],
      ["view-source:https://app.example.test/page?token=fake-token-123"],
      ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/public.html"],
      ["https://chromewebstore.google.com/detail/x/abc"],
    ])("%s", async (url) => {
      mock(b().tabs.get).mockResolvedValue(loadedTab(url));
      mock(b().permissions.contains).mockResolvedValue(false);

      for (const run of [() => getContent(), () => selectOption()]) {
        const err = await run().catch((e) => e);
        expect(err.message).toMatch(/^TAB NOT SCRIPTABLE \(restricted page\):/);
        expect(err.message).toContain("open-browser-tab");
        expect(err.message).not.toContain("fake-token-123");
      }
      // permissions.contains throws for an opaque origin; the dialog cannot help a page nothing can grant.
      expect(b().permissions.contains).not.toHaveBeenCalled();
      expect(b().tabs.create).not.toHaveBeenCalled();
      expect(b().tabs.sendMessage).not.toHaveBeenCalled();
      expect(b().scripting.executeScript).not.toHaveBeenCalled();
    });

    it("with Automation Mode on, a restricted page still gets no all-sites dialog", async () => {
      mock(b().storage.local.get).mockResolvedValue(config({ automationMode: true }));
      mock(b().tabs.get).mockResolvedValue(loadedTab("chrome://settings/"));
      mock(b().permissions.contains).mockResolvedValue(false);

      const err = await getContent().catch((e) => e);

      expect(err.message).toMatch(/^TAB NOT SCRIPTABLE \(restricted page\):/);
      expect(b().tabs.create).not.toHaveBeenCalled();
    });

    it("about:blank says it has no content and points at navigate-tab", async () => {
      mock(b().tabs.get).mockResolvedValue(loadedTab("about:blank"));
      const err = await getContent().catch((e) => e);
      expect(err.message).toContain("a blank page (about:blank)");
      expect(err.message).toContain("navigate-tab");
    });

    it("file: with file access off names the switch; with it on the call goes through", async () => {
      mock(b().tabs.get).mockResolvedValue(loadedTab("file:///tmp/page.html"));
      mock(b().permissions.contains).mockResolvedValue(false);
      const off = await getContent().catch((e) => e);
      expect(off.message).toMatch(/^TAB NOT SCRIPTABLE \(file: URL\):/);
      expect(off.message).toContain("Allow access to file URLs");
      expect(b().permissions.contains).toHaveBeenCalledWith({ origins: ["file:///*"] });
      expect(b().tabs.create).not.toHaveBeenCalled();

      mock(b().permissions.contains).mockResolvedValue(true);
      mock(b().tabs.sendMessage).mockResolvedValue({
        isTruncated: false,
        fullText: "local",
        links: [],
        totalLength: 5,
      });
      await getContent();
      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({ resource: "tab-content", fullText: "local" })
      );
    });

    it("a tab that has no URL yet (still opening) is let through, as before", async () => {
      mock(b().tabs.get).mockResolvedValue({ id: 7, url: "", pendingUrl: APP_URL, status: "loading" });
      mock(b().tabs.sendMessage).mockResolvedValue({
        isTruncated: false,
        fullText: "",
        links: [],
        totalLength: 0,
      });
      await getContent();
      expect(b().permissions.contains).not.toHaveBeenCalled();
      expect(transport.sendResourceToServer).toHaveBeenCalledWith(
        expect.objectContaining({ resource: "tab-content" })
      );
    });
  });

  describe("when the diagnosis itself cannot read the browser", () => {
    const refusedByInjection = () => {
      mock(b().tabs.sendMessage).mockRejectedValue(new Error(RECEIVING_END));
      mock(b().scripting.executeScript).mockRejectedValue(new Error(S1));
    };

    it("tabs.get rejecting: the browser's own message, redacted, and a note", async () => {
      mock(b().tabs.get).mockImplementation(afterDispatch(loadedTab(), new Error("No tab with id: 7.")));
      mock(b().permissions.contains).mockResolvedValue(true);
      refusedByInjection();

      const err = await selectOption().catch((e) => e);

      expect(err.message).toContain('Cannot access contents of url "https://app.example.test/dash?[redacted]#[redacted]"');
      expect(err.message).toContain("could not inspect the tab");
      expect(err.message).not.toContain("fake-token-123");
      expect(err.message).not.toMatch(/^(TAB|SITE)/);
    });

    it("tabs.get hanging: gives up inside the budget instead of hanging the command", async () => {
      mock(b().tabs.get).mockImplementation(afterDispatch(loadedTab(), "hang"));
      mock(b().permissions.contains).mockResolvedValue(true);
      refusedByInjection();

      const started = Date.now();
      const err = await selectOption().catch((e) => e);

      expect(Date.now() - started).toBeLessThan(3000);
      expect(err.message).toContain("could not inspect the tab");
      expect(err.message).not.toContain("fake-token-123");
    });

    it.each([
      ["rejecting", new Error("denied")],
      ["hanging", "hang" as const],
    ])("permissions.contains %s: no cause is claimed", async (_label, failure) => {
      mock(b().tabs.get).mockResolvedValue(loadedTab());
      mock(b().permissions.contains).mockImplementation(afterDispatch(true, failure));
      refusedByInjection();

      const err = await selectOption().catch((e) => e);

      expect(err.message).toContain("could not inspect the tab");
      expect(err.message).not.toMatch(/^(TAB|SITE)/);
      expect(err.message).not.toContain("fake-token-123");
    });

    it("an error that is not a page-access refusal passes through as the very same object", async () => {
      mock(b().tabs.get).mockResolvedValue(loadedTab());
      mock(b().permissions.contains).mockResolvedValue(true);
      const boom = new Error("something else entirely");
      mock(b().tabs.sendMessage).mockRejectedValue(boom);

      await expect(getContent()).rejects.toBe(boom);
    });

    it("an already diagnosed message is not diagnosed again", async () => {
      mock(b().tabs.get).mockResolvedValue(unloadedTab());
      mock(b().permissions.contains).mockResolvedValue(true);
      mock(b().tabs.sendMessage).mockRejectedValue(new Error(RECEIVING_END));

      const err = await getContent().catch((e) => e);

      // Diagnosed once (by the self-heal); the central catch left it alone.
      expect(err.message.match(/Original error:/g)).toHaveLength(1);
    });
  });
});

describe("sendMessageToTab self-heal (chrome)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const fn of [b().tabs.get, b().tabs.sendMessage, b().permissions.contains, b().scripting.executeScript]) {
      mock(fn).mockReset();
    }
    mock(b().scripting.executeScript).mockResolvedValue([]);
    mock(waitForTabReady).mockResolvedValue(undefined);
  });

  it("still re-injects the content script once for 'Receiving end does not exist' on a loaded, granted tab", async () => {
    let call = 0;
    mock(b().tabs.sendMessage).mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error(RECEIVING_END);
      return { ok: true, tree: "x" };
    });
    mock(b().tabs.get).mockResolvedValue(loadedTab("https://new.example.test/page"));
    mock(b().permissions.contains).mockResolvedValue(true);

    const result = await sendMessageToTab(7, { type: "buildSnapshot" });

    expect(result).toEqual({ ok: true, tree: "x" });
    expect(b().permissions.contains).toHaveBeenCalledWith({ origins: ["https://new.example.test/*"] });
    expect(waitForTabReady).toHaveBeenCalledWith(7, { timeoutMs: 8000 });
    expect(b().scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(b().scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["dist/content-script.js"],
    });
    expect(b().tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("proceeds with the re-injection when permissions.contains cannot be read", async () => {
    let call = 0;
    mock(b().tabs.sendMessage).mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error(RECEIVING_END);
      return { ok: true };
    });
    mock(b().tabs.get).mockResolvedValue(loadedTab("https://new.example.test/page"));
    mock(b().permissions.contains).mockRejectedValue(new Error("boom"));

    await expect(sendMessageToTab(7, { type: "ping" })).resolves.toEqual({ ok: true });
    expect(waitForTabReady).toHaveBeenCalledTimes(1);
  });

  it("a restricted live tab is reported at once: no permission call, no wait, no injection", async () => {
    mock(b().tabs.sendMessage).mockRejectedValue(new Error(RECEIVING_END));
    mock(b().tabs.get).mockResolvedValue(loadedTab("about:blank"));
    mock(b().permissions.contains).mockResolvedValue(false);

    const err = await sendMessageToTab(7, { type: "ping" }).catch((e) => e);

    expect(err.message).toMatch(/^TAB NOT SCRIPTABLE \(restricted page\):/);
    expect(b().permissions.contains).not.toHaveBeenCalled();
    expect(waitForTabReady).not.toHaveBeenCalled();
    expect(b().scripting.executeScript).not.toHaveBeenCalled();
  });

  it("widens the permission check to the browser's S1/S2 strings", async () => {
    for (const refusal of [S1, S2]) {
      mock(b().tabs.sendMessage).mockReset();
      mock(b().tabs.sendMessage).mockRejectedValue(new Error(refusal));
      mock(b().tabs.get).mockResolvedValue(unloadedTab());
      const err = await sendMessageToTab(7, { type: "ping" }).catch((e) => e);
      expect(err.message).toMatch(/^TAB DISCARDED:/);
    }
  });

  it("an unrelated error is rethrown untouched, with no tab lookup", async () => {
    const boom = new Error("nope");
    mock(b().tabs.sendMessage).mockRejectedValue(boom);
    await expect(sendMessageToTab(7, { type: "ping" })).rejects.toBe(boom);
    expect(b().tabs.get).not.toHaveBeenCalled();
  });
});
