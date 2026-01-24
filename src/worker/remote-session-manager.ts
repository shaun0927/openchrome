/**
 * Remote Session Manager - Proxies session operations to Master via IPC
 * Provides the same interface as SessionManager but delegates to Master
 */

import { IPCClient } from './ipc-client';

export class RemoteSessionManager {
  private currentSessionId: string | null = null;

  constructor(private ipc: IPCClient) {}

  /**
   * Ensure we have a session
   */
  async ensureSession(): Promise<string> {
    if (!this.currentSessionId) {
      const result = await this.createSession();
      this.currentSessionId = result.id;
    }
    return this.currentSessionId;
  }

  /**
   * Create a new session
   */
  async createSession(options?: { name?: string }): Promise<{ id: string; name: string }> {
    const result = await this.ipc.call<{ id: string; name: string }>('session/create', options || {});
    this.currentSessionId = result.id;
    return result;
  }

  /**
   * Get session info
   */
  async getSession(sessionId: string) {
    return this.ipc.call('session/get', { sessionId });
  }

  /**
   * List all sessions
   */
  async listSessions() {
    return this.ipc.call('session/list', {});
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.ipc.call('session/delete', { sessionId });
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
  }

  /**
   * Create a new target (tab)
   */
  async createTarget(sessionId: string, url?: string): Promise<{ targetId: string; url: string; title: string }> {
    return this.ipc.call('tabs/create', { sessionId, url });
  }

  /**
   * List targets for a session
   */
  async listTargets(sessionId: string) {
    return this.ipc.call('tabs/list', { sessionId });
  }

  /**
   * Close a target
   */
  async closeTarget(sessionId: string, targetId: string): Promise<void> {
    await this.ipc.call('tabs/close', { sessionId, targetId });
  }

  /**
   * Navigate a page
   */
  async navigate(sessionId: string, targetId: string, url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void> {
    await this.ipc.call('page/navigate', { sessionId, targetId, url, options });
  }

  /**
   * Take a screenshot
   */
  async screenshot(sessionId: string, targetId: string, options?: { format?: string; quality?: number; fullPage?: boolean }): Promise<string> {
    return this.ipc.call('page/screenshot', { sessionId, targetId, options });
  }

  /**
   * Evaluate JavaScript
   */
  async evaluate<T>(sessionId: string, targetId: string, script: string): Promise<T> {
    return this.ipc.call('page/evaluate', { sessionId, targetId, script });
  }

  /**
   * Click at coordinates
   */
  async click(sessionId: string, targetId: string, x: number, y: number): Promise<void> {
    await this.ipc.call('page/click', { sessionId, targetId, x, y });
  }

  /**
   * Type text
   */
  async type(sessionId: string, targetId: string, text: string): Promise<void> {
    await this.ipc.call('page/type', { sessionId, targetId, text });
  }

  /**
   * Scroll
   */
  async scroll(sessionId: string, targetId: string, x: number, y: number, direction: string, amount: number): Promise<void> {
    await this.ipc.call('page/scroll', { sessionId, targetId, x, y, direction, amount });
  }

  /**
   * Execute CDP command
   */
  async executeCDP<T>(sessionId: string, targetId: string, method: string, params?: Record<string, unknown>): Promise<T> {
    return this.ipc.call('cdp/execute', { sessionId, targetId, method, params });
  }

  /**
   * Get accessibility tree
   */
  async getAccessibilityTree(sessionId: string, targetId: string): Promise<unknown> {
    return this.ipc.call('page/getAccessibilityTree', { sessionId, targetId });
  }

  /**
   * Set ref
   */
  async setRef(sessionId: string, targetId: string, refId: string, backendNodeId: number, nodeInfo: { role: string; name: string }): Promise<void> {
    await this.ipc.call('refs/set', { sessionId, targetId, refId, backendNodeId, nodeInfo });
  }

  /**
   * Get ref
   */
  async getRef(sessionId: string, targetId: string, refId: string) {
    return this.ipc.call('refs/get', { sessionId, targetId, refId });
  }

  /**
   * Clear refs
   */
  async clearRefs(sessionId: string, targetId?: string): Promise<void> {
    await this.ipc.call('refs/clear', { sessionId, targetId });
  }

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Set current session ID
   */
  setCurrentSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }
}
