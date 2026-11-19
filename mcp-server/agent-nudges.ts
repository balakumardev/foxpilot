/**
 * Reminders that keep agents from reaching for FoxPilot's two visible escape
 * hatches out of habit.
 *
 *  - `activateTab:true` switches the user's visible tab and back.
 *  - `engine:"cdp"`, `capture-response-bodies` and the screenshot fallback
 *    attach Chrome's debugger: the user sees "FoxPilot started debugging this
 *    browser" and the page can detect it.
 *
 * Descriptions and error text say when to use them, but only at the moment the
 * agent reads them. An audit of real sessions (2026-11) found most activateTab
 * calls followed a call on the same tab that had NOT failed, i.e. habit. So a
 * SUCCESSFUL call that used either flag gets a one-line reminder appended to its
 * reply, right where the agent would copy the habit into its next call. Errors
 * are left alone: their text already says what to do.
 */

export const ACTIVATE_TAB_REPLY_NOTE =
  "Note: activateTab:true briefly switched the user's visible tab for this call. " +
  "Omit it on your next call on this tab; set it again only if a call on this tab " +
  "times out, errors, or comes back empty.";

export const ENGINE_CDP_REPLY_NOTE =
  "Note: engine:\"cdp\" attached Chrome's debugger for this call, so the user saw a " +
  "\"FoxPilot started debugging this browser\" banner and the page can detect it. " +
  "Omit engine next time; use it again only if the default call ran but the page ignored it.";

export const SCREENSHOT_IMAGE_NOTE =
  "Note: that image is the costliest read FoxPilot returns. To read text, confirm an action " +
  "or find a control use take-snapshot or get-tab-web-content (no image); take another " +
  "screenshot only when you need to see the rendering.";

export const SCREENSHOT_DEBUGGER_NOTE =
  "That fallback attached Chrome's debugger, so the user saw a \"FoxPilot started " +
  "debugging this browser\" banner. Screenshots are the usual cause: to read text or " +
  "check state use take-snapshot or get-tab-web-content, and take another screenshot " +
  "only when you must see the rendering. If the warning names missing all-sites access, " +
  "tell the user once how to grant it rather than taking more screenshots.";

interface ContentItem {
  type: string;
  [key: string]: unknown;
}

interface ToolResultLike {
  content: ContentItem[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Reminder texts owed for these tool arguments, in the order they are shown. */
function notesFor(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const a = args as { activateTab?: unknown; engine?: unknown };
  const notes: string[] = [];
  if (a.activateTab === true) notes.push(ACTIVATE_TAB_REPLY_NOTE);
  if (a.engine === "cdp") notes.push(ENGINE_CDP_REPLY_NOTE);
  return notes;
}

/**
 * Appends the reminders to a successful tool result. Returns the original
 * result object untouched when nothing is owed or the call failed; otherwise a
 * copy with the notes added as trailing text items (images stay in place).
 */
export function withNudges<R extends ToolResultLike>(args: unknown, result: R): R {
  if (result.isError) return result;
  const notes = notesFor(args);
  if (notes.length === 0) return result;
  return {
    ...result,
    content: [...result.content, ...notes.map((text) => ({ type: "text", text }))],
  };
}

/** Text for a take-screenshot warning, with the debugger explanation when it applies. */
export function screenshotWarningText(warning: string): string {
  const text = `Warning: ${warning}`;
  return /CDP screenshot fallback/.test(warning) ? `${text} ${SCREENSHOT_DEBUGGER_NOTE}` : text;
}

function declaresNudgedField(arg: unknown): boolean {
  return (
    !!arg &&
    typeof arg === "object" &&
    !Array.isArray(arg) &&
    ("activateTab" in (arg as object) || "engine" in (arg as object))
  );
}

/**
 * Makes every tool registered on `server` after this call add the reminders when
 * its input shape declares `activateTab` or `engine`. Done at registration so a
 * tool added later cannot silently skip it. Tools with neither field keep their
 * original callback.
 *
 * Shadows `server.tool` with an instance property, so it must run before the
 * first registration.
 */
export function installNudges(server: { tool: (...args: any[]) => unknown }): void {
  const register = server.tool.bind(server);
  server.tool = (...args: any[]): unknown => {
    const last = args.length - 1;
    if (typeof args[last] === "function" && args.slice(1, last).some(declaresNudgedField)) {
      const cb = args[last] as (a: unknown, extra: unknown) => Promise<ToolResultLike>;
      args[last] = async (a: unknown, extra: unknown) =>
        withNudges(a, await cb(a, extra));
    }
    return register(...args);
  };
}
