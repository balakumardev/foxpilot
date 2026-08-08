import {
  buildUserAgentRule,
  applyUserAgentRule,
  clearUserAgentRule,
  clearAllUserAgents,
  clearAllUserAgentRules,
  clearStaleUserAgentRules,
  initEmulate,
  getTabUserAgent,
  __getUserAgentMap,
  UA_RULE_ID_BASE,
  UA_RULE_ID_MAX,
} from "../emulate";
import { COOKIE_RULE_ID_BASE, COOKIE_RULE_ID_MAX } from "../browser-http";

// Grab the most-recently-registered listener for a mocked event API.
function lastListener(mockFn: jest.Mock): (...args: any[]) => any {
  const calls = mockFn.mock.calls;
  return calls[calls.length - 1][0];
}

// Flush pending promise chains (microtasks across multiple awaits).
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const dnr = () => (browser as any).declarativeNetRequest;

// All rule ids passed to addRules across every updateSessionRules call.
function addedRuleIds(): number[] {
  return (dnr().updateSessionRules as jest.Mock).mock.calls.flatMap((c: any[]) =>
    (c[0].addRules ?? []).map((r: any) => r.id)
  );
}

// All rule ids passed to removeRuleIds across every updateSessionRules call.
function removedRuleIds(): number[] {
  return (dnr().updateSessionRules as jest.Mock).mock.calls.flatMap(
    (c: any[]) => c[0].removeRuleIds ?? []
  );
}

// How many updateSessionRules calls have happened so far. Lets a test ignore the
// removeRuleIds an applyUserAgentRule issues for its OWN id and look only at
// what a later call (e.g. a sweep) removed.
function updateCallCount(): number {
  return (dnr().updateSessionRules as jest.Mock).mock.calls.length;
}

// Rule ids removed by updateSessionRules calls made at or after `index`.
function removedRuleIdsSince(index: number): number[] {
  return (dnr().updateSessionRules as jest.Mock).mock.calls
    .slice(index)
    .flatMap((c: any[]) => c[0].removeRuleIds ?? []);
}

// A promise plus its settlers, so a test can hold an await open and interleave
// other work before letting it finish.
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resetDnrMocks(): void {
  jest.clearAllMocks();
  (dnr().updateSessionRules as jest.Mock).mockResolvedValue(undefined);
  (dnr().getSessionRules as jest.Mock).mockResolvedValue([]);
}

beforeEach(() => {
  resetDnrMocks();
  // The per-tab map is module state; start every test with an empty one.
  clearAllUserAgents();
});

afterEach(() => {
  clearAllUserAgents();
});

describe("buildUserAgentRule (pure)", () => {
  it("builds a modifyHeaders session rule that sets User-Agent for the given tab", () => {
    const rule = buildUserAgentRule(42, "MyUA/1.0", 4200);
    expect(rule.id).toBe(4200);
    expect(rule.action.type).toBe("modifyHeaders");
    expect(rule.action.requestHeaders).toEqual([
      { header: "user-agent", operation: "set", value: "MyUA/1.0" },
    ]);
    expect(rule.condition.tabIds).toEqual([42]);
    expect(Array.isArray(rule.condition.resourceTypes)).toBe(true);
    expect(rule.condition.resourceTypes.length).toBeGreaterThan(0);
  });

  it("derives a stable, distinct rule id per tab", () => {
    const a = buildUserAgentRule(1, "ua", 1001);
    const b = buildUserAgentRule(2, "ua", 1002);
    expect(a.id).not.toBe(b.id);
  });
});

describe("applyUserAgentRule / clearUserAgentRule (DNR plumbing)", () => {
  it("applies a session rule via updateSessionRules with the rule in addRules and its id removed first", async () => {
    await applyUserAgentRule(7, "UA-7");
    expect(dnr().updateSessionRules).toHaveBeenCalledTimes(1);
    const arg = (dnr().updateSessionRules as jest.Mock).mock.calls[0][0];
    expect(arg.addRules).toHaveLength(1);
    expect(arg.addRules[0].action.requestHeaders[0].value).toBe("UA-7");
    expect(arg.addRules[0].condition.tabIds).toEqual([7]);
    // The same id is cleared first so re-applying for a tab replaces cleanly.
    expect(arg.removeRuleIds).toContain(arg.addRules[0].id);
  });

  it("clearUserAgentRule removes only that tab's rule id", async () => {
    await applyUserAgentRule(7, "x");
    const expectedId = (dnr().updateSessionRules as jest.Mock).mock.calls[0][0]
      .addRules[0].id;
    resetDnrMocks();

    await clearUserAgentRule(7);
    expect(dnr().updateSessionRules).toHaveBeenCalledTimes(1);
    const arg = (dnr().updateSessionRules as jest.Mock).mock.calls[0][0];
    expect(arg.removeRuleIds).toEqual([expectedId]);
    expect(arg.addRules ?? []).toEqual([]);
  });

  it("re-applying for the same tab reuses that tab's rule id (no orphan left behind)", async () => {
    await applyUserAgentRule(7, "first");
    const firstId = addedRuleIds()[0];
    resetDnrMocks();

    await applyUserAgentRule(7, "second");
    expect(addedRuleIds()).toEqual([firstId]);
    expect(getTabUserAgent(7)).toBe("second");
  });

  it("clearing a tab that is not emulated makes no declarativeNetRequest call", async () => {
    // tabs.onRemoved fires for every tab close, not just emulated ones.
    await clearUserAgentRule(4242);
    expect(dnr().updateSessionRules).not.toHaveBeenCalled();
  });

  it("rolls the tracked override back when the browser rejects the rule update", async () => {
    (dnr().updateSessionRules as jest.Mock).mockRejectedValueOnce(
      new Error("rule limit exceeded")
    );
    await expect(applyUserAgentRule(9, "Never/1.0")).rejects.toThrow(
      "rule limit exceeded"
    );
    // The map must not claim an override that never reached the wire.
    expect(getTabUserAgent(9)).toBeUndefined();
  });

  // F2 — the emulate-clear path (message-handler passes userAgent:"" for a tab
  // the user is still using), not just tabs.onRemoved.
  it("restores the tracked override when the browser rejects the rule REMOVAL", async () => {
    await applyUserAgentRule(9, "Live/1.0");
    resetDnrMocks();
    (dnr().updateSessionRules as jest.Mock).mockRejectedValueOnce(
      new Error("removal rejected")
    );

    await expect(clearUserAgentRule(9)).rejects.toThrow("removal rejected");

    // The rule is still installed, so the map must still track it — otherwise
    // the UA keeps being rewritten untracked and the id is free to reallocate.
    expect(getTabUserAgent(9)).toBe("Live/1.0");
  });

  // F3 — compare-and-restore, not restore-a-pre-call-snapshot.
  it("a failed apply does not clobber a concurrent apply's entry for the same tab", async () => {
    const first = deferred<void>();
    (dnr().updateSessionRules as jest.Mock)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);

    const failing = applyUserAgentRule(5, "First/1.0");
    // Attach the rejection handler now so the later reject is never unhandled.
    const settled = expect(failing).rejects.toThrow("boom");
    await Promise.resolve();
    // A second apply for the same tab lands and SUCCEEDS while the first is
    // still in flight.
    await applyUserAgentRule(5, "Second/1.0");

    first.reject(new Error("boom"));
    await settled;

    // The first call's rollback must not delete the second call's live entry.
    expect(getTabUserAgent(5)).toBe("Second/1.0");
  });
});

// ---------------------------------------------------------------------------
// Bug G — the User-Agent id band must be BOUNDED and disjoint from the cookie
// band that browser-http.ts's startup sweep deletes wholesale.
// ---------------------------------------------------------------------------

describe("User-Agent rule id band (Bug G)", () => {
  it("reserves a band that cannot overlap the Cookie-rule band", () => {
    expect(UA_RULE_ID_BASE).toBeLessThan(UA_RULE_ID_MAX);
    // Disjoint by construction: the UA band must end at or before the cookie
    // band starts, so neither startup sweep can delete the other's live rules.
    expect(UA_RULE_ID_MAX).toBeLessThanOrEqual(COOKIE_RULE_ID_BASE);
  });

  // Chrome tab ids climb for the life of a browser session, so a long-lived
  // browser genuinely reaches ids in the hundreds of thousands. These tabIds
  // break a `UA_RULE_ID_BASE + tabId` scheme in different ways: 150_000 lands
  // SQUARELY INSIDE the cookie band (100000 + 150000 = 250000), where
  // clearStaleCookieRules() would delete the live UA rule on the next SW boot;
  // 5_000_000 escapes every reserved band entirely. 1 is the benign control.
  it.each([1, 150_000, 5_000_000])(
    "allocates an in-band id that is never inside the Cookie band (tabId %i)",
    async (tabId) => {
      await applyUserAgentRule(tabId, `UA-${tabId}`);

      const [id] = addedRuleIds();
      expect(id).toBeGreaterThanOrEqual(UA_RULE_ID_BASE);
      expect(id).toBeLessThan(UA_RULE_ID_MAX);
      const insideCookieBand =
        id >= COOKIE_RULE_ID_BASE && id < COOKIE_RULE_ID_MAX;
      expect(insideCookieBand).toBe(false);
    }
  );

  it("keeps every live tab's rule id distinct, including tabIds a band-width apart", async () => {
    const span = UA_RULE_ID_MAX - UA_RULE_ID_BASE;
    // Tab ids exactly one band width apart are the pair a wrapping allocator is
    // most likely to collide on. They must still get distinct rule ids.
    const tabIds = [1, 1 + span, 2, 2 + span, 5_000_000];
    for (const tabId of tabIds) {
      await applyUserAgentRule(tabId, `UA-${tabId}`);
    }
    const ids = addedRuleIds();
    expect(ids).toHaveLength(tabIds.length);
    expect(new Set(ids).size).toBe(tabIds.length);
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(UA_RULE_ID_BASE);
      expect(id).toBeLessThan(UA_RULE_ID_MAX);
    }
  });

  it("keeps serving in-band ids across apply/clear churn with arbitrary tabIds", async () => {
    // Releasing an id must return it to the band rather than leak the slot, and
    // the id must stay in-band however large the tabId gets.
    for (const tabId of [1, 150_000, 5_000_000, 987_654_321]) {
      await applyUserAgentRule(tabId, `UA-${tabId}`);
      const [id] = addedRuleIds();
      expect(id).toBeGreaterThanOrEqual(UA_RULE_ID_BASE);
      expect(id).toBeLessThan(UA_RULE_ID_MAX);
      await clearUserAgentRule(tabId);
      resetDnrMocks();
    }
  });

  it("does not hand a just-released id straight back to the next allocation", async () => {
    await applyUserAgentRule(1, "UA-1");
    const [firstId] = addedRuleIds();
    await clearUserAgentRule(1);
    resetDnrMocks();

    // Re-emulating the SAME tab must not immediately reuse the id it just
    // released: a late in-flight removal for the old rule would otherwise delete
    // the newly installed one. A tabId-derived id hands back the same number.
    await applyUserAgentRule(1, "UA-1-again");
    expect(addedRuleIds()[0]).not.toBe(firstId);
  });
});

// ---------------------------------------------------------------------------
// Bug F — turning Automation Mode off must REMOVE the installed DNR rules, not
// just wipe the in-memory map. A DNR session rule lives in the browser: clearing
// the map leaves the browser rewriting the User-Agent header while automation is
// off, with nothing left that knows the rule exists.
// ---------------------------------------------------------------------------

describe("Automation Mode off tears down installed UA rules (Bug F)", () => {
  it("removes the installed session rules when Automation Mode flips off", async () => {
    initEmulate();
    const onChanged = lastListener(
      browser.storage.onChanged.addListener as jest.Mock
    );

    await applyUserAgentRule(11, "Spoofed/1.0");
    await applyUserAgentRule(12, "Spoofed/2.0");
    const installed = addedRuleIds();
    expect(installed).toHaveLength(2);

    resetDnrMocks();
    (dnr().getSessionRules as jest.Mock).mockResolvedValue(
      installed.map((id) => ({ id }))
    );

    onChanged(
      {
        config: {
          oldValue: { automationMode: true },
          newValue: { automationMode: false },
        },
      },
      "local"
    );
    await flushPromises();

    expect(dnr().updateSessionRules).toHaveBeenCalled();
    const removed = removedRuleIds();
    for (const id of installed) {
      expect(removed).toContain(id);
    }
    // Nothing may be re-installed on the way out.
    expect(addedRuleIds()).toEqual([]);
  });

  it("leaves browser-http's Cookie rules alone when Automation Mode flips off", async () => {
    initEmulate();
    const onChanged = lastListener(
      browser.storage.onChanged.addListener as jest.Mock
    );
    await applyUserAgentRule(11, "Spoofed/1.0");
    const installed = addedRuleIds();
    resetDnrMocks();
    (dnr().getSessionRules as jest.Mock).mockResolvedValue([
      ...installed.map((id) => ({ id })),
      { id: COOKIE_RULE_ID_BASE },
      { id: COOKIE_RULE_ID_MAX - 1 },
    ]);

    onChanged({ config: { newValue: { automationMode: false } } }, "local");
    await flushPromises();

    const removed = removedRuleIds();
    expect(removed).toEqual(installed);
    expect(removed).not.toContain(COOKIE_RULE_ID_BASE);
    expect(removed).not.toContain(COOKIE_RULE_ID_MAX - 1);
  });

  it("clearAllUserAgentRules drops the map so a later re-enable cannot resurrect stale spoofing", async () => {
    await applyUserAgentRule(11, "Spoofed/1.0");
    const installed = addedRuleIds();
    resetDnrMocks();
    (dnr().getSessionRules as jest.Mock).mockResolvedValue(
      installed.map((id) => ({ id }))
    );

    await clearAllUserAgentRules();
    expect(getTabUserAgent(11)).toBeUndefined();
    resetDnrMocks();

    // With the map cleared there is no longer any rule this extension believes
    // it owns for tab 11, so clearing it again is a no-op.
    await clearUserAgentRule(11);
    expect(dnr().updateSessionRules).not.toHaveBeenCalled();
  });

  it("ignores storage.onChanged events from other areas or unrelated keys", async () => {
    initEmulate();
    const onChanged = lastListener(
      browser.storage.onChanged.addListener as jest.Mock
    );
    await applyUserAgentRule(21, "Keep/1.0");
    resetDnrMocks();

    onChanged({ config: { newValue: { automationMode: false } } }, "sync");
    onChanged({ somethingElse: { newValue: 1 } }, "local");
    await flushPromises();

    expect(dnr().updateSessionRules).not.toHaveBeenCalled();
    expect(getTabUserAgent(21)).toBe("Keep/1.0");
  });
});

// ---------------------------------------------------------------------------
// Bug H — an MV3 service-worker eviction takes the per-tab map with it and
// leaves the rules installed. Sweep the reserved band at startup, exactly like
// clearStaleCookieRules does for the Cookie band.
// ---------------------------------------------------------------------------

describe("clearStaleUserAgentRules (Bug H)", () => {
  it("removes only orphaned session rules within the User-Agent id band", async () => {
    (dnr().getSessionRules as jest.Mock).mockResolvedValue([
      { id: UA_RULE_ID_BASE }, // orphaned UA rule (band floor)
      { id: UA_RULE_ID_MAX - 1 }, // orphaned UA rule (band ceiling)
      { id: UA_RULE_ID_MAX }, // one past the band — left alone
      { id: COOKIE_RULE_ID_BASE }, // browser-http.ts cookie rule — left alone
      { id: 42 }, // below the band — left alone
    ]);

    await clearStaleUserAgentRules();

    expect(dnr().updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [UA_RULE_ID_BASE, UA_RULE_ID_MAX - 1],
    });
  });

  it("makes no removal call when there are no stale User-Agent rules", async () => {
    (dnr().getSessionRules as jest.Mock).mockResolvedValue([
      { id: COOKIE_RULE_ID_BASE },
    ]);

    await clearStaleUserAgentRules();

    expect(dnr().updateSessionRules).not.toHaveBeenCalled();
  });

  it("does not delete a rule this service-worker generation still owns", async () => {
    await applyUserAgentRule(3, "Live/1.0");
    const [liveId] = addedRuleIds();
    resetDnrMocks();
    (dnr().getSessionRules as jest.Mock).mockResolvedValue([
      { id: liveId },
      { id: UA_RULE_ID_BASE + 12345 }, // orphan from a prior generation
    ]);

    await clearStaleUserAgentRules();

    const removed = removedRuleIds();
    expect(removed).not.toContain(liveId);
    expect(removed).toContain(UA_RULE_ID_BASE + 12345);
  });

  // F1 — `keep` must be recomputed AFTER the getSessionRules() await. A rule
  // installed during that await is read back by getSessionRules(), and a `keep`
  // frozen before the await does not contain it, so the sweep deletes a LIVE
  // rule while its map entry survives: the map then claims an override that is
  // not on the wire.
  it("does not delete a rule installed while the sweep awaits getSessionRules", async () => {
    const gate = deferred<Array<{ id: number }>>();
    (dnr().getSessionRules as jest.Mock).mockReturnValue(gate.promise);

    const sweep = clearStaleUserAgentRules();
    await Promise.resolve(); // let the sweep reach its await

    await applyUserAgentRule(4321, "Live/1.0");
    const [liveId] = addedRuleIds();
    const sweepCallsStart = updateCallCount();

    gate.resolve([{ id: liveId }]);
    await sweep;

    expect(removedRuleIdsSince(sweepCallsStart)).not.toContain(liveId);
    expect(getTabUserAgent(4321)).toBe("Live/1.0");
  });

  // N1 — teardown is the one sweep that must NOT keep a mid-window rule. An
  // `emulate` already past its automation gate can land inside the window, and
  // keeping it would leave the browser rewriting the User-Agent after Automation
  // Mode is off — a narrow recurrence of Bug F. There is no "next teardown" to
  // recover: that needs a re-enable AND another disable. So teardown must end
  // with nothing installed and nothing tracked, and must never leave an entry
  // tracked-but-uninstalled on the way there.
  it("removes a rule installed while Automation-Mode-off teardown is in flight", async () => {
    const gate = deferred<Array<{ id: number }>>();
    (dnr().getSessionRules as jest.Mock).mockReturnValue(gate.promise);

    const teardown = clearAllUserAgentRules();
    await Promise.resolve();

    await applyUserAgentRule(4321, "Live/1.0");
    const [liveId] = addedRuleIds();
    const sweepCallsStart = updateCallCount();

    gate.resolve([{ id: liveId }]);
    await teardown;

    expect(removedRuleIdsSince(sweepCallsStart)).toContain(liveId);
    expect(getTabUserAgent(4321)).toBeUndefined();
    expect(__getUserAgentMap().size).toBe(0);
  });

  it("takes another teardown pass for a rule that lands after the read-back", async () => {
    // Worst case: the rule is installed too late to appear in the first
    // getSessionRules() read-back, so one pass cannot see it at all.
    const installed: Array<{ id: number }> = [];
    const gate = deferred<void>();
    let firstRead = true;
    (dnr().getSessionRules as jest.Mock).mockImplementation(async () => {
      if (firstRead) {
        firstRead = false;
        await gate.promise;
        return []; // misses the rule that landed meanwhile
      }
      return installed;
    });

    const teardown = clearAllUserAgentRules();
    await Promise.resolve();

    await applyUserAgentRule(4321, "Live/1.0");
    const [liveId] = addedRuleIds();
    installed.push({ id: liveId });
    const sweepCallsStart = updateCallCount();

    gate.resolve();
    await teardown;

    expect(removedRuleIdsSince(sweepCallsStart)).toContain(liveId);
    expect(getTabUserAgent(4321)).toBeUndefined();
    expect(__getUserAgentMap().size).toBe(0);
  });

  it("does not forget a tab whose rule is reinstalled after teardown removed it", async () => {
    // The dangerous ordering, which neither of the tests above reaches: the
    // re-`emulate` is for an ALREADY-emulated tab (so applyUserAgentRule reuses
    // its rule id rather than allocating a fresh one) and its install lands
    // AFTER teardown's removal. Dropping entries by "ids we asked to remove"
    // then forgets a tab whose rule is back on the wire — Bug F verbatim, and
    // a tab close does not collect it either, because clearUserAgentRule
    // early-returns when there is no entry.
    //
    // Modelled against a DNR store that applies mutations in invocation order,
    // so "installed" is a real assertion rather than a mock call count.
    const wire = new Set<number>();
    const gate = deferred<void>();
    let removalHeld = false;

    (dnr().getSessionRules as jest.Mock).mockImplementation(async () =>
      [...wire].map((id) => ({ id }))
    );
    (dnr().updateSessionRules as jest.Mock).mockImplementation(
      async (arg: any) => {
        const isTeardownRemoval = !arg.addRules && !removalHeld;
        for (const id of arg.removeRuleIds ?? []) {
          wire.delete(id);
        }
        for (const r of arg.addRules ?? []) {
          wire.add(r.id);
        }
        if (isTeardownRemoval) {
          removalHeld = true;
          await gate.promise; // hold teardown open after its removal applied
        }
      }
    );

    await applyUserAgentRule(77, "Before/1.0");
    const [idZ] = [...wire];

    const teardown = clearAllUserAgentRules();
    await flushPromises(); // park teardown inside its removal

    // Same tab, so the id is REUSED and the rule goes back on the wire.
    await applyUserAgentRule(77, "After/2.0");
    expect(wire.has(idZ)).toBe(true);

    gate.resolve();
    await teardown;

    // Automation is off: nothing may still be rewriting the User-Agent, and
    // nothing installed may be left untracked.
    const tracked = new Set(
      [...__getUserAgentMap().values()].map((e) => e.ruleId)
    );
    for (const id of wire) {
      expect(tracked.has(id)).toBe(true);
    }
    expect(wire.size).toBe(0);
    expect(__getUserAgentMap().size).toBe(0);
  });

  it("teardown forgets an entry only once its rule is off the wire", async () => {
    // The invariant that must hold at every await: an entry is dropped only
    // after its rule has actually been removed, and never before.
    await applyUserAgentRule(1, "A/1.0");
    await applyUserAgentRule(2, "B/1.0");
    const [idA, idB] = addedRuleIds();
    resetDnrMocks();

    const trackedAtPass2: number[] = [];
    let call = 0;
    (dnr().getSessionRules as jest.Mock).mockImplementation(async () => {
      call++;
      if (call === 1) {
        return [{ id: idA }]; // pass 1 reports only A
      }
      trackedAtPass2.push(
        ...[...__getUserAgentMap().values()].map((e) => e.ruleId)
      );
      return [{ id: idA }, { id: idB }]; // pass 2 reports both
    });

    await clearAllUserAgentRules();

    // Entering pass 2: A's rule was removed so A is forgotten; B's was NOT
    // removed, so B must still be tracked rather than silently dropped.
    expect(trackedAtPass2).toEqual([idB]);
    expect(__getUserAgentMap().size).toBe(0);
  });

  it("swallows a declarativeNetRequest failure rather than breaking startup", async () => {
    (dnr().getSessionRules as jest.Mock).mockRejectedValue(new Error("boom"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(clearStaleUserAgentRules()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("initEmulate sweeps the band at service-worker startup", async () => {
    (dnr().getSessionRules as jest.Mock).mockResolvedValue([
      { id: UA_RULE_ID_BASE + 7 },
      { id: COOKIE_RULE_ID_BASE + 7 },
    ]);

    initEmulate();
    await flushPromises();

    expect(dnr().getSessionRules).toHaveBeenCalled();
    expect(dnr().updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [UA_RULE_ID_BASE + 7],
    });
  });
});

describe("initEmulate wiring", () => {
  it("registers tabs.onRemoved and storage.onChanged listeners", () => {
    initEmulate();
    expect(browser.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
    expect(browser.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
  });

  it("removes a closed tab's rule via the tabs.onRemoved listener", async () => {
    initEmulate();
    const onRemoved = lastListener(
      browser.tabs.onRemoved.addListener as jest.Mock
    );
    await applyUserAgentRule(31, "Closing/1.0");
    const [installed] = addedRuleIds();
    resetDnrMocks();

    onRemoved(31);
    await flushPromises();

    expect(removedRuleIds()).toContain(installed);
    expect(getTabUserAgent(31)).toBeUndefined();
  });
});
