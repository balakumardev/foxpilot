/**
 * HTTP long-poll fallback transport for the extension leg.
 *
 * When a persistent WebSocket is unreliable, the extension can instead:
 *   - GET  /extension/poll?auth=<hmac>      — long-poll for pending requests
 *   - POST /extension/respond?auth=<hmac>   — post a response/error back
 *
 * `auth` is an HMAC-SHA256 of a fixed string with the shared secret, proving
 * the caller knows the secret. Responses posted to /respond are the exact JSON
 * the extension would send over WebSocket (a signed `{payload,signature}` for
 * results, or a raw `{correlationId,errorMessage}` for errors), so the broker
 * validates them with the same logic as the WS leg.
 */

import * as http from "http";
import type { ServerMessageRequest } from "@foxpilot/common";
import { BrokerServer } from "./broker";
import { createSignature, verifySignature } from "./signing";

const POLL_TIMEOUT_MS = 25000;
const MAX_BODY_BYTES = 5_000_000;
export const POLL_AUTH_STRING = "extension-poll";

export interface BrokerLongPollOptions {
  pollTimeoutMs?: number;
}

export class BrokerLongPoll {
  private readonly server: BrokerServer;
  private readonly secret: string;
  private readonly pollTimeoutMs: number;

  private queue: ServerMessageRequest[] = [];
  private waiter: { send: () => void; timer: ReturnType<typeof setTimeout> } | null =
    null;
  private active = false;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    server: BrokerServer,
    secret: string,
    opts: BrokerLongPollOptions = {}
  ) {
    this.server = server;
    this.secret = secret;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    server.addHttpHandler((req, res, path) => this.handle(req, res, path));
  }

  private handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string
  ): boolean {
    if (path === "/extension/poll" && req.method === "GET") {
      this.handlePoll(req, res);
      return true;
    }
    if (path === "/extension/respond" && req.method === "POST") {
      this.handleRespond(req, res);
      return true;
    }
    return false;
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const url = new URL(req.url ?? "", "http://localhost");
    const auth = url.searchParams.get("auth") ?? "";
    return verifySignature(this.secret, POLL_AUTH_STRING, auth);
  }

  private activate(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.server.setLongPollSink((reqToSend) => {
      this.queue.push(reqToSend);
      this.flushWaiter();
      return true;
    });
  }

  private deactivate(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
    this.queue = [];
    this.server.setLongPollSink(null);
    this.server.onLongPollExtensionGone();
  }

  private resetStaleTimer(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
    }
    this.staleTimer = setTimeout(
      () => this.deactivate(),
      this.pollTimeoutMs * 2
    );
    (this.staleTimer as { unref?: () => void }).unref?.();
  }

  private flushWaiter(): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.send();
    }
  }

  private handlePoll(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    if (!this.checkAuth(req)) {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    this.activate();
    this.resetStaleTimer();

    const sendBatch = () => {
      const batch = this.queue;
      this.queue = [];
      const signed = batch.map((req) => ({
        payload: req,
        signature: createSignature(this.secret, JSON.stringify(req)),
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ requests: signed }));
    };

    if (this.queue.length > 0) {
      sendBatch();
      return;
    }

    // Only one extension polls at a time in normal use, but the broker is a
    // network-facing authenticated endpoint, so release any already-parked
    // poll (with an empty batch) before parking this one — never orphan it.
    if (this.waiter) {
      const prev = this.waiter;
      this.waiter = null;
      clearTimeout(prev.timer);
      prev.send();
    }

    const timer = setTimeout(() => {
      this.waiter = null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ requests: [] }));
    }, this.pollTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
    this.waiter = { send: sendBatch, timer };

    res.on("close", () => {
      if (this.waiter && this.waiter.timer === timer) {
        clearTimeout(timer);
        this.waiter = null;
      }
    });
  }

  private handleRespond(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    if (!this.checkAuth(req)) {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
      }
    });
    req.on("end", () => {
      if (body.length > 0) {
        this.server.ingestExtensionMessage(body);
      }
      this.resetStaleTimer();
      res.writeHead(204).end();
    });
  }
}
