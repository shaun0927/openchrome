/**
 * Session Manager - Manages lifecycle of parallel Claude Code sessions
 */

import type { Session, SessionCreateOptions, SessionInfo, SessionEvent } from './types/session';
import { TAB_GROUP_COLORS } from './types/session';
import { TabGroupManager } from './tab-group-manager';
import { CDPConnectionPool } from './cdp-pool';
import { RequestQueueManager } from './request-queue';

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private tabGroupManager: TabGroupManager;
  private cdpPool: CDPConnectionPool;
  private queueManager: RequestQueueManager;
  private eventListeners: ((event: SessionEvent) => void)[] = [];
  private colorIndex = 0;

  constructor(
    tabGroupManager: TabGroupManager,
    cdpPool: CDPConnectionPool,
    queueManager: RequestQueueManager
  ) {
    this.tabGroupManager = tabGroupManager;
    this.cdpPool = cdpPool;
    this.queueManager = queueManager;
  }

  /**
   * Create a new session
   */
  async createSession(options: SessionCreateOptions = {}): Promise<Session> {
    const id = options.id || crypto.randomUUID();

    // Check if session already exists
    if (this.sessions.has(id)) {
      return this.sessions.get(id)!;
    }

    const color = options.color || this.getNextColor();
    const name = options.name || `Session ${id.slice(0, 8)}`;

    const session: Session = {
      id,
      tabGroupId: -1,
      tabs: new Set(),
      cdpConnections: new Map(),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      name,
      color,
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

    // Clean up CDP connections
    await this.cdpPool.detachAll(sessionId);

    // Clean up tab group
    await this.tabGroupManager.deleteTabGroup(sessionId);

    // Clean up request queue
    this.queueManager.deleteQueue(sessionId);

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
   * Ensure session has a tab group
   */
  async ensureTabGroup(sessionId: string): Promise<number> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.tabGroupId === -1) {
      const groupId = await this.tabGroupManager.createTabGroup(sessionId, session.name);
      session.tabGroupId = groupId;

      // The createTabGroup creates an initial tab, get it
      const tabs = await this.tabGroupManager.getTabsInGroup(sessionId);
      for (const tab of tabs) {
        if (tab.id) {
          session.tabs.add(tab.id);
        }
      }
    }

    return session.tabGroupId;
  }

  /**
   * Create a new tab in the session
   */
  async createTab(sessionId: string, url?: string): Promise<chrome.tabs.Tab> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Ensure tab group exists
    await this.ensureTabGroup(sessionId);

    const tab = await this.tabGroupManager.createTabInGroup(sessionId, url);
    if (tab.id) {
      session.tabs.add(tab.id);
      this.emitEvent({
        type: 'session:tab-added',
        sessionId,
        tabId: tab.id,
        timestamp: Date.now(),
      });
    }

    this.touchSession(sessionId);
    return tab;
  }

  /**
   * Add an existing tab to a session
   */
  async addTab(sessionId: string, tabId: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Ensure tab group exists
    await this.ensureTabGroup(sessionId);

    await this.tabGroupManager.addTabToGroup(tabId, sessionId);
    session.tabs.add(tabId);

    this.emitEvent({
      type: 'session:tab-added',
      sessionId,
      tabId,
      timestamp: Date.now(),
    });

    this.touchSession(sessionId);
  }

  /**
   * Remove a tab from a session
   */
  async removeTab(sessionId: string, tabId: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Detach CDP if connected
    await this.cdpPool.detach(sessionId, tabId);

    session.tabs.delete(tabId);
    session.cdpConnections.delete(tabId);

    this.emitEvent({
      type: 'session:tab-removed',
      sessionId,
      tabId,
      timestamp: Date.now(),
    });

    this.touchSession(sessionId);
  }

  /**
   * Get tabs for a session
   */
  async getSessionTabs(sessionId: string): Promise<chrome.tabs.Tab[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }

    return this.tabGroupManager.getTabsInGroup(sessionId);
  }

  /**
   * Validate tab ownership
   */
  validateTabOwnership(sessionId: string, tabId: number): boolean {
    return this.tabGroupManager.validateTabOwnership(sessionId, tabId);
  }

  /**
   * Execute a CDP command through the session's queue
   */
  async executeCDP<T = unknown>(
    sessionId: string,
    tabId: number,
    method: string,
    params?: object
  ): Promise<T> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Validate tab ownership
    if (!session.tabs.has(tabId) && !this.tabGroupManager.validateTabOwnership(sessionId, tabId)) {
      throw new Error(`Tab ${tabId} does not belong to session ${sessionId}`);
    }

    this.touchSession(sessionId);

    // Execute through the session's queue
    return this.queueManager.enqueue(sessionId, async () => {
      return this.cdpPool.execute<T>(sessionId, tabId, method, params);
    });
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
      tabGroupId: session.tabGroupId,
      tabCount: session.tabs.size,
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
        tabGroupId: session.tabGroupId,
        tabCount: session.tabs.size,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        name: session.name,
      });
    }
    return infos;
  }

  /**
   * Handle tab closed event
   */
  onTabRemoved(tabId: number): void {
    // Find and update session
    for (const [sessionId, session] of this.sessions) {
      if (session.tabs.has(tabId)) {
        session.tabs.delete(tabId);
        session.cdpConnections.delete(tabId);
        this.emitEvent({
          type: 'session:tab-removed',
          sessionId,
          tabId,
          timestamp: Date.now(),
        });
        break;
      }
    }

    this.tabGroupManager.onTabRemoved(tabId);
  }

  /**
   * Handle tab group removed event
   */
  onTabGroupRemoved(groupId: number): void {
    const sessionId = this.tabGroupManager.getSessionForGroup(groupId);
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.tabGroupId = -1;
      }
    }
    this.tabGroupManager.onTabGroupRemoved(groupId);
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
   * Get next color in rotation
   */
  private getNextColor(): chrome.tabGroups.ColorEnum {
    const color = TAB_GROUP_COLORS[this.colorIndex % TAB_GROUP_COLORS.length];
    this.colorIndex++;
    return color;
  }

  /**
   * Get the number of active sessions
   */
  get sessionCount(): number {
    return this.sessions.size;
  }
}
