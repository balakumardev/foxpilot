/**
 * Content script that wraps console.* and window errors in the page world.
 * Injected at document_start for all URLs via chrome.scripting.registerContentScripts.
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

// Bridge page-world messages to the background.
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
