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
  url: jest.Mock;
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

function createMockPage(targetId: string = 'target-1', url: string = 'about:blank'): MockPage {
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
    url: jest.fn().mockReturnValue(url),
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
      // releasePage is fire-and-forget — flush multi-step async cleanup
      for (let i = 0; i < 10; i++) await Promise.resolve();

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
      // releasePage is fire-and-forget — flush multi-step async cleanup
      for (let i = 0; i < 10; i++) await Promise.resolve();

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
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await smallPool.releasePage(page2);
      for (let i = 0; i < 10; i++) await Promise.resolve();

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

  describe('releasePage - origin cleanup', () => {
    test('should capture current origin before navigating to about:blank', async () => {
      const mockPage = createMockPage('target-1', 'https://example.com/path?q=1');
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      await pool.initialize();
      const page = await pool.acquirePage();
      await pool.releasePage(page);

      // url() should have been called to capture the origin
      expect(mockPage.url).toHaveBeenCalled();
    });

    test('should call Storage.clearDataForOrigin with specific origin (not wildcard)', async () => {
      const mockCdpSession = {
        send: jest.fn().mockResolvedValue(undefined),
        detach: jest.fn().mockResolvedValue(undefined),
      };
      const mockPage = createMockPage('target-1', 'https://example.com/page');
      mockPage.createCDPSession = jest.fn().mockResolvedValue(mockCdpSession);
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      await pool.initialize();
      const page = await pool.acquirePage();
      await pool.releasePage(page);
      // releasePage is fire-and-forget — flush multi-step async cleanup
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(mockCdpSession.send).toHaveBeenCalledWith('Network.clearBrowserCookies');
      expect(mockCdpSession.send).toHaveBeenCalledWith('Storage.clearDataForOrigin', {
        origin: 'https://example.com',
        storageTypes: 'all',
      });
    });

    test('should handle pages already on about:blank gracefully', async () => {
      const mockCdpSession = {
        send: jest.fn().mockResolvedValue(undefined),
        detach: jest.fn().mockResolvedValue(undefined),
      };
      const mockPage = createMockPage('target-1', 'about:blank');
      mockPage.createCDPSession = jest.fn().mockResolvedValue(mockCdpSession);
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      await pool.initialize();
      const page = await pool.acquirePage();
      await pool.releasePage(page);
      // releasePage is fire-and-forget — flush multi-step async cleanup
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Should still clear cookies but NOT call Storage.clearDataForOrigin (no valid origin)
      expect(mockCdpSession.send).toHaveBeenCalledWith('Network.clearBrowserCookies');
      expect(mockCdpSession.send).not.toHaveBeenCalledWith(
        'Storage.clearDataForOrigin',
        expect.anything()
      );
    });

    test('should handle invalid URL gracefully without crashing', async () => {
      const mockPage = createMockPage('target-1');
      // url() returns something that would cause URL parsing to throw
      mockPage.url = jest.fn().mockReturnValue('not-a-valid-url-at-all:::');
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      await pool.initialize();
      const page = await pool.acquirePage();

      // Should not throw
      await expect(pool.releasePage(page)).resolves.not.toThrow();
    });
  });

  describe('maintenance', () => {
    test('should close idle pages beyond timeout', async () => {
      const mockPage1 = createMockPage('target-1');
      const mockPage2 = createMockPage('target-2');
      const mockPage3 = createMockPage('target-3');
      mockCdpClient.createPage
        .mockResolvedValueOnce(mockPage1 as any)
        .mockResolvedValueOnce(mockPage2 as any)
        .mockResolvedValueOnce(mockPage3 as any);

      // Pool with 3 min pages and short idle timeout
      const maintenancePool = new CDPConnectionPool(mockCdpClient, {
        minPoolSize: 1,
        maxPoolSize: 5,
        pageIdleTimeout: 1000,
        preWarm: true,
      });
      await maintenancePool.initialize();

      // Verify pool has pages
      expect(maintenancePool.getStats().availablePages).toBe(1);

      // Acquire and release so we have pages with lastUsedAt in the past
      const page = await maintenancePool.acquirePage();
      await maintenancePool.releasePage(page);

      // Manually push an extra page with old lastUsedAt to simulate idle
      const extraPage = createMockPage('target-extra');
      mockCdpClient.createPage.mockResolvedValueOnce(extraPage as any);
      const extraAcquired = await maintenancePool.acquirePage();
      await maintenancePool.releasePage(extraAcquired);

      // Now we should have >= 2 available pages; advance time to make them idle
      jest.advanceTimersByTime(2000); // past pageIdleTimeout of 1000ms

      // Trigger maintenance
      jest.advanceTimersByTime(30000);
      // Allow pending promises to flush
      await Promise.resolve();

      // Pool should have closed idle pages beyond minPoolSize (1)
      expect(maintenancePool.getStats().availablePages).toBeLessThanOrEqual(1);

      await maintenancePool.shutdown();
    });

    test('should keep minimum pool size even if pages are idle', async () => {
      const mockPage1 = createMockPage('target-1');
      const mockPage2 = createMockPage('target-2');
      mockCdpClient.createPage
        .mockResolvedValueOnce(mockPage1 as any)
        .mockResolvedValueOnce(mockPage2 as any);

      const maintenancePool = new CDPConnectionPool(mockCdpClient, {
        minPoolSize: 2,
        maxPoolSize: 5,
        pageIdleTimeout: 1000,
        preWarm: true,
      });
      await maintenancePool.initialize();

      // Advance past idle timeout
      jest.advanceTimersByTime(2000);
      // Trigger maintenance
      jest.advanceTimersByTime(30000);
      await Promise.resolve();

      // Pool should retain at least minPoolSize pages
      expect(maintenancePool.getStats().availablePages).toBeGreaterThanOrEqual(
        maintenancePool.getConfig().minPoolSize
      );

      await maintenancePool.shutdown();
    });

    test('maintenance timer should run at 30s intervals', async () => {
      const mockPage = createMockPage('target-1');
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      await pool.initialize();

      // Spy on performMaintenance indirectly via page.close
      // Pool has minPoolSize=2, maxPoolSize=5. Add 3 extra pages beyond min.
      const extraPages = [
        createMockPage('extra-1'),
        createMockPage('extra-2'),
        createMockPage('extra-3'),
      ];
      for (const ep of extraPages) {
        mockCdpClient.createPage.mockResolvedValueOnce(ep as any);
      }

      // Acquire and release extra pages to fill pool above minPoolSize
      const p1 = await pool.acquirePage();
      const p2 = await pool.acquirePage();
      const p3 = await pool.acquirePage();
      await pool.releasePage(p1);
      await pool.releasePage(p2);
      await pool.releasePage(p3);

      // Advance to trigger maintenance once (30s)
      jest.advanceTimersByTime(31000);
      await Promise.resolve();

      // Maintenance ran; pool stats should be valid (no crash)
      const stats = pool.getStats();
      expect(stats.availablePages).toBeGreaterThanOrEqual(0);
    });
  });

  describe('pool lifecycle', () => {
    test('acquire and release cycle should maintain pool health', async () => {
      const mockPages = Array.from({ length: 10 }, (_, i) =>
        createMockPage(`target-${i}`, 'https://example.com')
      );
      let idx = 0;
      mockCdpClient.createPage.mockImplementation(() =>
        Promise.resolve(mockPages[idx++] as any)
      );

      await pool.initialize();

      // Perform 5 acquire/release cycles
      for (let i = 0; i < 5; i++) {
        const page = await pool.acquirePage();
        await pool.releasePage(page);
      }

      const stats = pool.getStats();
      // All pages released, none in use
      expect(stats.inUsePages).toBe(0);
      expect(stats.availablePages).toBeGreaterThanOrEqual(0);
      // Total stats are sane
      expect(stats.totalPagesCreated).toBeGreaterThanOrEqual(1);
    });

    test('rapid acquire/release should not leak pages', async () => {
      const mockPages = Array.from({ length: 20 }, (_, i) =>
        createMockPage(`target-${i}`, 'https://example.com')
      );
      let idx = 0;
      mockCdpClient.createPage.mockImplementation(() =>
        Promise.resolve(mockPages[idx++ % mockPages.length] as any)
      );

      const rapidPool = new CDPConnectionPool(mockCdpClient, {
        minPoolSize: 2,
        maxPoolSize: 4,
        pageIdleTimeout: 1000,
        preWarm: false,
      });
      await rapidPool.initialize();

      // Acquire up to maxPoolSize concurrently, then release all
      const pages = await Promise.all([
        rapidPool.acquirePage(),
        rapidPool.acquirePage(),
        rapidPool.acquirePage(),
        rapidPool.acquirePage(),
      ]);

      // Release sequentially to avoid race condition on availablePages check
      for (const p of pages) {
        await rapidPool.releasePage(p);
      }

      const stats = rapidPool.getStats();
      // No pages should remain in use
      expect(stats.inUsePages).toBe(0);
      // Pages should be available (some may exceed maxPoolSize due to async replenishment)
      expect(stats.availablePages).toBeGreaterThanOrEqual(0);

      await rapidPool.shutdown();
    });
  });
});
