/**
 * navigate-tab must report the URL the tab ACTUALLY navigated to — never the
 * URL it was on before the navigation.
 *
 * Unlike navigate-tab.test.ts this file does NOT mock nav-ready: the settle
 * logic under test lives there. The fake tab below replays the tabs API the way
 * real Chromium (149, recorded with a probe extension) behaves:
 *
 *  - tabs.update() resolves BEFORE the navigation commits, with
 *    status:"loading", url = the OLD url and pendingUrl = the new one.
 *  - onUpdated fires nothing until the commit, then {status:"loading", url}
 *    (url only when it changed), then {status:"complete"}.
 *  - A redirect commits straight to the final url.
 *  - A navigation that never commits (204, download) fires NO event at all: the
 *    tab just drops pendingUrl and goes back to status:"complete" on the old url.
 */
jest.mock("../native-input-client", () => ({
  NativeInputClient: jest.fn().mockImplementation(() => ({ sendGesture: jest.fn() })),
}));
jest.mock("../cdp-eval", () => ({ cdpEval: jest.fn() }));

import { mockBrowser } from "./setup";
import { MessageHandler } from "../message-handler";
import type { ExtensionTransport } from "../transport";
import type { ServerMessageRequest } from "@foxpilot/common";

const TAB = 7;
const OLD = "https://app.example.com/dashboard";
const NEW = "https://app.example.com/settings";

type TabState = { url: string; status: "loading" | "complete"; pendingUrl?: string };
// `close` makes the tab disappear (tabs.get rejects from then on); `replacedBy`
// additionally fires tabs.onReplaced(replacedBy, TAB) first, as Chrome does when
// it swaps a tab's contents into a new tab id.
type Step = {
  at: number;
  set?: Partial<TabState>;
  event?: Record<string, string>;
  close?: true;
  replacedBy?: number;
};
type Listener = (id: number, info: Record<string, string>, tab: object) => void;
type ReplacedListener = (addedTabId: number, removedTabId: number) => void;

const timers: ReturnType<typeof setTimeout>[] = [];

// A single fake tab: tabs.get reads its live state, onUpdated delivers the
// scheduled events, and tabs.update registers the navigation synchronously
// (status "loading" + pendingUrl, like Chromium) before `timeline` plays out on
// real timers.
function fakeTab(initial: TabState, timeline: Step[]) {
  const state: TabState = { ...initial };
  const listeners: Listener[] = [];
  const replacedListeners: ReplacedListener[] = [];
  let closed = false;
  (mockBrowser as any).tabs.onUpdated = {
    addListener: (l: Listener) => listeners.push(l),
    removeListener: (l: Listener) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  (mockBrowser as any).tabs.onReplaced = {
    addListener: (l: ReplacedListener) => replacedListeners.push(l),
    removeListener: (l: ReplacedListener) => {
      const i = replacedListeners.indexOf(l);
      if (i >= 0) replacedListeners.splice(i, 1);
    },
  };
  const snapshot = () => {
    const tab: Record<string, unknown> = { id: TAB, url: state.url, status: state.status };
    if (state.pendingUrl) tab.pendingUrl = state.pendingUrl;
    return tab;
  };
  (mockBrowser.tabs.get as jest.Mock).mockImplementation(async (id: number) => {
    if (closed) throw new Error(`No tab with id: ${id}.`);
    return snapshot();
  });
  // The content script of whichever document is live answers the ping — the
  // old page included, until the new one commits.
  (mockBrowser.scripting.executeScript as jest.Mock).mockResolvedValue([]);
  (mockBrowser.tabs.sendMessage as jest.Mock).mockResolvedValue({ ok: true });
  (mockBrowser.tabs.update as jest.Mock).mockImplementation(async (_id: number, props: { url: string }) => {
    Object.assign(state, { status: "loading", pendingUrl: props.url });
    for (const step of timeline) {
      timers.push(
        setTimeout(() => {
          Object.assign(state, step.set);
          if (step.replacedBy !== undefined) {
            const added = step.replacedBy;
            replacedListeners.slice().forEach((l) => l(added, TAB));
          }
          if (step.close || step.replacedBy !== undefined) closed = true;
          if (step.event) {
            const info = step.event;
            listeners.slice().forEach((l) => l(TAB, info, snapshot()));
          }
        }, step.at)
      );
    }
    return snapshot();
  });
  return { state, listeners, replacedListeners };
}

function makeTransport(): jest.Mocked<ExtensionTransport> {
  return {
    sendResourceToServer: jest.fn().mockResolvedValue(undefined),
    sendErrorToServer: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ExtensionTransport>;
}

function navigate(extra: Record<string, unknown> = {}): ServerMessageRequest {
  return { cmd: "navigate-tab", tabId: TAB, url: NEW, correlationId: "c1", ...extra } as any;
}

// Verbatim the template every mcp-server before 213aa14 rendered a
// navigate-tab reply with: it knows nothing of committed/pendingUrl/mismatch.
// Extensions update from the stores while npm installs stay pinned, so an old
// server meets a new extension, and the reply's `url` alone must still carry
// what matters.
function renderedByOldServer(requested: string, reply: { tabId: number; url?: string }): string {
  return `Navigated tab ${reply.tabId} to ${reply.url ?? requested}`;
}

describe("chrome navigate-tab reports the navigated-to url, never the old one", () => {
  let handler: MessageHandler;
  let transport: jest.Mocked<ExtensionTransport>;

  beforeEach(() => {
    jest.clearAllMocks();
    transport = makeTransport();
    handler = new MessageHandler(transport);
    (mockBrowser.storage.local.get as jest.Mock).mockResolvedValue({
      config: { secret: "s", ports: [8089], domainDenyList: [], auditLog: [], toolSettings: {}, automationMode: true },
    });
  });

  afterEach(() => {
    while (timers.length) clearTimeout(timers.pop());
  });

  it("reports the committed url of an ordinary navigation", async () => {
    const tab = fakeTab({ url: OLD, status: "complete" }, [
      { at: 20, set: { url: NEW, pendingUrl: undefined }, event: { status: "loading", url: NEW } },
      { at: 30, set: { status: "complete" }, event: { status: "complete" } },
    ]);

    await handler.handleDecodedMessage(navigate());

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: NEW,
    });
    expect(tab.listeners).toHaveLength(0);
  });

  it("reports where a server redirect landed", async () => {
    const FINAL = "https://app.example.com/login";
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 20, set: { url: FINAL, pendingUrl: undefined }, event: { status: "loading", url: FINAL } },
      { at: 30, set: { status: "complete" }, event: { status: "complete" } },
    ]);

    await handler.handleDecodedMessage(navigate());

    const sent = (transport.sendResourceToServer as jest.Mock).mock.calls[0][0];
    expect(sent.url).toBe(FINAL);
    expect(sent.committed).toBeUndefined();
  });

  it("still counts a redirect that lands back on the page it left as navigated", async () => {
    // e.g. /logout → 302 → the page the tab was already on. Chromium reports
    // the commit as {status:"loading"} with NO url, since the url did not change.
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 20, set: { pendingUrl: undefined }, event: { status: "loading" } },
      { at: 30, set: { status: "complete" }, event: { status: "complete" } },
    ]);

    await handler.handleDecodedMessage(navigate());

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: OLD,
    });
  });

  it("says the navigation did not commit when it ends without a new page (204 / download)", async () => {
    // Chromium fires NO onUpdated event here — the tab silently drops
    // pendingUrl and returns to status:"complete" on the old url.
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 20, set: { status: "complete", pendingUrl: undefined } },
    ]);

    const started = Date.now();
    await handler.handleDecodedMessage(navigate({ timeoutMs: 3000 }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: OLD,
      committed: false,
    });
    // The browser already said the navigation was over; waiting out the whole
    // settle budget for an event that never comes is pure dead time.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("reports the destination when the commit lands after the settle window, while a waitFor* condition is still polling", async () => {
    const tab = fakeTab({ url: OLD, status: "complete" }, [
      { at: 1200, set: { url: NEW, pendingUrl: undefined }, event: { status: "loading", url: NEW } },
      { at: 1220, set: { status: "complete" }, event: { status: "complete" } },
    ]);
    // waitForText is only met once the new page is in.
    (mockBrowser.scripting.executeScript as jest.Mock).mockImplementation(async (d: { func?: unknown }) =>
      d.func ? [{ result: tab.state.url === NEW }] : []
    );

    await handler.handleDecodedMessage(navigate({ timeoutMs: 1000, waitForText: "Settings" }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: NEW,
    });
  });

  it("does not claim a reload of the current url happened before it commits", async () => {
    fakeTab({ url: NEW, status: "complete" }, [
      { at: 5000, set: { pendingUrl: undefined }, event: { status: "loading" } },
    ]);

    await handler.handleDecodedMessage(navigate({ timeoutMs: 200 }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: NEW,
      committed: false,
      pendingUrl: NEW,
    });
  });

  it("never reports a url the page being LEFT gave itself as the destination", async () => {
    // The old page's router rewrites its own url while ours is pending (the
    // event's tab still carries our pendingUrl), then ours ends without a page.
    const REWRITTEN = OLD + "#tab2";
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 20, set: { url: REWRITTEN }, event: { status: "loading", url: REWRITTEN } },
      { at: 40, set: { status: "complete", pendingUrl: undefined } },
    ]);

    await handler.handleDecodedMessage(navigate({ timeoutMs: 3000 }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: REWRITTEN,
      committed: false,
    });
  });

  it("never reports the old page's own rewritten url as the destination while ours is still in flight", async () => {
    const REWRITTEN = OLD + "#tab2";
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 20, set: { url: REWRITTEN }, event: { status: "loading", url: REWRITTEN } },
      { at: 5000, set: { url: NEW, pendingUrl: undefined }, event: { status: "loading", url: NEW } },
    ]);

    await handler.handleDecodedMessage(navigate({ timeoutMs: 200 }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: REWRITTEN,
      committed: false,
      pendingUrl: NEW,
    });
  });

  it("reports a reload of the current url as navigated when it commits during the waitFor* poll", async () => {
    const tab = fakeTab({ url: NEW, status: "complete" }, [
      { at: 1200, set: { pendingUrl: undefined }, event: { status: "loading" } },
      { at: 1220, set: { status: "complete" }, event: { status: "complete" } },
    ]);
    // waitForText is only met once the reloaded page is in.
    (mockBrowser.scripting.executeScript as jest.Mock).mockImplementation(async (d: { func?: unknown }) =>
      d.func ? [{ result: tab.state.pendingUrl === undefined }] : []
    );

    await handler.handleDecodedMessage(navigate({ timeoutMs: 1000, waitForText: "Settings" }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: NEW,
    });
  });

  it("fails clearly when the tab is closed mid-navigation, instead of claiming it arrived", async () => {
    fakeTab({ url: OLD, status: "complete" }, [{ at: 20, close: true }]);

    const started = Date.now();
    await expect(handler.handleDecodedMessage(navigate({ timeoutMs: 3000 }))).rejects.toThrow(
      /tab 7 was closed/i
    );
    expect(transport.sendResourceToServer).not.toHaveBeenCalled();
    // Nothing is left to wait for once the tab is gone.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("names the tab that replaced ours mid-navigation", async () => {
    const tab = fakeTab({ url: OLD, status: "complete" }, [{ at: 20, replacedBy: 12 }]);

    await expect(handler.handleDecodedMessage(navigate({ timeoutMs: 3000 }))).rejects.toThrow(
      /tab 7 was replaced by tab 12/i
    );
    expect(tab.replacedListeners).toHaveLength(0);
  });

  it("does not claim a destination for a tab that has never committed any page", async () => {
    // A brand-new tab has url "" until its first commit (it shows the initial
    // empty document, about:blank); ours then outlasts the wait.
    fakeTab({ url: "", status: "loading", pendingUrl: "https://app.example.com/start" }, [
      { at: 5000, set: { url: NEW, pendingUrl: undefined }, event: { status: "loading", url: NEW } },
    ]);

    await handler.handleDecodedMessage(navigate({ timeoutMs: 200 }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: "about:blank",
      committed: false,
      pendingUrl: NEW,
    });
    // An older server must not print a sentence that ends in nothing.
    const sent = (transport.sendResourceToServer as jest.Mock).mock.calls[0][0];
    expect(renderedByOldServer(NEW, sent)).toBe("Navigated tab 7 to about:blank");
  });

  it("still folds a waitFor* mismatch into the url when the navigation did not commit, so an older server shows it", async () => {
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 5000, set: { url: NEW, pendingUrl: undefined }, event: { status: "loading", url: NEW } },
    ]);
    (mockBrowser.scripting.executeScript as jest.Mock).mockImplementation(async (d: { func?: unknown }) =>
      d.func ? [{ result: false }] : []
    );

    await handler.handleDecodedMessage(navigate({ timeoutMs: 300, waitForText: "Create Token" }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: `${OLD} — expected text "Create Token" not found`,
      committed: false,
      pendingUrl: NEW,
      mismatch: 'expected text "Create Token" not found',
    });
    const sent = (transport.sendResourceToServer as jest.Mock).mock.calls[0][0];
    expect(renderedByOldServer(NEW, sent)).toBe(
      'Navigated tab 7 to https://app.example.com/dashboard — expected text "Create Token" not found'
    );
  });

  it("stops waiting, and does not claim it is still loading, once the navigation is over but a stale pendingUrl lingers", async () => {
    // Defensive: not observed on Chromium 149 (a 204 from the New Tab page
    // drops pendingUrl within ~60ms), but a build that kept the pending entry
    // after the navigation ended must neither stall the wait nor be described
    // as still loading.
    fakeTab({ url: OLD, status: "complete" }, [{ at: 20, set: { status: "complete" } }]);

    const started = Date.now();
    await handler.handleDecodedMessage(navigate({ timeoutMs: 3000 }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: OLD,
      committed: false,
    });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("does not credit the page being left with a url change it makes after our navigation ended without a page", async () => {
    const LATER = OLD + "#later";
    fakeTab({ url: OLD, status: "complete" }, [
      // Ours ends without a page (204 / download): Chromium fires no event.
      { at: 20, set: { status: "complete", pendingUrl: undefined } },
      // Then, while a waitFor* condition is still polling, the old page's
      // router changes its own url.
      { at: 300, set: { url: LATER }, event: { status: "loading", url: LATER } },
      { at: 310, event: { status: "complete" } },
    ]);
    (mockBrowser.scripting.executeScript as jest.Mock).mockImplementation(async (d: { func?: unknown }) =>
      d.func ? [{ result: false }] : []
    );

    await handler.handleDecodedMessage(navigate({ timeoutMs: 800, waitForText: "Settings" }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: `${LATER} — expected text "Settings" not found`,
      committed: false,
      mismatch: 'expected text "Settings" not found',
    });
  });

  it("does not credit the page being left with a url change it makes after ours ended without a page, when that end came after the settle window", async () => {
    const LATER = OLD + "#later";
    fakeTab({ url: OLD, status: "complete" }, [
      // Ours outlasts the settle window (700ms), then ends without a page
      // while the waitFor* poll runs: Chromium fires no event for that.
      { at: 900, set: { status: "complete", pendingUrl: undefined } },
      // Then the old page's router changes its own url.
      { at: 1100, set: { url: LATER }, event: { status: "loading", url: LATER } },
      { at: 1110, event: { status: "complete" } },
    ]);
    (mockBrowser.scripting.executeScript as jest.Mock).mockImplementation(async (d: { func?: unknown }) =>
      d.func ? [{ result: false }] : []
    );

    await handler.handleDecodedMessage(navigate({ timeoutMs: 700, waitForText: "Settings" }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: `${LATER} — expected text "Settings" not found`,
      committed: false,
      mismatch: 'expected text "Settings" not found',
    });
  });

  it("does not wait out the budget probing a page that cannot be scripted when nothing committed", async () => {
    // Recorded on Chromium 149: a 204 from the New Tab page. The tab stays on
    // chrome://newtab/, where no content script can run, so the readiness
    // ping can never answer.
    fakeTab({ url: "chrome://newtab/", status: "complete" }, [
      { at: 20, set: { status: "complete", pendingUrl: undefined } },
    ]);
    (mockBrowser.scripting.executeScript as jest.Mock).mockRejectedValue(
      new Error("Cannot access a chrome:// URL")
    );
    (mockBrowser.tabs.sendMessage as jest.Mock).mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );

    const started = Date.now();
    await handler.handleDecodedMessage(navigate({ timeoutMs: 3000 }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: "chrome://newtab/",
      committed: false,
    });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("says the navigation has not committed yet when it outlasts the wait, naming the pending url", async () => {
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 5000, set: { url: NEW, pendingUrl: undefined }, event: { status: "loading", url: NEW } },
    ]);

    await handler.handleDecodedMessage(navigate({ timeoutMs: 200 }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: OLD,
      committed: false,
      pendingUrl: NEW,
    });
  });
});
