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
} from "@browser-control-mcp/common";
import { BrokerServerFrame, getMessageTabId } from "./broker-protocol";
import * as crypto from "crypto";

interface PendingRequest {
  clientId: string;
  requestId: string;
  tabId?: number;
  timer: ReturnType<typeof setTimeout>;
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

export interface BrokerCoreOptions {
  /** Deliver a correlated request to the browser extension. */
  sendToExtension: (req: ServerMessageRequest) => void;
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

export class BrokerCore {
  private readonly sendToExtension: (req: ServerMessageRequest) => void;
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
    const timer = setTimeout(() => {
      this.failPending(
        correlationId,
        "Timed out waiting for response from the browser extension"
      );
    }, this.getTimeoutMs(message.cmd));
    // Don't let a pending request's timer keep the process alive on its own;
    // the broker's server socket is what keeps the daemon running.
    (timer as { unref?: () => void }).unref?.();
    this.pending.set(correlationId, { clientId, requestId, tabId, timer });
    this.sendToExtension(req);
  }

  handleExtensionResponse(message: ExtensionMessage): void {
    const pending = this.pending.get(message.correlationId);
    if (!pending) {
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

  onExtensionDisconnect(): void {
    for (const [correlationId, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      this.pending.delete(correlationId);
      this.sendToClient(pending.clientId, {
        kind: "tool-error",
        requestId: pending.requestId,
        errorMessage:
          "The browser extension disconnected before responding. Is Firefox open with the Browser Control extension installed and connected?",
      });
    }
    for (const [, q] of this.tabQueues) {
      for (const item of q) {
        this.sendToClient(item.clientId, {
          kind: "tool-error",
          requestId: item.requestId,
          errorMessage:
            "The browser extension disconnected before the request could be sent.",
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
