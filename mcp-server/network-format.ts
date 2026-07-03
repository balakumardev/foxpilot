// Header redaction + formatting for get-network-requests, extracted from
// server.ts (which self-executes on import) so it can be imported and
// unit-tested directly — the same reason formatPointResult lives in
// point-format.ts. Credential-bearing header VALUES (Cookie / Set-Cookie /
// Authorization / Proxy-Authorization) are redacted UNLESS includeCredentials
// is true (default false at the tool layer).
export const SENSITIVE_HEADER =
  /^(cookie|set-cookie|authorization|proxy-authorization)$/i;

export function formatNetworkHeaders(
  label: string,
  headers: { name: string; value?: string }[] | undefined,
  includeCredentials: boolean
): string {
  if (!headers || headers.length === 0) {
    return "";
  }
  const lines = headers
    .map((h) => {
      const value =
        !includeCredentials && SENSITIVE_HEADER.test(h.name)
          ? `<redacted:${(h.value ?? "").length} chars>`
          : h.value ?? "";
      return `      ${h.name}: ${value}`;
    })
    .join("\n");
  return `\n    ${label}:\n${lines}`;
}
