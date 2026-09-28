/**
 * navigate-tab must report the URL the tab ACTUALLY navigated to — never the
 * URL it was on before the navigation.
 *
 * Unlike navigate-tab.test.ts this file does NOT mock nav-ready: the settle
 * logic under test lives there. The fake tab below replays the tabs API the way
 * real Firefox (151, headless, recorded with a probe extension) behaves:
 *
 *  - tabs.update() resolves BEFORE the navigation has even started: it reports
 *    status:"complete" and the OLD url, and an immediate tabs.get() can still
 *    say the same thing.
 *  - onUpdated then fires {status:"loading"} with NO url when the load starts
 *    (tab.url is still the old one), {status:"loading", url} when it commits,
 *    and {status:"complete"} when it finishes.
 *  - The old document keeps answering tabs.executeScript until the commit.
 *  - A load that never commits (204, download) fires loading → complete with no
 *    url, and the tab stays on the old page.
 *  - Navigating while the previous load is still in flight first fires a
 *    {status:"complete"} for that aborted load, THEN the new {status:"loading"}.
 */
import { mockBrowser } from "./setup";
import { MessageHandler } from "../message-handler";
import type { ExtensionTransport } from "../transport";
import type { ServerMessageRequest } from "@foxpilot/common";

const TAB = 7;
const OLD = "https://app.example.com/dashboard";
const NEW = "https://app.example.com/settings";

// `doc` is a test-only marker for WHICH document is live (a same-url reload
// does not change the url); the fake reports it through tabs.get like any field.
type TabState = { url: string; status: "loading" | "complete"; doc?: string };
// `close` makes the tab disappear: from then on tabs.get rejects, as it does
// for a closed tab.
type Step = { at: number; set?: Partial<TabState>; event?: Record<string, unknown>; close?: true };
type Listener = (id: number, info: Record<string, unknown>, tab: object) => void;

const timers: ReturnType<typeof setTimeout>[] = [];

// A single fake tab: tabs.get reads its live state, onUpdated delivers the
// scheduled events, and tabs.update resolves with the pre-navigation snapshot
// (what Firefox returns) while `timeline` plays out on real timers.
function fakeTab(initial: TabState, timeline: Step[]) {
  const state: TabState = { ...initial };
  const listeners: Listener[] = [];
  let closed = false;
  (mockBrowser as any).tabs.onUpdated = {
    addListener: (l: Listener) => listeners.push(l),
    removeListener: (l: Listener) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  (mockBrowser.tabs.get as jest.Mock).mockImplementation(async (id: number) => {
    if (closed) throw new Error(`Invalid tab ID: ${id}`);
    return { id, ...state };
  });
  // The document currently in the tab answers the readiness probe — the old
  // page included, until the new one commits.
  (mockBrowser.tabs.executeScript as jest.Mock).mockResolvedValue([1]);
  (mockBrowser.tabs.update as jest.Mock).mockImplementation(async (id: number) => {
    const snapshot = { id, ...state };
    for (const step of timeline) {
      timers.push(
        setTimeout(() => {
          Object.assign(state, step.set);
          if (step.close) closed = true;
          if (step.event) {
            const info = step.event;
            listeners.slice().forEach((l) => l(TAB, info, { id: TAB, ...state }));
          }
        }, step.at)
      );
    }
    return snapshot;
  });
  return { state, listeners };
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

describe("firefox navigate-tab reports the navigated-to url, never the old one", () => {
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

  it("waits for the new document instead of settling on the old page's status:'complete'", async () => {
    const tab = fakeTab({ url: OLD, status: "complete" }, [
      { at: 15, set: { status: "loading" }, event: { status: "loading" } },
      { at: 40, set: { url: NEW }, event: { status: "loading", url: NEW } },
      { at: 50, set: { status: "complete" }, event: { status: "complete" } },
    ]);

    await handler.handleDecodedMessage(navigate());

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: NEW,
    });
    // The settle must not leak its tabs.onUpdated listener.
    expect(tab.listeners).toHaveLength(0);
  });

  it("ignores the aborted previous load's status:'complete' when navigating mid-load", async () => {
    fakeTab({ url: OLD, status: "loading" }, [
      { at: 5, set: { status: "complete" }, event: { status: "complete" } },
      { at: 12, set: { status: "loading" }, event: { status: "loading" } },
      { at: 40, set: { url: NEW }, event: { status: "loading", url: NEW } },
      { at: 50, set: { status: "complete" }, event: { status: "complete" } },
    ]);

    await handler.handleDecodedMessage(navigate());

    const sent = (transport.sendResourceToServer as jest.Mock).mock.calls[0][0];
    expect(sent.url).toBe(NEW);
    expect(sent.committed).toBeUndefined();
  });

  it("reports the final url after a client-side router rewrites it on load", async () => {
    const LANDED = "https://app.example.com/settings/profile";
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 10, set: { status: "loading" }, event: { status: "loading" } },
      { at: 30, set: { url: NEW }, event: { status: "loading", url: NEW } },
      { at: 38, set: { url: LANDED }, event: { status: "loading", url: LANDED } },
      { at: 45, set: { status: "complete" }, event: { status: "complete" } },
    ]);

    await handler.handleDecodedMessage(navigate());

    const sent = (transport.sendResourceToServer as jest.Mock).mock.calls[0][0];
    expect(sent.url).toBe(LANDED);
  });

  it("still counts a redirect that lands back on the page it left as navigated", async () => {
    // e.g. /logout → 302 → the page the tab was already on. Firefox still
    // reports the commit with a url, even though it did not change.
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 10, set: { status: "loading" }, event: { status: "loading" } },
      { at: 30, event: { status: "loading", url: OLD } },
      { at: 40, set: { status: "complete" }, event: { status: "complete" } },
    ]);

    await handler.handleDecodedMessage(navigate());

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: OLD,
    });
  });

  it("reports the destination when the commit lands after the settle window, while a waitFor* condition is still polling", async () => {
    const tab = fakeTab({ url: OLD, status: "complete" }, [
      { at: 20, set: { status: "loading" }, event: { status: "loading" } },
      { at: 1200, set: { url: NEW }, event: { status: "loading", url: NEW } },
      { at: 1220, set: { status: "complete" }, event: { status: "complete" } },
    ]);
    // The readiness probe ("1") always answers; waitForText is only met once
    // the new page is in.
    (mockBrowser.tabs.executeScript as jest.Mock).mockImplementation(async (_id: number, d: { code: string }) =>
      d.code === "1" ? [1] : [tab.state.url === NEW]
    );

    await handler.handleDecodedMessage(navigate({ timeoutMs: 1000, waitForText: "Settings" }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: NEW,
    });
  });

  it("reports a reload of the current url as navigated when it commits during the waitFor* poll", async () => {
    const tab = fakeTab({ url: NEW, status: "complete", doc: "old" }, [
      { at: 20, set: { status: "loading" }, event: { status: "loading" } },
      { at: 1200, set: { doc: "new" }, event: { status: "loading", url: NEW } },
      { at: 1220, set: { status: "complete" }, event: { status: "complete" } },
    ]);
    // The readiness probe ("1") always answers; waitForText is only met once
    // the reloaded document is in.
    (mockBrowser.tabs.executeScript as jest.Mock).mockImplementation(async (_id: number, d: { code: string }) =>
      d.code === "1" ? [1] : [tab.state.doc === "new"]
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
      { at: 20, set: { status: "loading" }, event: { status: "loading" } },
      { at: 5000, event: { status: "loading", url: NEW } },
    ]);

    await handler.handleDecodedMessage(navigate({ timeoutMs: 200 }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: NEW,
      committed: false,
    });
  });

  it("does not settle on a url the page being left gives itself before our load starts", async () => {
    // Firefox reports a same-document change on a loaded page as
    // {status:"complete", url}; this one is the OLD page's router, not us.
    const REWRITTEN = OLD + "#tab2";
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 5, set: { url: REWRITTEN }, event: { status: "complete", url: REWRITTEN } },
      { at: 15, set: { status: "loading" }, event: { status: "loading" } },
      { at: 40, set: { url: NEW }, event: { status: "loading", url: NEW } },
      { at: 50, set: { status: "complete" }, event: { status: "complete" } },
    ]);

    await handler.handleDecodedMessage(navigate());

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: NEW,
    });
  });

  it("does not take an unloaded background tab restoring its old page as the commit", async () => {
    // Recorded on Firefox 151: tabs.update on a discarded tab first restores
    // the OLD page (reported as {status:"complete", url: <old>}, the lazy tab
    // reading about:blank until then) and only then starts our load.
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 5, set: { url: "about:blank" }, event: { discarded: false } },
      { at: 140, set: { url: OLD }, event: { status: "complete", url: OLD } },
      { at: 160, set: { status: "loading" }, event: { status: "loading" } },
      { at: 460, set: { url: NEW }, event: { status: "loading", url: NEW } },
      { at: 480, set: { status: "complete" }, event: { status: "complete" } },
    ]);

    await handler.handleDecodedMessage(navigate());

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: NEW,
    });
  });

  it("fails clearly when the tab is closed mid-navigation, instead of claiming it arrived", async () => {
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 10, set: { status: "loading" }, event: { status: "loading" } },
      { at: 20, close: true },
    ]);

    const started = Date.now();
    await expect(handler.handleDecodedMessage(navigate({ timeoutMs: 3000 }))).rejects.toThrow(
      /tab 7 was closed/i
    );
    expect(transport.sendResourceToServer).not.toHaveBeenCalled();
    // Nothing is left to wait for once the tab is gone.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("keeps a waitFor* mismatch out of the url when the navigation did not commit", async () => {
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 10, set: { status: "loading" }, event: { status: "loading" } },
      { at: 5000, set: { url: NEW }, event: { status: "loading", url: NEW } },
    ]);
    (mockBrowser.tabs.executeScript as jest.Mock).mockImplementation(async (_id: number, d: { code: string }) =>
      d.code === "1" ? [1] : [false]
    );

    await handler.handleDecodedMessage(navigate({ timeoutMs: 300, waitForText: "Create Token" }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: OLD,
      committed: false,
      mismatch: 'expected text "Create Token" not found',
    });
  });

  it("does not credit the page being left with a navigation it starts after ours ended without a page", async () => {
    const ELSEWHERE = "https://app.example.com/elsewhere";
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 10, set: { status: "loading" }, event: { status: "loading" } },
      // Ours ends without a page (204 / download).
      { at: 25, set: { status: "complete" }, event: { status: "complete" } },
      // Then, while a waitFor* condition is still polling, the old page
      // navigates itself somewhere else.
      { at: 300, set: { status: "loading" }, event: { status: "loading" } },
      { at: 320, set: { url: ELSEWHERE }, event: { status: "loading", url: ELSEWHERE } },
      { at: 330, set: { status: "complete" }, event: { status: "complete" } },
    ]);
    (mockBrowser.tabs.executeScript as jest.Mock).mockImplementation(async (_id: number, d: { code: string }) =>
      d.code === "1" ? [1] : [false]
    );

    await handler.handleDecodedMessage(navigate({ timeoutMs: 800, waitForText: "Settings" }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: ELSEWHERE,
      committed: false,
      mismatch: 'expected text "Settings" not found',
    });
  });

  it("does not wait out the budget probing a page that cannot be scripted when nothing committed", async () => {
    // The page being left refuses executeScript (e.g. an about: page or a
    // reader view) and the navigation ends without a new page.
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 10, set: { status: "loading" }, event: { status: "loading" } },
      { at: 25, set: { status: "complete" }, event: { status: "complete" } },
    ]);
    (mockBrowser.tabs.executeScript as jest.Mock).mockRejectedValue(new Error("Missing host permission for the tab"));

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

  it("says the navigation did not commit, instead of presenting the old url as the destination", async () => {
    // e.g. the server answered 204 / a download: loading → complete, no url.
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 10, set: { status: "loading" }, event: { status: "loading" } },
      { at: 25, set: { status: "complete" }, event: { status: "complete" } },
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
    // The browser said the load was over; there is nothing left to wait for.
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
