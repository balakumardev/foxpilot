/**
 * Isolated-world bridge for console capture (Chrome MV3).
 *
 * Registered in the DEFAULT (isolated) world at document_start. Listens for the
 * window message the MAIN-world wrapper (console-capture-main.ts) posts and
 * forwards it to the background via chrome.runtime.sendMessage. The MAIN world
 * cannot reach chrome.runtime, which is why this split exists.
 *
 * The `e.source === window` guard only forwards messages that originated in THIS
 * same window/frame, rejecting cross-frame/cross-window posts (e.g. from an
 * iframe or another tab). It does NOT prevent same-page forgery: a page's own
 * script shares this `window`, so it can still post a crafted { __bcmcp_console }
 * message that we forward. Captured console output is therefore page-influenced
 * data, not a trusted channel — treat it accordingly.
 */

window.addEventListener("message", function (e) {
  if (e.source === window && e.data && e.data.__bcmcp_console) {
    try {
      chrome.runtime.sendMessage({
        type: "bcmcp-console-entry",
        entry: {
          level: e.data.__bcmcp_console.level,
          text: e.data.__bcmcp_console.text,
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      /* ignore */
    }
  }
});
