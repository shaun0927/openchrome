/// <reference types="jest" />

// Mock global fetch before imports
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

jest.mock('ws', () => class MockWebSocket {});

jest.mock('puppeteer-core', () => ({
  default: {
    connect: jest.fn(),
  },
}));

jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: jest.fn().mockResolvedValue({ wsEndpoint: 'ws://localhost:9222' }),
  }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false, skipCookieBridge: false }),
}));

import { CDPClient } from '../../src/cdp/client';

function createConnectedClient(): CDPClient {
  const client = new CDPClient({ port: 9222 });
  const mockBrowserTarget = { createCDPSession: jest.fn() };
  const mockBrowser = {
    isConnected: jest.fn().mockReturnValue(true),
    target: jest.fn().mockReturnValue(mockBrowserTarget),
    on: jest.fn(),
    pages: jest.fn().mockResolvedValue([]),
    targets: jest.fn().mockReturnValue([]),
    newPage: jest.fn(),
  };
  (client as any).browser = mockBrowser;
  (client as any).connectionState = 'connected';
  return client;
}

describe('CDPClient cookie scan explicit results', () => {
  let client: CDPClient;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.clearAllMocks();
    client = createConnectedClient();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns a partial result when overall timeout expires before all candidates are scanned', async () => {
    const candidates = ['a', 'b', 'c', 'd'].map((id) => ({
      targetId: id,
      type: 'page',
      url: `https://${id}.example.com`,
    }));

    const mockSession = {
      send: jest.fn((method: string, params?: any) => {
        if (method === 'Target.getTargets') {
          return Promise.resolve({ targetInfos: candidates });
        }
        if (method === 'Target.attachToTarget') {
          return Promise.resolve({ sessionId: `session-${params.targetId}` });
        }
        if (method === 'Network.getAllCookies') {
          return new Promise(() => {});
        }
        if (method === 'Target.detachFromTarget') {
          return Promise.resolve(undefined);
        }
        return Promise.resolve(undefined);
      }),
      detach: jest.fn().mockResolvedValue(undefined),
    };
    (client as any).browser.target().createCDPSession = jest.fn().mockResolvedValue(mockSession);

    const promise = client.findAuthenticatedPageTarget('example.com');
    await jest.advanceTimersByTimeAsync(7_000);
    const result = await promise;

    expect(result.status).toBe('partial');
    expect(result.targetId).toBeNull();
    expect(result.scanned).toBe(3);
    expect(result.total).toBe(4);
    expect(result.warning).toContain('timed out');
  });

  test('prioritizes recently active targets when domain scores tie', async () => {
    const now = Date.now();
    (client as any).targetActivityAt.set('recent-target', now);
    (client as any).targetActivityAt.set('stale-target', now - 10_000);

    const attachOrder: string[] = [];
    const mockSession = {
      send: jest.fn((method: string, params?: any, extra?: any) => {
        if (method === 'Target.getTargets') {
          return Promise.resolve({
            targetInfos: [
              { targetId: 'stale-target', type: 'page', url: 'https://app.example.com/dashboard' },
              { targetId: 'recent-target', type: 'page', url: 'https://app.example.com/settings' },
            ],
          });
        }
        if (method === 'Target.attachToTarget') {
          attachOrder.push(params.targetId);
          return Promise.resolve({ sessionId: `session-${params.targetId}` });
        }
        if (method === 'Network.getAllCookies') {
          return Promise.resolve({
            cookies: extra?.sessionId === 'session-recent-target'
              ? [{ name: 'session', value: 'abc', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true }]
              : [],
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

    const result = await client.findAuthenticatedPageTarget('example.com');

    expect(attachOrder[0]).toBe('recent-target');
    expect(result.targetId).toBe('recent-target');
    expect(result.status).toBe('partial');
  });
});
