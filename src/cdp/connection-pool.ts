/**
 * CDP Connection Pool - Pre-allocate and manage page instances for faster session creation
 */

import { Page } from 'puppeteer-core';
import { CDPClient, getCDPClient } from './client';

export interface PoolConfig {
  /** Minimum number of pre-allocated pages to keep ready (default: 2) */
  minPoolSize?: number;
  /** Maximum number of pre-allocated pages (default: 10) */
  maxPoolSize?: number;
  /** Page idle timeout in ms before returning to pool (default: 5 minutes) */
  pageIdleTimeout?: number;
  /** Whether to pre-warm pages on startup (default: true) */
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
}

const DEFAULT_CONFIG: Required<PoolConfig> = {
  minPoolSize: 2,
  maxPoolSize: 10,
  pageIdleTimeout: 5 * 60 * 1000, // 5 minutes
  preWarm: true,
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
      this.performMaintenance();
    }, 30000); // Every 30 seconds
    this.maintenanceTimer.unref();

    this.isInitialized = true;
    console.error('[Pool] Connection pool initialized');
  }

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

    // Replenish pool in background if needed
    this.replenishPoolAsync();

    return page;
  }

  /**
   * Release a page back to the pool
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

    // Check if pool is at max capacity
    if (this.availablePages.length >= this.config.maxPoolSize) {
      // Close the page instead of returning to pool
      try {
        await page.close();
      } catch {
        // Ignore close errors
      }
      return;
    }

    // Reset the page state before returning to pool
    try {
      // Navigate to blank page to clear state
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });

      // Clear cookies and storage
      const client = await page.createCDPSession();
      await client.send('Network.clearBrowserCookies');
      await client.send('Storage.clearDataForOrigin', {
        origin: '*',
        storageTypes: 'all',
      }).catch(() => {}); // Ignore if not supported
      await client.detach();

      pooledPage.lastUsedAt = Date.now();
      this.availablePages.push(pooledPage);
    } catch {
      // Failed to reset, close the page
      try {
        await page.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  /**
   * Create a new page
   */
  private async createNewPage(): Promise<Page> {
    const page = await this.cdpClient.createPage();
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
