/**
 * "All sites" host access as the BROWSER sees it.
 *
 * Automation Mode is a flag in extension storage. The host permission it needs
 * (`<all_urls>`, optional in the manifest) is separate browser state, and it can
 * be missing while the flag is on: the grant prompt was dismissed, the grant was
 * revoked, or the browser's Site access setting withholds it. When that happens
 * `permissions.contains({origins:[<page origin>]})` is false for every host that
 * was not individually granted, so without this module the user is asked for
 * permission once per host while the options page still shows Automation Mode ON.
 *
 * Everything here reads the real permission state; nothing trusts the stored flag.
 */

import { buildTabAccessMessage } from "@foxpilot/common";

export const ALL_SITES_ORIGINS = ["<all_urls>"];

/** Query parameter that makes options.html open the all-sites grant dialog. */
export const REQUEST_ALL_SITES_PARAM = "requestAllSites";

/** Shown next to the Automation Mode toggle when the flag is on but the grant is not. */
export const MISSING_ACCESS_WARNING =
  "Automation Mode is on, but the browser has not granted FoxPilot access to all sites, so it will keep asking per site. Turn Automation Mode on again and accept the prompt.";

/**
 * Whether the browser currently gives FoxPilot access to every site. A rejecting
 * permissions API counts as "no": the callers use this to decide whether to ask.
 */
export async function hasAllSitesAccess(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: ALL_SITES_ORIGINS });
  } catch {
    return false;
  }
}

/**
 * What the Automation Mode toggle should show. The toggle is ON only when the
 * stored flag AND the browser grant are both present; a flag with no grant shows
 * OFF plus a warning, so the next click on the toggle (a user gesture) requests
 * the permission instead of switching a "ghost ON" state off.
 */
export function automationToggleView(
  flagOn: boolean,
  hasAccess: boolean
): { checked: boolean; warning: string | null } {
  if (!flagOn) {
    return { checked: false, warning: null };
  }
  if (hasAccess) {
    return { checked: true, warning: null };
  }
  return { checked: false, warning: MISSING_ACCESS_WARNING };
}

/** The options-page URL that opens the all-sites grant dialog. */
export function allSitesRequestUrl(optionsUrl: string): string {
  return `${optionsUrl}?${REQUEST_ALL_SITES_PARAM}=1`;
}

/**
 * Error text for a tool call that hit an origin the browser has not granted while
 * Automation Mode is on. Tagged SITE ACCESS NOT GRANTED, with the exact place to
 * fix it (chrome://extensions -> FoxPilot -> Details -> Site access).
 */
export function allSitesMissingMessage(origin: string): string {
  return buildTabAccessMessage("notGranted", {
    browser: "chrome",
    origin,
    automationMode: true,
    dialog: "all-sites",
  });
}
