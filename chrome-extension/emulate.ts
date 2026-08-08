/**
 * Background-side device/UA emulation support for Chrome MV3.
 *
 * Blocking webRequest is unavailable in MV3 service workers, so we rewrite the
 * wire User-Agent request header via declarativeNetRequest session rules
 * instead (one modifyHeaders rule per tab; see buildUserAgentRule /
 * applyUserAgentRule below). This makes the server-visible User-Agent header
 * match the emulated value. The page-world navigator.userAgent shim (injected
 * by the message handler) covers what the PAGE reads in JS, so the two stay
 * consistent.
 *
 * A DNR session rule is BROWSER state, not extension state: it keeps rewriting
 * headers even if this service-worker generation forgets about it. So every
 * entry in the per-tab map below owns a rule id, and every path that drops an
 * entry (tab close, emulate-clear, Automation Mode off) must also remove the
 * rule. Rules whose owner is gone entirely — an MV3 service-worker eviction
 * takes the map with it — are swept from the reserved id band at startup, the
 * same way browser-http.ts sweeps its Cookie rules.
 */

const userAgents = new Map<number, UserAgentEntry>();

/**
 * A tab's live emulation: the override string plus the id of the DNR session
 * rule installed for it. The rule id is allocated (see allocateRuleId) rather
 * than derived from the tabId, so it always lands inside the reserved band.
 */
export interface UserAgentEntry {
  userAgent: string;
  ruleId: number;
}

export function getTabUserAgent(tabId: number): string | undefined {
  return userAgents.get(tabId)?.userAgent;
}

/**
 * TEST-ONLY. Forget every tracked override WITHOUT touching the installed DNR
 * rules, so the browser keeps rewriting headers for them — reaching for this in
 * production code IS the bug that made Automation-Mode-off leave live rules
 * behind. It has no production callers; tests use it to reset module state.
 * Production code wants clearAllUserAgentRules().
 *
 * @internal
 */
export function clearAllUserAgents(): void {
  userAgents.clear();
}

/**
 * TEST-ONLY accessor for the live per-tab map. Mutating it desynchronizes the
 * map from the installed rules — see clearAllUserAgents above.
 *
 * @internal
 */
export function __getUserAgentMap(): Map<number, UserAgentEntry> {
  return userAgents;
}

// Reserved id band for per-tab User-Agent DNR session rules: ids are allocated
// from [UA_RULE_ID_BASE, UA_RULE_ID_MAX) and nowhere else.
//
// The band is BOUNDED on purpose. The old scheme was `UA_RULE_ID_BASE + tabId`,
// which is unbounded upward because Chrome tab ids keep climbing for the life of
// a browser session — a long-lived browser reaches ids that push the computed
// rule id into browser-http.ts's Cookie band, where clearStaleCookieRules()
// deletes it wholesale on the next service-worker boot (and where it can collide
// with a real Cookie rule id).
//
// INVARIANT: UA_RULE_ID_MAX <= COOKIE_RULE_ID_BASE, so the two bands — and
// therefore the two startup sweeps — are strictly disjoint. This module does not
// import COOKIE_RULE_ID_BASE, so there is no compile-time link; the invariant is
// asserted in __tests__/emulate.test.ts against both real exported constants, so
// moving either band fails that test (and CI) rather than silently overlapping.
export const UA_RULE_ID_BASE = 100000;
export const UA_RULE_ID_MAX = 200000;
const UA_RULE_ID_SPAN = UA_RULE_ID_MAX - UA_RULE_ID_BASE;

// Rotating allocation cursor within the band. Rotating (rather than "lowest
// free") keeps a just-released id from being handed straight back to the next
// tab, which would make a late in-flight removal for the closed tab silently
// delete the new tab's rule.
let uaRuleCursor = 0;

// Resource types whose request User-Agent header we rewrite. Covers the page
// load and its subresources/XHR so the wire UA is consistent.
const UA_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "script",
  "image",
  "stylesheet",
  "font",
  "media",
  "websocket",
  "other",
];

function errMessage(e: unknown): string {
  return String((e as any)?.message ?? e);
}

/** Rule ids this service-worker generation currently believes are installed. */
function liveRuleIds(): Set<number> {
  const ids = new Set<number>();
  for (const entry of userAgents.values()) {
    ids.add(entry.ruleId);
  }
  return ids;
}

/**
 * Take the next free id in the reserved band. Scans forward from the rotating
 * cursor, skipping ids held by live entries, so two emulated tabs can never
 * share a rule id no matter how large their tabIds are.
 *
 * Chrome caps session rules far below the band width, so exhaustion is not
 * reachable in practice; it throws rather than returning a colliding id.
 */
function allocateRuleId(): number {
  const live = liveRuleIds();
  for (let i = 0; i < UA_RULE_ID_SPAN; i++) {
    const candidate = UA_RULE_ID_BASE + ((uaRuleCursor + i) % UA_RULE_ID_SPAN);
    if (!live.has(candidate)) {
      uaRuleCursor = (candidate - UA_RULE_ID_BASE + 1) % UA_RULE_ID_SPAN;
      return candidate;
    }
  }
  throw new Error(
    `emulate: no free User-Agent rule id in [${UA_RULE_ID_BASE}, ${UA_RULE_ID_MAX}) — ${userAgents.size} tabs are being emulated`
  );
}

/**
 * Pure builder for a declarativeNetRequest session rule that sets the
 * User-Agent request header for one tab. No chrome.* access — unit-testable.
 */
export function buildUserAgentRule(
  tabId: number,
  userAgent: string,
  ruleId: number
): {
  id: number;
  priority: number;
  action: {
    type: "modifyHeaders";
    requestHeaders: { header: string; operation: "set"; value: string }[];
  };
  condition: { tabIds: number[]; resourceTypes: string[] };
} {
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "user-agent", operation: "set", value: userAgent },
      ],
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: UA_RESOURCE_TYPES,
    },
  };
}

/**
 * Installs (or replaces) the per-tab User-Agent session rule on the wire. A tab
 * that is already emulated keeps its allocated rule id, so re-applying replaces
 * the rule in place instead of leaving the previous one orphaned.
 *
 * If the browser rejects the update, the tracked entry is rolled back so the map
 * never claims an override that is not on the wire (and the allocated id is
 * released back to the band). The rollback is compare-and-restore: it only fires
 * while the entry is still the one THIS call wrote, so a failure here cannot
 * delete a concurrent apply's entry whose rule is live.
 */
export async function applyUserAgentRule(
  tabId: number,
  userAgent: string
): Promise<void> {
  const previous = userAgents.get(tabId);
  const id = previous ? previous.ruleId : allocateRuleId();
  const mine: UserAgentEntry = { userAgent, ruleId: id };
  userAgents.set(tabId, mine);
  try {
    await (browser as any).declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [buildUserAgentRule(tabId, userAgent, id)],
    });
  } catch (e) {
    if (userAgents.get(tabId) === mine) {
      if (previous) {
        userAgents.set(tabId, previous);
      } else {
        userAgents.delete(tabId);
      }
    }
    throw e;
  }
}

/**
 * Removes the per-tab User-Agent session rule (on emulate-clear / tab close).
 *
 * A tab this generation is not emulating owns no rule, so there is nothing to
 * remove and no DNR call is made — which matters because this runs on EVERY tab
 * close. A rule whose map entry was lost to a service-worker eviction is not
 * reachable here; clearStaleUserAgentRules() at startup is what collects those.
 *
 * If the browser rejects the removal the entry is restored, because the rule is
 * still installed: this also runs for a LIVE tab (emulate with userAgent:""), so
 * forgetting the entry would leave that tab's UA rewritten untracked, with its
 * rule id free to be handed to another tab. Compare-and-restore, for the same
 * reason as applyUserAgentRule.
 */
export async function clearUserAgentRule(tabId: number): Promise<void> {
  const entry = userAgents.get(tabId);
  if (!entry) {
    return;
  }
  userAgents.delete(tabId);
  try {
    await (browser as any).declarativeNetRequest.updateSessionRules({
      removeRuleIds: [entry.ruleId],
    });
  } catch (e) {
    if (!userAgents.has(tabId)) {
      userAgents.set(tabId, entry);
    }
    throw e;
  }
}

/**
 * Remove every session rule in the reserved User-Agent band that no live map
 * entry owns. Only ids inside [UA_RULE_ID_BASE, UA_RULE_ID_MAX) are ever
 * touched, so browser-http.ts's Cookie rules are never disturbed. Never throws —
 * a failure here must not take down startup or the Automation Mode toggle.
 *
 * `keep` is a PROVIDER, not a set, and is deliberately called AFTER the
 * getSessionRules() await. A rule installed during that await is present in the
 * read-back, so a set frozen before the await would not contain it and the sweep
 * would delete a live rule while its map entry survived — leaving the map
 * claiming an override that is not on the wire. Recomputing afterwards keeps the
 * map and the wire consistent: a rule that arrives mid-sweep is kept AND still
 * tracked, so the next teardown or startup sweep can collect it.
 */
async function removeUserAgentRulesInBand(
  keep: () => ReadonlySet<number>
): Promise<void> {
  try {
    const dnr = (browser as any).declarativeNetRequest;
    const existing: Array<{ id?: number }> = (await dnr.getSessionRules()) ?? [];
    const live = keep();
    const stale = existing
      .map((r) => r.id)
      .filter(
        (id): id is number =>
          typeof id === "number" &&
          id >= UA_RULE_ID_BASE &&
          id < UA_RULE_ID_MAX &&
          !live.has(id)
      );
    if (stale.length > 0) {
      await dnr.updateSessionRules({ removeRuleIds: stale });
    }
  } catch (e) {
    console.error(
      "emulate: failed to clear stale user-agent rules:",
      errMessage(e)
    );
  }
}

/**
 * Remove leftover User-Agent DNR session rules in our reserved id band. A rule
 * is removed on emulate-clear, on tab close, and when Automation Mode turns off;
 * but if the MV3 service worker is recycled the per-tab map is lost while the
 * rules survive — the browser would keep rewriting the User-Agent header on
 * those tabs, with nothing left that knows the rules exist, until the browser
 * restarts. Run once at service-worker startup, this sweep clears them.
 *
 * Every rule the map owns at the moment the read-back lands is kept — including
 * one installed while this sweep was in flight — so it is safe to call at any
 * time, not only before the first applyUserAgentRule.
 */
export async function clearStaleUserAgentRules(): Promise<void> {
  await removeUserAgentRulesInBand(liveRuleIds);
}

// Teardown drains in a loop rather than one pass, because a rule can be
// installed after the read-back it would have appeared in. The bound only exists
// so a pathological state cannot spin the service worker; see the convergence
// note on clearAllUserAgentRules.
const TEARDOWN_MAX_PASSES = 5;

/**
 * One teardown pass: remove every band rule the browser currently reports, then
 * forget the entries those rules belonged to — identified by ENTRY OBJECT, not
 * by rule id.
 *
 * The distinction is load-bearing. A rule id does not identify a generation of
 * emulation: applyUserAgentRule REUSES an already-emulated tab's rule id, so an
 * `emulate` that lands while the removal below is in flight puts the very same
 * id back on the wire. Dropping by "ids we asked to remove" would then forget a
 * tab whose rule is installed again — leaving the browser rewriting the
 * User-Agent untracked after Automation Mode is off, which is Bug F, and which
 * a tab close cannot even collect (clearUserAgentRule early-returns with no
 * entry). Every apply allocates a fresh UserAgentEntry, so an identity check
 * distinguishes the re-applied entry and leaves it tracked for the next pass.
 *
 * Invariant, at every await: an entry is dropped only after ITS rule was taken
 * off the wire and not put back, and a rule is never removed while the entry
 * that owns it survives.
 */
async function teardownUserAgentRulesOnce(): Promise<void> {
  const dnr = (browser as any).declarativeNetRequest;
  const existing: Array<{ id?: number }> = (await dnr.getSessionRules()) ?? [];
  const targets = existing
    .map((r) => r.id)
    .filter(
      (id): id is number =>
        typeof id === "number" && id >= UA_RULE_ID_BASE && id < UA_RULE_ID_MAX
    );
  // Snapshot which entry OBJECT owns each doomed id, before the removal await.
  const doomed = new Set(targets);
  const claimed: Array<[number, UserAgentEntry]> = [];
  for (const [tabId, entry] of userAgents) {
    if (doomed.has(entry.ruleId)) {
      claimed.push([tabId, entry]);
    }
  }
  if (targets.length > 0) {
    await dnr.updateSessionRules({ removeRuleIds: targets });
  }
  for (const [tabId, entry] of claimed) {
    // Still the same entry => nothing re-applied for this tab, so its rule is
    // genuinely off the wire. A different (or absent) entry means a concurrent
    // apply reinstalled the id; leave it tracked and let the next pass remove it.
    if (userAgents.get(tabId) === entry) {
      userAgents.delete(tabId);
    }
  }
}

/**
 * Stop emulating everywhere: remove every session rule in the band AND drop the
 * entries that tracked them. Called when Automation Mode turns off — clearing
 * the map alone would leave the browser rewriting the User-Agent header while
 * automation is off, because the rule lives in the browser, not in the map.
 *
 * Unlike clearStaleUserAgentRules, this must NOT leave a rule that appears
 * mid-teardown installed: an `emulate` already past its automation gate can land
 * inside the window, and keeping it would leave the User-Agent rewritten after
 * automation is off, with no near recovery — the next teardown needs a re-enable
 * AND another disable. So it drains in a loop until nothing is tracked, with
 * each pass dropping only entries whose rules it actually took off the wire.
 *
 * Convergence: `emulate` is in AUTOMATION_COMMANDS, so once the toggle is off
 * the message handler refuses NEW emulate commands. Only the finite set already
 * past that gate can still install, and each pass either removes a rule or lets
 * an in-flight install land for the next one — so this terminates. The pass
 * bound is a backstop against a pathological state, not the expected exit; the
 * steady state finishes in one pass. On exhaustion the leftovers are still
 * TRACKED as well as installed, so the ordinary paths still reach them — a tab
 * close removes one, and a later teardown or the startup sweep finishes the
 * rest. (An UNtracked leftover would have no such recovery, which is exactly
 * why teardownUserAgentRulesOnce drops by entry identity.)
 */
export async function clearAllUserAgentRules(): Promise<void> {
  try {
    for (let pass = 0; pass < TEARDOWN_MAX_PASSES; pass++) {
      await teardownUserAgentRulesOnce();
      if (userAgents.size === 0) {
        return;
      }
    }
    console.error(
      `emulate: ${userAgents.size} user-agent rule(s) still installed after ${TEARDOWN_MAX_PASSES} teardown passes`
    );
  } catch (e) {
    console.error("emulate: failed to remove user-agent rules:", errMessage(e));
  }
}

export function initEmulate(): void {
  try {
    // Collect rules orphaned by a previous service-worker generation. Nothing
    // can have been applied yet this generation (background.ts starts the broker
    // clients after this call), so this runs against a clean map.
    void clearStaleUserAgentRules();

    browser.tabs.onRemoved.addListener((tabId: number) => {
      // clearUserAgentRule rejects if the browser refuses the removal; this is a
      // fire-and-forget listener, so swallow it rather than raise an unhandled
      // rejection in the service worker. The entry is restored on failure, so the
      // startup sweep still collects the rule.
      void clearUserAgentRule(tabId).catch((e) =>
        console.error("emulate: failed to clear rule for closed tab:", errMessage(e))
      );
    });

    browser.storage.onChanged.addListener(
      (
        changes: { [key: string]: { oldValue?: unknown; newValue?: unknown } },
        areaName: string
      ) => {
        if (areaName !== "local" || !changes.config) {
          return;
        }
        const newConfig = changes.config.newValue as
          | { automationMode?: boolean }
          | undefined;
        const enabled = newConfig?.automationMode === true;
        if (!enabled) {
          void clearAllUserAgentRules();
        }
      }
    );
  } catch (error) {
    console.error("emulate: initEmulate failed:", error);
  }
}
