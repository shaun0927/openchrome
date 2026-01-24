/**
 * CDP Connection Pool - Manages Chrome DevTools Protocol connections per session
 */

export interface CDPConnection {
  sessionId: string;
  tabId: number;
  target: chrome.debugger.Debuggee;
  attached: boolean;
}

export class CDPConnectionPool {
  // Map of sessionId -> Map of tabId -> connection
  private connections: Map<string, Map<number, CDPConnection>> = new Map();
  private attachPromises: Map<string, Promise<void>> = new Map();

  /**
   * Attach debugger to a tab for a session
   */
  async attach(sessionId: string, tabId: number): Promise<void> {
    const key = `${sessionId}:${tabId}`;

    // If already attaching, wait for that
    const existingPromise = this.attachPromises.get(key);
    if (existingPromise) {
      return existingPromise;
    }

    // Check if already attached
    const existing = this.getConnection(sessionId, tabId);
    if (existing?.attached) {
      return;
    }

    const target: chrome.debugger.Debuggee = { tabId };

    const attachPromise = (async () => {
      try {
        // Attach the debugger
        await chrome.debugger.attach(target, '1.3');

        // Store the connection
        let sessionConnections = this.connections.get(sessionId);
        if (!sessionConnections) {
          sessionConnections = new Map();
          this.connections.set(sessionId, sessionConnections);
        }

        sessionConnections.set(tabId, {
          sessionId,
          tabId,
          target,
          attached: true,
        });
      } finally {
        this.attachPromises.delete(key);
      }
    })();

    this.attachPromises.set(key, attachPromise);
    return attachPromise;
  }

  /**
   * Detach debugger from a tab
   */
  async detach(sessionId: string, tabId: number): Promise<void> {
    const connection = this.getConnection(sessionId, tabId);
    if (!connection || !connection.attached) {
      return;
    }

    try {
      await chrome.debugger.detach(connection.target);
    } catch {
      // May already be detached
    }

    connection.attached = false;

    // Remove from our tracking
    const sessionConnections = this.connections.get(sessionId);
    if (sessionConnections) {
      sessionConnections.delete(tabId);
      if (sessionConnections.size === 0) {
        this.connections.delete(sessionId);
      }
    }
  }

  /**
   * Execute a CDP command
   */
  async execute<T = unknown>(
    sessionId: string,
    tabId: number,
    method: string,
    params?: object
  ): Promise<T> {
    // Ensure attached
    await this.attach(sessionId, tabId);

    const connection = this.getConnection(sessionId, tabId);
    if (!connection || !connection.attached) {
      throw new Error(`Not attached to tab ${tabId} for session ${sessionId}`);
    }

    try {
      const result = await chrome.debugger.sendCommand(
        connection.target,
        method,
        params
      );
      return result as T;
    } catch (error) {
      // Check if detached
      if (
        error instanceof Error &&
        error.message.includes('Debugger is not attached')
      ) {
        connection.attached = false;
        // Try to reattach and retry once
        await this.attach(sessionId, tabId);
        return chrome.debugger.sendCommand(
          connection.target,
          method,
          params
        ) as Promise<T>;
      }
      throw error;
    }
  }

  /**
   * Detach all connections for a session
   */
  async detachAll(sessionId: string): Promise<void> {
    const sessionConnections = this.connections.get(sessionId);
    if (!sessionConnections) {
      return;
    }

    const detachPromises: Promise<void>[] = [];
    for (const [tabId] of sessionConnections) {
      detachPromises.push(this.detach(sessionId, tabId));
    }

    await Promise.allSettled(detachPromises);
    this.connections.delete(sessionId);
  }

  /**
   * Get a connection
   */
  getConnection(sessionId: string, tabId: number): CDPConnection | undefined {
    return this.connections.get(sessionId)?.get(tabId);
  }

  /**
   * Check if attached
   */
  isAttached(sessionId: string, tabId: number): boolean {
    return this.getConnection(sessionId, tabId)?.attached ?? false;
  }

  /**
   * Get all connections for a session
   */
  getSessionConnections(sessionId: string): CDPConnection[] {
    const sessionConnections = this.connections.get(sessionId);
    if (!sessionConnections) {
      return [];
    }
    return Array.from(sessionConnections.values());
  }

  /**
   * Handle debugger detach event
   */
  onDetach(target: chrome.debugger.Debuggee, reason: string): void {
    if (!target.tabId) return;

    // Find and mark the connection as detached
    for (const [, sessionConnections] of this.connections) {
      const connection = sessionConnections.get(target.tabId);
      if (connection) {
        connection.attached = false;
        console.log(
          `CDP detached from tab ${target.tabId} (session: ${connection.sessionId}): ${reason}`
        );
        break;
      }
    }
  }

  /**
   * Get statistics
   */
  getStats(): { sessions: number; totalConnections: number } {
    let totalConnections = 0;
    for (const [, sessionConnections] of this.connections) {
      totalConnections += sessionConnections.size;
    }
    return {
      sessions: this.connections.size,
      totalConnections,
    };
  }
}
