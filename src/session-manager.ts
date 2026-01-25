/**
 * Session Manager - Manages lifecycle of parallel Claude Code sessions
 */

import { Page, Target } from 'puppeteer-core';
import { Session, SessionInfo, SessionCreateOptions, SessionEvent } from './types/session';
import { CDPClient, getCDPClient } from './cdp/client';
import { CDPConnectionPool, getCDPConnectionPool, PoolStats } from './cdp/connection-pool';
import { RequestQueueManager } from './utils/request-queue';
import { getRefIdManager } from './utils/ref-id-manager';

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
  /** Use connection pool for page management (default: true) */
  useConnectionPool?: boolean;
}

export interface SessionManagerStats {
  activeSessions: number;
  totalTargets: number;
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
  useConnectionPool: true,
};

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private targetToSession: Map<string, string> = new Map();
  private cdpClient: CDPClient;
  private connectionPool: CDPConnectionPool | null = null;
  private queueManager: RequestQueueManager;
  private eventListeners: ((event: SessionEvent) => void)[] = [];

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

    if (this.config.useConnectionPool) {
      this.connectionPool = getCDPConnectionPool();
    }

    if (this.config.autoCleanup) {
      this.startAutoCleanup();
    }
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
    for (const session of this.sessions.values()) {
      totalTargets += session.targets.size;
    }

    const stats: SessionManagerStats = {
      activeSessions: this.sessions.size,
      totalTargets,
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

  /**
   * Create a new session
   */
  async createSession(options: SessionCreateOptions = {}): Promise<Session> {
    await this.ensureConnected();

    const id = options.id || crypto.randomUUID();

    if (this.sessions.has(id)) {
      return this.sessions.get(id)!;
    }

    // Check max sessions limit
    if (this.sessions.size >= this.config.maxSessions) {
      // Try to cleanup old sessions first
      const deleted = await this.cleanupInactiveSessions(this.config.sessionTTL);
      if (deleted.length === 0 && this.sessions.size >= this.config.maxSessions) {
        throw new Error(`Maximum session limit (${this.config.maxSessions}) reached. Clean up inactive sessions first.`);
      }
    }

    const name = options.name || `Session ${id.slice(0, 8)}`;

    const session: Session = {
      id,
      targets: new Set(),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      name,
    };

    this.sessions.set(id, session);
    this.totalSessionsCreated++;
    this.emitEvent({ type: 'session:created', sessionId: id, timestamp: Date.now() });

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
   * Delete a session and clean up resources
   */
  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Release or close all pages for this session
    for (const targetId of session.targets) {
      try {
        const page = await this.cdpClient.getPageByTargetId(targetId);
        if (page && this.connectionPool) {
          // Return page to pool for reuse
          await this.connectionPool.releasePage(page);
        } else {
          // Close directly if no pool
          await this.cdpClient.closePage(targetId);
        }
      } catch {
        // Page might already be closed
      }
      this.targetToSession.delete(targetId);
    }

    // Clean up request queue
    this.queueManager.deleteQueue(sessionId);

    // Clean up ref IDs
    getRefIdManager().clearSessionRefs(sessionId);

    // Remove session
    this.sessions.delete(sessionId);
    this.emitEvent({ type: 'session:deleted', sessionId, timestamp: Date.now() });
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

    return count;
  }

  /**
   * Create a new page/target for a session
   */
  async createTarget(sessionId: string, url?: string): Promise<{ targetId: string; page: Page }> {
    await this.ensureConnected();

    const session = await this.getOrCreateSession(sessionId);

    // Use connection pool if available
    let page: Page;
    if (this.connectionPool) {
      page = await this.connectionPool.acquirePage();
      if (url) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
      }
    } else {
      page = await this.cdpClient.createPage(url);
    }

    const targetId = getTargetId(page.target());

    session.targets.add(targetId);
    this.targetToSession.set(targetId, sessionId);

    this.emitEvent({
      type: 'session:target-added',
      sessionId,
      targetId,
      timestamp: Date.now(),
    });

    this.touchSession(sessionId);
    return { targetId, page };
  }

  /**
   * Get page for a target
   */
  async getPage(sessionId: string, targetId: string): Promise<Page | null> {
    if (!this.validateTargetOwnership(sessionId, targetId)) {
      throw new Error(`Target ${targetId} does not belong to session ${sessionId}`);
    }

    return this.cdpClient.getPageByTargetId(targetId);
  }

  /**
   * Get all pages for a session
   */
  async getSessionPages(sessionId: string): Promise<Page[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }

    const pages: Page[] = [];
    for (const targetId of session.targets) {
      const page = await this.cdpClient.getPageByTargetId(targetId);
      if (page) {
        pages.push(page);
      }
    }

    return pages;
  }

  /**
   * Get target IDs for a session
   */
  getSessionTargetIds(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }
    return Array.from(session.targets);
  }

  /**
   * Validate target ownership
   */
  validateTargetOwnership(sessionId: string, targetId: string): boolean {
    const owner = this.targetToSession.get(targetId);
    return owner === sessionId;
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
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!this.validateTargetOwnership(sessionId, targetId)) {
      throw new Error(`Target ${targetId} does not belong to session ${sessionId}`);
    }

    this.touchSession(sessionId);

    return this.queueManager.enqueue(sessionId, async () => {
      const page = await this.cdpClient.getPageByTargetId(targetId);
      if (!page) {
        throw new Error(`Page not found for target ${targetId}`);
      }
      return this.cdpClient.send<T>(page, method, params);
    });
  }

  /**
   * Remove a target from a session
   */
  async removeTarget(sessionId: string, targetId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.targets.delete(targetId);
    this.targetToSession.delete(targetId);

    // Clean up ref IDs for this target
    getRefIdManager().clearTargetRefs(sessionId, targetId);

    this.emitEvent({
      type: 'session:target-removed',
      sessionId,
      targetId,
      timestamp: Date.now(),
    });

    this.touchSession(sessionId);
  }

  /**
   * Get session info (for serialization)
   */
  getSessionInfo(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    return {
      id: session.id,
      targetCount: session.targets.size,
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
    for (const session of this.sessions.values()) {
      infos.push({
        id: session.id,
        targetCount: session.targets.size,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        name: session.name,
      });
    }
    return infos;
  }

  /**
   * Handle target closed event
   */
  onTargetClosed(targetId: string): void {
    const sessionId = this.targetToSession.get(targetId);
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.targets.delete(targetId);
        this.targetToSession.delete(targetId);
        this.emitEvent({
          type: 'session:target-removed',
          sessionId,
          targetId,
          timestamp: Date.now(),
        });
      }
    }
  }

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
   * Get CDPClient
   */
  getCDPClient(): CDPClient {
    return this.cdpClient;
  }
}

// Singleton instance
let sessionManagerInstance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManagerInstance) {
    sessionManagerInstance = new SessionManager();
  }
  return sessionManagerInstance;
}
