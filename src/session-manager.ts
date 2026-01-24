/**
 * Session Manager - Manages lifecycle of parallel Claude Code sessions
 */

import { Page, Target } from 'puppeteer-core';
import { Session, SessionInfo, SessionCreateOptions, SessionEvent } from './types/session';
import { CDPClient, getCDPClient } from './cdp/client';
import { RequestQueueManager } from './utils/request-queue';
import { getRefIdManager } from './utils/ref-id-manager';

// Helper to get target ID (internal puppeteer property)
function getTargetId(target: Target): string {
  return (target as unknown as { _targetId: string })._targetId;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private targetToSession: Map<string, string> = new Map();
  private cdpClient: CDPClient;
  private queueManager: RequestQueueManager;
  private eventListeners: ((event: SessionEvent) => void)[] = [];

  constructor(cdpClient?: CDPClient) {
    this.cdpClient = cdpClient || getCDPClient();
    this.queueManager = new RequestQueueManager();
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

    const name = options.name || `Session ${id.slice(0, 8)}`;

    const session: Session = {
      id,
      targets: new Set(),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      name,
    };

    this.sessions.set(id, session);
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

    // Close all pages for this session
    for (const targetId of session.targets) {
      try {
        await this.cdpClient.closePage(targetId);
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
      }
    }

    return deletedSessions;
  }

  /**
   * Create a new page/target for a session
   */
  async createTarget(sessionId: string, url?: string): Promise<{ targetId: string; page: Page }> {
    await this.ensureConnected();

    const session = await this.getOrCreateSession(sessionId);
    const page = await this.cdpClient.createPage(url);
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
