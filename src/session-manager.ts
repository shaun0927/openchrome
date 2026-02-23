/**
 * Session Manager - Manages lifecycle of parallel Claude Code sessions
 * Supports multiple Workers within a single session for parallel browser operations
 */

import path from 'path';
import { Page, Target, BrowserContext } from 'puppeteer-core';
import { Session, SessionInfo, SessionCreateOptions, SessionEvent, Worker, WorkerInfo, WorkerCreateOptions } from './types/session';
import { CDPClient, getCDPClient, CDPClientFactory, getCDPClientFactory } from './cdp/client';
import { CDPConnectionPool, getCDPConnectionPool, PoolStats } from './cdp/connection-pool';
import { ChromePool, getChromePool } from './chrome/pool';
import { getGlobalConfig } from './config/global';
import { RequestQueueManager } from './utils/request-queue';
import { getRefIdManager } from './utils/ref-id-manager';
import { smartGoto } from './utils/smart-goto';
import { BrowserRouter } from './router';
import { HybridConfig } from './types/browser-backend';
import { StorageStateManager } from './storage-state';
import { StorageStateConfig } from './config';

// Helper to get target ID (internal puppeteer property)
function getTargetId(target: Target): string {
  return (target as unknown as { _targetId: string })._targetId;
}

export interface SessionManagerConfig {
  /** Session TTL in milliseconds (default: 30 minutes) */
  sessionTTL?: number;
  /** Auto-cleanup interval in milliseconds (default: 1 minute) */
  cleanupInterval?: number;
  /** Enable auto-cleanup (default: true) */
  autoCleanup?: boolean;
  /** Maximum number of sessions (default: 100) */
  maxSessions?: number;
  /** Maximum workers per session (default: 20) */
  maxWorkersPerSession?: number;
  /** Use connection pool for page management (default: false for worker isolation) */
  useConnectionPool?: boolean;
  /** Use default browser context (shares cookies/sessions with Chrome profile) */
  useDefaultContext?: boolean;
  /** Enable Chrome pool for origin-aware instance distribution (default: false) */
  usePool?: boolean;
  /** Storage state persistence config (default: disabled) */
  storageState?: StorageStateConfig;
}

export interface SessionManagerStats {
  activeSessions: number;
  totalTargets: number;
  totalWorkers: number;
  totalSessionsCreated: number;
  totalSessionsCleaned: number;
  uptime: number;
  lastCleanup: number | null;
  memoryUsage: number;
  connectionPool?: PoolStats;
}

const DEFAULT_CONFIG: Required<SessionManagerConfig> = {
  sessionTTL: 30 * 60 * 1000,      // 30 minutes
  cleanupInterval: 60 * 1000,       // 1 minute
  autoCleanup: true,
  maxSessions: 100,
  maxWorkersPerSession: 50,
  useConnectionPool: true,          // Enabled by default for faster page creation
  useDefaultContext: true,          // Use Chrome profile's cookies/sessions by default
  usePool: false,                   // Disabled by default; enable for multi-Chrome origin isolation
  storageState: { enabled: false },
};

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private targetToWorker: Map<string, { sessionId: string; workerId: string }> = new Map();
  private cdpClient: CDPClient;
  private connectionPool: CDPConnectionPool | null = null;
  private chromePool: ChromePool | null = null;
  private cdpFactory: CDPClientFactory;
  private queueManager: RequestQueueManager;
  private eventListeners: ((event: SessionEvent) => void)[] = [];
  private browserRouter: BrowserRouter | null = null;
  private storageStateManagers = new Map<string, StorageStateManager>();
  private storageStateConfig: StorageStateConfig | null = null;

  // TTL & Stats
  private config: Required<SessionManagerConfig>;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private startTime: number = Date.now();
  private totalSessionsCreated: number = 0;
  private totalSessionsCleaned: number = 0;
  private lastCleanupTime: number | null = null;

  constructor(cdpClient?: CDPClient, config?: SessionManagerConfig) {
    this.cdpClient = cdpClient || getCDPClient();
    this.queueManager = new RequestQueueManager();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cdpFactory = getCDPClientFactory();

    if (this.config.useConnectionPool) {
      this.connectionPool = getCDPConnectionPool();
    }

    if (this.config.usePool) {
      this.chromePool = getChromePool({ autoLaunch: getGlobalConfig().autoLaunch });
    }

    if (this.config.autoCleanup) {
      this.startAutoCleanup();
    }

    // Register target destroyed listener
    this.cdpClient.addTargetDestroyedListener((targetId) => {
      this.onTargetClosed(targetId);
    });

    // Store storage state config if enabled
    if (this.config.storageState?.enabled) {
      this.storageStateConfig = this.config.storageState;
    }
  }

  /**
   * Get the CDPClient for a specific worker (may be on a different Chrome instance)
   */
  private getCDPClientForWorker(sessionId: string, workerId: string): CDPClient {
    const worker = this.getWorker(sessionId, workerId);
    if (worker?.port) {
      const client = this.cdpFactory.get(worker.port);
      if (client) return client;
    }
    return this.cdpClient;
  }

  /**
   * Start automatic cleanup interval
   */
  private startAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(async () => {
      try {
        const deleted = await this.cleanupInactiveSessions(this.config.sessionTTL);
        if (deleted.length > 0) {
          console.error(`[SessionManager] Auto-cleanup: removed ${deleted.length} inactive session(s)`);
        }
        this.lastCleanupTime = Date.now();
      } catch (error) {
        console.error('[SessionManager] Auto-cleanup error:', error);
      }
    }, this.config.cleanupInterval);

    // Don't prevent process exit
    this.cleanupTimer.unref();
  }

  /**
   * Stop automatic cleanup
   */
  stopAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get session manager statistics
   */
  getStats(): SessionManagerStats {
    let totalTargets = 0;
    let totalWorkers = 0;

    for (const session of this.sessions.values()) {
      totalWorkers += session.workers.size;
      for (const worker of session.workers.values()) {
        totalTargets += worker.targets.size;
      }
      // Also count legacy targets
      totalTargets += session.targets.size;
    }

    const stats: SessionManagerStats = {
      activeSessions: this.sessions.size,
      totalTargets,
      totalWorkers,
      totalSessionsCreated: this.totalSessionsCreated,
      totalSessionsCleaned: this.totalSessionsCleaned,
      uptime: Date.now() - this.startTime,
      lastCleanup: this.lastCleanupTime,
      memoryUsage: process.memoryUsage().heapUsed,
    };

    if (this.connectionPool) {
      stats.connectionPool = this.connectionPool.getStats();
    }

    return stats;
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<SessionManagerConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SessionManagerConfig>): void {
    this.config = { ...this.config, ...config };

    // Restart cleanup timer if interval changed
    if (config.cleanupInterval !== undefined || config.autoCleanup !== undefined) {
      this.stopAutoCleanup();
      if (this.config.autoCleanup) {
        this.startAutoCleanup();
      }
    }
  }

  /**
   * Ensure connected to Chrome
   */
  async ensureConnected(): Promise<void> {
    if (!this.cdpClient.isConnected()) {
      await this.cdpClient.connect();
    }
  }

  // ==================== SESSION MANAGEMENT ====================

  /**
   * Create a new session with a default worker
   */
  async createSession(options: SessionCreateOptions = {}): Promise<Session> {
    await this.ensureConnected();

    const id = options.id || crypto.randomUUID();

    if (this.sessions.has(id)) {
      return this.sessions.get(id)!;
    }

    // Check max sessions limit
    if (this.sessions.size >= this.config.maxSessions) {
      const deleted = await this.cleanupInactiveSessions(this.config.sessionTTL);
      if (deleted.length === 0 && this.sessions.size >= this.config.maxSessions) {
        throw new Error(`Maximum session limit (${this.config.maxSessions}) reached.`);
      }
    }

    const name = options.name || `Session ${id.slice(0, 8)}`;
    const defaultWorkerId = 'default';

    // Create default worker - use default context if configured (shares Chrome profile's cookies)
    // or create isolated browser context for session isolation
    const defaultContext = this.config.useDefaultContext
      ? null  // null means use default browser context (shares cookies with Chrome profile)
      : await this.cdpClient.createBrowserContext();
    const defaultWorker: Worker = {
      id: defaultWorkerId,
      name: 'Default Worker',
      targets: new Set(),
      context: defaultContext,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    const session: Session = {
      id,
      workers: new Map([[defaultWorkerId, defaultWorker]]),
      defaultWorkerId,
      targets: new Set(),  // Legacy support
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      name,
      context: defaultContext,  // Legacy support
    };

    this.sessions.set(id, session);
    this.totalSessionsCreated++;
    this.emitEvent({ type: 'session:created', sessionId: id, timestamp: Date.now() });

    console.error(`[SessionManager] Created session ${id} with default worker`);
    return session;
  }

  /**
   * Get or create a session
   */
  async getOrCreateSession(sessionId: string): Promise<Session> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = await this.createSession({ id: sessionId });
    }
    return session;
  }

  /**
   * Get an existing session
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Update last activity timestamp
   */
  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Delete a session and clean up all workers
   */
  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Save storage state before cleanup (save first, then stop watchdog)
    const manager = this.storageStateManagers.get(sessionId);
    if (manager) {
      try {
        for (const worker of session.workers.values()) {
          for (const tid of worker.targets) {
            const cdpClient = this.getCDPClientForWorker(sessionId, worker.id);
            const p = await cdpClient.getPageByTargetId(tid);
            if (p) {
              await manager.save(p, cdpClient, this.getStorageStatePath(sessionId));
              break;
            }
          }
        }
      } catch {
        // Best-effort: don't block deletion on storage state errors
      }
      manager.stopWatchdog();
      this.storageStateManagers.delete(sessionId);
    }

    // Delete all workers
    for (const workerId of session.workers.keys()) {
      await this.deleteWorkerInternal(session, workerId);
    }

    // Clean up all worker queues
    for (const workerId of session.workers.keys()) {
      this.queueManager.deleteQueue(`${sessionId}:${workerId}`);
    }
    this.queueManager.deleteQueue(sessionId);

    // Clean up ref IDs
    getRefIdManager().clearSessionRefs(sessionId);

    // Remove session
    this.sessions.delete(sessionId);
    this.emitEvent({ type: 'session:deleted', sessionId, timestamp: Date.now() });

    console.error(`[SessionManager] Deleted session ${sessionId}`);
  }

  /**
   * Clean up inactive sessions
   */
  async cleanupInactiveSessions(maxAgeMs: number): Promise<string[]> {
    const now = Date.now();
    const deletedSessions: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActivityAt > maxAgeMs) {
        await this.deleteSession(sessionId);
        deletedSessions.push(sessionId);
        this.totalSessionsCleaned++;
      }
    }

    // Trigger browser-level GC after bulk cleanup
    if (deletedSessions.length > 0) {
      try {
        const pages = await this.cdpClient.getPages();
        if (pages.length > 0) {
          await this.cdpClient.triggerGC(pages[0]);
        }
      } catch {
        // Best-effort GC
      }
    }

    return deletedSessions;
  }

  /**
   * Force cleanup all sessions
   */
  async cleanupAllSessions(): Promise<number> {
    const count = this.sessions.size;
    const sessionIds = Array.from(this.sessions.keys());

    for (const sessionId of sessionIds) {
      await this.deleteSession(sessionId);
      this.totalSessionsCleaned++;
    }

    // Clean up Chrome pool and factory connections
    if (this.chromePool) {
      await this.chromePool.cleanup();
    }
    await this.cdpFactory.disconnectAll();

    return count;
  }

  // ==================== WORKER MANAGEMENT ====================

  /**
   * Create a new worker within a session
   * Each worker has its own isolated browser context (cookies, localStorage, etc.)
   */
  async createWorker(sessionId: string, options: WorkerCreateOptions = {}): Promise<Worker> {
    await this.ensureConnected();

    const session = await this.getOrCreateSession(sessionId);

    // Check max workers limit
    if (session.workers.size >= this.config.maxWorkersPerSession) {
      throw new Error(`Maximum workers per session (${this.config.maxWorkersPerSession}) reached.`);
    }

    const workerId = options.id || `worker-${crypto.randomUUID().slice(0, 8)}`;

    if (session.workers.has(workerId)) {
      return session.workers.get(workerId)!;
    }

    const name = options.name || `Worker ${workerId}`;

    // Create browser context: shared (null = copies cookies from Chrome profile) or isolated
    const context = options.shareCookies
      ? null
      : await this.cdpClient.createBrowserContext();

    // If pool is enabled and targetUrl provided, acquire a separate Chrome instance
    let workerPort: number | undefined;
    let workerPoolOrigin: string | undefined;
    if (this.chromePool && options.targetUrl) {
      try {
        const origin = new URL(options.targetUrl).origin;
        const poolInstance = await this.chromePool.acquireInstance(origin);
        workerPort = poolInstance.port;
        workerPoolOrigin = origin;

        // Ensure CDPClient for this port is connected
        const workerCdpClient = this.cdpFactory.getOrCreate(workerPort, {
          autoLaunch: getGlobalConfig().autoLaunch,
        });
        if (!workerCdpClient.isConnected()) {
          await workerCdpClient.connect();
        }

        console.error(`[SessionManager] Worker ${workerId} assigned to Chrome instance on port ${workerPort} for origin ${origin}`);
      } catch (err) {
        console.error(`[SessionManager] Pool acquisition failed, falling back to default:`, err);
        workerPort = undefined;
        workerPoolOrigin = undefined;
      }
    }

    const worker: Worker = {
      id: workerId,
      name,
      targets: new Set(),
      context,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      port: workerPort,
      poolOrigin: workerPoolOrigin,
    };

    session.workers.set(workerId, worker);
    this.touchSession(sessionId);

    this.emitEvent({
      type: 'worker:created',
      sessionId,
      workerId,
      timestamp: Date.now(),
    });

    console.error(`[SessionManager] Created worker ${workerId} in session ${sessionId}`);
    return worker;
  }

  /**
   * Get a worker by ID
   */
  getWorker(sessionId: string, workerId: string): Worker | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return session.workers.get(workerId);
  }

  /**
   * Get or create a worker
   */
  async getOrCreateWorker(sessionId: string, workerId?: string): Promise<Worker> {
    const session = await this.getOrCreateSession(sessionId);

    // If no workerId specified, use default worker
    const targetWorkerId = workerId || session.defaultWorkerId;

    let worker = session.workers.get(targetWorkerId);
    if (!worker) {
      worker = await this.createWorker(sessionId, { id: targetWorkerId });
    }

    return worker;
  }

  /**
   * List all workers in a session
   */
  getWorkers(sessionId: string): WorkerInfo[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const workers: WorkerInfo[] = [];
    for (const worker of session.workers.values()) {
      workers.push({
        id: worker.id,
        name: worker.name,
        targetCount: worker.targets.size,
        createdAt: worker.createdAt,
        lastActivityAt: worker.lastActivityAt,
      });
    }

    return workers;
  }

  /**
   * Delete a worker and its resources
   */
  async deleteWorker(sessionId: string, workerId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Can't delete default worker
    if (workerId === session.defaultWorkerId) {
      throw new Error('Cannot delete the default worker. Delete the session instead.');
    }

    await this.deleteWorkerInternal(session, workerId);

    this.emitEvent({
      type: 'worker:deleted',
      sessionId,
      workerId,
      timestamp: Date.now(),
    });
  }

  /**
   * Internal worker deletion (also used for cleanup)
   */
  private async deleteWorkerInternal(session: Session, workerId: string): Promise<void> {
    const worker = session.workers.get(workerId);
    if (!worker) return;

    // Determine which CDPClient to use for this worker
    const workerCdpClient = worker.port
      ? (this.cdpFactory.get(worker.port) || this.cdpClient)
      : this.cdpClient;

    // Close all pages in this worker (return to pool if available)
    for (const targetId of worker.targets) {
      try {
        if (this.connectionPool && this.config.useConnectionPool) {
          const page = await workerCdpClient.getPageByTargetId(targetId);
          if (page && !page.isClosed()) {
            await this.connectionPool.releasePage(page);
          } else {
            await workerCdpClient.closePage(targetId);
          }
        } else {
          await workerCdpClient.closePage(targetId);
        }
      } catch {
        // Page might already be closed
      }
      this.targetToWorker.delete(targetId);
    }

    // Close the browser context (only if it's an isolated context, not the default)
    if (worker.context) {
      try {
        await workerCdpClient.closeBrowserContext(worker.context);
      } catch {
        // Context might already be closed
      }
    }

    // Release Chrome pool instance if worker had one
    if (worker.port && worker.poolOrigin && this.chromePool) {
      this.chromePool.releaseInstance(worker.port, worker.poolOrigin);
      console.error(`[SessionManager] Released pool instance port ${worker.port} for origin ${worker.poolOrigin}`);
    }

    // Clean up ref IDs for this worker
    for (const targetId of worker.targets) {
      getRefIdManager().clearTargetRefs(session.id, targetId);
    }

    session.workers.delete(workerId);
    console.error(`[SessionManager] Deleted worker ${workerId} from session ${session.id}`);
  }

  // ==================== TARGET/PAGE MANAGEMENT ====================

  /**
   * Create a new page/target for a worker
   * @param sessionId Session ID
   * @param url Optional URL to navigate to
   * @param workerId Optional worker ID (uses default worker if not specified)
   */
  async createTarget(
    sessionId: string,
    url?: string,
    workerId?: string
  ): Promise<{ targetId: string; page: Page; workerId: string }> {
    await this.ensureConnected();

    const worker = await this.getOrCreateWorker(sessionId, workerId);

    // Create page — try connection pool first for pre-warmed pages, fall back to direct creation
    const cdpClient = this.getCDPClientForWorker(sessionId, worker.id);
    let page: Page;

    // Snapshot existing target IDs before page creation.
    // Chrome's Site Isolation can create orphan about:blank targets during cross-origin
    // navigation (renderer process swap). We detect and close these after navigation.
    const existingTargetIds = new Set(
      cdpClient.getBrowser().targets()
        .filter(t => t.type() === 'page')
        .map(t => getTargetId(t))
    );

    if (this.connectionPool && this.config.useConnectionPool) {
      let poolPage: Page | null = null;
      try {
        poolPage = await this.connectionPool.acquirePage();
        // Navigate the pre-warmed page to the target URL
        if (url) {
          await smartGoto(poolPage, url, { timeout: 30000 });
        }
        // Copy cookies from the worker's browser context if available
        // (pool pages start blank — replicate what cdpClient.createPage() does for contexts)
        if (worker.context) {
          try {
            const cookies = await worker.context.cookies();
            if (cookies.length > 0) {
              await poolPage.setCookie(...cookies);
            }
          } catch {
            // Best-effort cookie copy
          }
        }
        page = poolPage;
        console.error(`[SessionManager] Acquired page from pool for session ${sessionId}`);
      } catch (err) {
        // Close the acquired pool page to prevent about:blank ghost tabs.
        // Close first (removes from Chrome), then release (cleans pool tracking).
        // Do NOT just releasePage — that returns it to pool as about:blank.
        if (poolPage) {
          await poolPage.close().catch(() => {});
          this.connectionPool.releasePage(poolPage).catch(() => {});
        }
        console.error(`[SessionManager] Pool acquire/navigate failed, falling back to direct creation:`, err);
        page = await cdpClient.createPage(url, worker.context);
      }
    } else {
      page = await cdpClient.createPage(url, worker.context);
    }

    const targetId = getTargetId(page.target());

    // Clean up orphan about:blank targets created by Chrome during navigation.
    // Chrome's Site Isolation creates temporary renderer targets during cross-origin
    // navigation (about:blank → real URL) that can persist as ghost tabs.
    // Runs after a brief delay to catch async target creation by Chrome.
    const cleanupExistingIds = existingTargetIds;
    const cleanupTargetId = targetId;
    const cleanupBrowser = cdpClient.getBrowser();
    setTimeout(async () => {
      try {
        const orphans = cleanupBrowser.targets().filter(t =>
          t.type() === 'page' &&
          t.url() === 'about:blank' &&
          !cleanupExistingIds.has(getTargetId(t)) &&
          getTargetId(t) !== cleanupTargetId &&
          !this.targetToWorker.has(getTargetId(t))
        );
        for (const t of orphans) {
          try {
            const orphanPage = await t.page();
            if (orphanPage && !orphanPage.isClosed()) {
              await orphanPage.close();
              console.error(`[SessionManager] Closed orphan about:blank ghost tab: ${getTargetId(t)}`);
            }
          } catch { /* target may already be destroyed */ }
        }
      } catch { /* best-effort cleanup */ }
    }, 500);

    worker.targets.add(targetId);
    worker.lastActivityAt = Date.now();

    this.targetToWorker.set(targetId, { sessionId, workerId: worker.id });

    this.emitEvent({
      type: 'session:target-added',
      sessionId,
      workerId: worker.id,
      targetId,
      timestamp: Date.now(),
    });

    this.touchSession(sessionId);

    // Restore storage state on first target for this session
    const session = this.sessions.get(sessionId)!;
    const allTargetsCount = Array.from(session.workers.values()).reduce((sum, w) => sum + w.targets.size, 0);
    if (this.storageStateConfig?.enabled && allTargetsCount === 1) {
      try {
        const ssManager = new StorageStateManager();
        this.storageStateManagers.set(sessionId, ssManager);
        const filePath = this.getStorageStatePath(sessionId);
        await ssManager.restore(page, this.cdpClient, filePath);

        const intervalMs = this.storageStateConfig?.watchdogIntervalMs || 30000;
        ssManager.startWatchdog(page, this.cdpClient, {
          intervalMs,
          filePath,
        });
      } catch {
        // Best-effort: don't block session creation on storage state errors
      }
    }

    return { targetId, page, workerId: worker.id };
  }

  /**
   * Register a pre-acquired page as a target for a worker.
   * Used by workflow engine when pages are batch-acquired from the pool
   * to avoid per-page replenishment (about:blank proliferation fix).
   */
  registerExistingTarget(sessionId: string, workerId: string, targetId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const worker = session.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found in session ${sessionId}`);
    }

    worker.targets.add(targetId);
    worker.lastActivityAt = Date.now();
    this.targetToWorker.set(targetId, { sessionId, workerId });

    this.emitEvent({
      type: 'session:target-added',
      sessionId,
      workerId,
      targetId,
      timestamp: Date.now(),
    });

    this.touchSession(sessionId);
  }

  /**
   * Check if a target is still valid (page not closed)
   */
  async isTargetValid(targetId: string): Promise<boolean> {
    try {
      const page = await this.cdpClient.getPageByTargetId(targetId);
      return page !== null && !page.isClosed();
    } catch {
      return false;
    }
  }

  /**
   * Get page for a target
   * @param sessionId Session ID
   * @param targetId Target/Tab ID
   * @param workerId Optional worker ID for validation
   * @param toolName Optional MCP tool name for hybrid BrowserRouter routing
   */
  async getPage(sessionId: string, targetId: string, workerId?: string, toolName?: string): Promise<Page | null> {
    const ownerInfo = this.targetToWorker.get(targetId);

    if (!ownerInfo || ownerInfo.sessionId !== sessionId) {
      throw new Error(`Target ${targetId} does not belong to session ${sessionId}`);
    }

    if (workerId && ownerInfo.workerId !== workerId) {
      throw new Error(`Target ${targetId} does not belong to worker ${workerId}`);
    }

    const cdpClient = this.getCDPClientForWorker(sessionId, ownerInfo.workerId);

    // Validate target is still valid
    try {
      const page = await cdpClient.getPageByTargetId(targetId);
      if (!page || page.isClosed()) {
        this.onTargetClosed(targetId);
        return null;
      }

      // Route through BrowserRouter if hybrid mode is active and toolName provided
      if (this.browserRouter && toolName) {
        const result = await this.browserRouter.route(toolName, page);
        return result.page;
      }

      return page;
    } catch {
      this.onTargetClosed(targetId);
      return null;
    }
  }

  /**
   * Get all pages for a worker
   */
  async getWorkerPages(sessionId: string, workerId: string): Promise<Page[]> {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker) return [];

    const cdpClient = this.getCDPClientForWorker(sessionId, workerId);
    const pages: Page[] = [];
    for (const targetId of worker.targets) {
      const page = await cdpClient.getPageByTargetId(targetId);
      if (page) {
        pages.push(page);
      }
    }

    return pages;
  }

  /**
   * Get target IDs for a session (all workers)
   */
  getSessionTargetIds(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const allTargets: string[] = [];
    for (const worker of session.workers.values()) {
      allTargets.push(...worker.targets);
    }

    return allTargets;
  }

  /**
   * Get target IDs for a specific worker
   */
  getWorkerTargetIds(sessionId: string, workerId: string): string[] {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker) return [];
    return Array.from(worker.targets);
  }

  /**
   * Validate target ownership (legacy method, checks session only)
   */
  validateTargetOwnership(sessionId: string, targetId: string): boolean {
    const ownerInfo = this.targetToWorker.get(targetId);
    return ownerInfo?.sessionId === sessionId;
  }

  /**
   * Get the worker ID that owns a target
   */
  getTargetWorkerId(targetId: string): string | undefined {
    return this.targetToWorker.get(targetId)?.workerId;
  }

  /**
   * Close a specific target/tab
   * @param sessionId Session ID
   * @param targetId Target/Tab ID to close
   * @returns true if closed, false if not found
   */
  async closeTarget(sessionId: string, targetId: string): Promise<boolean> {
    const ownerInfo = this.targetToWorker.get(targetId);

    if (!ownerInfo || ownerInfo.sessionId !== sessionId) {
      return false;
    }

    try {
      // Close the page via CDP (use worker's CDPClient if on pool)
      const cdpClient = this.getCDPClientForWorker(sessionId, ownerInfo.workerId);

      if (this.connectionPool && this.config.useConnectionPool) {
        // Return the page to the pool for reuse instead of destroying it
        try {
          const page = await cdpClient.getPageByTargetId(targetId);
          if (page && !page.isClosed()) {
            await this.connectionPool.releasePage(page);
          } else {
            await cdpClient.closePage(targetId);
          }
        } catch {
          // If pool release fails, fall back to direct close
          await cdpClient.closePage(targetId);
        }
      } else {
        // closePage() already triggers GC internally before closing
        await cdpClient.closePage(targetId);
      }

      // Clean up internal state
      const session = this.sessions.get(sessionId);
      if (session) {
        const worker = session.workers.get(ownerInfo.workerId);
        if (worker) {
          worker.targets.delete(targetId);
        }
      }

      // Clean up ref IDs
      getRefIdManager().clearTargetRefs(sessionId, targetId);

      // Remove from mapping
      this.targetToWorker.delete(targetId);

      this.emitEvent({
        type: 'session:target-closed',
        sessionId,
        workerId: ownerInfo.workerId,
        targetId,
        timestamp: Date.now(),
      });

      return true;
    } catch (error) {
      // Page might already be closed
      this.onTargetClosed(targetId);
      return true;
    }
  }

  /**
   * Close all tabs in a worker (without deleting the worker)
   * @param sessionId Session ID
   * @param workerId Worker ID
   * @returns Number of tabs closed
   */
  async closeWorkerTabs(sessionId: string, workerId: string): Promise<number> {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker) return 0;

    const targetIds = Array.from(worker.targets);
    let closedCount = 0;

    for (const targetId of targetIds) {
      if (await this.closeTarget(sessionId, targetId)) {
        closedCount++;
      }
    }

    return closedCount;
  }

  /**
   * Execute a CDP command through the session's queue
   */
  async executeCDP<T = unknown>(
    sessionId: string,
    targetId: string,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    if (!this.validateTargetOwnership(sessionId, targetId)) {
      throw new Error(`Target ${targetId} does not belong to session ${sessionId}`);
    }

    this.touchSession(sessionId);

    const ownerInfo = this.targetToWorker.get(targetId);
    const cdpClient = ownerInfo
      ? this.getCDPClientForWorker(sessionId, ownerInfo.workerId)
      : this.cdpClient;

    const workerQueueKey = ownerInfo ? `${sessionId}:${ownerInfo.workerId}` : sessionId;
    return this.queueManager.enqueue(workerQueueKey, async () => {
      const page = await cdpClient.getPageByTargetId(targetId);
      if (!page) {
        throw new Error(`Page not found for target ${targetId}`);
      }
      return cdpClient.send<T>(page, method, params);
    });
  }

  /**
   * Handle target closed event
   */
  onTargetClosed(targetId: string): void {
    const ownerInfo = this.targetToWorker.get(targetId);
    if (ownerInfo) {
      const session = this.sessions.get(ownerInfo.sessionId);
      if (session) {
        const worker = session.workers.get(ownerInfo.workerId);
        if (worker) {
          worker.targets.delete(targetId);
        }
        this.targetToWorker.delete(targetId);

        this.emitEvent({
          type: 'session:target-removed',
          sessionId: ownerInfo.sessionId,
          workerId: ownerInfo.workerId,
          targetId,
          timestamp: Date.now(),
        });
      }
    }
  }

  // ==================== SESSION INFO ====================

  /**
   * Get session info (for serialization)
   */
  getSessionInfo(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    let totalTargets = 0;
    const workers: WorkerInfo[] = [];

    for (const worker of session.workers.values()) {
      totalTargets += worker.targets.size;
      workers.push({
        id: worker.id,
        name: worker.name,
        targetCount: worker.targets.size,
        createdAt: worker.createdAt,
        lastActivityAt: worker.lastActivityAt,
      });
    }

    return {
      id: session.id,
      targetCount: totalTargets,
      workerCount: session.workers.size,
      workers,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      name: session.name,
    };
  }

  /**
   * Get all session infos
   */
  getAllSessionInfos(): SessionInfo[] {
    const infos: SessionInfo[] = [];
    for (const sessionId of this.sessions.keys()) {
      const info = this.getSessionInfo(sessionId);
      if (info) {
        infos.push(info);
      }
    }
    return infos;
  }

  // ==================== EVENT HANDLING ====================

  /**
   * Add event listener
   */
  addEventListener(listener: (event: SessionEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Remove event listener
   */
  removeEventListener(listener: (event: SessionEvent) => void): void {
    const index = this.eventListeners.indexOf(listener);
    if (index !== -1) {
      this.eventListeners.splice(index, 1);
    }
  }

  /**
   * Emit event to all listeners
   */
  private emitEvent(event: SessionEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Session event listener error:', e);
      }
    }
  }

  /**
   * Get the number of active sessions
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get the storage state file path for a session
   */
  private getStorageStatePath(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new Error(`Invalid sessionId for storage path: ${sessionId}`);
    }
    const dir = this.storageStateConfig?.dir || '.openchrome/storage-state';
    return path.join(dir, `${sessionId}.json`);
  }

  /**
   * Get CDPClient
   */
  getCDPClient(): CDPClient {
    return this.cdpClient;
  }

  /**
   * Initialize hybrid mode with BrowserRouter
   */
  async initHybrid(config: HybridConfig): Promise<void> {
    if (this.browserRouter) return; // Already initialized
    this.browserRouter = new BrowserRouter(config);
    await this.browserRouter.initialize();
    console.error('[SessionManager] Hybrid mode initialized');
  }

  /**
   * Get the BrowserRouter (for stats/escalation)
   */
  getBrowserRouter(): BrowserRouter | null {
    return this.browserRouter;
  }

  /**
   * Cleanup hybrid mode
   */
  async cleanupHybrid(): Promise<void> {
    if (this.browserRouter) {
      await this.browserRouter.cleanup();
      this.browserRouter = null;
      console.error('[SessionManager] Hybrid mode cleaned up');
    }
  }
}

// Singleton instance
let sessionManagerInstance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManagerInstance) {
    // Read storage state config from environment variables
    // These are set by CLI (cli/index.ts) before server startup
    const storageState = process.env.OC_PERSIST_STORAGE === '1'
      ? {
          enabled: true as const,
          dir: process.env.OC_STORAGE_DIR || undefined,
        }
      : undefined;

    sessionManagerInstance = new SessionManager(undefined, {
      storageState,
    });
  }
  return sessionManagerInstance;
}

/** Reset singleton for testing. Do not use in production code. */
export function _resetSessionManagerForTesting(): void {
  sessionManagerInstance = null;
}
