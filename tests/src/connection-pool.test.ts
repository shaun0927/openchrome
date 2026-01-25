/// <reference types="jest" />
/**
 * Tests for CDPConnectionPool (src version - uses puppeteer)
 */

import { CDPConnectionPool, PoolConfig, PoolStats } from '../../src/cdp/connection-pool';
import { CDPClient } from '../../src/cdp/client';

// Mock Page type
interface MockPage {
  goto: jest.Mock;
  close: jest.Mock;
  createCDPSession: jest.Mock;
  target: jest.Mock;
  viewport: jest.Mock;
  setViewport: jest.Mock;
}

// Mock CDPClient
jest.mock('../../src/cdp/client', () => ({
  CDPClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    createPage: jest.fn(),
    getPageByTargetId: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
  })),
  getCDPClient: jest.fn(),
}));

function createMockPage(targetId: string = 'target-1'): MockPage {
  const mockCdpSession = {
    send: jest.fn().mockResolvedValue(undefined),
    detach: jest.fn().mockResolvedValue(undefined),
  };

  return {
    goto: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    createCDPSession: jest.fn().mockResolvedValue(mockCdpSession),
    target: jest.fn().mockReturnValue({ _targetId: targetId }),
    viewport: jest.fn().mockReturnValue({ width: 1920, height: 1080 }),
    setViewport: jest.fn().mockResolvedValue(undefined),
  };
}

describe('CDPConnectionPool', () => {
  let pool: CDPConnectionPool;
  let mockCdpClient: jest.Mocked<CDPClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockCdpClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      createPage: jest.fn(),
      getPageByTargetId: jest.fn(),
      isConnected: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<CDPClient>;

    pool = new CDPConnectionPool(mockCdpClient, {
      minPoolSize: 2,
      maxPoolSize: 5,
      pageIdleTimeout: 1000,
      preWarm: false,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('initialize', () => {
    test('should connect to CDP client', async () => {
      await pool.initialize();

      expect(mockCdpClient.connect).toHaveBeenCalled();
    });

    test('should pre-warm pages when enabled', async () => {
      const mockPage1 = createMockPage('target-1');
      const mockPage2 = createMockPage('target-2');
      mockCdpClient.createPage
        .mockResolvedValueOnce(mockPage1 as any)
        .mockResolvedValueOnce(mockPage2 as any);

      const warmPool = new CDPConnectionPool(mockCdpClient, {
        minPoolSize: 2,
        maxPoolSize: 5,
        preWarm: true,
      });

      await warmPool.initialize();

      expect(mockCdpClient.createPage).toHaveBeenCalledTimes(2);
    });

    test('should not re-initialize if already initialized', async () => {
      await pool.initialize();
      await pool.initialize();

      expect(mockCdpClient.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('acquirePage', () => {
    test('should create new page when pool is empty', async () => {
      const mockPage = createMockPage('target-1');
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      const page = await pool.acquirePage();

      expect(page).toBe(mockPage);
      expect(mockCdpClient.createPage).toHaveBeenCalled();
    });

    test('should reuse page from pool when available', async () => {
      const mockPage1 = createMockPage('target-1');
      const mockPage2 = createMockPage('target-2');
      const mockPage3 = createMockPage('target-3');
      mockCdpClient.createPage
        .mockResolvedValueOnce(mockPage1 as any)
        .mockResolvedValueOnce(mockPage2 as any)
        .mockResolvedValueOnce(mockPage3 as any);

      // Pre-warm pool
      const warmPool = new CDPConnectionPool(mockCdpClient, {
        minPoolSize: 2,
        maxPoolSize: 5,
        preWarm: true,
      });
      await warmPool.initialize();

      const callCountAfterInit = mockCdpClient.createPage.mock.calls.length;

      // Acquire should use pooled page
      const page = await warmPool.acquirePage();

      expect(page).toBeDefined();
      // Should be one of the pre-warmed pages
      expect([mockPage1, mockPage2]).toContainEqual(page);
    });

    test('should track pages reused from pool', async () => {
      const mockPage = createMockPage('target-1');
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      const warmPool = new CDPConnectionPool(mockCdpClient, {
        minPoolSize: 1,
        maxPoolSize: 5,
        preWarm: true,
      });
      await warmPool.initialize();

      await warmPool.acquirePage();
      const stats = warmPool.getStats();

      expect(stats.pagesReused).toBe(1);
    });

    test('should track pages created on demand', async () => {
      const mockPage = createMockPage('target-1');
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      await pool.initialize();
      await pool.acquirePage();
      const stats = pool.getStats();

      expect(stats.pagesCreatedOnDemand).toBe(1);
    });
  });

  describe('releasePage', () => {
    test('should return page to pool', async () => {
      const mockPage = createMockPage('target-1');
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      await pool.initialize();
      const page = await pool.acquirePage();

      const statsBeforeRelease = pool.getStats();
      const inUseBefore = statsBeforeRelease.inUsePages;

      await pool.releasePage(page);

      const statsAfterRelease = pool.getStats();
      expect(statsAfterRelease.inUsePages).toBe(inUseBefore - 1);
      expect(statsAfterRelease.availablePages).toBeGreaterThanOrEqual(1);
    });

    test('should reset page state before returning to pool', async () => {
      const mockPage = createMockPage('target-1');
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      await pool.initialize();
      const page = await pool.acquirePage();
      await pool.releasePage(page);

      expect(mockPage.goto).toHaveBeenCalledWith('about:blank', expect.any(Object));
      expect(mockPage.createCDPSession).toHaveBeenCalled();
    });

    test('should close page if pool is at max capacity', async () => {
      const mockPages = Array.from({ length: 6 }, (_, i) => createMockPage(`target-${i}`));
      let pageIndex = 0;
      mockCdpClient.createPage.mockImplementation(() => Promise.resolve(mockPages[pageIndex++] as any));

      const smallPool = new CDPConnectionPool(mockCdpClient, {
        minPoolSize: 1,
        maxPoolSize: 2,
        preWarm: false,
      });
      await smallPool.initialize();

      // Fill the pool
      const page1 = await smallPool.acquirePage();
      const page2 = await smallPool.acquirePage();
      const page3 = await smallPool.acquirePage();

      await smallPool.releasePage(page1);
      await smallPool.releasePage(page2);

      // Pool is now at max (2), third page should be closed
      await smallPool.releasePage(page3);

      expect(mockPages[2].close).toHaveBeenCalled();
    });

    test('should handle unmanaged page gracefully', async () => {
      const unmanaged = createMockPage('unmanaged');

      await pool.initialize();
      await pool.releasePage(unmanaged as any);

      expect(unmanaged.close).toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    test('should return correct statistics', async () => {
      const mockPage = createMockPage('target-1');
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      await pool.initialize();
      await pool.acquirePage();

      const stats = pool.getStats();

      // Stats should have the expected shape and reasonable values
      expect(stats.inUsePages).toBeGreaterThanOrEqual(1);
      expect(stats.totalPagesCreated).toBeGreaterThanOrEqual(1);
      expect(stats.pagesCreatedOnDemand).toBeGreaterThanOrEqual(1);
      expect(stats.avgAcquireTimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof stats.availablePages).toBe('number');
      expect(typeof stats.pagesReused).toBe('number');
    });

    test('should track average acquire time', async () => {
      const mockPage = createMockPage('target-1');
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      await pool.initialize();
      await pool.acquirePage();
      await pool.acquirePage();

      const stats = pool.getStats();
      expect(stats.avgAcquireTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getConfig', () => {
    test('should return current configuration', () => {
      const config = pool.getConfig();

      expect(config).toEqual({
        minPoolSize: 2,
        maxPoolSize: 5,
        pageIdleTimeout: 1000,
        preWarm: false,
      });
    });
  });

  describe('updateConfig', () => {
    test('should update configuration', () => {
      pool.updateConfig({ minPoolSize: 5 });

      const config = pool.getConfig();
      expect(config.minPoolSize).toBe(5);
    });
  });

  describe('shutdown', () => {
    test('should close all pages in pool', async () => {
      const mockPage1 = createMockPage('target-1');
      const mockPage2 = createMockPage('target-2');
      mockCdpClient.createPage
        .mockResolvedValueOnce(mockPage1 as any)
        .mockResolvedValueOnce(mockPage2 as any);

      const warmPool = new CDPConnectionPool(mockCdpClient, {
        minPoolSize: 2,
        maxPoolSize: 5,
        preWarm: true,
      });
      await warmPool.initialize();
      await warmPool.shutdown();

      expect(mockPage1.close).toHaveBeenCalled();
      expect(mockPage2.close).toHaveBeenCalled();
    });

    test('should close in-use pages on shutdown', async () => {
      const mockPage = createMockPage('target-1');
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      await pool.initialize();
      await pool.acquirePage();
      await pool.shutdown();

      expect(mockPage.close).toHaveBeenCalled();
    });
  });
});
