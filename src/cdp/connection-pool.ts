/**
 * CDP Connection Pool - Pre-allocate and manage page instances for faster session creation
 */

import { Page } from 'puppeteer-core';
import { CDPClient, getCDPClient } from './client';

export interface PoolConfig {
  /** Minimum number of pre-allocated pages to keep ready (default: 0) */
  minPoolSize?: number;
  /** Maximum number of recycled pages to keep in pool (default: 0 — disabled to prevent about:blank ghost tabs) */
  maxPoolSize?: number;
  /** Page idle timeout in ms before returning to pool (default: 5 minutes) */
  pageIdleTimeout?: number;
  /** Whether to pre-warm pages on startup (default: false) */
  preWarm?: boolean;
}

export interface PoolStats {
  /** Number of pages currently in the pool (ready to use) */
  availablePages: number;
  /** Number of pages currently in use */
  inUsePages: number;
  /** Total pages created since pool initialization */
  totalPagesCreated: number;
  /** Number of pages reused from pool */
  pagesReused: number;
  /** Number of pages created on-demand (pool was empty) */
  pagesCreatedOnDemand: number;
  /** Average time to acquire a page (ms) */
  avgAcquireTimeMs: number;
}

interface PooledPage {
  page: Page;
  createdAt: number;
  lastUsedAt: number;
  visitedOrigins: Set<string>;
}

const DEFAULT_CONFIG: Required<PoolConfig> = {
  minPoolSize: 0,
  maxPoolSize: 0, // Disabled: recycled pages appear as about:blank ghost tabs in Chrome
  pageIdleTimeout: 5 * 60 * 1000, // 5 minutes
  preWarm: false,
};

export class CDPConnectionPool {
  private cdpClient: CDPClient;
  private config: Required<PoolConfig>;
  private availablePages: PooledPage[] = [];
  private inUsePages: Map<Page, PooledPage> = new Map();
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private isInitialized = false;

  // Stats
  private totalPagesCreated = 0;
  private pagesReused = 0;
  private pagesCreatedOnDemand = 0;
  private acquireTimes: number[] = [];

  constructor(cdpClient?: CDPClient, config?: PoolConfig) {
    this.cdpClient = cdpClient || getCDPClient();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the pool with pre-warmed pages
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    await this.cdpClient.connect();

    if (this.config.preWarm) {
      console.error(`[Pool] Pre-warming ${this.config.minPoolSize} pages...`);
      await this.ensureMinimumPages();
    }

    // Start maintenance timer
    this.maintenanceTimer = setInterval(() => {
      this.performMaintenance().catch((err) => {
        console.error('[Pool] Maintenance error:', err);
      });
    }, 30000); // Every 30 seconds
    this.maintenanceTimer.unref();

    this.isInitialized = true;
    console.error('[Pool] Connection pool initialized');
  }

  /**
   * When true, suppresses automatic pool replenishment.
   * Set during bulk operations (acquireBatch, preWarmForWorkflow) to prevent
   * about:blank tab proliferation.
   */
  private suppressReplenishment = false;

  /**
   * Acquire a page from the pool
   */
  async acquirePage(): Promise<Page> {
    const startTime = Date.now();

    // Ensure initialized
    if (!this.isInitialized) {
      await this.initialize();
    }

    let page: Page;
    let pooledPage: PooledPage;

    // Try to get from pool
    if (this.availablePages.length > 0) {
      pooledPage = this.availablePages.pop()!;
      page = pooledPage.page;
      pooledPage.lastUsedAt = Date.now();
      this.pagesReused++;
    } else {
      // Create new page on demand
      page = await this.createNewPage();
      pooledPage = {
        page,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        visitedOrigins: new Set(),
      };
      this.pagesCreatedOnDemand++;
    }

    this.inUsePages.set(page, pooledPage);

    // Track acquire time
    const acquireTime = Date.now() - startTime;
    this.acquireTimes.push(acquireTime);
    if (this.acquireTimes.length > 100) {
      this.acquireTimes.shift();
    }

    // Replenish pool in background if needed (suppressed during bulk ops)
    if (!this.suppressReplenishment) {
      this.replenishPoolAsync();
    }

    return page;
  }

  /**
   * Acquire multiple pages at once without triggering per-page replenishment.
   * Prevents about:blank tab proliferation during workflow_init.
   *
   * Instead of acquiring one-by-one (each triggering replenishPoolAsync),
   * this method batch-acquires all needed pages, only replenishing once at the end.
   *
   * @param count Number of pages to acquire
   * @returns Array of acquired pages
   */
  async acquireBatch(count: number): Promise<Page[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Suppress replenishment during batch acquire
    this.suppressReplenishment = true;
    const startTime = Date.now();

    try {
      const pages: Page[] = [];

      // First, take as many as possible from the pool
      const fromPool = Math.min(count, this.availablePages.length);
      for (let i = 0; i < fromPool; i++) {
        const pooledPage = this.availablePages.pop()!;
        pooledPage.lastUsedAt = Date.now();
        this.inUsePages.set(pooledPage.page, pooledPage);
        this.pagesReused++;
        pages.push(pooledPage.page);
      }

      // Create remaining pages on-demand (in parallel with concurrency limit)
      const remaining = count - fromPool;
      if (remaining > 0) {
        const concurrency = 10;
        let active = 0;
        const queue: Array<() => void> = [];

        const limiter = async <T>(fn: () => Promise<T>): Promise<T> => {
          if (active >= concurrency) {
            await new Promise<void>((resolve) => queue.push(resolve));
          }
          active++;
          try {
            return await fn();
          } finally {
            active--;
            if (queue.length > 0) queue.shift()!();
          }
        };

        const newPages = await Promise.all(
          Array.from({ length: remaining }, () =>
            limiter(async () => {
              const page = await this.createNewPage();
              const pooledPage: PooledPage = {
                page,
                createdAt: Date.now(),
                lastUsedAt: Date.now(),
                visitedOrigins: new Set(),
              };
              this.inUsePages.set(page, pooledPage);
              this.pagesCreatedOnDemand++;
              return page;
            })
          )
        );
        pages.push(...newPages);
      }

      const durationMs = Date.now() - startTime;
      console.error(
        `[Pool] Batch acquired ${pages.length} pages (${fromPool} from pool, ${remaining} on-demand) in ${durationMs}ms`
      );

      return pages;
    } finally {
      this.suppressReplenishment = false;
      // Do NOT replenish after batch acquire — workflow pages will be released back
      // to the pool during cleanup. Eager replenishment here creates about:blank ghost tabs.
    }
  }

  /**
   * Release a page back to the pool (non-blocking: cleanup runs async)
   */
  async releasePage(page: Page): Promise<void> {
    const pooledPage = this.inUsePages.get(page);
    if (!pooledPage) {
      // Page not managed by this pool, just close it
      try {
        await page.close();
      } catch {
        // Ignore close errors
      }
      return;
    }

    this.inUsePages.delete(page);

    // Check if pool is at max capacity — close immediately, don't queue cleanup
    if (this.availablePages.length >= this.config.maxPoolSize) {
      try {
        await page.close();
      } catch {
        // Ignore close errors
      }
      return;
    }

    // Fire-and-forget: cleanup runs async so the caller isn't blocked
    this.cleanAndReturnToPool(page, pooledPage).catch((err) => {
      console.error('[ConnectionPool] Cleanup failed, closing page:', err);
      page.close().catch(() => {});
    });
  }

  /**
   * Async cleanup and return to pool (called fire-and-forget from releasePage)
   */
  private async cleanAndReturnToPool(page: Page, pooledPage: PooledPage): Promise<void> {
    // Track the current page URL before navigating away (for origin-specific cleanup)
    let currentOrigin: string | undefined;
    try {
      const currentUrl = page.url();
      if (currentUrl && currentUrl !== 'about:blank') {
        currentOrigin = new URL(currentUrl).origin;
      }
    } catch {
      // Ignore URL parsing errors
    }

    // Navigate to blank page to clear state
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });

    // Clear cookies and storage via CDP session (with proper cleanup in finally)
    const client = await page.createCDPSession();
    try {
      await client.send('Network.clearBrowserCookies');

      // Clear storage for the specific origin (wildcard '*' silently fails)
      if (currentOrigin) {
        await client.send('Storage.clearDataForOrigin', {
          origin: currentOrigin,
          storageTypes: 'all',
        }).catch(() => {}); // Ignore if not supported
      }
    } finally {
      await client.detach().catch(() => {});
    }

    // Double-check pool capacity hasn't been exceeded while we were cleaning
    if (this.availablePages.length >= this.config.maxPoolSize) {
      await page.close().catch(() => {});
      return;
    }

    pooledPage.lastUsedAt = Date.now();
    this.availablePages.push(pooledPage);
  }

  // Default viewport for consistent debugging experience
  static readonly DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

  /**
   * Create a new page with default viewport.
   * Pool pages skip cookie bridging to avoid CDP session conflicts
   * and unnecessary overhead — cookies will be bridged when the page
   * is actually navigated to a real URL.
   */
  private async createNewPage(): Promise<Page> {
    const page = await this.cdpClient.createPage(undefined, undefined, true);
    // Ensure viewport is set (cdpClient.createPage already sets it, but double-check)
    if (!page.viewport()) {
      await page.setViewport(CDPConnectionPool.DEFAULT_VIEWPORT);
    }
    this.totalPagesCreated++;
    return page;
  }

  /**
   * Ensure minimum number of pages in pool
   */
  private async ensureMinimumPages(): Promise<void> {
    const pagesToCreate = this.config.minPoolSize - this.availablePages.length;
    if (pagesToCreate <= 0) return;

    const promises: Promise<void>[] = [];
    for (let i = 0; i < pagesToCreate; i++) {
      promises.push(
        this.createNewPage().then((page) => {
          this.availablePages.push({
            page,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            visitedOrigins: new Set(),
          });
        }).catch((err) => {
          console.error('[Pool] Failed to pre-warm page:', err);
        })
      );
    }

    await Promise.all(promises);
  }

  /**
   * Replenish pool asynchronously
   */
  private replenishPoolAsync(): void {
    if (this.availablePages.length < this.config.minPoolSize) {
      this.ensureMinimumPages().catch((err) => {
        console.error('[Pool] Failed to replenish pool:', err);
      });
    }
  }

  /**
   * Perform maintenance on the pool
   */
  private async performMaintenance(): Promise<void> {
    const now = Date.now();
    const pagesToRemove: PooledPage[] = [];

    // Find pages that have been idle too long
    for (const pooledPage of this.availablePages) {
      const idleTime = now - pooledPage.lastUsedAt;
      if (
        idleTime > this.config.pageIdleTimeout &&
        this.availablePages.length > this.config.minPoolSize
      ) {
        pagesToRemove.push(pooledPage);
      }
    }

    // Remove idle pages
    for (const pooledPage of pagesToRemove) {
      const index = this.availablePages.indexOf(pooledPage);
      if (index !== -1) {
        this.availablePages.splice(index, 1);
        try {
          await pooledPage.page.close();
        } catch {
          // Ignore close errors
        }
      }
    }

    if (pagesToRemove.length > 0) {
      console.error(`[Pool] Maintenance: closed ${pagesToRemove.length} idle page(s)`);
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): PoolStats {
    const avgAcquireTime =
      this.acquireTimes.length > 0
        ? this.acquireTimes.reduce((a, b) => a + b, 0) / this.acquireTimes.length
        : 0;

    return {
      availablePages: this.availablePages.length,
      inUsePages: this.inUsePages.size,
      totalPagesCreated: this.totalPagesCreated,
      pagesReused: this.pagesReused,
      pagesCreatedOnDemand: this.pagesCreatedOnDemand,
      avgAcquireTimeMs: Math.round(avgAcquireTime * 100) / 100,
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<PoolConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<PoolConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Shutdown the pool
   */
  async shutdown(): Promise<void> {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    // Close all available pages
    for (const pooledPage of this.availablePages) {
      try {
        await pooledPage.page.close();
      } catch {
        // Ignore close errors
      }
    }
    this.availablePages = [];

    // Close all in-use pages
    for (const [page] of this.inUsePages) {
      try {
        await page.close();
      } catch {
        // Ignore close errors
      }
    }
    this.inUsePages.clear();

    this.isInitialized = false;
    console.error('[Pool] Connection pool shutdown');
  }
}

// Singleton instance
let poolInstance: CDPConnectionPool | null = null;

export function getCDPConnectionPool(config?: PoolConfig): CDPConnectionPool {
  if (!poolInstance) {
    poolInstance = new CDPConnectionPool(undefined, config);
  }
  return poolInstance;
}
