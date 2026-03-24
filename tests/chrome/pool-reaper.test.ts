import { ChromePool, resetChromePool, PooledInstance } from '../../src/chrome/pool';

// Mock ChromeLauncher
jest.mock('../../src/chrome/launcher', () => ({
  ChromeLauncher: jest.fn().mockImplementation((port: number) => ({
    ensureChrome: jest.fn().mockResolvedValue({
      wsEndpoint: `ws://127.0.0.1:${port}`,
      httpEndpoint: `http://127.0.0.1:${port}`,
    }),
    close: jest.fn().mockResolvedValue(undefined),
    getPort: jest.fn().mockReturnValue(port),
    isConnected: jest.fn().mockReturnValue(true),
    getChromePid: jest.fn().mockReturnValue(undefined),
  })),
  getChromeLauncher: jest.fn(),
}));

// Mock ProfileManager
jest.mock('../../src/chrome/profile-manager', () => ({
  ProfileManager: jest.fn().mockImplementation(() => ({
    listProfiles: jest.fn().mockReturnValue([
      { directory: 'Default', name: 'Person 1' },
      { directory: 'Profile 1', name: 'Person 2' },
    ]),
  })),
}));

// Mock http for checkDebugPort
jest.mock('http', () => ({
  request: jest.fn().mockImplementation((_opts: unknown, _cb: unknown) => {
    // Simulate port not responding (for launchNewInstance)
    const req = {
      on: jest.fn().mockImplementation((event: string, handler: Function) => {
        if (event === 'error') setTimeout(() => handler(new Error('ECONNREFUSED')), 10);
        return req;
      }),
      end: jest.fn(),
      destroy: jest.fn(),
    };
    return req;
  }),
}));

describe('ChromePool idle instance reaper', () => {
  let pool: ChromePool;

  beforeEach(() => {
    resetChromePool();
    jest.useFakeTimers();
    pool = new ChromePool({ maxInstances: 5, basePort: 19500, autoLaunch: true });
  });

  afterEach(() => {
    pool.stopReaper();
    jest.useRealTimers();
    resetChromePool();
  });

  it('starts and stops the reaper without errors', () => {
    pool.startReaper(60000);
    pool.stopReaper();
    // No error thrown
  });

  it('startReaper is idempotent', () => {
    pool.startReaper(60000);
    pool.startReaper(60000); // second call is no-op
    pool.stopReaper();
  });

  it('reaps idle profile instances after timeout', async () => {
    const mockLauncher = {
      close: jest.fn().mockResolvedValue(undefined),
      ensureChrome: jest.fn(),
      getPort: jest.fn().mockReturnValue(19501),
      isConnected: jest.fn().mockReturnValue(true),
    };

    const instances = (pool as any).instances as Map<number, PooledInstance>;
    instances.set(19501, {
      port: 19501,
      launcher: mockLauncher as any,
      origins: new Set(),
      tabCount: 0,
      isPreExisting: false,
      profileDirectory: 'Profile 1',
      lastActiveAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago
    });

    // Call reapIdleInstances directly to avoid fake timer infinite loop with setInterval
    const reaped = await (pool as any).reapIdleInstances(5 * 60 * 1000);

    expect(reaped).toBe(1);
    expect(mockLauncher.close).toHaveBeenCalled();
    expect(instances.size).toBe(0);
  });

  it('does NOT reap instances with active tabs', async () => {
    const mockLauncher = {
      close: jest.fn().mockResolvedValue(undefined),
      ensureChrome: jest.fn(),
      getPort: jest.fn().mockReturnValue(19502),
    };

    const instances = (pool as any).instances as Map<number, PooledInstance>;
    instances.set(19502, {
      port: 19502,
      launcher: mockLauncher as any,
      origins: new Set(),
      tabCount: 1, // active tab!
      isPreExisting: false,
      profileDirectory: 'Profile 1',
      lastActiveAt: Date.now() - 10 * 60 * 1000,
    });

    const reaped = await (pool as any).reapIdleInstances(5 * 60 * 1000);

    expect(reaped).toBe(0);
    expect(mockLauncher.close).not.toHaveBeenCalled();
    expect(instances.size).toBe(1);
  });

  it('does NOT reap pre-existing instances', async () => {
    const mockLauncher = {
      close: jest.fn().mockResolvedValue(undefined),
      ensureChrome: jest.fn(),
      getPort: jest.fn().mockReturnValue(19503),
    };

    const instances = (pool as any).instances as Map<number, PooledInstance>;
    instances.set(19503, {
      port: 19503,
      launcher: mockLauncher as any,
      origins: new Set(),
      tabCount: 0,
      isPreExisting: true, // pre-existing!
      profileDirectory: 'Default',
      lastActiveAt: Date.now() - 10 * 60 * 1000,
    });

    const reaped = await (pool as any).reapIdleInstances(5 * 60 * 1000);

    expect(reaped).toBe(0);
    expect(mockLauncher.close).not.toHaveBeenCalled();
    expect(instances.size).toBe(1);
  });

  it('does NOT reap non-profile (origin-based) instances', async () => {
    const mockLauncher = {
      close: jest.fn().mockResolvedValue(undefined),
      ensureChrome: jest.fn(),
      getPort: jest.fn().mockReturnValue(19504),
    };

    const instances = (pool as any).instances as Map<number, PooledInstance>;
    instances.set(19504, {
      port: 19504,
      launcher: mockLauncher as any,
      origins: new Set(['https://example.com']),
      tabCount: 0,
      isPreExisting: false,
      // no profileDirectory
      lastActiveAt: Date.now() - 10 * 60 * 1000,
    });

    const reaped = await (pool as any).reapIdleInstances(5 * 60 * 1000);

    expect(reaped).toBe(0);
    expect(mockLauncher.close).not.toHaveBeenCalled();
    expect(instances.size).toBe(1);
  });
});
