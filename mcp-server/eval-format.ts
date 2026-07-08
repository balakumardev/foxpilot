// Formats an evaluate-script result for the MCP tool. Extracted from server.ts
// — which self-executes on import (it constructs the BrowserAPI, connects stdio,
// and wires process exit, so it cannot be imported into a test) — for the same
// reason formatPointResult lives in point-format.ts, formatSnapshotResult in
// snapshot-format.ts, and formatNetworkHeaders in network-format.ts.
//
// Fix 6: the old handler did `text: JSON.stringify(value)`, which DOUBLE-encodes
// a value that is already a string. A page function returning a pre-serialized
// string — e.g. `() => JSON.stringify(state)` — reached the model as
// "{\"a\":1}" (a quoted, backslash-escaped blob it had to unescape by hand).
// Here a string passes through RAW/unquoted (killing the double-escape); a
// non-string is pretty-printed. When the value is a plain object we ALSO set
// structuredContent so structured MCP clients get the typed value (additive —
// the text block stays the primary channel). structuredContent on CallToolResult
// is typed Record<string, unknown> in @modelcontextprotocol/sdk 1.29.0, so it is
// set ONLY for non-null, non-array objects; every other kind (string, number,
// boolean, null, array) is carried by the text block alone. evaluate-script
// declares no outputSchema, so the SDK neither requires nor validates
// structuredContent — it passes through harmlessly (server/mcp.js
// validateToolOutput returns early when the tool has no outputSchema).
export function formatEvalResult(value: unknown): {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
} {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2) ?? String(value);
  const out: {
    content: { type: "text"; text: string }[];
    structuredContent?: Record<string, unknown>;
  } = { content: [{ type: "text" as const, text }] };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    out.structuredContent = value as Record<string, unknown>;
  }
  return out;
}
