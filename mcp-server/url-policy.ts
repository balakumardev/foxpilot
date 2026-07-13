/**
 * Shared URL policy for tools that open or navigate a browser tab
 * (open-browser-tab, navigate-tab).
 *
 * Mirrors the extension-side `isNavigableUrl` gate (chrome-extension /
 * firefox-extension `message-handler.ts`): allow https:// to any host, and
 * http:// ONLY for loopback hosts (localhost / 127.0.0.1 / [::1]) so a local
 * dev/test server can be opened in a new tab.
 *
 * Keeping open-browser-tab and navigate-tab on the SAME policy fixes the
 * inconsistency where open-browser-tab rejected `http://localhost:PORT`
 * ("Invalid URL") while navigate-tab already allowed it. This helper is the
 * single source of truth both tools' schemas refine against.
 *
 * Pure and dependency-free (no zod, no side effects) so it can be unit-tested
 * in isolation — unlike server.ts, which self-executes on import.
 */
export function allowedNavUrl(u: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  if (parsed.protocol === "http:") {
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]"
    );
  }
  return false;
}

/** Rejection message surfaced by the zod refinement on both tools. */
export const NAV_URL_MESSAGE = "URL must be https, or http only for localhost";
