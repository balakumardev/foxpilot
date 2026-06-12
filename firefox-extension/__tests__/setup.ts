// Jest setup file for browser API mocking

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
