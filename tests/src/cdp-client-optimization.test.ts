/// <reference types="jest" />
/**
 * Tests for CDPClient P0/P1 optimizations:
 * - Cookie source cache (TTL-based)
 * - Cookie data cache (TTL-based)
 * - Forced GC (triggerGC)
 * - CDPClientFactory
 */

// ─── Mocks must come before any imports ───────────────────────────────────────

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Mock 'ws' WebSocket
const mockWsSend = jest.fn();
const mockWsClose = jest.fn();
const mockWsOn = jest.fn();

class MockWebSocket {
  send = mockWsSend;
  close = mockWsClose;
  on = mockWsOn;
}

jest.mock('ws', () => MockWebSocket);

// Mock puppeteer-core
jest.mock('puppeteer-core', () => ({
  default: {
    connect: jest.fn(),
  },
}));

// Mock launcher
jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: jest.fn().mockResolvedValue({ wsEndpoint: 'ws://localhost:9222' }),
  }),
}));

// Mock global config
jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { CDPClient, CDPClientFactory } from '../../src/cdp/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockPage(targetId = 'page-target-1') {
  const mockCdpSession = {
    send: jest.fn().mockResolvedValue(undefined),
    detach: jest.fn().mockResolvedValue(undefined),
  };
  return {
    target: jest.fn().mockReturnValue({ _targetId: targetId }),
    createCDPSession: jest.fn().mockResolvedValue(mockCdpSession),
    close: jest.fn().mockResolvedValue(undefined),
    setViewport: jest.fn().mockResolvedValue(undefined),
    _cdpSession: mockCdpSession,
  };
}

/**
 * Set up a CDPClient instance with a mocked browser already attached,
 * bypassing connect() so we can test cookie/GC methods in isolation.
 */
function createConnectedClient(): CDPClient {
  const client = new CDPClient({ port: 9222 });

  // Inject a fake browser via private field access
  const mockBrowserTarget = {
    createCDPSession: jest.fn(),
  };
  const mockBrowser = {
    isConnected: jest.fn().mockReturnValue(true),
    target: jest.fn().mockReturnValue(mockBrowserTarget),
    on: jest.fn(),
  };

  (client as any).browser = mockBrowser;
  (client as any).connectionState = 'connected';

  return client;
}

/**
 * Build a WS mock that responds to Network.getAllCookies with the given cookies.
 * The returned setup fn must be called before the code-under-test runs so that
 * `MockWebSocket.on` registers the right callbacks.
 */
function setupWsWithCookies(cookies: object[]): void {
  mockWsOn.mockImplementation((event: string, cb: (...args: any[]) => void) => {
    if (event === 'open') {
      // Trigger 'open' synchronously so send() is called
      setImmediate(() => cb());
    }
    if (event === 'message') {
      // Respond after send() is called
      setImmediate(() => {
        const response = JSON.stringify({
          id: 1,
          result: { cookies },
        });
        cb(Buffer.from(response));
      });
    }
  });
}

function setupWsWithError(): void {
  mockWsOn.mockImplementation((event: string, cb: (...args: any[]) => void) => {
    if (event === 'error') {
      setImmediate(() => cb(new Error('WS error')));
    }
  });
}

// ─── Cookie Source Cache ──────────────────────────────────────────────────────

describe('CDPClient – cookieSourceCache', () => {
  let client: CDPClient;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.clearAllMocks();
    client = createConnectedClient();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('cache miss: queries CDP when cache is empty', async () => {
    // Provide target list and cookies via CDP session (Target.getTargets + Target.attachToTarget + Network.getAllCookies)
    const mockSession = {
      send: jest.fn().mockImplementation((method: string, params?: any) => {
        if (method === 'Target.getTargets') {
          return Promise.resolve({
            targetInfos: [
              { targetId: 'tgt-1', type: 'page', url: 'https://example.com', browserContextId: 'default' },
            ],
          });
        }
        if (method === 'Target.attachToTarget') {
          return Promise.resolve({ sessionId: 'attached-session-1' });
        }
        if (method === 'Network.getAllCookies') {
          return Promise.resolve({
            cookies: [
              { name: 'session', value: 'abc', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true },
              { name: 'user', value: '123', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false },
            ],
          });
        }
        if (method === 'Target.detachFromTarget') {
          return Promise.resolve(undefined);
        }
        return Promise.resolve(undefined);
      }),
      detach: jest.fn().mockResolvedValue(undefined),
    };
    (client as any).browser.target().createCDPSession = jest.fn().mockResolvedValue(mockSession);

    const result = await client.findAuthenticatedPageTargetId();

    expect(result).toBe('tgt-1');
    // CDP session must have been used (Target.getTargets called)
    expect(mockSession.send).toHaveBeenCalledWith('Target.getTargets');
  });

  test('cache hit: returns cached targetId without re-querying WebSocket', async () => {
    // Manually prime the cache
    (client as any).cookieSourceCache.set('*', {
      targetId: 'cached-target-42',
      timestamp: Date.now(),
    });

    const result = await client.findAuthenticatedPageTargetId();

    expect(result).toBe('cached-target-42');
    // No fetch or WS calls should occur
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('cache expires after COOKIE_CACHE_TTL and re-queries', async () => {
    // Prime the cache with an old timestamp
    const expiredTimestamp = Date.now() - (CDPClient as any).COOKIE_CACHE_TTL - 1;
    (client as any).cookieSourceCache.set('*', {
      targetId: 'stale-target',
      timestamp: expiredTimestamp,
    });

    // Advance timers so Date.now() reflects the expiry
    jest.advanceTimersByTime(30001);

    // No candidates → null (but we verify WebSocket path was attempted)
    const mockSession = {
      send: jest.fn().mockResolvedValue({ targetInfos: [] }),
      detach: jest.fn().mockResolvedValue(undefined),
    };
    (client as any).browser.target().createCDPSession = jest.fn().mockResolvedValue(mockSession);

    const result = await client.findAuthenticatedPageTargetId();

    // Should have re-queried (cache miss after expiry) → no candidates → null
    expect(result).toBeNull();
    expect(mockSession.send).toHaveBeenCalledWith('Target.getTargets');
  });

  test('onTargetDestroyed clears matching cache entries', () => {
    (client as any).cookieSourceCache.set('example.com', { targetId: 'tgt-abc', timestamp: Date.now() });
    (client as any).cookieSourceCache.set('other.com', { targetId: 'tgt-xyz', timestamp: Date.now() });

    // Destroy tgt-abc
    (client as any).onTargetDestroyed('tgt-abc');

    expect((client as any).cookieSourceCache.has('example.com')).toBe(false);
    // Other entry must remain
    expect((client as any).cookieSourceCache.has('other.com')).toBe(true);
  });

  test('different domains get separate cache entries', async () => {
    (client as any).cookieSourceCache.set('example.com', { targetId: 'tgt-example', timestamp: Date.now() });
    (client as any).cookieSourceCache.set('other.com', { targetId: 'tgt-other', timestamp: Date.now() });

    const r1 = await client.findAuthenticatedPageTargetId('example.com');
    const r2 = await client.findAuthenticatedPageTargetId('other.com');

    expect(r1).toBe('tgt-example');
    expect(r2).toBe('tgt-other');
    // No WS/fetch calls – both served from cache
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── Cookie Data Cache ────────────────────────────────────────────────────────

describe('CDPClient – cookieDataCache', () => {
  let client: CDPClient;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.clearAllMocks();
    client = createConnectedClient();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('cache miss: fetches cookies via CDP session and stores in cache', async () => {
    const sampleCookies = [
      { name: 'session', value: 'abc', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true },
    ];

    // Set up browser CDP session mock for Target.getTargets, Target.attachToTarget, Network.getAllCookies
    const mockBrowserSession = {
      send: jest.fn().mockImplementation((method: string, params?: any) => {
        if (method === 'Target.getTargets') {
          return Promise.resolve({
            targetInfos: [
              { targetId: 'src-target', type: 'page', url: 'https://example.com' },
            ],
          });
        }
        if (method === 'Target.attachToTarget') {
          return Promise.resolve({ sessionId: 'attached-session-1' });
        }
        if (method === 'Network.getAllCookies') {
          return Promise.resolve({ cookies: sampleCookies });
        }
        if (method === 'Target.detachFromTarget') {
          return Promise.resolve(undefined);
        }
        return Promise.resolve(undefined);
      }),
      detach: jest.fn().mockResolvedValue(undefined),
    };
    (client as any).browser.target().createCDPSession = jest.fn().mockResolvedValue(mockBrowserSession);

    const mockPage = createMockPage('dest-target');
    const count = await client.copyCookiesViaCDP('src-target', mockPage as any);

    expect(count).toBe(1);
    // Cookie must be stored in cache now
    const cached = (client as any).cookieDataCache.get('src-target');
    expect(cached).toBeDefined();
    expect(cached.cookies).toHaveLength(1);
    // destPage.createCDPSession must have been called to set cookies
    expect(mockPage.createCDPSession).toHaveBeenCalled();
    expect(mockPage._cdpSession.send).toHaveBeenCalledWith('Network.setCookies', expect.objectContaining({ cookies: expect.any(Array) }));
  });

  test('cache hit: skips WebSocket and sets cookies directly', async () => {
    const cachedCookies = [
      { name: 'token', value: 'xyz', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: true },
      { name: 'user', value: '42', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false },
    ];

    // Prime the cache
    (client as any).cookieDataCache.set('src-target', {
      cookies: cachedCookies,
      timestamp: Date.now(),
    });

    const mockPage = createMockPage('dest-target');
    const count = await client.copyCookiesViaCDP('src-target', mockPage as any);

    expect(count).toBe(2);
    // fetch (for /json/list) must NOT be called
    expect(mockFetch).not.toHaveBeenCalled();
    // But CDP session must be used to set cookies
    expect(mockPage.createCDPSession).toHaveBeenCalled();
    expect(mockPage._cdpSession.send).toHaveBeenCalledWith('Network.setCookies', expect.objectContaining({ cookies: expect.any(Array) }));
  });

  test('cache hit expires after COOKIE_CACHE_TTL', async () => {
    const expiredTimestamp = Date.now() - (CDPClient as any).COOKIE_CACHE_TTL - 1;
    (client as any).cookieDataCache.set('src-target', {
      cookies: [{ name: 'old', value: 'stale', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false }],
      timestamp: expiredTimestamp,
    });

    jest.advanceTimersByTime(30001);

    // Mock browser CDP session – target not found → returns 0
    const mockBrowserSession = {
      send: jest.fn().mockImplementation((method: string) => {
        if (method === 'Target.getTargets') {
          return Promise.resolve({ targetInfos: [] });
        }
        return Promise.resolve(undefined);
      }),
      detach: jest.fn().mockResolvedValue(undefined),
    };
    (client as any).browser.target().createCDPSession = jest.fn().mockResolvedValue(mockBrowserSession);

    const mockPage = createMockPage('dest-target');
    const count = await client.copyCookiesViaCDP('src-target', mockPage as any);

    // Cache miss path triggered; target not found → 0
    expect(count).toBe(0);
    expect(mockBrowserSession.send).toHaveBeenCalledWith('Target.getTargets');
  });

  test('onTargetDestroyed clears cookie data cache for that target', () => {
    (client as any).cookieDataCache.set('tgt-abc', {
      cookies: [{ name: 'a', value: '1', domain: 'x.com', path: '/', expires: -1, httpOnly: false, secure: false }],
      timestamp: Date.now(),
    });
    (client as any).cookieDataCache.set('tgt-xyz', {
      cookies: [],
      timestamp: Date.now(),
    });

    (client as any).onTargetDestroyed('tgt-abc');

    expect((client as any).cookieDataCache.has('tgt-abc')).toBe(false);
    expect((client as any).cookieDataCache.has('tgt-xyz')).toBe(true);
  });
});

// ─── triggerGC ────────────────────────────────────────────────────────────────

describe('CDPClient – triggerGC', () => {
  let client: CDPClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = createConnectedClient();
  });

  test('sends HeapProfiler.collectGarbage via CDP session', async () => {
    const mockPage = createMockPage('gc-target');
    // Inject session into the sessions map so getCDPSession returns it directly
    (client as any).sessions.set('gc-target', mockPage._cdpSession);

    await client.triggerGC(mockPage as any);

    expect(mockPage._cdpSession.send).toHaveBeenCalledWith('HeapProfiler.collectGarbage');
  });

  test('silently swallows errors (best-effort)', async () => {
    const mockPage = createMockPage('gc-target');
    const failingSession = {
      send: jest.fn().mockRejectedValue(new Error('GC failed')),
      detach: jest.fn().mockResolvedValue(undefined),
    };
    (client as any).sessions.set('gc-target', failingSession);

    // Should not throw
    await expect(client.triggerGC(mockPage as any)).resolves.toBeUndefined();
  });
});

// ─── closePage calls triggerGC before page.close() ───────────────────────────

describe('CDPClient – closePage', () => {
  let client: CDPClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = createConnectedClient();
  });

  test('calls triggerGC before closing the page', async () => {
    const targetId = 'close-target';
    const mockPage = createMockPage(targetId);
    const callOrder: string[] = [];

    mockPage._cdpSession.send.mockImplementation(async (method: string) => {
      callOrder.push(`send:${method}`);
    });
    mockPage.close.mockImplementation(async () => {
      callOrder.push('close');
    });

    // Inject the session and make getPageByTargetId return the page
    (client as any).sessions.set(targetId, mockPage._cdpSession);
    const origGetPage = client.getPageByTargetId.bind(client);
    jest.spyOn(client, 'getPageByTargetId').mockResolvedValue(mockPage as any);

    await client.closePage(targetId);

    const gcIndex = callOrder.indexOf('send:HeapProfiler.collectGarbage');
    const closeIndex = callOrder.indexOf('close');

    expect(gcIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(gcIndex).toBeLessThan(closeIndex);
  });

  test('closes the page even when getPageByTargetId finds no page', async () => {
    jest.spyOn(client, 'getPageByTargetId').mockResolvedValue(null);

    // Should resolve without error
    await expect(client.closePage('nonexistent-target')).resolves.toBeUndefined();
  });
});

// ─── CDPClientFactory ─────────────────────────────────────────────────────────

describe('CDPClientFactory', () => {
  let factory: CDPClientFactory;

  beforeEach(() => {
    jest.clearAllMocks();
    factory = new CDPClientFactory();
  });

  test('getOrCreate creates a new client for a new port', () => {
    const client = factory.getOrCreate(9222);

    expect(client).toBeInstanceOf(CDPClient);
    expect(client.getPort()).toBe(9222);
  });

  test('getOrCreate returns the same client for the same port', () => {
    const client1 = factory.getOrCreate(9222);
    const client2 = factory.getOrCreate(9222);

    expect(client1).toBe(client2);
  });

  test('getOrCreate creates different clients for different ports', () => {
    const client1 = factory.getOrCreate(9222);
    const client2 = factory.getOrCreate(9223);

    expect(client1).not.toBe(client2);
    expect(client1.getPort()).toBe(9222);
    expect(client2.getPort()).toBe(9223);
  });

  test('get returns undefined for unknown port', () => {
    expect(factory.get(9999)).toBeUndefined();
  });

  test('get returns the client for a known port', () => {
    const created = factory.getOrCreate(9222);
    const fetched = factory.get(9222);

    expect(fetched).toBe(created);
  });

  test('getAll returns all managed clients', () => {
    const c1 = factory.getOrCreate(9222);
    const c2 = factory.getOrCreate(9223);
    const c3 = factory.getOrCreate(9224);

    const all = factory.getAll();

    expect(all).toHaveLength(3);
    expect(all).toContain(c1);
    expect(all).toContain(c2);
    expect(all).toContain(c3);
  });

  test('getAll returns empty array when no clients exist', () => {
    expect(factory.getAll()).toHaveLength(0);
  });

  test('disconnectAll disconnects all clients and clears the map', async () => {
    const c1 = factory.getOrCreate(9222);
    const c2 = factory.getOrCreate(9223);

    // Spy on disconnect – we do NOT want real browser connections
    const disconnectSpy1 = jest.spyOn(c1, 'disconnect').mockResolvedValue(undefined);
    const disconnectSpy2 = jest.spyOn(c2, 'disconnect').mockResolvedValue(undefined);

    await factory.disconnectAll();

    expect(disconnectSpy1).toHaveBeenCalledTimes(1);
    expect(disconnectSpy2).toHaveBeenCalledTimes(1);
    // Map must be cleared
    expect(factory.getAll()).toHaveLength(0);
    expect(factory.get(9222)).toBeUndefined();
    expect(factory.get(9223)).toBeUndefined();
  });

  test('disconnectAll resolves even when a client disconnect throws', async () => {
    const c1 = factory.getOrCreate(9222);
    jest.spyOn(c1, 'disconnect').mockRejectedValue(new Error('disconnect failed'));

    // Should not throw
    await expect(factory.disconnectAll()).resolves.toBeUndefined();
    expect(factory.getAll()).toHaveLength(0);
  });
});
