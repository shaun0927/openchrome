/// <reference types="jest" />
/**
 * Tests for CDPClient active connection probing and stale state cleanup.
 *
 * These fixes prevent navigate hangs caused by:
 * 1. Dead WebSocket connections undetected by browser.isConnected() (half-open TCP)
 * 2. Stale targetIdIndex entries surviving forceReconnect() (orphaned page refs)
 * 3. Expensive ensureChrome() calls on every connect() verification (2-7s overhead)
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockBrowser(wsEndpoint = 'ws://localhost:9222/devtools/browser/abc') {
  return {
    isConnected: jest.fn().mockReturnValue(true),
    wsEndpoint: jest.fn().mockReturnValue(wsEndpoint),
    version: jest.fn().mockResolvedValue('Chrome/120.0.0.0'),
    target: jest.fn().mockReturnValue({ createCDPSession: jest.fn() }),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    disconnect: jest.fn().mockResolvedValue(undefined),
    targets: jest.fn().mockReturnValue([]),
    pages: jest.fn().mockResolvedValue([]),
  };
}

function createMockPage(closed = false) {
  return {
    isClosed: jest.fn().mockReturnValue(closed),
    url: jest.fn().mockReturnValue('https://example.com'),
    target: jest.fn().mockReturnValue({
      _targetId: 'target-123',
    }),
    close: jest.fn().mockResolvedValue(undefined),
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

// ─── Tests: Active heartbeat probe ──────────────────────────────────────────

describe('CDPClient – active heartbeat probe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const launcherMock = require('../../src/chrome/launcher');
    launcherMock.getChromeLauncher.mockReturnValue({ ensureChrome: mockEnsureChrome });
    mockEnsureChrome.mockResolvedValue({
      wsEndpoint: 'ws://localhost:9222/devtools/browser/abc',
      httpEndpoint: 'http://127.0.0.1:9222',
    });
  });

  test('heartbeat sends active CDP probe via browser.version()', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();
    (client as any).browser = mockBrowser;
    (client as any).connectionState = 'connected';

    const result = await (client as any).checkConnection();

    expect(result).toBe(true);
    expect(mockBrowser.version).toHaveBeenCalledTimes(1);
    stopHeartbeat(client);
  });

  test('heartbeat updates lastVerifiedAt on success', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();
    (client as any).browser = mockBrowser;
    (client as any).connectionState = 'connected';
    (client as any).lastVerifiedAt = 0;

    await (client as any).checkConnection();

    expect((client as any).lastVerifiedAt).toBeGreaterThan(0);
    stopHeartbeat(client);
  });

  test('heartbeat detects dead connection when version() hangs', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();
    // Simulate dead WebSocket: version() never resolves
    mockBrowser.version.mockImplementation(() => new Promise(() => {}));
    (client as any).browser = mockBrowser;
    (client as any).connectionState = 'connected';

    // Mock handleDisconnect to prevent actual reconnection attempts
    const handleDisconnectSpy = jest.spyOn(client as any, 'handleDisconnect')
      .mockResolvedValue(undefined);

    const result = await (client as any).checkConnection();

    expect(result).toBe(false);
    expect(handleDisconnectSpy).toHaveBeenCalled();
    stopHeartbeat(client);
  });

  test('heartbeat detects dead connection when version() rejects', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();
    mockBrowser.version.mockRejectedValue(new Error('WebSocket is not open'));
    (client as any).browser = mockBrowser;
    (client as any).connectionState = 'connected';

    const handleDisconnectSpy = jest.spyOn(client as any, 'handleDisconnect')
      .mockResolvedValue(undefined);

    const result = await (client as any).checkConnection();

    expect(result).toBe(false);
    expect(handleDisconnectSpy).toHaveBeenCalled();
    stopHeartbeat(client);
  });

  test('heartbeat still checks isConnected() flag first', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();
    mockBrowser.isConnected.mockReturnValue(false);
    (client as any).browser = mockBrowser;

    const handleDisconnectSpy = jest.spyOn(client as any, 'handleDisconnect')
      .mockResolvedValue(undefined);

    const result = await (client as any).checkConnection();

    expect(result).toBe(false);
    expect(handleDisconnectSpy).toHaveBeenCalled();
    // version() should NOT be called if isConnected() is false
    expect(mockBrowser.version).not.toHaveBeenCalled();
    stopHeartbeat(client);
  });
});

// ─── Tests: connect() active probe (replaces ensureChrome) ──────────────────

describe('CDPClient – connect() active probe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const launcherMock = require('../../src/chrome/launcher');
    launcherMock.getChromeLauncher.mockReturnValue({ ensureChrome: mockEnsureChrome });
    mockEnsureChrome.mockResolvedValue({
      wsEndpoint: 'ws://localhost:9222/devtools/browser/abc',
      httpEndpoint: 'http://127.0.0.1:9222',
    });
  });

  test('connect() skips probe when recently verified', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();
    (client as any).browser = mockBrowser;
    (client as any).connectionState = 'connected';
    (client as any).lastVerifiedAt = Date.now(); // just verified

    await client.connect();

    // Should return immediately without probing
    expect(mockBrowser.version).not.toHaveBeenCalled();
    expect(mockEnsureChrome).not.toHaveBeenCalled();
    stopHeartbeat(client);
  });

  test('connect() probes when lastVerifiedAt is stale', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();
    (client as any).browser = mockBrowser;
    (client as any).connectionState = 'connected';
    (client as any).lastVerifiedAt = Date.now() - 20000; // 20s ago (stale)

    await client.connect();

    expect(mockBrowser.version).toHaveBeenCalledTimes(1);
    // ensureChrome should NOT be called (replaced by active probe)
    expect(mockEnsureChrome).not.toHaveBeenCalled();
    stopHeartbeat(client);
  });

  test('connect() updates lastVerifiedAt after successful probe', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();
    (client as any).browser = mockBrowser;
    (client as any).connectionState = 'connected';
    (client as any).lastVerifiedAt = 0;

    const before = Date.now();
    await client.connect();
    const after = Date.now();

    expect((client as any).lastVerifiedAt).toBeGreaterThanOrEqual(before);
    expect((client as any).lastVerifiedAt).toBeLessThanOrEqual(after);
    stopHeartbeat(client);
  });

  test('connect() triggers forceReconnect when probe fails', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();
    mockBrowser.version.mockRejectedValue(new Error('dead connection'));
    (client as any).browser = mockBrowser;
    (client as any).connectionState = 'connected';
    (client as any).lastVerifiedAt = 0;

    const forceReconnectSpy = jest.spyOn(client, 'forceReconnect')
      .mockResolvedValue(undefined);

    await client.connect();

    expect(forceReconnectSpy).toHaveBeenCalledTimes(1);
    stopHeartbeat(client);
  });

  test('connect() triggers forceReconnect when probe times out', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();
    // Simulate hung connection: version() never resolves
    mockBrowser.version.mockImplementation(() => new Promise(() => {}));
    (client as any).browser = mockBrowser;
    (client as any).connectionState = 'connected';
    (client as any).lastVerifiedAt = 0;

    const forceReconnectSpy = jest.spyOn(client, 'forceReconnect')
      .mockResolvedValue(undefined);

    await client.connect();

    expect(forceReconnectSpy).toHaveBeenCalledTimes(1);
    stopHeartbeat(client);
  }, 10000);

  test('connect() no longer calls ensureChrome() for URL verification', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();
    (client as any).browser = mockBrowser;
    (client as any).connectionState = 'connected';
    (client as any).lastVerifiedAt = 0;

    await client.connect();

    // ensureChrome was previously called for WS URL verification.
    // Now replaced by lightweight browser.version() probe.
    expect(mockEnsureChrome).not.toHaveBeenCalled();
    stopHeartbeat(client);
  });
});

// ─── Tests: forceReconnect stale state cleanup ──────────────────────────────

describe('CDPClient – forceReconnect clears stale state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const launcherMock = require('../../src/chrome/launcher');
    launcherMock.getChromeLauncher.mockReturnValue({ ensureChrome: mockEnsureChrome });
    mockEnsureChrome.mockResolvedValue({
      wsEndpoint: 'ws://localhost:9222/devtools/browser/abc',
      httpEndpoint: 'http://127.0.0.1:9222',
    });
  });

  test('forceReconnect clears targetIdIndex', async () => {
    const client = new CDPClient({ port: 9222 });
    const oldBrowser = createMockBrowser();
    (client as any).browser = oldBrowser;

    // Populate targetIdIndex with stale entries
    const stalePage = createMockPage();
    (client as any).targetIdIndex.set('stale-target-1', stalePage);
    (client as any).targetIdIndex.set('stale-target-2', stalePage);
    expect((client as any).targetIdIndex.size).toBe(2);

    const newBrowser = createMockBrowser('ws://new');
    jest.spyOn(client as any, 'connectInternal').mockImplementation(async () => {
      (client as any).browser = newBrowser;
      (client as any).connectionState = 'connected';
    });

    await client.forceReconnect();

    expect((client as any).targetIdIndex.size).toBe(0);
    stopHeartbeat(client);
  });

  test('forceReconnect clears inFlightCookieScans', async () => {
    const client = new CDPClient({ port: 9222 });
    const oldBrowser = createMockBrowser();
    (client as any).browser = oldBrowser;

    // Populate inFlightCookieScans with stale promises
    (client as any).inFlightCookieScans.set('example.com', Promise.resolve(null));
    expect((client as any).inFlightCookieScans.size).toBe(1);

    const newBrowser = createMockBrowser('ws://new');
    jest.spyOn(client as any, 'connectInternal').mockImplementation(async () => {
      (client as any).browser = newBrowser;
      (client as any).connectionState = 'connected';
    });

    await client.forceReconnect();

    expect((client as any).inFlightCookieScans.size).toBe(0);
    stopHeartbeat(client);
  });

  test('forceReconnect resets lastVerifiedAt then sets it after reconnect', async () => {
    const client = new CDPClient({ port: 9222 });
    const oldBrowser = createMockBrowser();
    (client as any).browser = oldBrowser;
    (client as any).lastVerifiedAt = 999999;

    let verifiedDuringConnect = -1;
    jest.spyOn(client as any, 'connectInternal').mockImplementation(async () => {
      verifiedDuringConnect = (client as any).lastVerifiedAt;
      (client as any).browser = createMockBrowser('ws://new');
      (client as any).connectionState = 'connected';
    });

    await client.forceReconnect();

    // Should have been reset to 0 before connectInternal
    expect(verifiedDuringConnect).toBe(0);
    // Should be set after successful reconnect
    expect((client as any).lastVerifiedAt).toBeGreaterThan(0);
    stopHeartbeat(client);
  });

  test('forceReconnect clears sessions (existing behavior preserved)', async () => {
    const client = new CDPClient({ port: 9222 });
    const oldBrowser = createMockBrowser();
    (client as any).browser = oldBrowser;
    (client as any).sessions.set('sess-1', {});

    jest.spyOn(client as any, 'connectInternal').mockImplementation(async () => {
      (client as any).browser = createMockBrowser('ws://new');
      (client as any).connectionState = 'connected';
    });

    await client.forceReconnect();

    expect((client as any).sessions.size).toBe(0);
    stopHeartbeat(client);
  });
});

// ─── Tests: handleDisconnect also clears lastVerifiedAt ─────────────────────

describe('CDPClient – handleDisconnect resets lastVerifiedAt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const launcherMock = require('../../src/chrome/launcher');
    launcherMock.getChromeLauncher.mockReturnValue({ ensureChrome: mockEnsureChrome });
    mockEnsureChrome.mockResolvedValue({
      wsEndpoint: 'ws://localhost:9222/devtools/browser/abc',
      httpEndpoint: 'http://127.0.0.1:9222',
    });
  });

  test('handleDisconnect resets lastVerifiedAt to 0', async () => {
    const client = new CDPClient({ port: 9222 });
    const mockBrowser = createMockBrowser();
    (client as any).browser = mockBrowser;
    (client as any).connectionState = 'connected';
    (client as any).lastVerifiedAt = 999999;

    // Mock connectInternal to prevent actual reconnection
    jest.spyOn(client as any, 'connectInternal').mockRejectedValue(
      new Error('no chrome')
    );

    await (client as any).handleDisconnect();

    expect((client as any).lastVerifiedAt).toBe(0);
    stopHeartbeat(client);
  });
});
