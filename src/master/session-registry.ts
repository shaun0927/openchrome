/**
 * Session Registry - Central session management for Master process
 * Wraps the existing SessionManager to add worker tracking
 */

import { SessionManager } from '../session-manager';
import { CDPClient, getCDPClient } from '../cdp/client';
import { getRefIdManager } from '../utils/ref-id-manager';

interface WorkerSession {
  sessionId: string;
  workerId: string;
}

export class SessionRegistry {
  private sessionManager: SessionManager;
  private workerSessions: Map<string, Set<string>> = new Map(); // workerId -> sessionIds
  private sessionWorker: Map<string, string> = new Map(); // sessionId -> workerId

  constructor(cdpClient?: CDPClient) {
    this.sessionManager = new SessionManager(cdpClient || getCDPClient());
  }

  /**
   * Ensure connected to Chrome
   */
  async ensureConnected(): Promise<void> {
    await this.sessionManager.ensureConnected();
  }

  /**
   * Create a new session for a worker
   */
  async createSession(workerId: string, options?: { name?: string }): Promise<{ id: string; name: string }> {
    const session = await this.sessionManager.createSession(options);

    // Track worker ownership
    let workerSessionSet = this.workerSessions.get(workerId);
    if (!workerSessionSet) {
      workerSessionSet = new Set();
      this.workerSessions.set(workerId, workerSessionSet);
    }
    workerSessionSet.add(session.id);
    this.sessionWorker.set(session.id, workerId);

    console.error(`[SessionRegistry] Created session ${session.id} for worker ${workerId}`);
    return { id: session.id, name: session.name };
  }

  /**
   * Get session info
   */
  getSession(sessionId: string) {
    return this.sessionManager.getSessionInfo(sessionId);
  }

  /**
   * List all sessions
   */
  listSessions() {
    return this.sessionManager.getAllSessionInfos();
  }

  /**
   * List sessions for a specific worker
   */
  listWorkerSessions(workerId: string) {
    const sessionIds = this.workerSessions.get(workerId);
    if (!sessionIds) return [];

    return Array.from(sessionIds)
      .map(id => this.sessionManager.getSessionInfo(id))
      .filter(info => info !== undefined);
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    const workerId = this.sessionWorker.get(sessionId);
    if (workerId) {
      const workerSessions = this.workerSessions.get(workerId);
      if (workerSessions) {
        workerSessions.delete(sessionId);
      }
      this.sessionWorker.delete(sessionId);
    }

    await this.sessionManager.deleteSession(sessionId);
  }

  /**
   * Create a new target (tab) for a session
   */
  async createTarget(sessionId: string, url?: string) {
    const result = await this.sessionManager.createTarget(sessionId, url);
    return {
      targetId: result.targetId,
      url: result.page.url(),
      title: await result.page.title(),
    };
  }

  /**
   * List targets for a session
   */
  async listTargets(sessionId: string) {
    const pages = await this.sessionManager.getSessionPages(sessionId);
    const targets = [];

    for (const page of pages) {
      const target = page.target();
      const targetId = (target as unknown as { _targetId: string })._targetId;
      targets.push({
        targetId,
        url: page.url(),
        title: await page.title(),
      });
    }

    return targets;
  }

  /**
   * Close a target
   */
  async closeTarget(sessionId: string, targetId: string): Promise<void> {
    await this.sessionManager.removeTarget(sessionId, targetId);
    await this.sessionManager.getCDPClient().closePage(targetId);
  }

  /**
   * Navigate a page
   */
  async navigate(sessionId: string, targetId: string, url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void> {
    const page = await this.sessionManager.getPage(sessionId, targetId);
    if (!page) throw new Error(`Page not found: ${targetId}`);

    await page.goto(url, {
      waitUntil: (options?.waitUntil as 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2') || 'domcontentloaded',
      timeout: options?.timeout || 30000,
    });
  }

  /**
   * Take a screenshot
   */
  async screenshot(sessionId: string, targetId: string, options?: { format?: string; quality?: number; fullPage?: boolean }): Promise<string> {
    const page = await this.sessionManager.getPage(sessionId, targetId);
    if (!page) throw new Error(`Page not found: ${targetId}`);

    const buffer = await page.screenshot({
      type: (options?.format as 'png' | 'jpeg' | 'webp') || 'png',
      quality: options?.format === 'jpeg' ? (options?.quality || 80) : undefined,
      fullPage: options?.fullPage || false,
      encoding: 'base64',
    });

    return buffer as string;
  }

  /**
   * Evaluate JavaScript
   */
  async evaluate<T>(sessionId: string, targetId: string, script: string): Promise<T> {
    const page = await this.sessionManager.getPage(sessionId, targetId);
    if (!page) throw new Error(`Page not found: ${targetId}`);

    return page.evaluate(script) as Promise<T>;
  }

  /**
   * Click at coordinates
   */
  async click(sessionId: string, targetId: string, x: number, y: number): Promise<void> {
    const page = await this.sessionManager.getPage(sessionId, targetId);
    if (!page) throw new Error(`Page not found: ${targetId}`);

    await page.mouse.click(x, y);
  }

  /**
   * Type text
   */
  async type(sessionId: string, targetId: string, text: string): Promise<void> {
    const page = await this.sessionManager.getPage(sessionId, targetId);
    if (!page) throw new Error(`Page not found: ${targetId}`);

    await page.keyboard.type(text);
  }

  /**
   * Scroll
   */
  async scroll(sessionId: string, targetId: string, x: number, y: number, direction: string, amount: number): Promise<void> {
    const page = await this.sessionManager.getPage(sessionId, targetId);
    if (!page) throw new Error(`Page not found: ${targetId}`);

    await page.mouse.move(x, y);

    let deltaX = 0;
    let deltaY = 0;
    const scrollAmount = amount * 100;

    switch (direction) {
      case 'up': deltaY = -scrollAmount; break;
      case 'down': deltaY = scrollAmount; break;
      case 'left': deltaX = -scrollAmount; break;
      case 'right': deltaX = scrollAmount; break;
    }

    await page.mouse.wheel({ deltaX, deltaY });
  }

  /**
   * Execute CDP command
   */
  async executeCDP<T>(sessionId: string, targetId: string, method: string, params?: Record<string, unknown>): Promise<T> {
    return this.sessionManager.executeCDP<T>(sessionId, targetId, method, params);
  }

  /**
   * Get accessibility tree
   */
  async getAccessibilityTree(sessionId: string, targetId: string): Promise<unknown> {
    return this.sessionManager.executeCDP(sessionId, targetId, 'Accessibility.getFullAXTree');
  }

  /**
   * Clean up all sessions for a disconnected worker
   */
  async cleanupWorker(workerId: string): Promise<void> {
    const sessionIds = this.workerSessions.get(workerId);
    if (!sessionIds) return;

    console.error(`[SessionRegistry] Cleaning up ${sessionIds.size} sessions for worker ${workerId}`);

    for (const sessionId of sessionIds) {
      try {
        await this.sessionManager.deleteSession(sessionId);
        this.sessionWorker.delete(sessionId);
      } catch (error) {
        console.error(`[SessionRegistry] Error deleting session ${sessionId}:`, error);
      }
    }

    this.workerSessions.delete(workerId);
  }

  /**
   * Get ref ID manager
   */
  getRefIdManager() {
    return getRefIdManager();
  }

  /**
   * Get underlying session manager
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      sessions: this.sessionManager.sessionCount,
      workers: this.workerSessions.size,
    };
  }
}
