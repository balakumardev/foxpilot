// Formats the open-browser-tab reply. Extracted from server.ts (which
// self-executes on import, see navigate-format.ts) so the wording is
// unit-testable.
//
// With a cookieStoreId (Firefox container), the reply says which store the tab
// really opened in. An extension older than this field ignores it and opens the
// tab in the default container, and its reply does not name a store, so the
// reply warns instead of claiming the container was used.
export function formatOpenTabResult(result: {
  url: string;
  tabId: number | undefined;
  /** The cookieStoreId the caller asked for, if any. */
  requestedCookieStoreId?: string;
  /** The cookie store the extension reports the tab opened in. */
  cookieStoreId?: string;
}): string | undefined {
  if (result.tabId === undefined) {
    return undefined;
  }
  const text = `${result.url} opened in tab id ${result.tabId}`;
  const requested = result.requestedCookieStoreId;
  if (requested === undefined) {
    return text;
  }
  if (result.cookieStoreId === requested) {
    return `${text} (cookieStoreId=${requested})`;
  }
  const where =
    result.cookieStoreId === undefined
      ? "the browser extension did not confirm the container (it is older than the server), so the tab probably opened in the default container; update or reload the FoxPilot extension."
      : `the tab opened in cookieStoreId=${result.cookieStoreId}, not ${requested}.`;
  return `${text}\nWARNING: ${where} Close it with close-browser-tabs if the container matters.`;
}
