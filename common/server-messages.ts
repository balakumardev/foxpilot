export interface ServerMessageBase {
  cmd: string;
}

export interface OpenTabServerMessage extends ServerMessageBase {
  cmd: "open-tab";
  url: string;
}

export interface CloseTabsServerMessage extends ServerMessageBase {
  cmd: "close-tabs";
  tabIds: number[];
}

export interface GetTabListServerMessage extends ServerMessageBase {
  cmd: "get-tab-list";
}

export interface GetBrowserRecentHistoryServerMessage extends ServerMessageBase {
  cmd: "get-browser-recent-history";
  searchQuery?: string;
}

export interface GetTabContentServerMessage extends ServerMessageBase {
  cmd: "get-tab-content";
  tabId: number;
  offset?: number;
}

export interface ReorderTabsServerMessage extends ServerMessageBase {
  cmd: "reorder-tabs";
  tabOrder: number[];
}

export interface FindHighlightServerMessage extends ServerMessageBase {
  cmd: "find-highlight";
  tabId: number;
  queryPhrase: string;
}

export interface GroupTabsServerMessage extends ServerMessageBase {
  cmd: "group-tabs";
  tabIds: number[];
  isCollapsed: boolean;
  groupColor: string;
  groupTitle: string;
}

export interface TakeSnapshotServerMessage extends ServerMessageBase {
  cmd: "take-snapshot";
  tabId: number;
  verbose?: boolean;
  includePointer?: boolean;
  maxInteractive?: number;
  selector?: string;
  textContains?: string;
  rootSelector?: string;
  offset?: number;
  limit?: number;
}

export interface NavigateTabServerMessage extends ServerMessageBase {
  cmd: "navigate-tab";
  tabId: number;
  url: string;
}

export interface NavigatePageHistoryServerMessage extends ServerMessageBase {
  cmd: "navigate-page-history";
  tabId: number;
  direction: "back" | "forward" | "reload";
  bypassCache?: boolean;
}

export interface SelectTabServerMessage extends ServerMessageBase {
  cmd: "select-tab";
  tabId: number;
}

export interface GetActiveTabServerMessage extends ServerMessageBase {
  cmd: "get-active-tab";
}

export interface WaitForTextServerMessage extends ServerMessageBase {
  cmd: "wait-for-text";
  tabId: number;
  // Back-compat: a plain string OR a non-empty array (OR-match — resolve as
  // soon as ANY string appears). The result reports which string matched.
  text: string | string[];
  timeoutMs?: number;
}

export interface ClickElementServerMessage extends ServerMessageBase {
  cmd: "click-element";
  tabId: number;
  uid: string;
  doubleClick?: boolean;
}

export interface HoverElementServerMessage extends ServerMessageBase {
  cmd: "hover-element";
  tabId: number;
  uid: string;
}

export interface FillElementServerMessage extends ServerMessageBase {
  cmd: "fill-element";
  tabId: number;
  uid: string;
  value: string;
}

export interface FillFormServerMessage extends ServerMessageBase {
  cmd: "fill-form";
  tabId: number;
  fields: { uid: string; value: string }[];
}

export interface TypeTextServerMessage extends ServerMessageBase {
  cmd: "type-text";
  tabId: number;
  text: string;
  submit?: boolean;
}

export interface PressKeyServerMessage extends ServerMessageBase {
  cmd: "press-key";
  tabId: number;
  key: string;
  modifiers?: string[];
}

// Drag the element identified by `fromUid` onto the element identified by
// `toUid` (both snapshot uids). Implemented in the page world via synthetic
// HTML5 drag events plus a pointer/mouse fallback — see action-script.ts.
export interface DragElementServerMessage extends ServerMessageBase {
  cmd: "drag-element";
  tabId: number;
  fromUid: string;
  toUid: string;
}

// Resize the BROWSER WINDOW that hosts the given tab (not the page viewport).
// A plain window operation — no page injection.
export interface ResizeWindowServerMessage extends ServerMessageBase {
  cmd: "resize-window";
  tabId: number;
  width: number;
  height: number;
}

export interface EvaluateScriptServerMessage extends ServerMessageBase {
  cmd: "evaluate-script";
  tabId: number;
  function: string;
  args?: unknown[];
  // Which JS world to run in. "main" (default) injects a page-world <script>
  // (sees the page's real window/globals; blockable by a strict page CSP).
  // "isolated" runs in the extension's isolated content-script world
  // (CSP-immune; sees the DOM but not page-JS globals; synchronous — a
  // returned Promise is not awaited). Back-compat default is "main".
  world?: "main" | "isolated";
}

// Upload a local file into a file <input> identified by a snapshot uid. The MCP
// server (a Node process with filesystem access) reads the file itself and ships
// the bytes here as base64 — the extension never sees a filesystem path. The
// page-world script reconstructs a `File` via `DataTransfer` and assigns it to
// the input, which is the only way to programmatically populate a file input
// (browsers forbid setting `input.value` for security).
export interface UploadFileServerMessage extends ServerMessageBase {
  cmd: "upload-file";
  tabId: number;
  uid: string;
  filename: string;
  mimeType: string;
  base64: string;
}

// Capture a screenshot of a tab. `fullPage` stitches the whole scrollable page;
// `uid` (a snapshot uid) crops to just that element; otherwise the visible
// viewport is captured. `format` defaults to png. The server-side `filePath`
// option is intentionally NOT part of this message — the extension only returns
// the image bytes, and the MCP server writes the file itself.
export interface TakeScreenshotServerMessage extends ServerMessageBase {
  cmd: "take-screenshot";
  tabId: number;
  fullPage?: boolean;
  uid?: string;
  format?: "png" | "jpeg";
}

// Read the console output captured for a tab. Page console output and uncaught
// errors are invisible to a WebExtension, so the extension captures them via an
// injected page-world wrapper (registered only while Automation Mode is on) and
// keeps a per-tab ring buffer. This is a pure buffer read — no page scripting.
// `limit` caps the number of most-recent entries returned (default: all).
export interface GetConsoleMessagesServerMessage extends ServerMessageBase {
  cmd: "get-console-messages";
  tabId: number;
  limit?: number;
}

// Arm a tab so FUTURE native JS dialogs (alert/confirm/prompt) are
// auto-handled. `action` "accept" makes confirm return true and prompt return
// `promptText` (or ""); "dismiss" makes confirm return false and prompt return
// null; alert is suppressed either way. Implemented in the page world by
// overriding window.alert/confirm/prompt. Caveat: cannot intercept an
// already-open native dialog (it blocks the page's JS thread), and the override
// is reset on navigation.
export interface HandleDialogServerMessage extends ServerMessageBase {
  cmd: "handle-dialog";
  tabId: number;
  action: "accept" | "dismiss";
  promptText?: string;
}

// Emulate device conditions for a tab. `geolocation` shims
// navigator.geolocation in the page world to report the given coordinates;
// `userAgent` shims navigator.userAgent in the page AND rewrites the User-Agent
// request header on outgoing requests (via a background webRequest listener) so
// the server-visible UA changes too. Only geolocation and userAgent are
// supported — CPU throttling, network conditions, and colorScheme are not
// feasible from a WebExtension and are intentionally omitted.
export interface EmulateServerMessage extends ServerMessageBase {
  cmd: "emulate";
  tabId: number;
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  userAgent?: string;
}

// Read the network activity captured for a tab. While Automation Mode is on the
// extension observes requests via the webRequest API into a per-tab ring
// buffer; this is a pure buffer read. `filter` is a case-insensitive substring
// match on the URL or an exact resourceType match. `limit` caps the number of
// most-recent records returned. `includeBody` opts into best-effort response
// body capture (Firefox-specific); because bodies are captured at request time,
// it only affects requests made AFTER it is enabled.
export interface GetNetworkRequestsServerMessage extends ServerMessageBase {
  cmd: "get-network-requests";
  tabId: number;
  filter?: string;
  limit?: number;
  includeBody?: boolean;
}

// --- Privileged background-context HTTP + cookie tools ---
// These run in the extension BACKGROUND context (Chrome MV3 service worker /
// Firefox MV2 persistent page), NOT the page world, so they are immune to the
// visited page's Content-Security-Policy and can use the browser's real cookie
// jar (including httpOnly cookies) and its cross-origin host privileges. They
// intentionally carry NO `tabId` — they act on a URL/origin — so the broker does
// not serialize them per-tab and multiple calls run concurrently.

// Read cookies from the browser's cookie jar. Returns httpOnly cookies too
// (unlike document.cookie). Narrow by `url`, `domain`, and/or `name`; omit all
// to return every cookie the extension is permitted to see.
export interface GetCookiesServerMessage extends ServerMessageBase {
  cmd: "get-cookies";
  url?: string;
  domain?: string;
  name?: string;
  // Filter to cookies whose name is in this set (union with `name` if both).
  names?: string[];
}

// A privileged one-shot fetch executed from the extension background context.
// Because it runs at the extension origin (not the page), the visited page's CSP
// does NOT apply. With host permission for the target and credentials:"include"
// the browser attaches that site's cookies (incl. httpOnly) automatically, and
// the request looks browser-originated (passing WAFs that reject curl). Provide
// EITHER `body` (UTF-8 text) or `bodyBase64` (binary). `useSessionCookies` opts
// into injecting a `Cookie` header from the jar (the default credentialed request
// can miss SameSite=Strict cookies); it is applied via a declarativeNetRequest
// session rule (Chrome) or a blocking webRequest listener (Firefox) because
// `Cookie` is a forbidden header for fetch() and would otherwise be dropped.
export interface BrowserFetchServerMessage extends ServerMessageBase {
  cmd: "browser-fetch";
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  credentials?: "include" | "omit" | "same-origin";
  useSessionCookies?: boolean;
  redirect?: "follow" | "manual" | "error";
  timeoutMs?: number;
  maxBytes?: number;
}

// Open a streaming/SSE request in the background and buffer decoded frames. A
// single MCP call cannot stream through the one-response-per-request broker, so
// streaming is modeled as three correlated round-trips: `stream-start` opens the
// request and returns a `streamId` once response headers arrive (NOT once the
// body completes — an SSE body never completes); `stream-poll` drains buffered
// frames after a cursor; `stream-close` aborts and frees the buffer. Same fetch
// semantics as browser-fetch (credentials / useSessionCookies / redirect).
export interface StreamStartServerMessage extends ServerMessageBase {
  cmd: "stream-start";
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  credentials?: "include" | "omit" | "same-origin";
  useSessionCookies?: boolean;
  redirect?: "follow" | "manual" | "error";
  maxFrames?: number;
  maxBytes?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}

// Drain buffered frames produced since `sinceIndex` (a cursor; default 0). The
// handler may wait briefly for the first new frame, then returns promptly so it
// stays under the broker's per-command timeout. `done` is true once the stream
// has ended (server closed, `[DONE]`, error, or close).
export interface StreamPollServerMessage extends ServerMessageBase {
  cmd: "stream-poll";
  streamId: string;
  sinceIndex?: number;
}

// Abort the stream and free its buffer. Idempotent.
export interface StreamCloseServerMessage extends ServerMessageBase {
  cmd: "stream-close";
  streamId: string;
}

// Opt-in DEEP network capture via chrome.debugger (Chrome/Edge only). Attaching
// the debugger is the ONLY way MV3 can read RESPONSE bodies, but it shows a
// "started debugging this browser" banner and is detectable by the page — it
// BREAKS covert observation. `enabled:true` attaches to the tab; `enabled:false`
// detaches and returns to the covert webRequest path. No-op on Firefox (which
// already captures response bodies covertly via get-network-requests includeBody).
export interface CaptureResponseBodiesServerMessage extends ServerMessageBase {
  cmd: "capture-response-bodies";
  tabId: number;
  enabled: boolean;
}

// --- Coordinate (synthetic) interaction — Phase 2 ---
// Act at viewport CSS-pixel coordinates {x,y} (origin = top-left of the visible
// viewport, matching document.elementFromPoint). All run covertly in the
// isolated content-script world (elementFromPoint → the existing action
// sequences). No trusted-input engine in Phase 2 — the optional `engine` param
// is a backward-compatible Phase 3 addition.
export interface ClickAtServerMessage extends ServerMessageBase {
  cmd: "click-at";
  tabId: number;
  x: number;
  y: number;
  doubleClick?: boolean;
  button?: "left" | "middle" | "right";
}

// Type text into the element at viewport CSS-pixel coordinates {x,y}: click the
// point to focus it, then synthesize the keystrokes in the isolated world.
// Handles <input>/<textarea> (framework-safe native setter) AND
// <div contenteditable> chat inputs. `submit` presses Enter afterward (and
// requestSubmit()s the enclosing form if there is one).
export interface TypeAtServerMessage extends ServerMessageBase {
  cmd: "type-at";
  tabId: number;
  x: number;
  y: number;
  text: string;
  submit?: boolean;
}

// Move a synthetic pointer to the element at viewport CSS-pixel coordinates
// {x,y}: elementFromPoint → dispatch mouseover/mouseenter/mousemove on that
// element to reveal hover-only UI (dropdown menus, tooltips). Runs covertly in
// the isolated content-script world. Reports the element under the point.
export interface HoverAtServerMessage extends ServerMessageBase {
  cmd: "hover-at";
  tabId: number;
  x: number;
  y: number;
}

export type ServerMessage =
  | OpenTabServerMessage
  | CloseTabsServerMessage
  | GetTabListServerMessage
  | GetBrowserRecentHistoryServerMessage
  | GetTabContentServerMessage
  | ReorderTabsServerMessage
  | FindHighlightServerMessage
  | GroupTabsServerMessage
  | TakeSnapshotServerMessage
  | NavigateTabServerMessage
  | NavigatePageHistoryServerMessage
  | SelectTabServerMessage
  | GetActiveTabServerMessage
  | WaitForTextServerMessage
  | ClickElementServerMessage
  | HoverElementServerMessage
  | FillElementServerMessage
  | FillFormServerMessage
  | TypeTextServerMessage
  | PressKeyServerMessage
  | DragElementServerMessage
  | ResizeWindowServerMessage
  | EvaluateScriptServerMessage
  | UploadFileServerMessage
  | TakeScreenshotServerMessage
  | HandleDialogServerMessage
  | EmulateServerMessage
  | GetConsoleMessagesServerMessage
  | GetNetworkRequestsServerMessage
  | GetCookiesServerMessage
  | BrowserFetchServerMessage
  | StreamStartServerMessage
  | StreamPollServerMessage
  | StreamCloseServerMessage
  | CaptureResponseBodiesServerMessage
  | ClickAtServerMessage
  | TypeAtServerMessage
  | HoverAtServerMessage;

export type ServerMessageRequest = ServerMessage & { correlationId: string };
