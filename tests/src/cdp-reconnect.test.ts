/// <reference types="jest" />
/**
 * Tests for GitHub issue #67 bug fixes:
 * 1. handleDisconnect resets reconnectAttempts to 0 on each new disconnect event
 * 2. handleDisconnect removes old browser listeners before nulling the browser reference
 * 3. getChromeLauncher creates a new instance when called with a different port
 */

// ─── Mocks must come before any imports ───────────────────────────────────────

// Mock puppeteer-core
jest.mock('puppeteer-core', () => ({
  default: {
    connect: jest.fn(),
  },
}));

// Mock launcher (used for CDPClient tests)
const mockEnsureChrome = jest.fn();
jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: mockEnsureChrome,
  }),
}));

// Mock global config
jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { CDPClient } from '../../src/cdp/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a CDPClient with a mock browser already attached, matching the pattern
 * from cdp-client-optimization.test.ts.
 *
 * Note: reconnectDelayMs must be >= 1 because the constructor uses `|| 1000`,
 * so passing 0 (falsy) would silently fall back to the 1000ms default.
 */
function createConnectedClient(opts: {
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  removeAllListeners?: jest.Mock;
} = {}): CDPClient {
  const client = new CDPClient({
    port: 9222,
    maxReconnectAttempts: opts.maxReconnectAttempts ?? 3,
    reconnectDelayMs: opts.reconnectDelayMs ?? 1, // 1ms — falsy 0 would hit the 1000ms default
  });

  const mockBrowserTarget = {
    createCDPSession: jest.fn(),
  };
  const mockBrowser = {
    isConnected: jest.fn().mockReturnValue(true),
    target: jest.fn().mockReturnValue(mockBrowserTarget),
    on: jest.fn(),
    removeAllListeners: opts.removeAllListeners ?? jest.fn(),
  };

  (client as any).browser = mockBrowser;
  (client as any).connectionState = 'connected';

  return client;
}

// ─── CDPClient – handleDisconnect reconnection fixes ─────────────────────────

describe('CDPClient – handleDisconnect reconnection fixes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore getChromeLauncher mock return value after clearAllMocks (which only
    // clears call history, not implementations — but be explicit for clarity)
    const launcherMock = require('../../src/chrome/launcher');
    launcherMock.getChromeLauncher.mockReturnValue({ ensureChrome: mockEnsureChrome });
  });

  test('resets reconnectAttempts to 0 on new disconnect event', async () => {
    const client = createConnectedClient({ maxReconnectAttempts: 3, reconnectDelayMs: 1 });

    // Simulate leftover reconnectAttempts from a previous partial reconnect
    (client as any).reconnectAttempts = 2;

    // Spy on connectInternal to count actual reconnection attempts
    const connectSpy = jest.spyOn(client as any, 'connectInternal')
      .mockRejectedValue(new Error('Chrome not available'));

    await (client as any).handleDisconnect();

    // reconnectAttempts was reset to 0 before retrying, so all 3 attempts fired
    expect(connectSpy).toHaveBeenCalledTimes(3);

    // After all retries fail, reconnectAttempts is reset to 0 again
    expect((client as any).reconnectAttempts).toBe(0);
  });

  test('does not skip retries when reconnectAttempts was non-zero before disconnect', async () => {
    const client = createConnectedClient({ maxReconnectAttempts: 3, reconnectDelayMs: 1 });

    // Simulate leftover state: 2 attempts already "used"
    (client as any).reconnectAttempts = 2;

    let callCount = 0;
    const connectSpy = jest.spyOn(client as any, 'connectInternal')
      .mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error('not ready');
        }
        // 3rd attempt succeeds: set state as connectInternal would
        (client as any).browser = { on: jest.fn(), isConnected: jest.fn().mockReturnValue(true) };
        (client as any).connectionState = 'connected';
      });

    await (client as any).handleDisconnect();

    // Should have made exactly 3 attempts (all of maxReconnectAttempts),
    // not just 1 (which would happen if reconnectAttempts hadn't been reset to 0)
    expect(connectSpy).toHaveBeenCalledTimes(3);
    expect((client as any).connectionState).toBe('connected');
  });

  test('removes old browser listeners before nulling reference', async () => {
    const removeAllListeners = jest.fn();
    const client = createConnectedClient({ removeAllListeners, reconnectDelayMs: 1 });

    // Track whether browser is still set when removeAllListeners is called
    const callOrder: string[] = [];

    removeAllListeners.mockImplementation((event: string) => {
      callOrder.push(`removeAllListeners:${event}`);
      // browser must NOT be null yet when the listener removal fires
      if ((client as any).browser === null) {
        callOrder.push('ERROR:browser-already-null');
      }
    });

    // Make reconnection fail so handleDisconnect completes quickly
    jest.spyOn(client as any, 'connectInternal')
      .mockRejectedValue(new Error('Chrome not available'));

    await (client as any).handleDisconnect();

    // Both listeners must have been removed
    expect(removeAllListeners).toHaveBeenCalledWith('disconnected');
    expect(removeAllListeners).toHaveBeenCalledWith('targetdestroyed');

    // Removal happened before browser was set to null
    expect(callOrder).toContain('removeAllListeners:disconnected');
    expect(callOrder).toContain('removeAllListeners:targetdestroyed');
    expect(callOrder).not.toContain('ERROR:browser-already-null');

    // After handleDisconnect, browser must be null
    expect((client as any).browser).toBeNull();
  });

  test('skips handleDisconnect if already reconnecting', async () => {
    const client = createConnectedClient({ reconnectDelayMs: 1 });
    (client as any).connectionState = 'reconnecting';

    const connectSpy = jest.spyOn(client as any, 'connectInternal')
      .mockRejectedValue(new Error('Chrome not available'));

    await (client as any).handleDisconnect();

    // Should return immediately without attempting reconnection
    expect(connectSpy).not.toHaveBeenCalled();
  });
});

// ─── getChromeLauncher – port validation ──────────────────────────────────────
//
// The real launcher module is tested directly using jest.isolateModules() so
// each test gets a fresh module load (clean launcherInstance singleton).
// The top-of-file jest.mock for launcher only applies to the main module registry;
// isolateModules creates a separate registry where we load the real module.

describe('getChromeLauncher – port validation', () => {
  /**
   * Load the real (non-mocked) ChromeLauncher module in an isolated module
   * registry so launcherInstance starts as null for each test.
   */
  function loadRealLauncherModule(): { getChromeLauncher: (port?: number) => any } {
    let mod: any;
    jest.isolateModules(() => {
      // Provide config mock so the launcher constructor doesn't call getGlobalConfig
      jest.mock('../../src/config/global', () => ({
        getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false }),
      }));
      // Load the REAL launcher (not the file-level mock) from this isolated registry
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = jest.requireActual('../../src/chrome/launcher');
    });
    return mod;
  }

  test('returns same instance when called with same port', () => {
    const { getChromeLauncher } = loadRealLauncherModule();
    const instance1 = getChromeLauncher(9222);
    const instance2 = getChromeLauncher(9222);

    expect(instance1).toBe(instance2);
    // Access the private port field to verify it was constructed with the right port
    expect((instance1 as any).port).toBe(9222);
  });

  test('creates new instance when called with different port', () => {
    const { getChromeLauncher } = loadRealLauncherModule();
    const instance1 = getChromeLauncher(9222);
    const instance2 = getChromeLauncher(9223);

    expect(instance1).not.toBe(instance2);
    expect((instance1 as any).port).toBe(9222);
    expect((instance2 as any).port).toBe(9223);
  });

  test('defaults to DEFAULT_PORT (9222) when port is undefined', () => {
    const { getChromeLauncher } = loadRealLauncherModule();
    const instance = getChromeLauncher();

    expect((instance as any).port).toBe(9222);
  });

  test('replaces singleton when called with a new port after initial creation', () => {
    const { getChromeLauncher } = loadRealLauncherModule();

    // First call creates instance at 9222
    const first = getChromeLauncher(9222);
    expect((first as any).port).toBe(9222);

    // Second call with different port replaces singleton
    const second = getChromeLauncher(9300);
    expect((second as any).port).toBe(9300);
    expect(second).not.toBe(first);

    // Third call with the same new port returns the updated singleton
    const third = getChromeLauncher(9300);
    expect(third).toBe(second);
  });
});
