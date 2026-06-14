/**
 * Isolated-world bridge for console capture (Chrome MV3).
 *
 * Registered in the DEFAULT (isolated) world at document_start. Listens for the
 * window message the MAIN-world wrapper (console-capture-main.ts) posts and
 * forwards it to the background via chrome.runtime.sendMessage. The MAIN world
 * cannot reach chrome.runtime, which is why this split exists.
 *
 * Security: only forward same-window messages (e.source === window) carrying the
 * expected payload shape, so a hostile page cannot inject forged console entries
 * by posting a crafted { __bcmcp_console } message.
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
