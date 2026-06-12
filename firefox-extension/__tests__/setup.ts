// Jest setup file for browser API mocking

// jsdom in this jest version does not expose the WHATWG text encoders as
// globals, but real Firefox (where this extension runs) always has them. Some
// modules under test use `TextDecoder`/`TextEncoder` directly (e.g. the
// network-capture response-body decode). Polyfill them from Node's `util` so the
// real code paths run under test instead of silently hitting their best-effort
// catch branches. These are standard web globals; installing them is benign.
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "util";
if (typeof (global as any).TextDecoder === "undefined") {
  (global as any).TextDecoder = NodeTextDecoder;
}
if (typeof (global as any).TextEncoder === "undefined") {
  (global as any).TextEncoder = NodeTextEncoder;
}

// Mock the browser API completely
const mockBrowser = {
  tabs: {
    create: jest.fn(),
    remove: jest.fn(),
    query: jest.fn(),
    get: jest.fn(),
    executeScript: jest.fn(),
    move: jest.fn(),
    update: jest.fn(),
    group: jest.fn(),
    goBack: jest.fn(),
    goForward: jest.fn(),
    reload: jest.fn(),
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
  find: {
    find: jest.fn(),
    highlightResults: jest.fn(),
  },
  storage: {
    local: {
        get: jest.fn(),
        set: jest.fn(),
    },
    onChanged: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  },
  permissions: {
    contains: jest.fn(),
  },
  runtime: {
    getURL: jest.fn(),
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  },
  contentScripts: {
    register: jest.fn(),
  },
  webRequest: {
    onBeforeRequest: { addListener: jest.fn(), removeListener: jest.fn() },
    onBeforeSendHeaders: { addListener: jest.fn(), removeListener: jest.fn() },
    onSendHeaders: { addListener: jest.fn(), removeListener: jest.fn() },
    onHeadersReceived: { addListener: jest.fn(), removeListener: jest.fn() },
    onCompleted: { addListener: jest.fn(), removeListener: jest.fn() },
    onErrorOccurred: { addListener: jest.fn(), removeListener: jest.fn() },
    filterResponseData: jest.fn(),
  },
};

// Override the global browser object
Object.defineProperty(global, 'browser', {
  value: mockBrowser,
  writable: true,
  configurable: true,
});

// Export for use in tests
export { mockBrowser };
