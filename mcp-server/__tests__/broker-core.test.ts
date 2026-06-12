import { BrokerCore, BrokerCoreOptions } from "../broker-core";
import type {
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
    sendToExtension: (req) => extReqs.push(req),
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
