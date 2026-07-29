import {
  BrokerCore,
  BrokerCoreOptions,
  NEVER_SENT_MESSAGE,
  timeoutMessageFor,
} from "../broker-core";
import type { SendToExtensionResult } from "../broker-core";
import type {
  ServerMessage,
  ServerMessageRequest,
  ExtensionMessage,
} from "@foxpilot/common";
import type { BrokerServerFrame } from "../broker-protocol";

function makeCore(overrides: Partial<BrokerCoreOptions> = {}) {
  const extReqs: ServerMessageRequest[] = [];
  const clientFrames: Array<{ clientId: string; frame: BrokerServerFrame }> = [];
  let counter = 0;
  let clock = 1000;
  const core = new BrokerCore({
    sendToExtension: (req) => {
      extReqs.push(req);
      // Delivered, but with no routed browser — what a long-poll transport
      // reports. This is the default the whole suite below assumes.
      return { delivered: true };
    },
    sendToClient: (clientId, frame) => clientFrames.push({ clientId, frame }),
    getTimeoutMs: () => 30000,
    genCorrelationId: () => `cid${++counter}`,
    now: () => clock,
    leaseTtlMs: 60000,
    ...overrides,
  });
  return {
    core,
    extReqs,
    clientFrames,
    advanceClock: (d: number) => {
      clock += d;
    },
  };
}

/** A core whose transport routes each request to a caller-chosen browser. */
function makeRoutedCore() {
  const extReqs: ServerMessageRequest[] = [];
  const clientFrames: Array<{ clientId: string; frame: BrokerServerFrame }> = [];
  let counter = 0;
  let result: SendToExtensionResult = {
    delivered: true,
    browserId: "chrome-1",
  };
  const core = new BrokerCore({
    sendToExtension: (req) => {
      // Only record what actually went out, matching the real transport:
      // the undeliverable branch writes to no socket.
      if (result.delivered) {
        extReqs.push(req);
      }
      return result;
    },
    sendToClient: (clientId, frame) => clientFrames.push({ clientId, frame }),
    getTimeoutMs: () => 30000,
    genCorrelationId: () => `cid${++counter}`,
  });
  return {
    core,
    extReqs,
    clientFrames,
    /** `null` = delivered but unrouted, i.e. the long-poll shape. */
    routeTo: (browserId: string | null) => {
      result =
        browserId === null
          ? { delivered: true }
          : { delivered: true, browserId };
    },
    /** No WS target and no long-poll sink: nothing leaves the broker. */
    stopDelivering: () => {
      result = { delivered: false };
    },
  };
}

const tabContent = (correlationId: string, tabId: number): ExtensionMessage => ({
  resource: "tab-content",
  correlationId,
  tabId,
  fullText: "",
  isTruncated: false,
  totalLength: 0,
  links: [],
});

describe("BrokerCore routing", () => {
  it("routes a tool request to the extension and the response back to the client", () => {
    const { core, extReqs, clientFrames } = makeCore();
    core.submitTool("A", "r1", { cmd: "open-tab", url: "https://x.com" });

    expect(extReqs).toHaveLength(1);
    expect(extReqs[0]).toMatchObject({
      cmd: "open-tab",
      url: "https://x.com",
      correlationId: "cid1",
    });

    core.handleExtensionResponse({
      resource: "opened-tab-id",
      correlationId: "cid1",
      tabId: 42,
    });

    expect(clientFrames).toEqual([
      {
        clientId: "A",
        frame: {
          kind: "tool-result",
          requestId: "r1",
          message: { resource: "opened-tab-id", correlationId: "cid1", tabId: 42 },
        },
      },
    ]);
    expect(core.pendingCount).toBe(0);
  });

  it("routes an extension error back to the originating client", () => {
    const { core, clientFrames } = makeCore();
    core.submitTool("A", "r1", { cmd: "open-tab", url: "https://x.com" });
    core.handleExtensionError({ correlationId: "cid1", errorMessage: "nope" });
    expect(clientFrames).toEqual([
      {
        clientId: "A",
        frame: { kind: "tool-error", requestId: "r1", errorMessage: "nope" },
      },
    ]);
  });

  it("ignores responses/errors with unknown correlation ids", () => {
    // These now log (see "BrokerCore late replies"); silence it here.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { core, clientFrames } = makeCore();
    expect(() =>
      core.handleExtensionResponse({
        resource: "tabs",
        correlationId: "ghost",
        tabs: [],
      })
    ).not.toThrow();
    expect(() =>
      core.handleExtensionError({ correlationId: "ghost", errorMessage: "x" })
    ).not.toThrow();
    expect(clientFrames).toHaveLength(0);
    spy.mockRestore();
  });

  it("fails a request the extension never answers (timeout)", () => {
    jest.useFakeTimers();
    const { core, clientFrames } = makeCore({ getTimeoutMs: () => 1000 });
    core.submitTool("A", "r1", { cmd: "get-tab-list" });
    jest.advanceTimersByTime(1000);
    expect(clientFrames).toEqual([
      {
        clientId: "A",
        frame: {
          kind: "tool-error",
          requestId: "r1",
          errorMessage: expect.stringContaining("Timed out"),
        },
      },
    ]);
    jest.useRealTimers();
  });
});

describe("BrokerCore timeout wording", () => {
  it("warns that a mutating command may already have landed", () => {
    const msg = timeoutMessageFor("click-element", 15000);
    expect(msg).toContain("15000ms");
    expect(msg).toContain("click-element");
    expect(msg).toContain("MISSING REPLY");
    expect(msg).toContain("may have already been applied");
    expect(msg).toMatch(/Do NOT blindly retry/);
    expect(msg).toContain("take-snapshot");
  });

  it("keeps the original wording for read-only commands", () => {
    expect(timeoutMessageFor("get-tab-list", 5000)).toBe(
      "Timed out waiting for response from the browser extension"
    );
    expect(timeoutMessageFor("take-snapshot", 30000)).toBe(
      "Timed out waiting for response from the browser extension"
    );
  });

  it("uses the mutating wording on a real dispatch timeout", () => {
    jest.useFakeTimers();
    const { core, clientFrames } = makeCore({ getTimeoutMs: () => 1000 });
    core.submitTool("A", "r1", { cmd: "click-element", tabId: 3, uid: "e1" });
    jest.advanceTimersByTime(1000);
    expect(clientFrames).toHaveLength(1);
    const frame = clientFrames[0].frame as { errorMessage: string };
    expect(frame.errorMessage).toContain("MISSING REPLY");
    expect(frame.errorMessage).toContain("1000ms");
    jest.useRealTimers();
  });
});

/**
 * Every wire `cmd` in the ServerMessage union, with the timeout wording it must
 * get. Keyed by the union itself: adding a command to
 * common/server-messages.ts fails to COMPILE until it is classified here, which
 * is what stops a new command from silently landing on the wrong side.
 *
 * The classification in broker-core is fail-safe — unknown commands get the
 * cautious wording — so a miss here is loud rather than dangerous. This table
 * is the record of the deliberate call for each one.
 */
const COMMAND_WORDING: Record<
  ServerMessage["cmd"],
  "read-only" | "cautious"
> = {
  "get-tab-list": "read-only",
  "get-browser-recent-history": "read-only",
  "get-tab-content": "read-only",
  "get-active-tab": "read-only",
  "take-snapshot": "read-only",
  "take-screenshot": "read-only",
  "wait-for-text": "read-only",
  "get-console-messages": "read-only",
  "get-network-requests": "read-only",
  "get-cookies": "read-only",
  "stream-poll": "read-only",

  "open-tab": "cautious",
  "close-tabs": "cautious",
  "reorder-tabs": "cautious",
  "find-highlight": "cautious",
  "group-tabs": "cautious",
  "navigate-tab": "cautious",
  "navigate-page-history": "cautious",
  "select-tab": "cautious",
  "click-element": "cautious",
  "hover-element": "cautious",
  "fill-element": "cautious",
  "fill-form": "cautious",
  "type-text": "cautious",
  "press-key": "cautious",
  "drag-element": "cautious",
  "resize-window": "cautious",
  "evaluate-script": "cautious",
  "upload-file": "cautious",
  "handle-dialog": "cautious",
  emulate: "cautious",
  "browser-fetch": "cautious",
  "stream-start": "cautious",
  "stream-close": "cautious",
  "capture-response-bodies": "cautious",
  "click-at": "cautious",
  "type-at": "cautious",
  "hover-at": "cautious",
  "scroll-at": "cautious",
  "scroll-to": "cautious",
  "scroll-into-view": "cautious",
  "select-option": "cautious",
  "dismiss-overlays": "cautious",
};

const PLAIN_TIMEOUT = "Timed out waiting for response from the browser extension";

describe("BrokerCore timeout wording classification", () => {
  it("classifies every cmd in the ServerMessage union", () => {
    for (const [cmd, wording] of Object.entries(COMMAND_WORDING)) {
      const msg = timeoutMessageFor(cmd, 1234);
      if (wording === "read-only") {
        expect([cmd, msg]).toEqual([cmd, PLAIN_TIMEOUT]);
      } else {
        expect([cmd, msg.includes("MISSING REPLY")]).toEqual([cmd, true]);
      }
    }
  });

  it("defaults an unrecognized command to the cautious wording", () => {
    // The whole point of the allow-list direction: a command nobody remembered
    // to classify must fail safe, not inherit "nothing happened, retry".
    const msg = timeoutMessageFor("some-command-added-tomorrow", 5000);
    expect(msg).toContain("MISSING REPLY");
    expect(msg).not.toBe(PLAIN_TIMEOUT);
  });

  it("warns for the state-changing commands an allow-list of mutations missed", () => {
    // Each of these has a reachable budget in timeouts.ts and a real
    // side effect: a cookie-authed POST, arbitrary page JS, a refcounted
    // chrome.debugger attach whose retry never detaches, a streaming request,
    // and an overlay dismissal.
    for (const cmd of [
      "browser-fetch",
      "evaluate-script",
      "capture-response-bodies",
      "stream-start",
      "dismiss-overlays",
      "navigate-tab",
      "hover-at",
      "scroll-at",
    ]) {
      expect([cmd, timeoutMessageFor(cmd, 1000).includes("MISSING REPLY")]).toEqual([
        cmd,
        true,
      ]);
    }
  });
});

describe("BrokerCore late replies", () => {
  let spy: jest.SpyInstance;

  beforeEach(() => {
    spy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("drops a late response but logs its correlationId", () => {
    jest.useFakeTimers();
    const { core, clientFrames } = makeCore({ getTimeoutMs: () => 1000 });
    core.submitTool("A", "r1", { cmd: "click-element", tabId: 3, uid: "e1" });
    jest.advanceTimersByTime(1000);
    expect(clientFrames).toHaveLength(1); // the timeout error

    // The ack finally arrives, after the pending is gone.
    core.handleExtensionResponse({
      resource: "action-result",
      correlationId: "cid1",
      ok: true,
    });

    expect(clientFrames).toHaveLength(1); // still dropped — no stale success
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("cid1"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("action-result"));
    jest.useRealTimers();
  });

  it("drops a late error but logs its correlationId", () => {
    const { core, clientFrames } = makeCore();
    core.handleExtensionError({ correlationId: "ghost", errorMessage: "boom" });
    expect(clientFrames).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("ghost"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});

describe("BrokerCore per-tab serialization", () => {
  it("serializes requests targeting the same tab", () => {
    const { core, extReqs } = makeCore();
    core.submitTool("A", "r1", { cmd: "get-tab-content", tabId: 5, offset: 0 });
    core.submitTool("B", "r2", { cmd: "find-highlight", tabId: 5, queryPhrase: "x" });

    expect(extReqs).toHaveLength(1);
    expect(extReqs[0]).toMatchObject({ cmd: "get-tab-content", tabId: 5, correlationId: "cid1" });

    core.handleExtensionResponse(tabContent("cid1", 5));

    expect(extReqs).toHaveLength(2);
    expect(extReqs[1]).toMatchObject({ cmd: "find-highlight", tabId: 5, correlationId: "cid2" });
  });

  it("runs requests for different tabs and tab-agnostic requests concurrently", () => {
    const { core, extReqs } = makeCore();
    core.submitTool("A", "r1", { cmd: "get-tab-content", tabId: 1, offset: 0 });
    core.submitTool("A", "r2", { cmd: "get-tab-content", tabId: 2, offset: 0 });
    core.submitTool("A", "r3", { cmd: "get-tab-list" });
    expect(extReqs).toHaveLength(3);
  });
});

describe("BrokerCore leases", () => {
  it("rejects another client's requests to a leased tab but allows the holder", () => {
    const { core, extReqs, clientFrames } = makeCore();
    expect(core.acquireLease("A", 5)).toEqual({ ok: true });

    core.submitTool("B", "r1", { cmd: "get-tab-content", tabId: 5, offset: 0 });
    expect(extReqs).toHaveLength(0);
    expect(clientFrames).toEqual([
      {
        clientId: "B",
        frame: {
          kind: "tool-error",
          requestId: "r1",
          errorMessage: expect.stringContaining("leased by another session"),
        },
      },
    ]);

    core.submitTool("A", "r2", { cmd: "get-tab-content", tabId: 5, offset: 0 });
    expect(extReqs).toHaveLength(1);
  });

  it("refuses a lease already held by another client", () => {
    const { core } = makeCore();
    expect(core.acquireLease("A", 5)).toEqual({ ok: true });
    expect(core.acquireLease("B", 5).ok).toBe(false);
  });

  it("treats an expired lease as released", () => {
    const { core, extReqs, advanceClock } = makeCore({ leaseTtlMs: 1000 });
    core.acquireLease("A", 5);
    advanceClock(1001);
    core.submitTool("B", "r1", { cmd: "get-tab-content", tabId: 5, offset: 0 });
    expect(extReqs).toHaveLength(1);
  });

  it("rejects a queued request if a conflicting lease appears before it dispatches", () => {
    const { core, extReqs, clientFrames } = makeCore();
    core.submitTool("A", "r1", { cmd: "get-tab-content", tabId: 5, offset: 0 });
    core.submitTool("B", "r2", { cmd: "get-tab-content", tabId: 5, offset: 0 });
    core.acquireLease("A", 5);
    core.handleExtensionResponse(tabContent("cid1", 5));

    expect(extReqs).toHaveLength(1);
    const bFrame = clientFrames.find((c) => c.clientId === "B");
    expect(bFrame?.frame).toMatchObject({ kind: "tool-error", requestId: "r2" });
  });
});

describe("BrokerCore lifecycle", () => {
  it("frees an in-flight tab when the owning client disconnects, dispatching the queued request", () => {
    const { core, extReqs } = makeCore();
    core.submitTool("A", "r1", { cmd: "get-tab-content", tabId: 5, offset: 0 });
    core.submitTool("B", "r2", { cmd: "get-tab-content", tabId: 5, offset: 0 });
    expect(extReqs).toHaveLength(1);

    core.onClientDisconnect("A");

    expect(extReqs).toHaveLength(2);
    expect(extReqs[1]).toMatchObject({ cmd: "get-tab-content", tabId: 5, correlationId: "cid2" });
  });

  it("releases a disconnected client's lease", () => {
    const { core, extReqs } = makeCore();
    core.acquireLease("A", 5);
    core.onClientDisconnect("A");
    core.submitTool("B", "r1", { cmd: "get-tab-content", tabId: 5, offset: 0 });
    expect(extReqs).toHaveLength(1);
  });

  it("fails all in-flight requests when the extension disconnects", () => {
    const { core, clientFrames } = makeCore();
    core.submitTool("A", "r1", { cmd: "get-tab-list" });
    core.submitTool("B", "r2", { cmd: "get-tab-list" });
    core.onExtensionDisconnect();
    expect(clientFrames).toHaveLength(2);
    expect(clientFrames.every((c) => c.frame.kind === "tool-error")).toBe(true);
    expect(core.pendingCount).toBe(0);
  });
});

describe("BrokerCore per-browser failure scoping", () => {
  it("fails only the matching browser's pendings", () => {
    const { core, clientFrames, routeTo } = makeRoutedCore();
    routeTo("chrome-1");
    core.submitTool("A", "r1", { cmd: "get-tab-content", tabId: 1, offset: 0 });
    routeTo("firefox-1");
    core.submitTool("B", "r2", { cmd: "get-tab-content", tabId: 2, offset: 0 });
    expect(core.pendingCount).toBe(2);

    core.failInFlightForBrowser("chrome-1", "chrome went away", "not sent");

    expect(clientFrames).toEqual([
      {
        clientId: "A",
        frame: {
          kind: "tool-error",
          requestId: "r1",
          errorMessage: "chrome went away",
        },
      },
    ]);
    // Firefox's request is untouched and still awaiting its reply.
    expect(core.pendingCount).toBe(1);
  });

  it("frees tabInFlight so a later same-tab request still dispatches", () => {
    const { core, extReqs, routeTo } = makeRoutedCore();
    routeTo("chrome-1");
    core.submitTool("A", "r1", { cmd: "get-tab-content", tabId: 5, offset: 0 });
    expect(extReqs).toHaveLength(1);

    core.failInFlightForBrowser("chrome-1", "chrome went away", "not sent");
    expect(core.pendingCount).toBe(0);

    // Without the tabInFlight release, tab 5 would still be marked in-flight
    // and this would queue forever instead of going out.
    core.submitTool("A", "r2", { cmd: "get-tab-content", tabId: 5, offset: 0 });
    expect(extReqs).toHaveLength(2);
    expect(extReqs[1]).toMatchObject({ cmd: "get-tab-content", tabId: 5 });
  });

  it("fails a queued same-tab request instead of re-dispatching it elsewhere", () => {
    // The disconnect path must NOT drain the queue. tabInFlight is a global
    // Set<number>, so a fill for Chrome's tab 5 queues behind a click on it;
    // draining re-resolves the target, and with Chrome gone the survivor picks
    // it up and mutates ITS tab 5 — a different page — reported as success.
    const { core, extReqs, clientFrames, routeTo } = makeRoutedCore();
    routeTo("chrome-1");
    core.submitTool("A", "r1", { cmd: "click-element", tabId: 5, uid: "e1" });
    core.submitTool("A", "r2", {
      cmd: "fill-element",
      tabId: 5,
      uid: "e2",
      value: "SECRET",
    });
    expect(extReqs).toHaveLength(1); // r2 is queued behind r1

    // Chrome drops; the transport would now route anything dispatched to
    // Firefox.
    routeTo("firefox-1");
    core.failInFlightForBrowser(
      "chrome-1",
      "chrome went away",
      "chrome went away before send"
    );

    expect(extReqs).toHaveLength(1); // the fill never went out
    expect(extReqs.some((r) => r.cmd === "fill-element")).toBe(false);
    expect(clientFrames).toEqual([
      {
        clientId: "A",
        frame: {
          kind: "tool-error",
          requestId: "r1",
          errorMessage: "chrome went away",
        },
      },
      {
        clientId: "A",
        frame: {
          kind: "tool-error",
          requestId: "r2",
          errorMessage: "chrome went away before send",
        },
      },
    ]);
    expect(core.pendingCount).toBe(0);

    // The abandoned queue is cleared and the tab freed, so tab 5 is usable
    // again rather than deadlocked.
    core.submitTool("A", "r3", { cmd: "click-element", tabId: 5, uid: "e3" });
    expect(extReqs).toHaveLength(2);
    expect(extReqs[1]).toMatchObject({ cmd: "click-element", uid: "e3" });
  });

  it("leaves an unscoped (long-poll) pending alone when a WebSocket browser drops", () => {
    // Hybrid session: a long-poll browser whose transport names nobody, plus a
    // WebSocket browser. Unscoped is a property of the transport, not evidence
    // that the long-poll browser is the one that died.
    const { core, clientFrames, routeTo } = makeRoutedCore();
    routeTo(null);
    core.submitTool("A", "r1", { cmd: "fill-form", tabId: 1, fields: [] });
    routeTo("chrome-1");
    core.submitTool("B", "r2", { cmd: "get-tab-list" });

    core.failInFlightForBrowser("chrome-1", "chrome went away", "not sent");

    expect(clientFrames).toEqual([
      {
        clientId: "B",
        frame: {
          kind: "tool-error",
          requestId: "r2",
          errorMessage: "chrome went away",
        },
      },
    ]);
    // The long-poll browser is healthy and its reply is still on its way.
    expect(core.pendingCount).toBe(1);
  });

  it("fails only unscoped pendings when the long-poll transport goes", () => {
    const { core, clientFrames, routeTo } = makeRoutedCore();
    routeTo(null);
    core.submitTool("A", "r1", { cmd: "get-tab-list" });
    routeTo("chrome-1");
    core.submitTool("B", "r2", { cmd: "get-tab-list" });

    core.failInFlightForLongPoll("long-poll gone", "not sent");

    expect(clientFrames).toEqual([
      {
        clientId: "A",
        frame: {
          kind: "tool-error",
          requestId: "r1",
          errorMessage: "long-poll gone",
        },
      },
    ]);
    // The WebSocket browser is untouched.
    expect(core.pendingCount).toBe(1);
  });

  it("fails a queued request behind an abandoned long-poll request", () => {
    const { core, extReqs, clientFrames, routeTo } = makeRoutedCore();
    routeTo(null);
    core.submitTool("A", "r1", { cmd: "click-element", tabId: 7, uid: "e1" });
    core.submitTool("A", "r2", { cmd: "click-element", tabId: 7, uid: "e2" });
    expect(extReqs).toHaveLength(1);

    core.failInFlightForLongPoll("long-poll gone", "never sent");

    expect(extReqs).toHaveLength(1);
    expect(clientFrames.map((c) => c.frame)).toEqual([
      { kind: "tool-error", requestId: "r1", errorMessage: "long-poll gone" },
      { kind: "tool-error", requestId: "r2", errorMessage: "never sent" },
    ]);
    expect(core.pendingCount).toBe(0);
  });
});

describe("BrokerCore undeliverable dispatch", () => {
  it("tells a never-delivered click-element that nothing ran and retrying is safe", () => {
    const { core, clientFrames, extReqs, stopDelivering } = makeRoutedCore();
    stopDelivering();
    core.submitTool("A", "r1", { cmd: "click-element", tabId: 3, uid: "e1" });

    expect(extReqs).toHaveLength(0);
    expect(clientFrames).toHaveLength(1);
    const frame = clientFrames[0].frame as {
      kind: string;
      requestId: string;
      errorMessage: string;
    };
    expect(frame).toMatchObject({ kind: "tool-error", requestId: "r1" });
    expect(frame.errorMessage).toBe(NEVER_SENT_MESSAGE);
    expect(frame.errorMessage).toContain("never sent");
    expect(frame.errorMessage).toContain("SAFE to retry");
    // The mutating-timeout wording claims the opposite (may have landed, do not
    // retry). A request that left no socket must never inherit it.
    expect(frame.errorMessage).not.toContain("may have already been applied");
    expect(frame.errorMessage).not.toContain("MISSING REPLY");
    expect(core.pendingCount).toBe(0);
  });

  it("fails a queued request the moment it is dispatched with nowhere to send it", () => {
    jest.useFakeTimers();
    const { core, extReqs, clientFrames, stopDelivering } = makeRoutedCore();
    core.submitTool("A", "r1", { cmd: "click-element", tabId: 5, uid: "e1" });
    core.submitTool("A", "r2", { cmd: "click-element", tabId: 5, uid: "e2" });
    expect(extReqs).toHaveLength(1); // r2 is queued behind r1

    // The extension goes away while r1 is still in flight — past the
    // submit-time guard, which only ran for r2 back when it was still queued.
    stopDelivering();
    core.handleExtensionError({ correlationId: "cid1", errorMessage: "boom" });

    // completeTab dispatched r2; it must already have failed, with no timer
    // advance at all.
    expect(clientFrames).toHaveLength(2);
    const queued = clientFrames[1].frame as {
      requestId: string;
      errorMessage: string;
    };
    expect(queued.requestId).toBe("r2");
    expect(queued.errorMessage).toBe(NEVER_SENT_MESSAGE);
    expect(queued.errorMessage).not.toContain("may have already been applied");
    expect(extReqs).toHaveLength(1); // r2 never went out
    expect(core.pendingCount).toBe(0);

    // Nothing further arrives once its timer would have fired.
    jest.advanceTimersByTime(60000);
    expect(clientFrames).toHaveLength(2);
    jest.useRealTimers();
  });

  it("frees tabInFlight on the fail-fast path so the tab is not deadlocked", () => {
    const { core, extReqs, stopDelivering, routeTo } = makeRoutedCore();
    stopDelivering();
    core.submitTool("A", "r1", { cmd: "click-element", tabId: 5, uid: "e1" });
    expect(extReqs).toHaveLength(0);
    expect(core.pendingCount).toBe(0);

    // Extension reconnects. Without completeTab on the fail-fast path, tab 5
    // would still be marked in-flight and this would queue forever.
    routeTo("chrome-1");
    core.submitTool("A", "r2", { cmd: "click-element", tabId: 5, uid: "e2" });
    expect(extReqs).toHaveLength(1);
    expect(extReqs[0]).toMatchObject({
      cmd: "click-element",
      tabId: 5,
      uid: "e2",
    });
  });
});
