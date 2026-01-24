/// <reference types="jest" />
/// <reference types="chrome" />
/**
 * Integration tests for session isolation
 *
 * These tests verify that multiple parallel Claude Code sessions
 * can operate independently without interference.
 */

import { SessionManager } from '../../extension/src/session-manager';
import { TabGroupManager } from '../../extension/src/tab-group-manager';
import { CDPConnectionPool } from '../../extension/src/cdp-pool';
import { RequestQueueManager } from '../../extension/src/request-queue';
import { MCPHandler } from '../../extension/src/mcp-handler';

describe('Session Isolation Integration Tests', () => {
  let sessionManager: SessionManager;
  let tabGroupManager: TabGroupManager;
  let cdpPool: CDPConnectionPool;
  let queueManager: RequestQueueManager;
  let mcpHandler: MCPHandler;

  let tabIdCounter = 1;
  let groupIdCounter = 100;

  beforeEach(() => {
    tabIdCounter = 1;
    groupIdCounter = 100;

    // Mock Chrome APIs with realistic behavior
    (chrome.tabs.create as jest.Mock).mockImplementation(async () => ({
      id: tabIdCounter++,
      url: 'about:blank',
      status: 'complete',
    }));

    (chrome.tabs.group as jest.Mock).mockImplementation(async () => groupIdCounter++);

    (chrome.tabGroups.update as jest.Mock).mockResolvedValue({});

    (chrome.tabs.query as jest.Mock).mockImplementation(async ({ groupId }: { groupId?: number }) => {
      // Return empty for simplicity in tests
      return [];
    });

    (chrome.tabs.get as jest.Mock).mockImplementation(async (tabId: number) => ({
      id: tabId,
      url: 'https://example.com',
      status: 'complete',
    }));

    (chrome.tabs.remove as jest.Mock).mockResolvedValue(undefined);
    (chrome.tabs.ungroup as jest.Mock).mockResolvedValue(undefined);

    (chrome.debugger.attach as jest.Mock).mockResolvedValue(undefined);
    (chrome.debugger.detach as jest.Mock).mockResolvedValue(undefined);
    (chrome.debugger.sendCommand as jest.Mock).mockResolvedValue({});

    // Create fresh instances
    tabGroupManager = new TabGroupManager();
    cdpPool = new CDPConnectionPool();
    queueManager = new RequestQueueManager();
    sessionManager = new SessionManager(tabGroupManager, cdpPool, queueManager);
    mcpHandler = new MCPHandler(sessionManager);
  });

  describe('Session Creation Isolation', () => {
    test('should create independent sessions with unique IDs', async () => {
      const sessionA = await sessionManager.createSession({ id: 'session-A' });
      const sessionB = await sessionManager.createSession({ id: 'session-B' });

      expect(sessionA.id).toBe('session-A');
      expect(sessionB.id).toBe('session-B');
      expect(sessionA).not.toBe(sessionB);
    });

    test('should create independent tab groups for each session', async () => {
      await sessionManager.createSession({ id: 'session-A' });
      await sessionManager.createSession({ id: 'session-B' });

      const groupIdA = await sessionManager.ensureTabGroup('session-A');
      const groupIdB = await sessionManager.ensureTabGroup('session-B');

      expect(groupIdA).not.toBe(groupIdB);
      expect(groupIdA).toBe(100);
      expect(groupIdB).toBe(101);
    });
  });

  describe('Tab Ownership Isolation', () => {
    test('should prevent session A from accessing session B tabs', async () => {
      await sessionManager.createSession({ id: 'session-A' });
      await sessionManager.createSession({ id: 'session-B' });

      await sessionManager.ensureTabGroup('session-A');
      await sessionManager.ensureTabGroup('session-B');

      // Tab 1 belongs to session-A, Tab 2 belongs to session-B
      const tabAId = 1;
      const tabBId = 2;

      // Session A should own tab 1
      expect(sessionManager.validateTabOwnership('session-A', tabAId)).toBe(true);
      expect(sessionManager.validateTabOwnership('session-A', tabBId)).toBe(false);

      // Session B should own tab 2
      expect(sessionManager.validateTabOwnership('session-B', tabBId)).toBe(true);
      expect(sessionManager.validateTabOwnership('session-B', tabAId)).toBe(false);
    });

    test('should track tabs correctly across multiple sessions', async () => {
      const sessions = ['A', 'B', 'C', 'D', 'E'];

      for (const name of sessions) {
        await sessionManager.createSession({ id: `session-${name}` });
        await sessionManager.ensureTabGroup(`session-${name}`);
      }

      // Each session should only own its own tab
      for (let i = 0; i < sessions.length; i++) {
        const currentSession = `session-${sessions[i]}`;
        const ownedTab = i + 1; // Tabs are numbered 1, 2, 3, ...

        expect(sessionManager.validateTabOwnership(currentSession, ownedTab)).toBe(true);

        // Should not own other tabs
        for (let j = 0; j < sessions.length; j++) {
          if (i !== j) {
            const otherTab = j + 1;
            expect(sessionManager.validateTabOwnership(currentSession, otherTab)).toBe(false);
          }
        }
      }
    });
  });

  describe('Request Queue Isolation', () => {
    test('should process requests independently per session', async () => {
      const results: string[] = [];

      // Enqueue to session A
      const promiseA1 = queueManager.enqueue('session-A', async () => {
        await new Promise((r) => setTimeout(r, 50));
        results.push('A1');
        return 'A1';
      });

      // Enqueue to session B (should not be blocked by session A)
      const promiseB1 = queueManager.enqueue('session-B', async () => {
        results.push('B1');
        return 'B1';
      });

      // B1 should complete before A1 since it doesn't wait
      await Promise.all([promiseA1, promiseB1]);

      // B1 should have completed before A1
      expect(results.indexOf('B1')).toBeLessThan(results.indexOf('A1'));
    });

    test('should maintain FIFO order within each session', async () => {
      const resultsA: number[] = [];
      const resultsB: number[] = [];

      const promisesA = [1, 2, 3].map((n) =>
        queueManager.enqueue('session-A', async () => {
          await new Promise((r) => setTimeout(r, 10));
          resultsA.push(n);
          return n;
        })
      );

      const promisesB = [1, 2, 3].map((n) =>
        queueManager.enqueue('session-B', async () => {
          await new Promise((r) => setTimeout(r, 10));
          resultsB.push(n);
          return n;
        })
      );

      await Promise.all([...promisesA, ...promisesB]);

      expect(resultsA).toEqual([1, 2, 3]);
      expect(resultsB).toEqual([1, 2, 3]);
    });
  });

  describe('CDP Connection Isolation', () => {
    test('should maintain separate debugger connections per session', async () => {
      await sessionManager.createSession({ id: 'session-A' });
      await sessionManager.createSession({ id: 'session-B' });

      await sessionManager.ensureTabGroup('session-A');
      await sessionManager.ensureTabGroup('session-B');

      // Execute CDP commands for both sessions
      await cdpPool.execute('session-A', 1, 'Page.enable');
      await cdpPool.execute('session-B', 2, 'Page.enable');

      // Both sessions should have their connections
      expect(cdpPool.isAttached('session-A', 1)).toBe(true);
      expect(cdpPool.isAttached('session-B', 2)).toBe(true);

      // Cross-session should not exist
      expect(cdpPool.isAttached('session-A', 2)).toBe(false);
      expect(cdpPool.isAttached('session-B', 1)).toBe(false);
    });

    test('should clean up connections when session is deleted', async () => {
      await sessionManager.createSession({ id: 'session-A' });
      await sessionManager.ensureTabGroup('session-A');

      await cdpPool.attach('session-A', 1);
      expect(cdpPool.isAttached('session-A', 1)).toBe(true);

      await sessionManager.deleteSession('session-A');

      expect(cdpPool.isAttached('session-A', 1)).toBe(false);
    });
  });

  describe('Parallel Operations', () => {
    test('should handle simultaneous session creations', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        sessionManager.createSession({ id: `session-${i}` })
      );

      const sessions = await Promise.all(promises);

      expect(sessions).toHaveLength(10);
      expect(new Set(sessions.map((s) => s.id)).size).toBe(10); // All unique IDs
    });

    test('should handle simultaneous tab group creations', async () => {
      // Create sessions first
      const sessions = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          sessionManager.createSession({ id: `session-${i}` })
        )
      );

      // Create tab groups in parallel
      const groupPromises = sessions.map((s) =>
        sessionManager.ensureTabGroup(s.id)
      );

      const groupIds = await Promise.all(groupPromises);

      expect(groupIds).toHaveLength(5);
      expect(new Set(groupIds).size).toBe(5); // All unique group IDs
    });

    test('should handle concurrent CDP commands across sessions', async () => {
      // Setup sessions
      await sessionManager.createSession({ id: 'session-A' });
      await sessionManager.createSession({ id: 'session-B' });
      await sessionManager.ensureTabGroup('session-A');
      await sessionManager.ensureTabGroup('session-B');

      // Track command execution
      const executionOrder: string[] = [];
      (chrome.debugger.sendCommand as jest.Mock).mockImplementation(
        async (target, method) => {
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          executionOrder.push(`${target.tabId}:${method}`);
          return {};
        }
      );

      // Execute commands concurrently
      const promises = [
        cdpPool.execute('session-A', 1, 'CommandA1'),
        cdpPool.execute('session-A', 1, 'CommandA2'),
        cdpPool.execute('session-B', 2, 'CommandB1'),
        cdpPool.execute('session-B', 2, 'CommandB2'),
      ];

      await Promise.all(promises);

      // All commands should have executed
      expect(executionOrder).toHaveLength(4);
    });
  });

  describe('Session Cleanup', () => {
    test('should clean up inactive sessions', async () => {
      const session1 = await sessionManager.createSession({ id: 'old-session' });
      await sessionManager.createSession({ id: 'new-session' });

      // Make session1 "old"
      session1.lastActivityAt = Date.now() - 10000;

      const deleted = await sessionManager.cleanupInactiveSessions(5000);

      expect(deleted).toContain('old-session');
      expect(deleted).not.toContain('new-session');
      expect(sessionManager.getSession('old-session')).toBeUndefined();
      expect(sessionManager.getSession('new-session')).toBeDefined();
    });

    test('should not affect other sessions when one is deleted', async () => {
      await sessionManager.createSession({ id: 'session-A' });
      await sessionManager.createSession({ id: 'session-B' });
      await sessionManager.ensureTabGroup('session-A');
      await sessionManager.ensureTabGroup('session-B');

      await sessionManager.deleteSession('session-A');

      // Session B should be unaffected
      expect(sessionManager.getSession('session-B')).toBeDefined();
      expect(tabGroupManager.getGroupId('session-B')).toBe(101);
    });
  });

  describe('Event Isolation', () => {
    test('should emit events only for the relevant session', async () => {
      const eventsA: string[] = [];
      const eventsB: string[] = [];

      sessionManager.addEventListener((event) => {
        if (event.sessionId === 'session-A') {
          eventsA.push(event.type);
        } else if (event.sessionId === 'session-B') {
          eventsB.push(event.type);
        }
      });

      await sessionManager.createSession({ id: 'session-A' });
      await sessionManager.createSession({ id: 'session-B' });
      await sessionManager.deleteSession('session-A');

      expect(eventsA).toContain('session:created');
      expect(eventsA).toContain('session:deleted');
      expect(eventsB).toContain('session:created');
      expect(eventsB).not.toContain('session:deleted');
    });
  });

  describe('MCP Handler Integration', () => {
    test('should auto-create sessions for tool calls', async () => {
      const response = await mcpHandler.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'sessions/create',
        params: { sessionId: 'new-session', name: 'Test Session' },
      });

      expect(response.error).toBeUndefined();
      expect(sessionManager.getSession('new-session')).toBeDefined();
    });

    test('should list all active sessions', async () => {
      await sessionManager.createSession({ id: 'session-1' });
      await sessionManager.createSession({ id: 'session-2' });

      const response = await mcpHandler.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'sessions/list',
        params: {},
      });

      expect(response.error).toBeUndefined();
      const content = response.result?.content?.[0] as { text: string };
      const sessions = JSON.parse(content.text);

      expect(sessions).toHaveLength(2);
      expect(sessions.map((s: { id: string }) => s.id)).toContain('session-1');
      expect(sessions.map((s: { id: string }) => s.id)).toContain('session-2');
    });
  });
});
