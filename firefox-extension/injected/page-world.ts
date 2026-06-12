/**
 * Reusable page-world injection helper.
 *
 * `browser.tabs.executeScript` runs in the extension's ISOLATED content-script
 * world. That world can read/modify the DOM but cannot see the page's REAL
 * `window` (its frameworks, globals, app state), and `executeScript` does NOT
 * await promises. To run code in the page's real world AND get an async result
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
    "var __out;" +
    "try { __out = JSON.parse(JSON.stringify(__result)); }" +
    "catch (e) { __out = String(__result); }" +
    "if (__out === undefined) { __out = null; }" +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:true, value: __out }));" +
    "} catch (err) {" +
    "document.documentElement.setAttribute(__attr, JSON.stringify({ ok:false, error: String(err && err.message || err) }));" +
    "}" +
    "})();"
  );
}

/**
 * Orchestrates inject → poll → parse. `exec` is the injected
 * `browser.tabs.executeScript`-style wrapper (`(code) => Promise<any[]>`), and
 * `sleep` is injected for testability.
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
