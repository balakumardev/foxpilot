/**
 * settleSnapshot / classifySnapshot (common/snapshot-settle.ts): the wait that
 * both extensions run when take-snapshot reads zero elements off a tab that is
 * still loading. The helper lives in @foxpilot/common and is tested here, with a
 * fake clock; each extension's handler test covers its own wiring.
 *
 * What this does NOT prove: that a real tab reports these statuses in this
 * order. The fixtures follow what the live probe measured (a new tab starts
 * "loading" with an unrendered document, then goes "complete"); the order is a
 * model, not a recording.
 */
import {
  classifySnapshot,
  settleSnapshot,
  SNAPSHOT_SETTLE_POLL_MS,
  SNAPSHOT_SETTLE_LOADING_MS,
  SNAPSHOT_SETTLE_SHELL_MS,
  SNAPSHOT_SHELL_MAX_BODY_CHILDREN,
  type SettleRead,
  type SettleTab,
} from "@foxpilot/common";

type Read = SettleRead & { tree: string };

const empty = (
  readyState: string,
  bodyChildren: number
): Read => ({
  tree: "",
  total: 0,
  docState: { readyState, bodyChildren },
});
const found = (n = 3): Read => ({
  tree: 'button "Go" [uid=e1]',
  total: n,
  docState: { readyState: "complete", bodyChildren: 9 },
});

/** A fake clock: sleep advances it, reads can cost time, every call is recorded. */
function harness(opts: {
  reads: Array<Read | Error>;
  tabs?: Array<SettleTab | Error>;
  readCostMs?: number;
}) {
  const clock = { t: 1_000_000 };
  const sleeps: number[] = [];
  const readAt: number[] = [];
  let reads = 0;
  let tabs = 0;
  const deps = {
    now: () => clock.t,
    sleep: jest.fn(async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    }),
    read: jest.fn(async () => {
      readAt.push(clock.t);
      clock.t += opts.readCostMs ?? 0;
      const next = opts.reads[Math.min(reads++, opts.reads.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    }),
    getTab: jest.fn(async () => {
      const t = (opts.tabs ?? [{ status: "complete" }])[
        Math.min(tabs++, (opts.tabs ?? [{ status: "complete" }]).length - 1)
      ];
      if (t instanceof Error) throw t;
      return t;
    }),
  };
  return { deps, clock, sleeps, readAt, startedAt: clock.t };
}

describe("constants", () => {
  it("pin the budgets the task specifies", () => {
    expect(SNAPSHOT_SETTLE_POLL_MS).toBe(300);
    expect(SNAPSHOT_SETTLE_LOADING_MS).toBe(5000);
    expect(SNAPSHOT_SETTLE_SHELL_MS).toBe(1500);
    expect(SNAPSHOT_SHELL_MAX_BODY_CHILDREN).toBe(3);
  });

  it("stay well inside the 30 s take-snapshot broker budget even with a slow read each time", () => {
    // Worst case modelled: loading budget, then a fresh shell budget, plus one
    // in-flight read that self-heals for up to 8 s (sendMessageToTab's
    // waitForTabReady), on top of a first read of a similar size.
    const worstCase = SNAPSHOT_SETTLE_LOADING_MS + SNAPSHOT_SETTLE_SHELL_MS + 8000 + 8000;
    expect(worstCase).toBeLessThan(30000);
  });
});

describe("classifySnapshot", () => {
  it("only an EMPTY, error-free, docState-carrying read is ever worth waiting on", () => {
    expect(classifySnapshot({ total: 0, error: "bad selector", docState: { readyState: "loading", bodyChildren: 0 } }, "loading")).toBe("ready");
    expect(classifySnapshot({ total: 4, docState: { readyState: "loading", bodyChildren: 0 } }, "loading")).toBe("ready");
    expect(classifySnapshot({ docState: { readyState: "loading", bodyChildren: 0 } }, "loading")).toBe("ready");
    expect(classifySnapshot({ total: 0 }, "loading")).toBe("ready");
  });

  it("loading: the tab OR the document is not complete", () => {
    expect(classifySnapshot(empty("complete", 1), "loading")).toBe("loading");
    expect(classifySnapshot(empty("loading", 1), "complete")).toBe("loading");
    expect(classifySnapshot(empty("interactive", 1), "complete")).toBe("loading");
    expect(classifySnapshot(empty("", 0), "complete")).toBe("loading");
    expect(classifySnapshot(empty("complete", 1), "unloaded")).toBe("loading");
  });

  it("an unknown tab status is treated as settled (only the document speaks)", () => {
    expect(classifySnapshot(empty("complete", 1), undefined)).toBe("shell");
    expect(classifySnapshot(empty("loading", 1), undefined)).toBe("loading");
  });

  it("shell: complete and a nearly bare body; a fuller body is a genuinely empty page", () => {
    expect(classifySnapshot(empty("complete", 0), "complete")).toBe("shell");
    expect(classifySnapshot(empty("complete", 3), "complete")).toBe("shell");
    expect(classifySnapshot(empty("complete", 4), "complete")).toBe("ready");
    expect(classifySnapshot(empty("complete", 42), "complete")).toBe("ready");
  });
});

describe("settleSnapshot: when it must NOT wait", () => {
  it("elements on the first read: returned as is, the tab is never even asked", async () => {
    const h = harness({ reads: [found()] });
    const first = found();
    const out = await settleSnapshot(first, h.deps);
    expect(out).toEqual({ result: first });
    expect(h.deps.getTab).not.toHaveBeenCalled();
    expect(h.deps.read).not.toHaveBeenCalled();
    expect(h.deps.sleep).not.toHaveBeenCalled();
  });

  it("a query error, a missing total or a missing docState never waits", async () => {
    for (const first of [
      { tree: "", total: 0, error: "rootSelector matched no element", docState: { readyState: "loading", bodyChildren: 0 } },
      { tree: "" },
      { tree: "", total: 0 },
    ] as Read[]) {
      const h = harness({ reads: [first] });
      const out = await settleSnapshot(first, h.deps);
      expect(out).toEqual({ result: first });
      expect(h.deps.sleep).not.toHaveBeenCalled();
      expect(h.deps.read).not.toHaveBeenCalled();
    }
  });

  it("a genuinely empty, settled page (complete, body > 3 children): ONE tab lookup, no re-read, no sleep, no waitedMs", async () => {
    const first = empty("complete", 12);
    const h = harness({ reads: [first], tabs: [{ status: "complete" }] });
    const out = await settleSnapshot(first, h.deps);
    expect(out).toEqual({ result: first });
    expect("waitedMs" in out).toBe(false);
    expect("tabStatus" in out).toBe(false);
    expect(h.deps.getTab).toHaveBeenCalledTimes(1);
    expect(h.deps.read).not.toHaveBeenCalled();
    expect(h.deps.sleep).not.toHaveBeenCalled();
  });
});

describe("settleSnapshot: a loading tab", () => {
  it("fills in after two re-reads: polls every 300 ms and reports the wait", async () => {
    const h = harness({
      reads: [empty("loading", 1), found(5)],
      tabs: [{ status: "loading" }, { status: "loading" }, { status: "complete" }],
    });
    // first read is empty+loading; re-read 1 still empty, re-read 2 has elements
    const out = await settleSnapshot(empty("loading", 0), h.deps);
    expect(h.sleeps).toEqual([300, 300]);
    expect(out.result.total).toBe(5);
    expect(out.waitedMs).toBe(600);
    expect(out.tabStatus).toBe("complete");
  });

  it("stays empty: stops at SNAPSHOT_SETTLE_LOADING_MS, never sleeps past the budget, reports waitedMs", async () => {
    const h = harness({
      reads: [empty("loading", 0)],
      tabs: [{ status: "loading" }],
    });
    const out = await settleSnapshot(empty("loading", 0), h.deps);
    expect(out.waitedMs).toBe(SNAPSHOT_SETTLE_LOADING_MS);
    expect(out.tabStatus).toBe("loading");
    expect(out.result.total).toBe(0);
    // 16 full polls and one short one: the last sleep is trimmed to the time left.
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(SNAPSHOT_SETTLE_LOADING_MS);
    expect(Math.max(...h.sleeps)).toBe(SNAPSHOT_SETTLE_POLL_MS);
    expect(h.sleeps[h.sleeps.length - 1]).toBe(SNAPSHOT_SETTLE_LOADING_MS % SNAPSHOT_SETTLE_POLL_MS);
    // No re-read ever starts after the deadline.
    for (const at of h.readAt) {
      expect(at).toBeLessThanOrEqual(h.startedAt + SNAPSHOT_SETTLE_LOADING_MS);
    }
    expect(h.deps.read).toHaveBeenCalledTimes(h.sleeps.length);
  });

  it("measures waitedMs on the injected clock, so slow reads count against the budget", async () => {
    const h = harness({
      reads: [empty("loading", 0)],
      tabs: [{ status: "loading" }],
      readCostMs: 1000,
    });
    const out = await settleSnapshot(empty("loading", 0), h.deps);
    // Each iteration costs a 300 ms sleep (or what is left) plus a 1 s read.
    expect(out.waitedMs).toBeGreaterThanOrEqual(SNAPSHOT_SETTLE_LOADING_MS);
    expect(out.waitedMs).toBeLessThan(SNAPSHOT_SETTLE_LOADING_MS + 1000 + SNAPSHOT_SETTLE_POLL_MS);
    // Far fewer than the 17 reads a free read allows.
    expect(h.deps.read.mock.calls.length).toBeLessThan(6);
  });

  it("finishes loading into a genuinely empty page (complete, full body): stops at once", async () => {
    const h = harness({
      reads: [empty("loading", 1), empty("complete", 9)],
      tabs: [{ status: "loading" }, { status: "loading" }, { status: "complete" }],
    });
    const out = await settleSnapshot(empty("loading", 0), h.deps);
    expect(h.sleeps).toEqual([300, 300]);
    expect(out.waitedMs).toBe(600);
    expect(out.tabStatus).toBe("complete");
    expect(out.result.total).toBe(0);
  });

  it("finishes loading into a shell: that shell gets its own fresh budget", async () => {
    // Loading for 600 ms, then complete but bare for the rest.
    const h = harness({
      reads: [empty("loading", 1), empty("complete", 1)],
      tabs: [{ status: "loading" }, { status: "loading" }, { status: "complete" }],
    });
    const out = await settleSnapshot(empty("loading", 0), h.deps);
    expect(out.waitedMs).toBe(600 + SNAPSHOT_SETTLE_SHELL_MS);
    expect(out.tabStatus).toBe("complete");
  });
});

describe("settleSnapshot: a complete but unrendered app shell", () => {
  it("stays empty: waits exactly SNAPSHOT_SETTLE_SHELL_MS (and not the loading budget)", async () => {
    const h = harness({ reads: [empty("complete", 1)], tabs: [{ status: "complete" }] });
    const out = await settleSnapshot(empty("complete", 1), h.deps);
    expect(out.waitedMs).toBe(SNAPSHOT_SETTLE_SHELL_MS);
    expect(out.tabStatus).toBe("complete");
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(SNAPSHOT_SETTLE_SHELL_MS);
    expect(h.deps.read).toHaveBeenCalledTimes(5);
  });

  it("renders after a few polls: returns the rendered read", async () => {
    const h = harness({
      reads: [empty("complete", 1), empty("complete", 2), found(7)],
      tabs: [{ status: "complete" }],
    });
    const out = await settleSnapshot(empty("complete", 1), h.deps);
    expect(out.result.total).toBe(7);
    expect(out.waitedMs).toBe(900);
  });

  it("a blank body (no children) counts as a shell too", async () => {
    const h = harness({ reads: [empty("complete", 0)], tabs: [{ status: "complete" }] });
    const out = await settleSnapshot(empty("complete", 0), h.deps);
    expect(out.waitedMs).toBe(SNAPSHOT_SETTLE_SHELL_MS);
  });

  it("a shell that starts navigating again falls back to the loading budget", async () => {
    // Shell for 300 ms, then a new navigation begins and never finishes.
    const h = harness({
      reads: [empty("complete", 1), empty("loading", 0)],
      tabs: [{ status: "complete" }, { status: "loading" }],
    });
    const out = await settleSnapshot(empty("complete", 1), h.deps);
    expect(out.waitedMs).toBe(SNAPSHOT_SETTLE_LOADING_MS);
    expect(out.tabStatus).toBe("loading");
  });
});

describe("settleSnapshot: a re-read that fails mid-navigation", () => {
  it("is retried within the budget and the next success is used", async () => {
    const h = harness({
      reads: [new Error("Could not establish connection. Receiving end does not exist."), new Error("Frame with ID 0 was removed."), found(2)],
      tabs: [{ status: "loading" }],
    });
    const out = await settleSnapshot(empty("loading", 0), h.deps);
    expect(out.result.total).toBe(2);
    expect(out.waitedMs).toBe(900);
    expect(h.deps.read).toHaveBeenCalledTimes(3);
  });

  it("rethrows the LAST error once the budget is spent with the last attempt failing", async () => {
    const last = new Error("fake last failure");
    let n = 0;
    const h = harness({ reads: [new Error("x")], tabs: [{ status: "loading" }] });
    h.deps.read.mockImplementation(async () => {
      n++;
      throw n >= 17 ? last : new Error(`fake failure ${n}`);
    });
    await expect(settleSnapshot(empty("loading", 0), h.deps)).rejects.toBe(last);
    expect(n).toBe(17);
  });

  it("a failure followed by a success that is still empty ends with that read, not an error", async () => {
    const h = harness({
      reads: [new Error("fake once"), empty("loading", 0)],
      tabs: [{ status: "loading" }],
    });
    const out = await settleSnapshot(empty("loading", 0), h.deps);
    expect(out.waitedMs).toBe(SNAPSHOT_SETTLE_LOADING_MS);
    expect(out.result.total).toBe(0);
  });
});

describe("settleSnapshot: a tab that goes away", () => {
  it("a closed tab (getTab rejects) ends the wait with that error", async () => {
    const gone = new Error("No tab with id: 9.");
    const h = harness({
      reads: [empty("loading", 0)],
      tabs: [{ status: "loading" }, gone],
    });
    await expect(settleSnapshot(empty("loading", 0), h.deps)).rejects.toBe(gone);
    expect(h.sleeps).toEqual([300]);
  });

  it("getTab rejecting right after the first read (tab closed, or denied) propagates before any wait", async () => {
    const denied = new Error("Domain in tab URL is in the deny list");
    const h = harness({ reads: [empty("loading", 0)], tabs: [denied] });
    await expect(settleSnapshot(empty("loading", 0), h.deps)).rejects.toBe(denied);
    expect(h.deps.sleep).not.toHaveBeenCalled();
  });

  it("a discarded tab: the read error propagates at once instead of being retried", async () => {
    const cannotAccess = new Error(
      "Cannot access contents of the page. Extension manifest must request permission to access the respective host."
    );
    for (const tab of [{ status: "unloaded", discarded: true }, { status: "complete", discarded: true }, { status: "unloaded" }]) {
      const h = harness({
        reads: [cannotAccess],
        tabs: [{ status: "loading" }, tab],
      });
      await expect(settleSnapshot(empty("loading", 0), h.deps)).rejects.toBe(cannotAccess);
      expect(h.deps.read).toHaveBeenCalledTimes(1);
      expect(h.sleeps).toEqual([300]);
    }
  });

  it("a discarded tab that somehow reads fine is not an error", async () => {
    const h = harness({ reads: [found(1)], tabs: [{ status: "loading" }, { status: "unloaded", discarded: true }] });
    const out = await settleSnapshot(empty("loading", 0), h.deps);
    expect(out.result.total).toBe(1);
  });
});

describe("settleSnapshot: pacing", () => {
  it("sleeps only through the injected sleep, never a timer of its own", async () => {
    const spy = jest.spyOn(global, "setTimeout");
    try {
      const h = harness({ reads: [found()], tabs: [{ status: "loading" }] });
      await settleSnapshot(empty("loading", 0), h.deps);
      expect(h.deps.sleep).toHaveBeenCalledWith(300);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
