/**
 * Transport-agnostic core of the broker.
 *
 * Owns the routing logic between many MCP clients and the single browser
 * extension: request/response correlation, per-tab serialization, soft tab
 * leases, per-command timeouts, and client/extension disconnect handling.
 *
 * Transport (WebSocket / HTTP long-poll) is injected via `sendToExtension`
 * and `sendToClient`, so all of this logic is unit-testable without sockets.
 */

import type {
  ServerMessage,
  ServerMessageRequest,
  ExtensionMessage,
  ExtensionError,
} from "@foxpilot/common";
import { BrokerServerFrame, getMessageTabId } from "./broker-protocol";
import * as crypto from "crypto";

interface PendingRequest {
  clientId: string;
  requestId: string;
  tabId?: number;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Which browser the transport routed this request to, when it knows. Absent
   * for transports that cannot identify a target (long-poll). Lets a single
   * browser's socket dropping fail only its own in-flight work.
   */
  browserId?: string;
}

interface QueuedRequest {
  clientId: string;
  requestId: string;
  message: ServerMessage;
  tabId: number;
}

interface Lease {
  clientId: string;
  expiresAt: number;
}

/** Outcome of one attempt to hand a request to the browser extension. */
export interface SendToExtensionResult {
  /**
   * Whether the transport actually handed the frame off. False means nothing
   * left the broker, so nothing can ever reply and nothing ran in the page.
   */
  delivered: boolean;
  /**
   * Which browser it went to, when the transport can name one. Only the
   * WebSocket leg can; long-poll delivers without knowing which browser drains
   * the queue, so it reports `delivered` with no id.
   */
  browserId?: string;
}

export interface BrokerCoreOptions {
  /**
   * Deliver a correlated request to the browser extension.
   *
   * Returns a result rather than a bare `browserId | null` because null was
   * ambiguous: it meant both "delivered via long-poll" and "delivered
   * nowhere", so `dispatch` could not tell a live request from a dead one.
   */
  sendToExtension: (req: ServerMessageRequest) => SendToExtensionResult;
  /** Deliver a frame back to a specific MCP client. */
  sendToClient: (clientId: string, frame: BrokerServerFrame) => void;
  /** Per-command response timeout (ms). */
  getTimeoutMs: (cmd: string) => number;
  /** Correlation id generator (injectable for deterministic tests). */
  genCorrelationId?: () => string;
  /** Clock (injectable for deterministic lease-expiry tests). */
  now?: () => number;
  /** Lease time-to-live (ms). */
  leaseTtlMs?: number;
}

const DEFAULT_LEASE_TTL_MS = 60_000;

function leaseConflictMessage(tabId: number): string {
  return `Tab ${tabId} is leased by another session. Wait for it to be released or target a different tab.`;
}

/**
 * Wire `cmd` values (see common/server-messages.ts) that only READ state:
 * browser/tab metadata, an already-captured buffer, the cookie jar, or a
 * rendering of the page as it currently is. Nothing here changes the page, the
 * browser, or anything on a remote server.
 *
 * This is deliberately an allow-list of the SAFE commands rather than a list of
 * the dangerous ones. The inverse is fail-OPEN: every command someone forgets
 * to add gets told "nothing happened, retry" — and the omissions were
 * `browser-fetch` (a real cookie-authed POST/DELETE, so a retry double-applies
 * SERVER-side), `capture-response-bodies` (a retry double-increments the
 * refcounted chrome.debugger attach, so the later `enabled:false` never
 * detaches), `evaluate-script`, `stream-start`, and every navigation. Anything
 * absent here — including a command added to the union tomorrow — falls to the
 * cautious wording, which is wrong at worst by making a read look scary.
 *
 * Two judgement calls sit on the cautious side: `find-highlight` repaints the
 * page's find highlight and `stream-close` aborts a stream. Both are
 * idempotent, but the question this wording answers is "did it already happen?"
 * — not "is a retry harmful?" — and for both the honest answer is "maybe".
 */
const READ_ONLY_COMMANDS = new Set<string>([
  "get-tab-list",
  "get-browser-recent-history",
  "get-tab-content",
  "get-active-tab",
  "take-snapshot",
  "take-screenshot",
  "wait-for-text",
  "get-console-messages",
  // `includeBody` arms capture for FUTURE requests, but the call itself is a
  // buffer read and re-arming is idempotent.
  "get-network-requests",
  "get-cookies",
  // Reads `buffer.slice(sinceIndex)` with a caller-supplied cursor — polling
  // the same index twice returns the same frames.
  "stream-poll",
]);

/**
 * Mutating `cmd`s that drive a SPECIFIC tab's renderer — synthetic/CDP input,
 * DOM-driving helpers, and scrolls. Every one of these stalls when the target
 * tab is frozen by Chrome Memory Saver / Edge Sleeping Tabs, so their timeout
 * carries an extra hint naming that cause and its remedy.
 *
 * Typed as `ServerMessage["cmd"][]` so a typo or a renamed command fails `tsc`
 * rather than silently dropping a command out of the hint. Deliberately NOT
 * exhaustive over the union: membership is "would a frozen tab explain this
 * timeout?", and for `browser-fetch` / `stream-*` / `get-*` it would not.
 *
 * Must stay disjoint from {@link READ_ONLY_COMMANDS} — those keep the original
 * byte-identical string and never receive this hint (broker-core.test.ts pins
 * both the disjointness and the read-only wording).
 *
 * `evaluate-script` and `upload-file` are deliberately absent: a frozen tab
 * does stall them, but their dominant real-world timeout cause is a strict page
 * CSP, and this hint's "stalls input" framing would misdirect there.
 */
const TAB_DRIVING_COMMANDS: ReadonlySet<string> = new Set<
  ServerMessage["cmd"]
>([
  // uid-based input actions (all accept `activateTab`).
  "click-element",
  "fill-element",
  "fill-form",
  "press-key",
  "type-text",
  "drag-element",
  "hover-element",
  // Coordinate input actions. NOTE: these four do NOT accept `activateTab`
  // today, which is why the hint leads with `select-tab` — the one remedy that
  // works for every command in this set.
  "click-at",
  "type-at",
  "hover-at",
  "scroll-at",
  // Other DOM drivers: menu polling, overlay dismissal, scrolling.
  "select-option",
  "dismiss-overlays",
  "scroll-to",
  "scroll-into-view",
]);

/**
 * A timeout is a MISSING REPLY, never a confirmed failure — the extension may
 * have applied the command and lost the ack. For anything that changes state
 * that distinction decides whether the agent retries: the old blanket wording
 * read as "nothing happened", so agents re-clicked and double-submitted.
 * Read-only commands keep the original string so they are not made scarier.
 *
 * For {@link TAB_DRIVING_COMMANDS} the wording additionally names the frozen
 * background tab. That cause is invisible from the agent's side: a frozen tab
 * still answers `take-snapshot` with a full element tree (one synchronous DOM
 * read), while an input action — which the background paces as several
 * sequential round-trips into the page — stalls for the whole budget. Without
 * this, a healthy-looking snapshot reads as proof the tab is fine.
 *
 * `activateTabRequested` flips the hint: when the call already foregrounded the
 * tab, repeating that advice would send the agent to redo what it just did, so
 * the message rules the freeze out instead and points at the page.
 */
export function timeoutMessageFor(
  cmd: string,
  ms: number,
  opts?: { activateTabRequested?: boolean }
): string {
  if (READ_ONLY_COMMANDS.has(cmd)) {
    return "Timed out waiting for response from the browser extension";
  }
  const base =
    `The browser extension did not respond within ${ms}ms for '${cmd}'. ` +
    `This is a MISSING REPLY, not a confirmed failure — '${cmd}' may have ` +
    `already been applied. Do NOT blindly retry it: a repeated ` +
    `click/fill/submit/request can double-apply. Verify the current state first ` +
    `(a fresh take-snapshot, or re-read whatever this command changes), then ` +
    `decide.`;
  if (!TAB_DRIVING_COMMANDS.has(cmd)) {
    return base;
  }
  if (opts?.activateTabRequested) {
    return (
      base +
      ` This call already ran with activateTab:true, so a frozen background ` +
      `tab is NOT the cause — look at the page itself (a modal or overlay ` +
      `swallowing the event, or a navigation in progress).`
    );
  }
  return (
    base +
    ` LIKELY CAUSE: if this tab is not the user's foreground tab it may be ` +
    `frozen (Chrome Memory Saver / Edge Sleeping Tabs). A frozen tab still ` +
    `returns a full snapshot, so a healthy tree does NOT rule this out — only ` +
    `input stalls. Foreground the tab with select-tab, or pass ` +
    `activateTab:true on the tools that accept it, before you retry.`
  );
}

/**
 * A request that was never handed to a transport is the exact opposite of one
 * that timed out, so it must not borrow the timeout wording. The submit-time
 * guard in broker.ts catches the common case up front, but a request queued
 * behind an in-flight one for the same tab is dispatched later by
 * `completeTab` — by then the extension may be gone. Telling that caller the
 * action "may have already been applied" would send it off to verify a click
 * that never happened, and talk it out of the retry that is in fact correct.
 *
 * Deliberately does not enumerate causes. `delivered:false` also covers a
 * resolved connection whose socket is null (long-poll registered before its
 * sink is armed) or no longer OPEN (mid-close); advice naming only "nothing
 * connected" and "none active" is unactionable in those. What holds in every
 * reachable case — nothing left the broker — is the part worth stating.
 */
export const NEVER_SENT_MESSAGE =
  "The request was never sent to a browser: no usable extension connection was " +
  "available when it was dispatched. Nothing ran in the page, so this is SAFE " +
  "to retry. Check that the FoxPilot extension is connected — and if more than " +
  "one browser is connected, call select-browser to pick one — then retry.";

/**
 * Sent to a client whose request was IN FLIGHT when the browser it was routed
 * to went away. Same epistemics as {@link timeoutMessageFor}: the extension may
 * have applied the command and lost the ack on the way back, so this is a
 * missing reply, not proof that nothing happened.
 *
 * Browser-agnostic on purpose. The commonest trigger is a Chrome MV3
 * service-worker flap, and the previous copy asked whether Firefox was open.
 */
export const EXTENSION_GONE_IN_FLIGHT_MESSAGE =
  "The browser extension disconnected before responding. This is a MISSING " +
  "REPLY, not a confirmed failure — the command may already have been applied " +
  "in the page. Verify the current state before retrying, once a browser with " +
  "the FoxPilot extension is connected again.";

/**
 * Sent to a client whose request was still QUEUED behind an in-flight request
 * for the same tab when that browser went away. Nothing was ever handed to a
 * transport, so unlike the in-flight case this one is flatly safe to retry.
 */
export const EXTENSION_GONE_QUEUED_MESSAGE =
  "The browser extension disconnected before the request could be sent. " +
  "Nothing ran in the page, so this is SAFE to retry once a browser is " +
  "connected.";

export class BrokerCore {
  private readonly sendToExtension: (
    req: ServerMessageRequest
  ) => SendToExtensionResult;
  private readonly sendToClient: (
    clientId: string,
    frame: BrokerServerFrame
  ) => void;
  private readonly getTimeoutMs: (cmd: string) => number;
  private readonly genCorrelationId: () => string;
  private readonly now: () => number;
  private readonly leaseTtlMs: number;

  private readonly pending = new Map<string, PendingRequest>();
  private readonly tabInFlight = new Set<number>();
  private readonly tabQueues = new Map<number, QueuedRequest[]>();
  private readonly leases = new Map<number, Lease>();

  constructor(opts: BrokerCoreOptions) {
    this.sendToExtension = opts.sendToExtension;
    this.sendToClient = opts.sendToClient;
    this.getTimeoutMs = opts.getTimeoutMs;
    this.genCorrelationId =
      opts.genCorrelationId ?? (() => crypto.randomBytes(12).toString("hex"));
    this.now = opts.now ?? (() => Date.now());
    this.leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  // ---- tool requests ----

  submitTool(
    clientId: string,
    requestId: string,
    message: ServerMessage
  ): void {
    const tabId = getMessageTabId(message);

    if (tabId !== undefined) {
      const lease = this.activeLease(tabId);
      if (lease && lease.clientId !== clientId) {
        this.sendToClient(clientId, {
          kind: "tool-error",
          requestId,
          errorMessage: leaseConflictMessage(tabId),
        });
        return;
      }
      // Refresh the holder's lease on activity.
      if (lease && lease.clientId === clientId) {
        lease.expiresAt = this.now() + this.leaseTtlMs;
      }
      // Serialize per tab: queue behind any in-flight request for this tab.
      if (this.tabInFlight.has(tabId)) {
        const q = this.tabQueues.get(tabId) ?? [];
        q.push({ clientId, requestId, message, tabId });
        this.tabQueues.set(tabId, q);
        return;
      }
    }

    this.dispatch(clientId, requestId, message, tabId);
  }

  private dispatch(
    clientId: string,
    requestId: string,
    message: ServerMessage,
    tabId: number | undefined
  ): void {
    if (tabId !== undefined) {
      this.tabInFlight.add(tabId);
    }
    const correlationId = this.genCorrelationId();
    const req = { ...message, correlationId } as ServerMessageRequest;
    const timeoutMs = this.getTimeoutMs(message.cmd);
    // `activateTab` is read off the request so the timeout can tell an agent
    // that already foregrounded the tab not to try that again. The field is
    // optional on a subset of messages, hence the structural read rather than a
    // per-cmd cast.
    const activateTabRequested =
      (message as { activateTab?: boolean }).activateTab === true;
    const timer = setTimeout(() => {
      this.failPending(
        correlationId,
        timeoutMessageFor(message.cmd, timeoutMs, { activateTabRequested })
      );
    }, timeoutMs);
    // Don't let a pending request's timer keep the process alive on its own;
    // the broker's server socket is what keeps the daemon running.
    (timer as { unref?: () => void }).unref?.();
    const pending: PendingRequest = { clientId, requestId, tabId, timer };
    // Register before sending so a reply can never race ahead of its own
    // pending; the transport is what resolves the target, so the browserId is
    // stamped on afterwards.
    this.pending.set(correlationId, pending);
    const sent = this.sendToExtension(req);
    if (!sent.delivered) {
      // Fail now instead of leaving it to the timer. Waiting would report a
      // never-sent request with the mutating-timeout wording, which claims the
      // opposite of what happened; and it would stall the tab for a full
      // timeout first. Routed through failPending so the tab bookkeeping
      // (completeTab) is identical to every other failure path — skipping it
      // would strand tabInFlight and deadlock the tab.
      this.failPending(correlationId, NEVER_SENT_MESSAGE);
      return;
    }
    // `!== undefined`, not truthiness: evaluateHello admits any string
    // browserId, "" included, and a falsy-but-present id must still scope the
    // pending — otherwise that browser's disconnect would leave it hanging.
    if (sent.browserId !== undefined) {
      pending.browserId = sent.browserId;
    }
  }

  handleExtensionResponse(message: ExtensionMessage): void {
    const pending = this.pending.get(message.correlationId);
    if (!pending) {
      // Still dropped — the client was already failed and replaying a stale
      // success would assert something no longer true. Logged because a silent
      // drop makes an ack that arrived at 15.1s indistinguishable from one that
      // never arrived, which is what kept this class invisible. This lands on
      // the BROKER process's stderr, which spawnBroker (browser-api.ts) points
      // at ~/.foxpilot/broker.log — best-effort: if that file cannot be opened
      // the spawn falls back to a discarded stream and the line goes nowhere.
      console.error(
        `Broker: dropping late/unknown extension reply correlationId=${message.correlationId} resource=${message.resource}`
      );
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.correlationId);
    this.sendToClient(pending.clientId, {
      kind: "tool-result",
      requestId: pending.requestId,
      message,
    });
    this.completeTab(pending.tabId);
  }

  handleExtensionError(error: ExtensionError): void {
    const pending = this.pending.get(error.correlationId);
    if (!pending) {
      // Same as handleExtensionResponse: dropped, but no longer silently, and
      // onto the same broker log with the same best-effort caveat.
      console.error(
        `Broker: dropping late/unknown extension error correlationId=${error.correlationId} errorMessage=${error.errorMessage}`
      );
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(error.correlationId);
    this.sendToClient(pending.clientId, {
      kind: "tool-error",
      requestId: pending.requestId,
      errorMessage: error.errorMessage,
    });
    this.completeTab(pending.tabId);
  }

  private failPending(correlationId: string, errorMessage: string): void {
    const pending = this.pending.get(correlationId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(correlationId);
    this.sendToClient(pending.clientId, {
      kind: "tool-error",
      requestId: pending.requestId,
      errorMessage,
    });
    this.completeTab(pending.tabId);
  }

  /**
   * Fail every in-flight request routed to `browserId`, and everything queued
   * behind them. The browser-scoped counterpart to
   * {@link onExtensionDisconnect}: with two browsers connected, one socket
   * closing must not kill the other's in-flight work.
   *
   * Matches strictly on `browserId`. A pending with none came from a transport
   * that cannot name a target (long-poll), and those are
   * {@link failInFlightForLongPoll}'s to fail — matching them here would let a
   * WebSocket browser's flap kill a healthy long-poll browser's in-flight work,
   * whose reply is still on its way.
   */
  failInFlightForBrowser(
    browserId: string,
    errorMessage: string,
    queuedErrorMessage: string
  ): void {
    this.failInFlight(
      (p) => p.browserId === browserId,
      errorMessage,
      queuedErrorMessage
    );
  }

  /**
   * Fail every in-flight request that no browser owns — which is exactly the
   * set the long-poll transport delivered, since it cannot name the browser
   * that drains its queue.
   *
   * Scoped for the same reason as {@link failInFlightForBrowser}: a stale
   * long-poll transport must not fail a live WebSocket browser's in-flight
   * work.
   */
  failInFlightForLongPoll(
    errorMessage: string,
    queuedErrorMessage: string
  ): void {
    this.failInFlight(
      (p) => p.browserId === undefined,
      errorMessage,
      queuedErrorMessage
    );
  }

  /**
   * Shared body of the two scoped failure paths: fail each matching pending,
   * then abandon its tab.
   *
   * Deliberately NOT `completeTab`. completeTab shifts the tab's queue and
   * dispatches the next entry, and `dispatch` re-resolves the target — but by
   * the time either caller runs, the failing browser is already out of the
   * registry, so a sole survivor becomes the implicit active driver. The queued
   * request would then execute against a DIFFERENT browser's tab of the same
   * id, and the client would be told it succeeded. Tab ids are per-browser:
   * Firefox's tab 5 is not Chrome's tab 5, and `tabInFlight` is a global
   * Set<number>, so a fill can queue behind a click on the other browser's tab.
   * {@link abandonTab} frees the in-flight slot (skipping that deadlocks the
   * tab) without dispatching anything.
   *
   * Leases are left alone, unlike {@link onExtensionDisconnect}'s
   * `leases.clear()`. That one is correct there because the entire browser
   * world is going away; here only one browser is. A lease is a CLIENT's claim
   * on a tab id and the lease map carries no browser dimension, so there is
   * nothing to scope by — clearing them all would strip a client of a lease it
   * legitimately holds on a browser that is still connected. Leases already
   * self-release on their TTL and on client disconnect.
   */
  private failInFlight(
    matches: (pending: PendingRequest) => boolean,
    errorMessage: string,
    queuedErrorMessage: string
  ): void {
    for (const [correlationId, pending] of [...this.pending]) {
      if (!matches(pending)) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(correlationId);
      this.sendToClient(pending.clientId, {
        kind: "tool-error",
        requestId: pending.requestId,
        errorMessage,
      });
      this.abandonTab(pending.tabId, queuedErrorMessage);
    }
  }

  /**
   * Release a tab whose browser is gone: free the in-flight slot and fail
   * everything queued for it, rather than handing that queued work to whichever
   * browser happens to resolve next. The draining counterpart is
   * {@link completeTab}, which every ordinary completion still uses.
   */
  private abandonTab(tabId: number | undefined, errorMessage: string): void {
    if (tabId === undefined) {
      return;
    }
    this.tabInFlight.delete(tabId);
    const q = this.tabQueues.get(tabId);
    this.tabQueues.delete(tabId);
    if (!q) {
      return;
    }
    for (const item of q) {
      this.sendToClient(item.clientId, {
        kind: "tool-error",
        requestId: item.requestId,
        errorMessage,
      });
    }
  }

  private completeTab(tabId: number | undefined): void {
    if (tabId === undefined) {
      return;
    }
    this.tabInFlight.delete(tabId);
    const q = this.tabQueues.get(tabId);
    if (!q || q.length === 0) {
      this.tabQueues.delete(tabId);
      return;
    }
    // Dispatch the next queued request, re-checking the lease (one may have
    // been acquired while the request waited). Skip-and-reject any that now
    // conflict, until one dispatches or the queue empties.
    while (q.length > 0) {
      const next = q.shift()!;
      const lease = this.activeLease(tabId);
      if (lease && lease.clientId !== next.clientId) {
        this.sendToClient(next.clientId, {
          kind: "tool-error",
          requestId: next.requestId,
          errorMessage: leaseConflictMessage(tabId),
        });
        continue;
      }
      if (q.length === 0) {
        this.tabQueues.delete(tabId);
      }
      this.dispatch(next.clientId, next.requestId, next.message, tabId);
      return;
    }
    this.tabQueues.delete(tabId);
  }

  // ---- leases ----

  private activeLease(tabId: number): Lease | undefined {
    const lease = this.leases.get(tabId);
    if (!lease) {
      return undefined;
    }
    if (lease.expiresAt <= this.now()) {
      this.leases.delete(tabId);
      return undefined;
    }
    return lease;
  }

  acquireLease(
    clientId: string,
    tabId: number
  ): { ok: boolean; error?: string } {
    const lease = this.activeLease(tabId);
    if (lease && lease.clientId !== clientId) {
      return {
        ok: false,
        error: `Tab ${tabId} is already leased by another session.`,
      };
    }
    this.leases.set(tabId, {
      clientId,
      expiresAt: this.now() + this.leaseTtlMs,
    });
    return { ok: true };
  }

  releaseLease(clientId: string, tabId: number): { ok: boolean } {
    const lease = this.leases.get(tabId);
    if (lease && lease.clientId === clientId) {
      this.leases.delete(tabId);
    }
    return { ok: true };
  }

  // ---- lifecycle ----

  onClientDisconnect(clientId: string): void {
    // Release leases held by this client.
    for (const [tabId, lease] of this.leases) {
      if (lease.clientId === clientId) {
        this.leases.delete(tabId);
      }
    }
    // Drop this client's queued (not-yet-dispatched) requests.
    for (const [tabId, q] of this.tabQueues) {
      const filtered = q.filter((item) => item.clientId !== clientId);
      if (filtered.length === 0) {
        this.tabQueues.delete(tabId);
      } else {
        this.tabQueues.set(tabId, filtered);
      }
    }
    // Abandon this client's in-flight requests and free their tabs so other
    // clients' queued requests can proceed.
    const freedTabs: Array<number | undefined> = [];
    for (const [correlationId, pending] of [...this.pending]) {
      if (pending.clientId === clientId) {
        clearTimeout(pending.timer);
        this.pending.delete(correlationId);
        freedTabs.push(pending.tabId);
      }
    }
    for (const tabId of freedTabs) {
      this.completeTab(tabId);
    }
  }

  /**
   * Unscoped teardown: fail EVERY pending and queued request and drop all
   * per-tab state, whichever browser they belong to. Correct only when the
   * whole browser world is going away.
   *
   * A single browser or transport going away must use the scoped
   * {@link failInFlightForBrowser} / {@link failInFlightForLongPoll} instead —
   * used here, this is the live bug where Chrome's socket closing killed
   * Firefox's in-flight work.
   */
  onExtensionDisconnect(): void {
    for (const [correlationId, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      this.pending.delete(correlationId);
      this.sendToClient(pending.clientId, {
        kind: "tool-error",
        requestId: pending.requestId,
        errorMessage: EXTENSION_GONE_IN_FLIGHT_MESSAGE,
      });
    }
    for (const [, q] of this.tabQueues) {
      for (const item of q) {
        this.sendToClient(item.clientId, {
          kind: "tool-error",
          requestId: item.requestId,
          errorMessage: EXTENSION_GONE_QUEUED_MESSAGE,
        });
      }
    }
    this.tabQueues.clear();
    this.tabInFlight.clear();
    this.leases.clear();
  }

  // ---- introspection (diagnostics / tests) ----

  get pendingCount(): number {
    return this.pending.size;
  }
}
