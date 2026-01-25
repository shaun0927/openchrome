/// <reference types="jest" />
/**
 * Tests for SessionManager TTL, Stats, and Config features
 */

// Mock browser context
const mockBrowserContext = {
  close: jest.fn().mockResolvedValue(undefined),
  newPage: jest.fn().mockResolvedValue({
    target: () => ({ _targetId: 'mock-target-id' }),
    goto: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    setViewport: jest.fn().mockResolvedValue(undefined),
  }),
};

// Counter for unique target IDs
let targetIdCounter = 0;

// Mock CDP client instance
const mockCdpClientInstance = {
  connect: jest.fn().mockResolvedValue(undefined),
  createPage: jest.fn().mockImplementation(() => {
    const targetId = `mock-target-id-${++targetIdCounter}`;
    return Promise.resolve({
      target: () => ({ _targetId: targetId }),
      goto: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      setViewport: jest.fn().mockResolvedValue(undefined),
      isClosed: jest.fn().mockReturnValue(false),
    });
  }),
  closePage: jest.fn().mockResolvedValue(undefined),
  getPageByTargetId: jest.fn().mockReturnValue(null),
  isConnected: jest.fn().mockReturnValue(true),
  addTargetDestroyedListener: jest.fn(),
  createBrowserContext: jest.fn().mockResolvedValue(mockBrowserContext),
  closeBrowserContext: jest.fn().mockResolvedValue(undefined),
};

// Mock dependencies
jest.mock('../../src/cdp/client', () => ({
  CDPClient: jest.fn().mockImplementation(() => mockCdpClientInstance),
  getCDPClient: jest.fn().mockReturnValue(mockCdpClientInstance),
}));

const mockPoolInstance = {
  acquirePage: jest.fn().mockResolvedValue({
    target: () => ({ _targetId: 'pool-target-id' }),
    goto: jest.fn().mockResolvedValue(undefined),
  }),
  releasePage: jest.fn().mockResolvedValue(undefined),
  getStats: jest.fn().mockReturnValue({
    availablePages: 2,
    inUsePages: 1,
    totalPagesCreated: 5,
    pagesReused: 3,
    pagesCreatedOnDemand: 2,
    avgAcquireTimeMs: 10,
  }),
  initialize: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../src/cdp/connection-pool', () => ({
  CDPConnectionPool: jest.fn().mockImplementation(() => mockPoolInstance),
  getCDPConnectionPool: jest.fn().mockReturnValue(mockPoolInstance),
}));

jest.mock('../../src/utils/request-queue', () => ({
  RequestQueueManager: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn((_, fn) => fn()),
    deleteQueue: jest.fn(),
  })),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(() => ({
    clearSessionRefs: jest.fn(),
    clearTargetRefs: jest.fn(),
  })),
}));

import { SessionManager, SessionManagerConfig, SessionManagerStats } from '../../src/session-manager';

describe('SessionManager TTL and Stats', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    targetIdCounter = 0; // Reset counter

    sessionManager = new SessionManager(undefined, {
      sessionTTL: 1000, // 1 second for testing
      cleanupInterval: 500, // 0.5 seconds
      autoCleanup: false, // Disable auto-cleanup for controlled testing
      maxSessions: 10,
      useConnectionPool: false, // Disable pool for basic tests
    });
  });

  afterEach(() => {
    sessionManager.stopAutoCleanup();
    jest.useRealTimers();
  });

  describe('Configuration', () => {
    test('should accept custom configuration', () => {
      const config = sessionManager.getConfig();

      expect(config.sessionTTL).toBe(1000);
      expect(config.cleanupInterval).toBe(500);
      expect(config.autoCleanup).toBe(false);
      expect(config.maxSessions).toBe(10);
    });

    test('should use default configuration when not provided', () => {
      const defaultManager = new SessionManager(undefined, { autoCleanup: false });
      const config = defaultManager.getConfig();

      expect(config.sessionTTL).toBe(30 * 60 * 1000); // 30 minutes
      expect(config.cleanupInterval).toBe(60 * 1000); // 1 minute
      expect(config.maxSessions).toBe(100);
    });

    test('should allow configuration updates', () => {
      sessionManager.updateConfig({ sessionTTL: 2000 });

      expect(sessionManager.getConfig().sessionTTL).toBe(2000);
    });
  });

  describe('Statistics', () => {
    test('should track active sessions count', async () => {
      await sessionManager.createSession({ id: 'session-1' });
      await sessionManager.createSession({ id: 'session-2' });

      const stats = sessionManager.getStats();

      expect(stats.activeSessions).toBe(2);
    });

    test('should track total sessions created', async () => {
      await sessionManager.createSession({ id: 'session-1' });
      await sessionManager.createSession({ id: 'session-2' });

      const stats = sessionManager.getStats();

      expect(stats.totalSessionsCreated).toBe(2);
    });

    test('should track uptime', async () => {
      const initialStats = sessionManager.getStats();
      const initialUptime = initialStats.uptime;

      jest.advanceTimersByTime(1000);

      const stats = sessionManager.getStats();

      expect(stats.uptime).toBeGreaterThan(initialUptime);
    });

    test('should track memory usage', () => {
      const stats = sessionManager.getStats();

      expect(stats.memoryUsage).toBeGreaterThan(0);
    });

    test('should not include pool stats when pool is disabled', () => {
      const stats = sessionManager.getStats();

      expect(stats.connectionPool).toBeUndefined();
    });
  });

  describe('Session TTL and Cleanup', () => {
    test('should clean up sessions older than TTL', async () => {
      const session = await sessionManager.createSession({ id: 'old-session' });

      // Manually set lastActivityAt to past
      (session as any).lastActivityAt = Date.now() - 2000;

      const deleted = await sessionManager.cleanupInactiveSessions(1000);

      expect(deleted).toContain('old-session');
      expect(sessionManager.getSession('old-session')).toBeUndefined();
    });

    test('should not clean up active sessions', async () => {
      await sessionManager.createSession({ id: 'active-session' });

      const deleted = await sessionManager.cleanupInactiveSessions(1000);

      expect(deleted).not.toContain('active-session');
      expect(sessionManager.getSession('active-session')).toBeDefined();
    });

    test('should track cleaned sessions count', async () => {
      const session = await sessionManager.createSession({ id: 'old-session' });
      (session as any).lastActivityAt = Date.now() - 2000;

      const initialStats = sessionManager.getStats();
      await sessionManager.cleanupInactiveSessions(1000);
      const finalStats = sessionManager.getStats();

      expect(finalStats.totalSessionsCleaned).toBe(initialStats.totalSessionsCleaned + 1);
    });
  });

  describe('cleanupAllSessions', () => {
    test('should delete all sessions', async () => {
      await sessionManager.createSession({ id: 'session-1' });
      await sessionManager.createSession({ id: 'session-2' });
      await sessionManager.createSession({ id: 'session-3' });

      const count = await sessionManager.cleanupAllSessions();

      expect(count).toBe(3);
      expect(sessionManager.getStats().activeSessions).toBe(0);
    });
  });

  describe('Max Sessions Limit', () => {
    test('should enforce max sessions limit', async () => {
      const smallManager = new SessionManager(undefined, {
        maxSessions: 2,
        autoCleanup: false,
        useConnectionPool: false,
      });

      await smallManager.createSession({ id: 'session-1' });
      await smallManager.createSession({ id: 'session-2' });

      await expect(smallManager.createSession({ id: 'session-3' })).rejects.toThrow(
        'Maximum session limit'
      );
    });

    test('should cleanup old sessions when limit reached', async () => {
      const smallManager = new SessionManager(undefined, {
        maxSessions: 2,
        sessionTTL: 1000,
        autoCleanup: false,
        useConnectionPool: false,
      });

      const session1 = await smallManager.createSession({ id: 'session-1' });
      await smallManager.createSession({ id: 'session-2' });

      // Make session-1 old
      (session1 as any).lastActivityAt = Date.now() - 2000;

      // Should succeed by cleaning up old session
      const session3 = await smallManager.createSession({ id: 'session-3' });

      expect(session3.id).toBe('session-3');
      expect(smallManager.getSession('session-1')).toBeUndefined();
    });
  });

  describe('touchSession', () => {
    test('should update lastActivityAt', async () => {
      const session = await sessionManager.createSession({ id: 'test' });
      const initialTime = session.lastActivityAt;

      jest.advanceTimersByTime(100);
      sessionManager.touchSession('test');

      expect(session.lastActivityAt).toBeGreaterThan(initialTime);
    });
  });
});

describe('SessionManager with Connection Pool', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    jest.clearAllMocks();

    sessionManager = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: true,
    });
  });

  afterEach(() => {
    sessionManager.stopAutoCleanup();
  });

  test('should include pool stats when pool is enabled', () => {
    const stats = sessionManager.getStats();

    expect(stats.connectionPool).toBeDefined();
    expect(stats.connectionPool?.availablePages).toBe(2);
    expect(stats.connectionPool?.inUsePages).toBe(1);
    expect(stats.connectionPool?.totalPagesCreated).toBe(5);
  });
});

describe('SessionManager Auto-Cleanup', () => {
  test('should run auto-cleanup at configured interval', async () => {
    jest.useFakeTimers();
    // Set system time to a known value
    const baseTime = 1000000;
    jest.setSystemTime(baseTime);

    const autoManager = new SessionManager(undefined, {
      sessionTTL: 100,
      cleanupInterval: 50,
      autoCleanup: true,
      useConnectionPool: false,
    });

    const session = await autoManager.createSession({ id: 'test' });
    // Set lastActivityAt to 200ms in the past
    (session as any).lastActivityAt = baseTime - 200;

    // Advance time past cleanup interval (this triggers the interval callback)
    // Use advanceTimersByTimeAsync to handle async cleanup
    await jest.advanceTimersByTimeAsync(100);

    expect(autoManager.getSession('test')).toBeUndefined();

    autoManager.stopAutoCleanup();
    jest.useRealTimers();
  });

  test('should stop auto-cleanup when stopAutoCleanup is called', async () => {
    jest.useFakeTimers();
    const baseTime = 1000000;
    jest.setSystemTime(baseTime);

    const autoManager = new SessionManager(undefined, {
      sessionTTL: 100,
      cleanupInterval: 50,
      autoCleanup: true,
      useConnectionPool: false,
    });

    autoManager.stopAutoCleanup();

    const session = await autoManager.createSession({ id: 'test' });
    (session as any).lastActivityAt = baseTime - 200;

    // Advance time past cleanup interval
    jest.advanceTimersByTime(100);
    await Promise.resolve();

    // Session should still exist because auto-cleanup was stopped
    expect(autoManager.getSession('test')).toBeDefined();

    jest.useRealTimers();
  });
});
