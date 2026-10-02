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
 *  - Once our load has started, a url the page being left gives itself
 *    (pushState) arrives as {status:"loading", url}, exactly like our commit.
 *  - A global the extension sets in its own isolated world of a page lasts as
 *    long as that document: through pushState and a fragment jump, but not
 *    across a commit or a reload (`isolatedWorlds` below models it).
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

// Verbatim the template every mcp-server before 213aa14 rendered a
// navigate-tab reply with: it knows nothing of committed/pendingUrl/mismatch.
// Extensions update from the stores while npm installs stay pinned, so an old
// server meets a new extension, and the reply's `url` alone must still carry
// what matters.
function renderedByOldServer(requested: string, reply: { tabId: number; url?: string }): string {
  return `Navigated tab ${reply.tabId} to ${reply.url ?? requested}`;
}

// Runs injected code the way tabs.executeScript does (the value is the code's
// completion value), with `win` standing in for the page's window as the
// extension's isolated world sees it.
function runInWindow(code: string, win: Record<string, unknown>): unknown {
  return new Function("window", "code", "return eval(code);")(win, code);
}

// Gives every document of the fake tab (`doc`) its own isolated-world window,
// so a token planted in one document is still there while that document is
// shown and absent from the next. The readiness probe ("1") always answers.
// `codes` lists every other script run, in order.
function isolatedWorlds(state: TabState) {
  const windows = new Map<string, Record<string, unknown>>();
  const codes: string[] = [];
  (mockBrowser.tabs.executeScript as jest.Mock).mockImplementation(async (_id: number, d: { code: string }) => {
    if (d.code === "1") return [1];
    codes.push(d.code);
    const doc = state.doc ?? "";
    if (!windows.has(doc)) windows.set(doc, {});
    return [runInWindow(d.code, windows.get(doc)!)];
  });
  return { codes };
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

  it("still folds a waitFor* mismatch into the url when the navigation did not commit, so an older server shows it", async () => {
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
      url: `${OLD} — expected text "Create Token" not found`,
      committed: false,
      mismatch: 'expected text "Create Token" not found',
    });
    const sent = (transport.sendResourceToServer as jest.Mock).mock.calls[0][0];
    expect(renderedByOldServer(NEW, sent)).toBe(
      'Navigated tab 7 to https://app.example.com/dashboard — expected text "Create Token" not found'
    );
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
      url: `${ELSEWHERE} — expected text "Settings" not found`,
      committed: false,
      mismatch: 'expected text "Settings" not found',
    });
  });

  it("does not credit the page being left with a navigation it starts after ours ended without a page, when that end came after the settle window", async () => {
    const ELSEWHERE = "https://app.example.com/elsewhere";
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 10, set: { status: "loading" }, event: { status: "loading" } },
      // Ours outlasts the settle window (700ms), then ends without a page
      // while the waitFor* poll runs.
      { at: 900, set: { status: "complete" }, event: { status: "complete" } },
      // Then the old page navigates itself somewhere else.
      { at: 1100, set: { status: "loading" }, event: { status: "loading" } },
      { at: 1120, set: { url: ELSEWHERE }, event: { status: "loading", url: ELSEWHERE } },
      { at: 1130, set: { status: "complete" }, event: { status: "complete" } },
    ]);
    (mockBrowser.tabs.executeScript as jest.Mock).mockImplementation(async (_id: number, d: { code: string }) =>
      d.code === "1" ? [1] : [false]
    );

    await handler.handleDecodedMessage(navigate({ timeoutMs: 700, waitForText: "Settings" }));

    expect(transport.sendResourceToServer).toHaveBeenCalledWith({
      resource: "navigated",
      correlationId: "c1",
      tabId: TAB,
      url: `${ELSEWHERE} — expected text "Settings" not found`,
      committed: false,
      mismatch: 'expected text "Settings" not found',
    });
  });

  it("stops waiting once our load has ended, even if the old page is already loading again", async () => {
    fakeTab({ url: OLD, status: "complete" }, [
      { at: 10, set: { status: "loading" }, event: { status: "loading" } },
      // Ours ends without a page, and by the time that is delivered the old
      // page has already started a load of its own, which never finishes.
      { at: 25, set: { status: "loading" }, event: { status: "complete" } },
      { at: 26, event: { status: "loading" } },
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
    expect(Date.now() - started).toBeLessThan(1500);
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

  describe("when the page being left moves itself while our load is in flight", () => {
    // Recorded on Firefox 151: 1.5 s after loading, the page being left
    // pushState-ed itself to another url while navigate-tab's load of a slow
    // page was in flight. The reply said the tab had navigated to that url;
    // the requested page committed about 2 s later.
    const MOVED = "https://app.example.com/dashboard/activity";
    const pageMovesItself = (): Step[] => [
      { at: 10, set: { status: "loading" }, event: { status: "loading" } },
      { at: 60, set: { url: MOVED }, event: { status: "loading", url: MOVED } },
      // Ours commits long after the reply.
      { at: 5000, set: { url: NEW, doc: "new" }, event: { status: "loading", url: NEW } },
    ];

    it("says it has not committed, naming the url that page moved to, when the tab still shows the document it left", async () => {
      const tab = fakeTab({ url: OLD, status: "complete", doc: "old" }, pageMovesItself());
      const scripts = isolatedWorlds(tab.state);

      await handler.handleDecodedMessage(navigate({ timeoutMs: 300 }));

      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "c1",
        tabId: TAB,
        url: MOVED,
        committed: false,
      });
      // Marked before the navigation, read back before the reply.
      expect(scripts.codes).toHaveLength(2);
    });

    it("still reports the same events as navigated when they come with a new document", async () => {
      // e.g. a redirect that committed but is still loading at the deadline.
      const LANDED = "https://app.example.com/login";
      const tab = fakeTab({ url: OLD, status: "complete", doc: "old" }, [
        { at: 10, set: { status: "loading" }, event: { status: "loading" } },
        { at: 60, set: { url: LANDED, doc: "new" }, event: { status: "loading", url: LANDED } },
      ]);
      const scripts = isolatedWorlds(tab.state);

      await handler.handleDecodedMessage(navigate({ timeoutMs: 300 }));

      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "c1",
        tabId: TAB,
        url: LANDED,
      });
      expect(scripts.codes).toHaveLength(2);
    });

    it("reports where a redirect landed: the tab shows a new document", async () => {
      const FINAL = "https://app.example.com/login";
      const tab = fakeTab({ url: OLD, status: "complete", doc: "old" }, [
        { at: 10, set: { status: "loading" }, event: { status: "loading" } },
        { at: 30, set: { url: FINAL, doc: "new" }, event: { status: "loading", url: FINAL } },
        { at: 40, set: { status: "complete" }, event: { status: "complete" } },
      ]);
      const scripts = isolatedWorlds(tab.state);

      await handler.handleDecodedMessage(navigate());

      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "c1",
        tabId: TAB,
        url: FINAL,
      });
      // The url is not the target, so the document was checked, and was new.
      expect(scripts.codes).toHaveLength(2);
    });

    it("leaves the verdict to the events on a page the extension cannot script", async () => {
      fakeTab({ url: OLD, status: "complete", doc: "old" }, pageMovesItself());
      (mockBrowser.tabs.executeScript as jest.Mock).mockImplementation(async (_id: number, d: { code: string }) => {
        if (d.code === "1") return [1];
        throw new Error("Missing host permission for the tab");
      });

      await handler.handleDecodedMessage(navigate({ timeoutMs: 300 }));

      // As before the document check: there the old page's move still reads
      // as our commit.
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "c1",
        tabId: TAB,
        url: MOVED,
      });
    });

    it("waits no more than 500ms for a page that does not answer the mark, and then does not check", async () => {
      const FINAL = "https://app.example.com/login";
      fakeTab({ url: OLD, status: "complete", doc: "old" }, [
        { at: 10, set: { status: "loading" }, event: { status: "loading" } },
        { at: 30, set: { url: FINAL, doc: "new" }, event: { status: "loading", url: FINAL } },
        { at: 40, set: { status: "complete" }, event: { status: "complete" } },
      ]);
      const codes: string[] = [];
      (mockBrowser.tabs.executeScript as jest.Mock).mockImplementation((_id: number, d: { code: string }) => {
        if (d.code === "1") return Promise.resolve([1]);
        codes.push(d.code);
        return new Promise(() => {}); // a frozen frame
      });

      const started = Date.now();
      await handler.handleDecodedMessage(navigate());

      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "c1",
        tabId: TAB,
        url: FINAL,
      });
      expect(codes).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(1300);
    });

    it("waits no more than 500ms for a page that does not answer the read, and keeps the events' verdict", async () => {
      const FINAL = "https://app.example.com/login";
      fakeTab({ url: OLD, status: "complete", doc: "old" }, [
        { at: 10, set: { status: "loading" }, event: { status: "loading" } },
        { at: 30, set: { url: FINAL, doc: "new" }, event: { status: "loading", url: FINAL } },
        { at: 40, set: { status: "complete" }, event: { status: "complete" } },
      ]);
      const codes: string[] = [];
      (mockBrowser.tabs.executeScript as jest.Mock).mockImplementation((_id: number, d: { code: string }) => {
        if (d.code === "1") return Promise.resolve([1]);
        codes.push(d.code);
        // The mark is planted; the read never comes back.
        return codes.length === 1 ? Promise.resolve([runInWindow(d.code, {})]) : new Promise(() => {});
      });

      const started = Date.now();
      await handler.handleDecodedMessage(navigate());

      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "c1",
        tabId: TAB,
        url: FINAL,
      });
      expect(codes).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(1300);
    });

    it("does not check the document after a same-document jump to the target", async () => {
      const TARGET = OLD + "#settings";
      const tab = fakeTab({ url: OLD, status: "complete", doc: "old" }, [
        { at: 5, set: { url: TARGET }, event: { status: "complete", url: TARGET } },
      ]);
      const scripts = isolatedWorlds(tab.state);

      await handler.handleDecodedMessage(navigate({ url: TARGET }));

      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "c1",
        tabId: TAB,
        url: TARGET,
      });
      // Marked, never read.
      expect(scripts.codes).toHaveLength(1);
    });

    it("does not check the document when a hash router moves a same-document jump on within its fragment", async () => {
      // #/settings is routed on to #/settings/general before the tab is read.
      const TARGET = OLD + "#/settings";
      const ROUTED = OLD + "#/settings/general";
      const tab = fakeTab({ url: OLD, status: "complete", doc: "old" }, [
        { at: 5, set: { url: ROUTED }, event: { status: "complete", url: TARGET } },
      ]);
      const scripts = isolatedWorlds(tab.state);

      await handler.handleDecodedMessage(navigate({ url: TARGET }));

      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "c1",
        tabId: TAB,
        url: ROUTED,
      });
      expect(scripts.codes).toHaveLength(1);
    });

    it("plants nothing and checks nothing for waitUntil:'none'", async () => {
      fakeTab({ url: OLD, status: "complete", doc: "old" }, pageMovesItself());

      await handler.handleDecodedMessage(navigate({ waitUntil: "none" }));

      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "navigated",
        correlationId: "c1",
        tabId: TAB,
        url: NEW,
      });
      expect(mockBrowser.tabs.executeScript).not.toHaveBeenCalled();
    });
  });
});
