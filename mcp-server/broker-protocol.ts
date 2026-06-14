/**
 * Wire protocol for the client <-> broker leg.
 *
 * The broker is a long-lived local daemon that owns the single connection to
 * the browser extension. Many MCP-client processes (one per Claude Code /
 * Cursor session) connect to the broker and post tool requests; the broker
 * forwards them to the extension and routes responses back to the originating
 * client.
 *
 * The broker <-> extension leg reuses the existing signed protocol unchanged
 * (`ServerMessageRequest` / `ExtensionMessage` / `ExtensionError` from
 * `@foxpilot/common`). This file only defines the additional
 * client <-> broker framing.
 *
 * Both legs wrap every frame in a `SignedEnvelope` (HMAC-SHA256 over the JSON
 * of `payload`), so a random local process cannot drive the browser.
 */

import type { ServerMessage, ExtensionMessage } from "@foxpilot/common";

/** Generic signed envelope used on both transport legs. */
export interface SignedEnvelope<T> {
  payload: T;
  signature: string;
}

/**
 * The extension's first frame on connect (WS) / first poll identity
 * (long-poll). Sent as a `SignedEnvelope<HelloPayload>`: the broker verifies
 * the signature with the shared secret BEFORE admitting the connection.
 * The `type: "hello"` discriminant is new and disjoint from `ExtensionMessage`
 * (which is keyed on `resource`/`correlationId`), so it is unambiguous on the
 * extension leg.
 */
export interface HelloPayload {
  type: "hello";
  browserId: string;
  browserType: "chrome" | "firefox";
  label: string;
}

// ===== Broker control protocol (client -> broker) =====

/** Acquire an exclusive soft lease on a tab. */
export interface AcquireLeaseControl {
  control: "acquire-lease";
  tabId: number;
}

/** Release a previously-acquired lease on a tab. */
export interface ReleaseLeaseControl {
  control: "release-lease";
  tabId: number;
}

/** Enumerate the connected browsers and which one is active. */
export interface ListBrowsersControl {
  control: "list-browsers";
}

/** Set the global active driver to the given browser. */
export interface SelectBrowserControl {
  control: "select-browser";
  browserId: string;
}

export type BrokerControlRequest =
  | AcquireLeaseControl
  | ReleaseLeaseControl
  | ListBrowsersControl
  | SelectBrowserControl;

/** A connected (or known) browser as reported by `list-browsers`. */
export interface BrowserInfo {
  browserId: string;
  label: string;
  type: "chrome" | "firefox";
  connected: boolean;
  active: boolean;
}

export interface BrokerControlResult {
  ok: boolean;
  error?: string;
  /** Present for `list-browsers` (and echoed by `select-browser`). */
  browsers?: BrowserInfo[];
  /** The active browser id after the control was applied, if any. */
  activeBrowserId?: string;
}

// ===== Client -> broker frames =====

/** Forward a tool command to the extension. */
export interface ToolClientFrame {
  kind: "tool";
  /** Client-local id used to match the broker's response back to the caller. */
  requestId: string;
  message: ServerMessage;
}

/** A broker-level control request (leases). */
export interface ControlClientFrame {
  kind: "control";
  requestId: string;
  control: BrokerControlRequest;
}

export type BrokerClientFrame = ToolClientFrame | ControlClientFrame;

// ===== Broker -> client frames =====

/** Successful tool result (the extension's response). */
export interface ToolResultServerFrame {
  kind: "tool-result";
  requestId: string;
  message: ExtensionMessage;
}

/** A tool failed (extension error, timeout, lease conflict, etc.). */
export interface ToolErrorServerFrame {
  kind: "tool-error";
  requestId: string;
  errorMessage: string;
}

/** Result of a control request. */
export interface ControlResultServerFrame {
  kind: "control-result";
  requestId: string;
  result: BrokerControlResult;
}

export type BrokerServerFrame =
  | ToolResultServerFrame
  | ToolErrorServerFrame
  | ControlResultServerFrame;

/** Extract the tabId a tool message targets, if any (for per-tab serialization). */
export function getMessageTabId(message: ServerMessage): number | undefined {
  return "tabId" in message && typeof message.tabId === "number"
    ? message.tabId
    : undefined;
}
