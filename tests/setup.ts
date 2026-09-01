/**
 * Jest setup file
 * Provides shared safety mocks for server tests.
 */

/// <reference types="jest" />

// Some tests intentionally reset Jest's module registry and re-import modules
// that depend on proper-lockfile/signal-exit. In one worker process that can
// install many process-level signal listeners and produce MaxListeners warnings
// even when behavior is correct. Raise the process listener cap for tests so CI
// output stays actionable and fast.
process.setMaxListeners(Math.max(process.getMaxListeners(), 100));

// ============================================================================
// GLOBAL SAFETY NET: Prevent real Chrome connections during tests.
// Individual tests can override these mocks when they provide their own.
// ============================================================================

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
