/**
 * Jest setup file
 */

// Mock Chrome API
const chromeMock = {
  tabs: {
    create: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    query: jest.fn(),
    group: jest.fn(),
    ungroup: jest.fn(),
    goBack: jest.fn(),
    goForward: jest.fn(),
    onRemoved: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
    onUpdated: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  },
  tabGroups: {
    update: jest.fn(),
    get: jest.fn(),
    query: jest.fn(),
  },
  debugger: {
    attach: jest.fn(),
    detach: jest.fn(),
    sendCommand: jest.fn(),
    onDetach: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  },
  runtime: {
    connect: jest.fn(),
    connectNative: jest.fn(),
    sendMessage: jest.fn(),
    onConnect: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
    onConnectExternal: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
    onMessageExternal: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
    onInstalled: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
    onStartup: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
    lastError: null,
  },
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
    },
  },
};

// @ts-expect-error - mocking global
global.chrome = chromeMock;

// Reset all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});
