/// <reference types="jest" />
/**
 * Tests for CDPClient connection coalescing and puppeteer.connect timeout.
 *
 * These fixes prevent the "infinite navigate hang" bug:
 * 1. Connection coalescing: concurrent connect() calls share one connectInternal()
 * 2. puppeteer.connect timeout: explicit 15s timeout on WebSocket connection
 * 3. forceReconnect invalidates pending connects
 */

// ─── Mocks must come before any imports ───────────────────────────────────────

jest.mock('puppeteer-core', () => ({
  __esModule: true,
  default: {
    connect: jest.fn(),
  },
}));

const mockEnsureChrome = jest.fn();
jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: mockEnsureChrome,
    invalidateInstance: jest.fn(),
  }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false }),
}));

jest.mock('../../src/config/defaults', () => {
  const actual = jest.requireActual('../../src/config/defaults');
  return {
    ...actual,
    DEFAULT_PUPPETEER_CONNECT_TIMEOUT_MS: 500, // Short timeout for test speed
  };
});

// ─── Imports ──────────────────────────────────────────────────────────────────

import { CDPClient } from '../../src/cdp/client';

// Get the actual mock function from the mocked module
const puppeteerMock = jest.requireMock('puppeteer-core') as { default: { connect: jest.Mock } };
const mockPuppeteerConnect = puppeteerMock.default.connect;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockBrowser(wsEndpoint = 'ws://localhost:9222/devtools/browser/abc') {
  return {
    isConnected: jest.fn().mockReturnValue(true),
    wsEndpoint: jest.fn().mockReturnValue(wsEndpoint),
    target: jest.fn().mockReturnValue({ createCDPSession: jest.fn() }),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    disconnect: jest.fn().mockResolvedValue(undefined),
    targets: jest.fn().mockReturnValue([]),
    pages: jest.fn().mockResolvedValue([]),
  };
}

/** Stop heartbeat timer to prevent Jest from hanging. */
function stopHeartbeat(client: CDPClient) {
  const hb = (client as any).heartbeatTimer;
  if (hb) {
    clearInterval(hb);
    (client as any).heartbeatTimer = null;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CDPClient – connection coalescing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const launcherMock = require('../../src/chrome/launcher');
    launcherMock.getChromeLauncher.mockReturnValue({ ensureChrome: mockEnsureChrome, invalidateInstance: jest.fn() });
    mockEnsureChrome.mockResolvedValue({
      wsEndpoint: 'ws://localhost:9222/devtools/browser/abc',
      httpEndpoint: 'http://127.0.0.1:9222',
    });
  });

  test('concurrent connect() calls share a single connectInternal()', async () => {
    const client = new CDPClient({ port: 9222 });

    const connectInternalSpy = jest.spyOn(client as any, 'connectInternal')
      .mockImplementation(() => new Promise<void>((resolve) => {
        setTimeout(() => {
          (client as any).browser = createMockBrowser();
          (client as any).connectionState = 'connected';
          resolve();
        }, 50);
      }));

    const promises = Array.from({ length: 5 }, () => client.connect());
    await Promise.all(promises);

    expect(connectInternalSpy).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(true);
    stopHeartbeat(client);
  });

  test('second connect() call reuses promise from first', async () => {
    const client = new CDPClient({ port: 9222 });

    let resolveConnect: (() => void) | null = null;
    const connectInternalSpy = jest.spyOn(client as any, 'connectInternal')
      .mockImplementation(() => new Promise<void>((resolve) => {
        resolveConnect = () => {
          (client as any).browser = createMockBrowser();
          (client as any).connectionState = 'connected';
          resolve();
        };
      }));

    const promise1 = client.connect();
    const promise2 = client.connect();

    resolveConnect!();
    await Promise.all([promise1, promise2]);

    expect(connectInternalSpy).toHaveBeenCalledTimes(1);
    stopHeartbeat(client);
  });

  test('failed connect() propagates error to all coalesced callers', async () => {
    const client = new CDPClient({ port: 9222 });
    const connectError = new Error('Chrome not available');

    jest.spyOn(client as any, 'connectInternal').mockRejectedValue(connectError);

    const promises = Array.from({ length: 3 }, () => client.connect());

    const results = await Promise.allSettled(promises);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason.message).toContain('Chrome not available');
      }
    }
  });

  test('pendingConnect is cleared after completion', async () => {
    const client = new CDPClient({ port: 9222 });

    jest.spyOn(client as any, 'connectInternal').mockImplementation(async () => {
      (client as any).browser = createMockBrowser();
      (client as any).connectionState = 'connected';
    });

    await client.connect();

    expect((client as any).pendingConnect).toBeNull();
    stopHeartbeat(client);
  });

  test('pendingConnect is cleared after failure', async () => {
    const client = new CDPClient({ port: 9222 });

    jest.spyOn(client as any, 'connectInternal').mockRejectedValue(new Error('fail'));

    await client.connect().catch(() => {});

    expect((client as any).pendingConnect).toBeNull();
  });

  test('connectionState set to disconnected after failure', async () => {
    const client = new CDPClient({ port: 9222 });

    jest.spyOn(client as any, 'connectInternal').mockRejectedValue(new Error('fail'));

    await client.connect().catch(() => {});

    expect(client.getConnectionState()).toBe('disconnected');
  });

  test('new connect() after previous failure starts fresh attempt', async () => {
    const client = new CDPClient({ port: 9222 });

    const connectInternalSpy = jest.spyOn(client as any, 'connectInternal');

    connectInternalSpy.mockRejectedValueOnce(new Error('fail'));
    await client.connect().catch(() => {});
    expect(connectInternalSpy).toHaveBeenCalledTimes(1);

    connectInternalSpy.mockImplementationOnce(async () => {
      (client as any).browser = createMockBrowser();
      (client as any).connectionState = 'connected';
    });
    await client.connect();
    expect(connectInternalSpy).toHaveBeenCalledTimes(2);
    expect(client.isConnected()).toBe(true);
    stopHeartbeat(client);
  });

  test('first call honors caller autoLaunch and tracks it on pendingConnectAutoLaunch', async () => {
    // The startup-probe race fix relies on connectInternal receiving the
    // caller's autoLaunch and on pendingConnectAutoLaunch tracking the
    // effective value so a mismatched second caller can detect the conflict.
    const client = new CDPClient({ port: 9222 });

    let resolveFirst: (() => void) | null = null;
    const connectInternalSpy = jest.spyOn(client as any, 'connectInternal')
      .mockImplementation(() => new Promise<void>((resolve) => {
        resolveFirst = () => {
          (client as any).browser = createMockBrowser();
          (client as any).connectionState = 'connected';
          resolve();
        };
      }));

    const probePromise = client.connect({ autoLaunch: false });
    expect((client as any).pendingConnect).not.toBeNull();
    expect((client as any).pendingConnectAutoLaunch).toBe(false);
    expect(connectInternalSpy.mock.calls[0][0]).toMatchObject({ autoLaunch: false });

    resolveFirst!();
    await probePromise;

    // Cleared after settlement.
    expect((client as any).pendingConnect).toBeNull();
    expect((client as any).pendingConnectAutoLaunch).toBeUndefined();
    stopHeartbeat(client);
  });

  test('conflicting autoLaunch: second caller gets its own attempt when in-flight call fails', async () => {
    // Regression guard for the startup-probe race: when the in-flight call
    // (e.g. probe with autoLaunch:false) fails because Chrome is not running,
    // a concurrent tool-call connect(autoLaunch:true) must not be coalesced
    // into that same failed attempt — it gets its own connectInternal so the
    // caller's autoLaunch preference is honored.
    const client = new CDPClient({ port: 9222 });

    let rejectFirst: ((err: Error) => void) | null = null;
    const connectInternalSpy = jest.spyOn(client as any, 'connectInternal')
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        rejectFirst = (err) => reject(err);
      }))
      .mockImplementationOnce(async () => {
        (client as any).browser = createMockBrowser();
        (client as any).connectionState = 'connected';
      });

    const probePromise = client.connect({ autoLaunch: false }).catch(() => { /* expected */ });
    expect((client as any).pendingConnectAutoLaunch).toBe(false);

    // Tool-call analog with conflicting autoLaunch:true lands while the probe
    // is in flight. Implementation must wait, then start its own attempt.
    const toolPromise = client.connect({ autoLaunch: true });

    rejectFirst!(new Error('chrome not running'));
    await Promise.all([probePromise, toolPromise]);

    // Two separate connectInternal invocations — coalescing would produce one.
    expect(connectInternalSpy).toHaveBeenCalledTimes(2);
    expect(connectInternalSpy.mock.calls[0][0]).toMatchObject({ autoLaunch: false });
    expect(connectInternalSpy.mock.calls[1][0]).toMatchObject({ autoLaunch: true });
    stopHeartbeat(client);
  });

  test('connect() with matching autoLaunch still coalesces', async () => {
    const client = new CDPClient({ port: 9222 });

    let resolveConnect: (() => void) | null = null;
    const connectInternalSpy = jest.spyOn(client as any, 'connectInternal')
      .mockImplementation(() => new Promise<void>((resolve) => {
        resolveConnect = () => {
          (client as any).browser = createMockBrowser();
          (client as any).connectionState = 'connected';
          resolve();
        };
      }));

    const p1 = client.connect({ autoLaunch: false });
    const p2 = client.connect({ autoLaunch: false });

    resolveConnect!();
    await Promise.all([p1, p2]);

    // Same effective autoLaunch → still coalesces to a single attempt.
    expect(connectInternalSpy).toHaveBeenCalledTimes(1);
    stopHeartbeat(client);
  });

  test('connect() with unspecified autoLaunch coalesces with the instance default', async () => {
    // Instance default is autoLaunch:false (per the mocked global config), so a
    // caller that omits the option resolves to false and should coalesce with
    // an in-flight explicit-false call.
    const client = new CDPClient({ port: 9222 });

    let resolveConnect: (() => void) | null = null;
    const connectInternalSpy = jest.spyOn(client as any, 'connectInternal')
      .mockImplementation(() => new Promise<void>((resolve) => {
        resolveConnect = () => {
          (client as any).browser = createMockBrowser();
          (client as any).connectionState = 'connected';
          resolve();
        };
      }));

    const explicit = client.connect({ autoLaunch: false });
    const implicit = client.connect(); // resolves to instance default = false

    resolveConnect!();
    await Promise.all([explicit, implicit]);

    expect(connectInternalSpy).toHaveBeenCalledTimes(1);
    stopHeartbeat(client);
  });
});

describe('CDPClient – puppeteer.connect timeout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const launcherMock = require('../../src/chrome/launcher');
    launcherMock.getChromeLauncher.mockReturnValue({ ensureChrome: mockEnsureChrome, invalidateInstance: jest.fn() });
    mockEnsureChrome.mockResolvedValue({
      wsEndpoint: 'ws://localhost:9222/devtools/browser/abc',
      httpEndpoint: 'http://127.0.0.1:9222',
    });
  });

  test('puppeteer.connect is wrapped with explicit timeout', async () => {
    const client = new CDPClient({ port: 9222 });

    // Simulate a hanging puppeteer.connect (never resolves)
    mockPuppeteerConnect.mockImplementation(
      () => new Promise(() => { /* intentionally never resolves */ })
    );

    const connectPromise = (client as any).connectInternal();

    await expect(connectPromise).rejects.toThrow(/puppeteer\.connect\(\) timed out/);
  }, 20000);

  test('timer is cleared on successful connect (no timer leak)', async () => {
    const client = new CDPClient({ port: 9222 });

    const mockBrowser = createMockBrowser();
    mockPuppeteerConnect.mockResolvedValue(mockBrowser);

    await (client as any).connectInternal();

    expect(mockPuppeteerConnect).toHaveBeenCalledTimes(1);
    expect((client as any).browser).toBe(mockBrowser);
  });

  test('puppeteer.connect receives correct options', async () => {
    const client = new CDPClient({ port: 9222 });

    const mockBrowser = createMockBrowser();
    mockPuppeteerConnect.mockResolvedValue(mockBrowser);

    await (client as any).connectInternal();

    expect(mockPuppeteerConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        browserWSEndpoint: 'ws://localhost:9222/devtools/browser/abc',
        defaultViewport: null,
        protocolTimeout: expect.any(Number),
      })
    );
  });
});

describe('CDPClient – forceReconnect invalidates pending connects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const launcherMock = require('../../src/chrome/launcher');
    launcherMock.getChromeLauncher.mockReturnValue({ ensureChrome: mockEnsureChrome, invalidateInstance: jest.fn() });
    mockEnsureChrome.mockResolvedValue({
      wsEndpoint: 'ws://localhost:9222/devtools/browser/abc',
      httpEndpoint: 'http://127.0.0.1:9222',
    });
  });

  test('forceReconnect sets pendingConnect to null', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();

    // Spy on connectInternal so we control the outcome
    jest.spyOn(client as any, 'connectInternal').mockImplementation(async () => {
      (client as any).browser = mockBrowser;
      (client as any).connectionState = 'connected';
    });

    // Simulate having a pending connect
    (client as any).pendingConnect = Promise.resolve();

    // forceReconnect should clear it
    await client.forceReconnect();

    expect((client as any).pendingConnect).toBeNull();
    stopHeartbeat(client);
  });

  test('forceReconnect replaces browser after clearing pending', async () => {
    const client = new CDPClient({ port: 9222 });
    const oldBrowser = createMockBrowser('ws://old');
    const newBrowser = createMockBrowser('ws://new');

    // Inject old browser
    (client as any).browser = oldBrowser;
    (client as any).connectionState = 'connected';

    // Spy on connectInternal — forceReconnect calls it internally
    jest.spyOn(client as any, 'connectInternal').mockImplementation(async () => {
      (client as any).browser = newBrowser;
      (client as any).connectionState = 'connected';
    });

    await client.forceReconnect();

    // Old browser should have been disconnected
    expect(oldBrowser.removeAllListeners).toHaveBeenCalledWith('disconnected');
    expect(oldBrowser.removeAllListeners).toHaveBeenCalledWith('targetdestroyed');
    expect(oldBrowser.disconnect).toHaveBeenCalled();

    // New browser should be active
    expect((client as any).browser).toBe(newBrowser);
    stopHeartbeat(client);
  });

  test('forceReconnect during pending connect does not corrupt state', async () => {
    const client = new CDPClient({ port: 9222 });

    // Start a slow connect — resolve callback does NOT set browser
    // (forceReconnect should have already replaced it)
    let resolveSlowConnect: (() => void) | null = null;
    const connectInternalSpy = jest.spyOn(client as any, 'connectInternal')
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveSlowConnect = resolve;
      }));

    const connectPromise = client.connect();

    // pendingConnect should be set
    expect((client as any).pendingConnect).not.toBeNull();

    // Now force reconnect (clears pendingConnect, starts fresh)
    const newBrowser = createMockBrowser('ws://new');
    connectInternalSpy.mockImplementationOnce(async () => {
      (client as any).browser = newBrowser;
      (client as any).connectionState = 'connected';
    });

    await client.forceReconnect();

    // pendingConnect should be cleared by the finally block of connect()
    // after forceReconnect completes and the old promise resolves
    expect((client as any).pendingConnect).toBeNull();

    // Resolve the old slow connect — it does not set browser anymore
    resolveSlowConnect!();
    await connectPromise;

    // The browser should be the one from forceReconnect
    expect((client as any).browser).toBe(newBrowser);
    stopHeartbeat(client);
  });

  test('stale connectInternal result cannot resurrect old browser after forceReconnect', async () => {
    const client = new CDPClient({ port: 9222 });
    const staleBrowser = createMockBrowser('ws://stale');
    const newBrowser = createMockBrowser('ws://new');

    let resolveStaleConnect: (() => void) | null = null;
    let resolveNewConnect: (() => void) | null = null;

    mockPuppeteerConnect
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveStaleConnect = () => resolve(staleBrowser);
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveNewConnect = () => resolve(newBrowser);
      }));

    const connectPromise = client.connect();
    await Promise.resolve();
    expect(mockPuppeteerConnect).toHaveBeenCalledTimes(1);

    const reconnectPromise = client.forceReconnect();
    await Promise.resolve();
    expect(mockPuppeteerConnect).toHaveBeenCalledTimes(2);

    resolveNewConnect!();
    await reconnectPromise;
    expect((client as any).browser).toBe(newBrowser);

    resolveStaleConnect!();
    await connectPromise;

    expect((client as any).browser).toBe(newBrowser);
    expect(client.isReconnecting()).toBe(false);
    expect(staleBrowser.disconnect).toHaveBeenCalled();
    stopHeartbeat(client);
  });

  test('stale disconnect reconnect result cannot overwrite newer forceReconnect browser', async () => {
    const client = new CDPClient({ port: 9222, maxReconnectAttempts: 1 });
    const oldBrowser = createMockBrowser('ws://old');
    const staleBrowser = createMockBrowser('ws://stale');
    const newBrowser = createMockBrowser('ws://new');

    let resolveStaleConnect: (() => void) | null = null;
    let resolveNewConnect: (() => void) | null = null;

    mockPuppeteerConnect
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveStaleConnect = () => resolve(staleBrowser);
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveNewConnect = () => resolve(newBrowser);
      }));

    (client as any).browser = oldBrowser;
    (client as any).connectionState = 'connected';

    const staleReconnectPromise = (client as any).handleDisconnect();
    await Promise.resolve();
    expect(mockPuppeteerConnect).toHaveBeenCalledTimes(1);

    const forceReconnectPromise = client.forceReconnect();
    await Promise.resolve();
    expect(mockPuppeteerConnect).toHaveBeenCalledTimes(2);

    resolveNewConnect!();
    await forceReconnectPromise;
    expect((client as any).browser).toBe(newBrowser);

    resolveStaleConnect!();
    await staleReconnectPromise;

    expect((client as any).browser).toBe(newBrowser);
    expect(client.isReconnecting()).toBe(false);
    expect(staleBrowser.disconnect).toHaveBeenCalled();
    stopHeartbeat(client);
  });

  test('stale disconnect reconnect abort clears reconnecting flags', async () => {
    const client = new CDPClient({ port: 9222, maxReconnectAttempts: 1 });
    const oldBrowser = createMockBrowser('ws://old');
    const staleBrowser = createMockBrowser('ws://stale');

    let resolveStaleConnect: (() => void) | null = null;
    mockPuppeteerConnect.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStaleConnect = () => resolve(staleBrowser);
    }));

    (client as any).browser = oldBrowser;
    (client as any).connectionState = 'connected';

    const staleReconnectPromise = (client as any).handleDisconnect();
    for (let i = 0; i < 5 && mockPuppeteerConnect.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(mockPuppeteerConnect).toHaveBeenCalledTimes(1);
    expect(client.isReconnecting()).toBe(true);
    expect((client as any).reconnectingAttempt).toBe(1);

    (client as any).reconnectNextRetryAt = Date.now() + 1000;
    (client as any).connectionGeneration += 1;

    resolveStaleConnect!();
    await staleReconnectPromise;

    expect((client as any).reconnecting).toBe(false);
    expect((client as any).connectionState).toBe('reconnecting');
    expect((client as any).reconnectingAttempt).toBe(0);
    expect((client as any).reconnectNextRetryAt).toBe(0);
    expect((client as any).browser).toBeNull();
    expect(staleBrowser.disconnect).toHaveBeenCalled();
    stopHeartbeat(client);
  });
});
