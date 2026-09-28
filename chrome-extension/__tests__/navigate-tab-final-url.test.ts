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
type Step = { at: number; set?: Partial<TabState>; event?: Record<string, string> };
type Listener = (id: number, info: Record<string, string>, tab: object) => void;

const timers: ReturnType<typeof setTimeout>[] = [];

// A single fake tab: tabs.get reads its live state, onUpdated delivers the
// scheduled events, and tabs.update registers the navigation synchronously
// (status "loading" + pendingUrl, like Chromium) before `timeline` plays out on
// real timers.
function fakeTab(initial: TabState, timeline: Step[]) {
  const state: TabState = { ...initial };
  const listeners: Listener[] = [];
  (mockBrowser as any).tabs.onUpdated = {
    addListener: (l: Listener) => listeners.push(l),
    removeListener: (l: Listener) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const snapshot = () => {
    const tab: Record<string, unknown> = { id: TAB, url: state.url, status: state.status };
    if (state.pendingUrl) tab.pendingUrl = state.pendingUrl;
    return tab;
  };
  (mockBrowser.tabs.get as jest.Mock).mockImplementation(async () => snapshot());
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
          if (step.event) {
            const info = step.event;
            listeners.slice().forEach((l) => l(TAB, info, snapshot()));
          }
        }, step.at)
      );
    }
    return snapshot();
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
