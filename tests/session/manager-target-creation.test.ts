const targetDestroyedListeners: Array<(targetId: string) => void> = [];

const mockCdpClientInstance = {
  connect: jest.fn().mockResolvedValue(undefined),
  isConnected: jest.fn().mockReturnValue(true),
  addConnectionListener: jest.fn(),
  addTargetDestroyedListener: jest.fn((listener: (targetId: string) => void) => {
    targetDestroyedListeners.push(listener);
  }),
  createBrowserContext: jest.fn(),
  closeBrowserContext: jest.fn().mockResolvedValue(undefined),
  getBrowser: jest.fn().mockReturnValue({ targets: jest.fn().mockReturnValue([]) }),
  getPageByTargetId: jest.fn().mockResolvedValue(null),
  closePage: jest.fn().mockResolvedValue(undefined),
  send: jest.fn(),
};

jest.mock('../../src/cdp/client', () => ({
  CDPClient: jest.fn().mockImplementation(() => mockCdpClientInstance),
  getCDPClient: jest.fn().mockReturnValue(mockCdpClientInstance),
  getCDPClientFactory: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnValue(mockCdpClientInstance),
    getOrCreate: jest.fn().mockReturnValue(mockCdpClientInstance),
    getAll: jest.fn().mockReturnValue([mockCdpClientInstance]),
    disconnectAll: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../../src/cdp/connection-pool', () => ({
  CDPConnectionPool: jest.fn(),
  getCDPConnectionPool: jest.fn().mockReturnValue({}),
}));

jest.mock('../../src/session/request-queue', () => ({
  RequestQueueManager: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn((_: string, fn: () => Promise<unknown>) => fn()),
    deleteQueue: jest.fn(),
  })),
}));

jest.mock('../../src/core/perception/ref-id-manager', () => ({
  getRefIdManager: jest.fn(() => ({
    clearSessionRefs: jest.fn(),
    clearTargetRefs: jest.fn(),
  })),
}));

import { SessionManager } from '../../src/session-manager';

function createManager(maxTargetsPerWorker = 5): SessionManager {
  return new SessionManager(undefined, {
    autoCleanup: false,
    useConnectionPool: false,
    useDefaultContext: true,
    maxTargetsPerWorker,
  });
}

describe('SessionManager target creation ledger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    targetDestroyedListeners.length = 0;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('promotes a provisional popup and retains it as closed evidence', async () => {
    const manager = createManager();
    await manager.createSession({ id: 's1' });
    await manager.registerExternalTarget('parent', 's1', 'default');
    const cursor = manager.getTargetCreationCursor();

    await expect(manager.registerPopupTarget('child', 'parent', { state: 'provisional' })).resolves.toBe(true);
    expect(manager.getOpenedTabsAfter({ afterSequence: cursor, sessionId: 's1', workerId: 'default', openerTargetId: 'parent' })).toMatchObject({
      total: 0,
      pendingCount: 1,
    });

    manager.markPopupTargetReady('child', { url: 'https://example.com/next#secret', title: 'Next\nPage' });
    manager.onTargetClosed('child');

    expect(manager.getOpenedTabsAfter({ afterSequence: cursor, sessionId: 's1', workerId: 'default', openerTargetId: 'parent' }).tabs).toEqual([{
      tabId: 'child',
      workerId: 'default',
      url: 'https://example.com/next',
      title: 'Next Page',
      status: 'closed',
    }]);
  });

  test('blocked children never become success evidence', async () => {
    const manager = createManager();
    await manager.createSession({ id: 's1' });
    await manager.registerExternalTarget('parent', 's1', 'default');
    const cursor = manager.getTargetCreationCursor();

    await expect(manager.registerPopupTarget('blocked', 'parent', { state: 'blocked' })).resolves.toBe(false);
    manager.onTargetClosed('blocked');

    expect(manager.getOpenedTabsAfter({ afterSequence: cursor, sessionId: 's1', workerId: 'default', openerTargetId: 'parent' }).total).toBe(0);
  });

  test('keeps a ready child pending until worker ownership commits', async () => {
    const manager = createManager();
    await manager.createSession({ id: 's1' });
    await manager.registerExternalTarget('parent', 's1', 'default');
    const cursor = manager.getTargetCreationCursor();
    const originalRegister = manager.registerExternalTarget.bind(manager);
    let release!: () => void;
    jest.spyOn(manager, 'registerExternalTarget').mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return originalRegister(...args);
    });

    const registration = manager.registerPopupTarget('child', 'parent', {
      state: 'ready',
      url: 'https://example.com/child',
    });
    expect(manager.getOpenedTabsAfter({ afterSequence: cursor, sessionId: 's1', workerId: 'default', openerTargetId: 'parent' })).toMatchObject({
      total: 0,
      pendingCount: 1,
    });

    release();
    await expect(registration).resolves.toBe(true);
    expect(manager.getOpenedTabsAfter({ afterSequence: cursor, sessionId: 's1', workerId: 'default', openerTargetId: 'parent' }).total).toBe(1);
  });

  test('cleans ownership when a popup closes before registration commits', async () => {
    const manager = createManager(2);
    await manager.createSession({ id: 's1' });
    await manager.registerExternalTarget('parent', 's1', 'default');
    await manager.registerExternalTarget('oldest-other', 's1', 'default');
    const closeTargetSpy = jest.spyOn(manager, 'closeTarget');
    const originalRegister = manager.registerExternalTarget.bind(manager);
    jest.spyOn(manager, 'registerExternalTarget').mockImplementationOnce(async (...args) => {
      manager.onTargetClosed('child');
      return originalRegister(...args);
    });

    await expect(manager.registerPopupTarget('child', 'parent', {
      state: 'ready',
      url: 'https://example.com/child',
    })).resolves.toBe(false);

    expect(manager.getTargetOwner('child')).toBeUndefined();
    expect(manager.getSessionInfo('s1')?.targetCount).toBe(2);
    expect(manager.getTargetOwner('oldest-other')).toEqual({ sessionId: 's1', workerId: 'default' });
    expect(closeTargetSpy).not.toHaveBeenCalled();
  });

  test('rejects late popup registration while the owning session is deleting', async () => {
    const manager = createManager();
    await manager.createSession({ id: 's1' });
    await manager.registerExternalTarget('parent', 's1', 'default');
    let releaseClose!: () => void;
    mockCdpClientInstance.closePage.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }));

    const deletion = manager.deleteSession('s1');
    await Promise.resolve();
    await expect(manager.registerPopupTarget('late-child', 'parent', { state: 'provisional' })).resolves.toBe(false);

    releaseClose();
    await deletion;
    expect(manager.getTargetOwner('late-child')).toBeUndefined();
  });

  test('does not evict the opener when the worker has no other target slot', async () => {
    const manager = createManager(1);
    await manager.createSession({ id: 's1' });
    await manager.registerExternalTarget('parent', 's1', 'default');

    await expect(manager.registerPopupTarget('child', 'parent', { state: 'provisional' })).resolves.toBe(false);
    expect(manager.getTargetOwner('parent')).toEqual({ sessionId: 's1', workerId: 'default' });
    expect(manager.getTargetOwner('child')).toBeUndefined();
  });

  test('serializes complete windows for one target and preserves cross-target parallelism', async () => {
    const manager = createManager();
    await manager.createSession({ id: 's1' });
    await manager.registerExternalTarget('tab-1', 's1', 'default');
    await manager.registerExternalTarget('tab-2', 's1', 'default');
    const events: string[] = [];

    const first = manager.runTargetExclusive('s1', 'tab-1', async () => {
      events.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push('first:end');
    });
    const second = manager.runTargetExclusive('s1', 'tab-1', async () => {
      events.push('second:start');
    });
    const parallel = manager.runTargetExclusive('s1', 'tab-2', async () => {
      events.push('parallel:start');
    });

    await Promise.all([first, second, parallel]);
    expect(events.indexOf('parallel:start')).toBeLessThan(events.indexOf('first:end'));
    expect(events.indexOf('second:start')).toBeGreaterThan(events.indexOf('first:end'));
  });
});
