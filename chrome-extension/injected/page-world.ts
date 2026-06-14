/**
 * Reusable page-world injection helper.
 *
 * `chrome.scripting.executeScript` runs in the extension's ISOLATED
 * content-script world. That world can read/modify the DOM but cannot see the
 * page's REAL `window` (its frameworks, globals, app state). To run code in the
 * page's real world AND get an async result
 * back, we use a two-stage inject-then-poll pattern:
 *
 *   1. INJECT (one `executeScript` call): an isolated-world "injector" appends a
 *      page-world `<script>` element. That page script runs the real code in
 *      page context and writes its awaited, JSON-encoded result onto an
 *      attribute of `document.documentElement` (e.g. `data-bcmcp-result-<key>`).
 *   2. POLL (repeated `executeScript` calls): an isolated-world "poller" reads
 *      that attribute until it appears (or a timeout elapses), then removes it.
 *
 * CSP-strict pages may block the inline `<script>`. Then the attribute never
 * appears and we time out with a clear Content-Security-Policy hint. That is the
 * documented caveat — we do not try to defeat CSP.
 *
 * The builders below are PURE (string in → string out) so they can be unit
 * tested directly. `runInPageWorld` is the orchestrator; its `exec` and `sleep`
 * dependencies are injected so it is testable with mocks.
 *
 * This helper is shared: the `evaluate-script` tool uses it now, and the
 * upcoming `upload-file` tool will reuse the same inject/poll machinery.
 */

const POLL_INTERVAL_MS = 100;

/**
 * JSON-encodes a string AND escapes the `</` sequence as `<\/`. The `<\/`
 * escape is invisible to a JS parser (it reads `</`) but means the literal
 * `</script>` can never appear verbatim in the output. This keeps the encoded
 * value safe even on the path where it ends up as a `<script>` element's
 * textContent, where an unescaped `</script>` would otherwise be a breakout
 * risk if the source were ever HTML-parsed.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

/**
 * Builds the ISOLATED-world injector code: a self-contained IIFE that appends a
 * page-world `<script>` whose body is `pageScript`. The page script is embedded
 * via `jsonForScript` so any characters (quotes, newlines, even `</script>`
 * sequences) are safely escaped — the `<script>` element's `textContent` is set
 * programmatically, so it is never HTML-parsed and cannot break out.
 */
export function buildInjectorCode(pageScript: string): string {
  return (
    "(function () {" +
    "var s = document.createElement('script');" +
    "s.textContent = " +
    jsonForScript(pageScript) +
    ";" +
    "(document.head || document.documentElement).appendChild(s);" +
    "s.remove();" +
    "})();"
  );
}

/**
 * Builds the ISOLATED-world poller code: an IIFE that reads the result attribute
 * from `document.documentElement`. If present, it removes the attribute (so the
 * value is consumed exactly once) and returns the string value; otherwise it
 * returns null. The returned string is the last expression value of the
 * injected code, which `executeScript` resolves to `[value]`.
 */
export function buildPollerCode(resultAttr: string): string {
  return (
    "(function () {" +
    "var v = document.documentElement.getAttribute(" +
    JSON.stringify(resultAttr) +
    ");" +
    "if (v !== null) {" +
    "document.documentElement.removeAttribute(" +
    JSON.stringify(resultAttr) +
    ");" +
    "}" +
    "return v;" +
    "})();"
  );
}

/**
 * Builds the PAGE-world script for the `evaluate-script` tool.
 *
 * Returns the source of an async IIFE that:
 *   - evaluates `functionSource` (a JS function expression string like
 *     `"() => document.title"`) and calls it with `args` spread in;
 *   - awaits the result if it is thenable;
 *   - serializes the result via `JSON.parse(JSON.stringify(result))`, falling
 *     back to `String(result)` if it is not JSON-serializable, and mapping
 *     `undefined` to `null`;
 *   - writes `JSON.stringify({ ok: true, value })` to `resultAttr` on
 *     `document.documentElement`;
 *   - on throw, writes `JSON.stringify({ ok: false, error })` instead.
 *
 * `functionSource`, `args`, and `resultAttr` are embedded via `JSON.stringify`
 * so they are injected safely.
 */
export function buildEvalPageScript(
  functionSource: string,
  args: unknown[],
  resultAttr: string
): string {
  return (
    "(async function () {" +
    "var __attr = " +
    jsonForScript(resultAttr) +
    ";" +
    "try {" +
    "var __fn = (" +
    jsonForScript(functionSource) +
    ");" +
    "var __args = " +
    jsonForScript(args) +
    ";" +
    // Evaluate the function-expression source into a callable.
    "var __callable = (0, eval)('(' + __fn + ')');" +
    "var __result = __callable.apply(null, __args);" +
    // Await thenables (covers async functions and returned promises).
    "if (__result && typeof __result.then === 'function') {" +
    "__result = await __result;" +
    "}" +
    // Handle undefined BEFORE the JSON round-trip: JSON.stringify(undefined) is
    // undefined, so JSON.parse(undefined) would throw and fall into the catch,
    // turning a top-level `undefined` return into the string "undefined".
    "var __out;" +
    "if (__result === undefined) { __out = null; }" +
    "else { try { __out = JSON.parse(JSON.stringify(__result)); } catch (e) { __out = String(__result); } }" +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:true, value: __out }));" +
    "} catch (err) {" +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:false, error: String(err && err.message || err) }));" +
    "}" +
    "})();"
  );
}

/**
 * Builds the PAGE-world script for the `upload-file` tool.
 *
 * Browsers forbid setting a file `<input>`'s value from JS, so the only way to
 * programmatically populate one is the verified `DataTransfer` technique:
 * reconstruct a `File` from the bytes and assign it via a `DataTransfer`'s
 * `files`. The MCP server has already read the file off disk and passed its
 * bytes here as `base64` — this script decodes them in the page.
 *
 * Returns the source of a synchronous IIFE that:
 *   - resolves the element by its snapshot uid (`data-bcmcp-uid="<uid>"`);
 *     if it no longer resolves, writes
 *     `{ ok:false, error:"...not found — take a fresh snapshot." }`;
 *   - decodes `base64` (`atob` → a `Uint8Array` built with a `charCodeAt` loop);
 *   - builds `new File([bytes], filename, { type: mimeType })`;
 *   - assigns it to the input via `DataTransfer` (`el.files = dt.files`);
 *   - dispatches bubbling `input` and `change` events so frameworks observe it;
 *   - writes `{ ok:true }` to `resultAttr` on `document.documentElement`.
 * The whole body is wrapped in try/catch → `{ ok:false, error:String(e) }`.
 *
 * It is synchronous (File/DataTransfer/dispatch are all sync), so the result
 * attribute is set immediately and `runInPageWorld`'s first poll sees it.
 *
 * `uid`, `filename`, `mimeType`, `base64`, and `resultAttr` are embedded via
 * `jsonForScript` so any characters — including `</script>` — are injected
 * safely.
 */
export function buildUploadPageScript(
  uid: string,
  filename: string,
  mimeType: string,
  base64: string,
  resultAttr: string
): string {
  return (
    "(function () {" +
    "var __attr = " +
    jsonForScript(resultAttr) +
    ";" +
    "try {" +
    "var __uid = " +
    jsonForScript(uid) +
    ";" +
    "var __el = document.querySelector('[data-bcmcp-uid=\"' + __uid + '\"]');" +
    "if (!__el) {" +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:false, error: \"Element uid '\" + __uid + \"' not found \\u2014 take a fresh snapshot (uids are reassigned each snapshot).\" }));" +
    "return;" +
    "}" +
    "var __b64 = " +
    jsonForScript(base64) +
    ";" +
    "var __filename = " +
    jsonForScript(filename) +
    ";" +
    "var __mimeType = " +
    jsonForScript(mimeType) +
    ";" +
    // Decode base64 to a byte string, then to a Uint8Array via charCodeAt.
    "var __bin = atob(__b64);" +
    "var __len = __bin.length;" +
    "var __bytes = new Uint8Array(__len);" +
    "for (var __i = 0; __i < __len; __i++) { __bytes[__i] = __bin.charCodeAt(__i); }" +
    // Reconstruct the File and assign it to the input via DataTransfer.
    "var __file = new File([__bytes], __filename, { type: __mimeType });" +
    "var __dt = new DataTransfer();" +
    "__dt.items.add(__file);" +
    "__el.files = __dt.files;" +
    // Notify frameworks listening in the page world.
    "__el.dispatchEvent(new Event(\"input\", { bubbles: true }));" +
    "__el.dispatchEvent(new Event(\"change\", { bubbles: true }));" +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:true }));" +
    "} catch (err) {" +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:false, error: String(err && err.message || err) }));" +
    "}" +
    "})();"
  );
}

/**
 * Builds the PAGE-world script for the `handle-dialog` tool.
 *
 * Arms the page so FUTURE native JS dialogs are auto-handled: it overrides
 * `window.alert` (becomes a no-op), `window.confirm` (returns true on "accept",
 * false on "dismiss"), and `window.prompt` (returns `promptText` (or "") on
 * "accept", null on "dismiss"). It also best-effort clears
 * `window.onbeforeunload` so an "are you sure you want to leave" prompt does not
 * block navigation.
 *
 * CAVEATS (the page cannot work around these):
 *   - This cannot intercept a dialog that is ALREADY open — a native dialog
 *     blocks the page's JS thread, so no script can run until it is dismissed by
 *     the user. It only affects dialogs raised AFTER this runs.
 *   - The overrides live on the page's `window` and are therefore reset on
 *     navigation (a fresh document gets fresh `window.alert` etc.). Re-arm after
 *     navigating.
 *
 * Returns the source of a synchronous IIFE that installs the overrides and then
 * writes `{ ok:true }` to `resultAttr` on `document.documentElement`. The whole
 * body is wrapped in try/catch and writes `{ ok:false, error }` on throw.
 *
 * `action`, `promptText`, and `resultAttr` are embedded via `jsonForScript` so
 * any characters (quotes, newlines, the `</script>` sequence) are injected
 * safely.
 */
export function buildDialogPageScript(
  action: "accept" | "dismiss",
  promptText: string | undefined,
  resultAttr: string
): string {
  const accept = action === "accept";
  return (
    "(function () {" +
    "var __attr = " +
    jsonForScript(resultAttr) +
    ";" +
    "try {" +
    "var __promptText = " +
    jsonForScript(promptText ?? "") +
    ";" +
    // alert: suppress entirely (no-op).
    "window.alert = function () {};" +
    // confirm: accept => true, dismiss => false.
    (accept
      ? "window.confirm = function () { return true; };"
      : "window.confirm = function () { return false; };") +
    // prompt: accept => the configured text (or ""), dismiss => null.
    (accept
      ? "window.prompt = function () { return __promptText || \"\"; };"
      : "window.prompt = function () { return null; };") +
    // Best-effort: clear any beforeunload handler so leaving the page is not
    // blocked by a confirmation dialog.
    "try { window.onbeforeunload = null; } catch (e) {}" +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:true }));" +
    "} catch (err) {" +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:false, error: String(err && err.message || err) }));" +
    "}" +
    "})();"
  );
}

/**
 * Builds the PAGE-world script for the `emulate` tool.
 *
 * Installs navigator shims in the page's real world:
 *   - geolocation (when `geolocation` is given): overrides
 *     `navigator.geolocation.getCurrentPosition` and `watchPosition` so they
 *     invoke the success callback with a synthetic `GeolocationPosition`
 *     ({ coords:{ latitude, longitude, accuracy, altitude:null,
 *     altitudeAccuracy:null, heading:null, speed:null }, timestamp }).
 *     `watchPosition` also returns a fake numeric watch id.
 *   - userAgent (when `userAgent` is given): redefines `navigator.userAgent`
 *     via `Object.defineProperty` with a getter returning the override (kept
 *     `configurable:true` so it can be re-emulated). NOTE this only changes the
 *     value the PAGE reads; the User-Agent sent on network requests is handled
 *     separately by a background webRequest header rewrite.
 *
 * Returns the source of a synchronous IIFE that installs whichever shims were
 * requested and then writes `{ ok:true }` to `resultAttr`. The whole body is
 * wrapped in try/catch and writes `{ ok:false, error }` on throw.
 *
 * Embedded values are injected via `jsonForScript` so any characters — including
 * the `</script>` sequence — are safe.
 */
export function buildEmulatePageScript(
  geolocation:
    | { latitude: number; longitude: number; accuracy?: number }
    | undefined,
  userAgent: string | undefined,
  resultAttr: string
): string {
  let geoBlock = "";
  if (geolocation) {
    geoBlock =
      "if (navigator.geolocation) {" +
      "var __lat = " +
      jsonForScript(geolocation.latitude) +
      ";" +
      "var __lon = " +
      jsonForScript(geolocation.longitude) +
      ";" +
      "var __acc = " +
      jsonForScript(geolocation.accuracy ?? 100) +
      ";" +
      "var __makePos = function () {" +
      "return { coords: { latitude: __lat, longitude: __lon, accuracy: __acc, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() };" +
      "};" +
      "navigator.geolocation.getCurrentPosition = function (success) {" +
      "if (typeof success === 'function') { success(__makePos()); }" +
      "};" +
      "navigator.geolocation.watchPosition = function (success) {" +
      "if (typeof success === 'function') { success(__makePos()); }" +
      "return 0;" +
      "};" +
      "}";
  }

  let uaBlock = "";
  if (userAgent !== undefined) {
    uaBlock =
      "var __ua = " +
      jsonForScript(userAgent) +
      ";" +
      "Object.defineProperty(navigator, \"userAgent\", { get: function () { return __ua; }, configurable: true });";
  }

  return (
    "(function () {" +
    "var __attr = " +
    jsonForScript(resultAttr) +
    ";" +
    "try {" +
    geoBlock +
    uaBlock +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:true }));" +
    "} catch (err) {" +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:false, error: String(err && err.message || err) }));" +
    "}" +
    "})();"
  );
}

/**
 * Orchestrates inject → poll → parse. `exec` is the injected wrapper over
 * `chrome.scripting.executeScript` (`(code) => Promise<any[]>`): it runs a code
 * string in the tab's isolated content-script world and resolves to the array of
 * per-frame results. `sleep` is injected for testability.
 *
 * Steps:
 *   1. Inject the page-world script once.
 *   2. Poll the result attribute every ~100ms until it appears or `timeoutMs`
 *      elapses.
 *   3. Parse the attribute's value (it is the page script's JSON envelope, e.g.
 *      `{ ok, value }` or `{ ok, error }`) and return it.
 *
 * On timeout returns `{ ok:false, error }` mentioning that the page's
 * Content-Security-Policy may be blocking the injected script. On a JSON parse
 * failure returns `{ ok:false, error }` describing the parse problem.
 */
export async function runInPageWorld(
  exec: (code: string) => Promise<any[]>,
  pageScript: string,
  resultAttr: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<{ ok: boolean; value?: any; error?: string }> {
  // 1. Inject the page-world script (one executeScript call).
  await exec(buildInjectorCode(pageScript));

  const pollerCode = buildPollerCode(resultAttr);
  const deadline = Date.now() + timeoutMs;

  // 2. Poll until the result attribute appears or we hit the deadline.
  while (true) {
    const [raw] = await exec(pollerCode);
    if (raw != null) {
      // 3. Parse the page script's JSON envelope.
      try {
        return JSON.parse(raw as string);
      } catch (e) {
        return {
          ok: false,
          error: `Failed to parse in-page result: ${String(e)}`,
        };
      }
    }
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return {
    ok: false,
    error:
      "Timed out waiting for in-page result (the page's Content-Security-Policy may be blocking injected scripts).",
  };
}
