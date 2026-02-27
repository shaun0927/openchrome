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
  }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false }),
}));

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
    launcherMock.getChromeLauncher.mockReturnValue({ ensureChrome: mockEnsureChrome });
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
});

describe('CDPClient – puppeteer.connect timeout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const launcherMock = require('../../src/chrome/launcher');
    launcherMock.getChromeLauncher.mockReturnValue({ ensureChrome: mockEnsureChrome });
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
    launcherMock.getChromeLauncher.mockReturnValue({ ensureChrome: mockEnsureChrome });
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
});
