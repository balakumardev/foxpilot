// Jest setup for the Chrome MV3 extension.
//
// Installs a single mock object under BOTH `global.browser` (used via the
// webextension-polyfill shim and the `globals.ts` re-export) and `global.chrome`
// (used directly by MV3-only call sites: chrome.offscreen, chrome.alarms,
// chrome.declarativeNetRequest, chrome.scripting). Tests drive it with
// `(browser.X.y as jest.Mock).mockResolvedValue(...)`.

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "util";
import { webcrypto as nodeWebcrypto } from "crypto";
if (typeof (global as any).TextDecoder === "undefined") {
  (global as any).TextDecoder = NodeTextDecoder;
}
if (typeof (global as any).TextEncoder === "undefined") {
  (global as any).TextEncoder = NodeTextEncoder;
}

// jsdom does not provide the Web Crypto API. `auth.ts` (HMAC signing) and
// `extension-config.ts` (randomUUID for browserId/secret) both call into
// `crypto.subtle`/`crypto.randomUUID`, so back the global `crypto` with Node's
// webcrypto. Defined configurable/writable so individual tests can still
// `jest.spyOn(crypto, "randomUUID")`.
if (
  typeof (global as any).crypto === "undefined" ||
  typeof (global as any).crypto.subtle === "undefined"
) {
  Object.defineProperty(global, "crypto", {
    value: nodeWebcrypto,
    writable: true,
    configurable: true,
  });
}

// WebSocket readyState constants for keepalive tests (jsdom lacks WebSocket).
if (typeof (global as any).WebSocket === "undefined") {
  (global as any).WebSocket = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  };
}

const mockBrowser: any = {
  tabs: {
    create: jest.fn(),
    remove: jest.fn(),
    query: jest.fn(),
    get: jest.fn(),
    move: jest.fn(),
    update: jest.fn(),
    group: jest.fn(),
    goBack: jest.fn(),
    goForward: jest.fn(),
    reload: jest.fn(),
    sendMessage: jest.fn(),
    captureVisibleTab: jest.fn(),
    onRemoved: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  },
  tabGroups: {
    update: jest.fn(),
  },
  windows: {
    update: jest.fn(),
  },
  history: {
    search: jest.fn(),
  },
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
    },
    onChanged: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  },
  permissions: {
    contains: jest.fn(),
    request: jest.fn(),
    remove: jest.fn(),
  },
  runtime: {
    getURL: jest.fn((p: string) => `chrome-extension://test/${p}`),
    sendMessage: jest.fn(),
    openOptionsPage: jest.fn(),
    reload: jest.fn(),
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  },
  scripting: {
    registerContentScripts: jest.fn().mockResolvedValue(undefined),
    unregisterContentScripts: jest.fn().mockResolvedValue(undefined),
    executeScript: jest.fn().mockResolvedValue([]),
  },
  offscreen: {
    Reason: {
      BLOBS: "BLOBS",
      DOM_PARSER: "DOM_PARSER",
      WORKERS: "WORKERS",
      LOCAL_STORAGE: "LOCAL_STORAGE",
    },
    createDocument: jest.fn().mockResolvedValue(undefined),
    closeDocument: jest.fn().mockResolvedValue(undefined),
    hasDocument: jest.fn().mockResolvedValue(false),
  },
  alarms: {
    create: jest.fn(),
    clear: jest.fn().mockResolvedValue(true),
    onAlarm: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  },
  declarativeNetRequest: {
    updateSessionRules: jest.fn().mockResolvedValue(undefined),
    getSessionRules: jest.fn().mockResolvedValue([]),
  },
  webRequest: {
    onBeforeRequest: { addListener: jest.fn(), removeListener: jest.fn() },
    onBeforeSendHeaders: { addListener: jest.fn(), removeListener: jest.fn() },
    onSendHeaders: { addListener: jest.fn(), removeListener: jest.fn() },
    onHeadersReceived: { addListener: jest.fn(), removeListener: jest.fn() },
    onCompleted: { addListener: jest.fn(), removeListener: jest.fn() },
    onErrorOccurred: { addListener: jest.fn(), removeListener: jest.fn() },
  },
};

Object.defineProperty(global, "browser", {
  value: mockBrowser,
  writable: true,
  configurable: true,
});

Object.defineProperty(global, "chrome", {
  value: mockBrowser,
  writable: true,
  configurable: true,
});

export { mockBrowser };
