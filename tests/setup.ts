/**
 * Jest setup file
 * Provides mocks for both Chrome extension and standalone server tests
 */

/// <reference types="jest" />

// ============================================================================
// GLOBAL SAFETY NET: Prevent real Chrome connections during tests
// These mocks are overridden by individual test files that provide their own.
// Without this, singleton leakage between test files in the same Jest worker
// can cause getCDPClient() or getSessionManager() to connect to a real Chrome
// instance on port 9222, spawning hundreds of about:blank tabs.
// ============================================================================

// Block puppeteer-core from connecting to real Chrome
jest.mock('puppeteer-core', () => {
  const mockBrowser = {
    isConnected: jest.fn().mockReturnValue(false),
    disconnect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    targets: jest.fn().mockReturnValue([]),
    pages: jest.fn().mockResolvedValue([]),
    newPage: jest.fn().mockRejectedValue(new Error('[TEST SAFETY] Real browser not available in tests')),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    target: jest.fn().mockReturnValue({
      createCDPSession: jest.fn().mockRejectedValue(new Error('[TEST SAFETY] Real CDP session not available')),
    }),
    wsEndpoint: jest.fn().mockReturnValue('ws://mock:9222'),
  };

  return {
    __esModule: true,
    default: {
      connect: jest.fn().mockResolvedValue(mockBrowser),
      launch: jest.fn().mockResolvedValue(mockBrowser),
    },
    connect: jest.fn().mockResolvedValue(mockBrowser),
    launch: jest.fn().mockResolvedValue(mockBrowser),
  };
});

// Block ChromeLauncher from launching real Chrome
jest.mock('../src/chrome/launcher', () => ({
  ChromeLauncher: jest.fn().mockImplementation(() => ({
    ensureChrome: jest.fn().mockResolvedValue({
      wsEndpoint: 'ws://mock:9222',
      httpEndpoint: 'http://mock:9222',
    }),
    close: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(false),
  })),
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: jest.fn().mockResolvedValue({
      wsEndpoint: 'ws://mock:9222',
      httpEndpoint: 'http://mock:9222',
    }),
    close: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(false),
  }),
}));

// ============================================================================

// Mock Chrome API (for extension tests)
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

// @ts-expect-error - mocking global chrome object
global.chrome = chromeMock;

// Mock console.error for cleaner test output (capture server logs)
const originalConsoleError = console.error;
let capturedLogs: string[] = [];

// Helper to capture or suppress server logs during tests
export function captureConsoleLogs(capture: boolean = true) {
  if (capture) {
    capturedLogs = [];
    console.error = (...args: unknown[]) => {
      capturedLogs.push(args.map(String).join(' '));
    };
  } else {
    console.error = originalConsoleError;
  }
}

export function getCapturedLogs(): string[] {
  return [...capturedLogs];
}

export function clearCapturedLogs(): void {
  capturedLogs = [];
}

// Mock crypto.randomUUID for consistent testing
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
  const mockRandomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
    const chars = 'abcdef0123456789';
    const sections = [8, 4, 4, 4, 12] as const;
    const parts = sections.map((len) =>
      Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
    );
    return `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3]}-${parts[4]}` as `${string}-${string}-${string}-${string}-${string}`;
  };

  Object.defineProperty(globalThis, 'crypto', {
    value: {
      randomUUID: mockRandomUUID,
    },
    writable: true,
    configurable: true,
  });
}

// Reset all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
  clearCapturedLogs();
});

// Restore console after all tests
afterAll(() => {
  console.error = originalConsoleError;
});

// Export chrome mock for direct access in tests
export { chromeMock };
