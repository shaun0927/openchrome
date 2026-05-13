/// <reference types="jest" />

const pages = new Map<string, { isClosed: jest.Mock<boolean, []>; url: jest.Mock<string, []> }>();

const mockCdpClientInstance = {
  connect: jest.fn().mockResolvedValue(undefined),
  isConnected: jest.fn().mockReturnValue(true),
  addConnectionListener: jest.fn(),
  addTargetDestroyedListener: jest.fn(),
  createBrowserContext: jest.fn(),
  closeBrowserContext: jest.fn().mockResolvedValue(undefined),
  closePage: jest.fn().mockResolvedValue(undefined),
  getPageByTargetId: jest.fn(async (targetId: string) => pages.get(targetId) ?? null),
  getBrowser: jest.fn().mockReturnValue({ targets: jest.fn().mockReturnValue([]) }),
};

jest.mock('../src/cdp/client', () => ({
  CDPClient: jest.fn().mockImplementation(() => mockCdpClientInstance),
  getCDPClient: jest.fn().mockReturnValue(mockCdpClientInstance),
  getCDPClientFactory: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnValue(mockCdpClientInstance),
    getOrCreate: jest.fn().mockReturnValue(mockCdpClientInstance),
    getAll: jest.fn().mockReturnValue([mockCdpClientInstance]),
    disconnectAll: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../src/cdp/connection-pool', () => ({
  CDPConnectionPool: jest.fn(),
  getCDPConnectionPool: jest.fn().mockReturnValue({}),
}));

jest.mock('../src/utils/request-queue', () => ({
  RequestQueueManager: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn((_, fn) => fn()),
    deleteQueue: jest.fn(),
  })),
}));

jest.mock('../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(() => ({
    clearSessionRefs: jest.fn(),
    clearTargetRefs: jest.fn(),
  })),
}));

import { SessionManager } from '../src/session-manager';

function page(url: string) {
  return {
    isClosed: jest.fn(() => false),
    url: jest.fn(() => url),
  };
}

describe('SessionManager ownership and stale-target contracts (#687 Wave 3 prereq)', () => {
  let sm: SessionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    pages.clear();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: true,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not recover or reassign a target already owned by another session', async () => {
    await sm.createSession({ id: 'owner-session' });
    await sm.createSession({ id: 'other-session' });
    await sm.registerExternalTarget('owner-target', 'owner-session', 'default');
    await sm.registerExternalTarget('other-target', 'other-session', 'default');
    pages.set('owner-target', page('https://example.test/owned'));

    await expect(sm.getPage('other-session', 'owner-target')).rejects.toThrow(/not found in session/);

    expect(sm.getTargetOwner('owner-target')).toEqual({ sessionId: 'owner-session', workerId: 'default' });
    expect(sm.getSessionTargetIds('other-session')).toEqual(['other-target']);
  });

  it('recovers an untracked non-internal target only into an already-active worker', async () => {
    await sm.createSession({ id: 'active-session' });
    await sm.registerExternalTarget('known-target', 'active-session', 'default');
    pages.set('oauth-replacement-target', page('https://idp.example.test/callback'));

    const recovered = await sm.getPage('active-session', 'oauth-replacement-target');

    expect(recovered).toBe(pages.get('oauth-replacement-target'));
    expect(sm.getTargetOwner('oauth-replacement-target')).toEqual({ sessionId: 'active-session', workerId: 'default' });
    expect(sm.getSessionTargetIds('active-session')).toEqual(['known-target', 'oauth-replacement-target']);
  });

  it('rejects stale recovery into an empty session and leaves ownership unset', async () => {
    await sm.createSession({ id: 'empty-session' });
    pages.set('stray-target', page('https://example.test/stray'));

    await expect(sm.getPage('empty-session', 'stray-target')).rejects.toThrow(/not found in session/);

    expect(sm.getTargetOwner('stray-target')).toBeUndefined();
    expect(sm.getSessionTargetIds('empty-session')).toEqual([]);
  });

  it('rejects internal Chrome pages during stale recovery', async () => {
    await sm.createSession({ id: 'active-session' });
    await sm.registerExternalTarget('known-target', 'active-session', 'default');
    pages.set('chrome-target', page('chrome://settings'));

    await expect(sm.getPage('active-session', 'chrome-target')).rejects.toThrow(/not found in session/);

    expect(sm.getTargetOwner('chrome-target')).toBeUndefined();
    expect(sm.getSessionTargetIds('active-session')).toEqual(['known-target']);
  });
});
