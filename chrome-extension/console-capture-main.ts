/**
 * MAIN-world console + error wrapper for Chrome MV3.
 *
 * Registered with world:"MAIN" at document_start so it wraps the PAGE's own
 * console.* and error events (not the isolated content-script world's). The
 * MAIN world has no chrome.runtime, so it cannot message the background
 * directly — it posts a window message that the isolated bridge
 * (console-capture-bridge.ts) forwards. Keep this file free of any chrome.*
 * usage.
 */

(function () {
  try {
    if ((window as any).__bcmcpConsoleHooked) {
      return;
    }
    (window as any).__bcmcpConsoleHooked = true;

    const MAX = 2000;
    function stringifyArg(a: any) {
      try {
        if (typeof a === "string") {
          return a;
        }
        if (a instanceof Error) {
          return a.stack || a.name + ": " + a.message;
        }
        if (a === undefined) {
          return "undefined";
        }
        return JSON.stringify(a);
      } catch (e) {
        try {
          return String(a);
        } catch (e2) {
          return "[unserializable]";
        }
      }
    }
    function post(level: string, args: any[]) {
      const parts = [];
      for (let i = 0; i < args.length; i++) {
        parts.push(stringifyArg(args[i]));
      }
      let text = parts.join(" ");
      if (text.length > MAX) {
        text = text.slice(0, MAX);
      }
      try {
        window.postMessage({ __bcmcp_console: { level, text } }, "*");
      } catch (e) {
        /* ignore */
      }
    }

    const levels = ["log", "info", "warn", "error", "debug"];
    for (let j = 0; j < levels.length; j++) {
      (function (level: string) {
        const original = (console as any)[level];
        (console as any)[level] = function (...args: any[]) {
          try {
            post(level, args);
          } catch (e) {
            /* ignore */
          }
          if (typeof original === "function") {
            return original.apply(console, args);
          }
        };
      })(levels[j]);
    }

    window.addEventListener("error", function (event) {
      let msg = event && event.message ? event.message : "Uncaught error";
      if (event && (event as any).filename) {
        msg += " (" + (event as any).filename + ":" + (event as any).lineno + ":" + (event as any).colno + ")";
      }
      post("error", [msg]);
    });

    window.addEventListener("unhandledrejection", function (event) {
      const reason = (event as any).reason;
      let text;
      try {
        text =
          reason instanceof Error
            ? reason.stack || reason.name + ": " + reason.message
            : "Unhandled promise rejection: " +
              (typeof reason === "string" ? reason : JSON.stringify(reason));
      } catch (e) {
        text = "Unhandled promise rejection";
      }
      post("error", [text]);
    });
  } catch (err) {
    /* never throw out of injected content script */
  }
})();
