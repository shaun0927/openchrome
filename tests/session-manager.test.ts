/**
 * Tests for SessionManager
 */

import { SessionManager } from '../extension/src/session-manager';
import { TabGroupManager } from '../extension/src/tab-group-manager';
import { CDPConnectionPool } from '../extension/src/cdp-pool';
import { RequestQueueManager } from '../extension/src/request-queue';

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  let tabGroupManager: TabGroupManager;
  let cdpPool: CDPConnectionPool;
  let queueManager: RequestQueueManager;

  beforeEach(() => {
    tabGroupManager = new TabGroupManager();
    cdpPool = new CDPConnectionPool();
    queueManager = new RequestQueueManager();
    sessionManager = new SessionManager(tabGroupManager, cdpPool, queueManager);

    // Mock Chrome tab group creation
    (chrome.tabs.create as jest.Mock).mockResolvedValue({ id: 1 });
    (chrome.tabs.group as jest.Mock).mockResolvedValue(100);
    (chrome.tabGroups.update as jest.Mock).mockResolvedValue({});
  });

  describe('createSession', () => {
    test('should create a new session with generated ID', async () => {
      const session = await sessionManager.createSession();

      expect(session.id).toBeDefined();
      expect(session.id.length).toBeGreaterThan(0);
      expect(session.tabGroupId).toBe(-1);
      expect(session.tabs.size).toBe(0);
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.lastActivityAt).toBeGreaterThan(0);
    });

    test('should create a session with provided ID', async () => {
      const session = await sessionManager.createSession({ id: 'custom-id' });

      expect(session.id).toBe('custom-id');
    });

    test('should return existing session if ID already exists', async () => {
      const session1 = await sessionManager.createSession({ id: 'same-id' });
      const session2 = await sessionManager.createSession({ id: 'same-id' });

      expect(session1).toBe(session2);
    });

    test('should create session with custom name', async () => {
      const session = await sessionManager.createSession({ name: 'My Session' });

      expect(session.name).toBe('My Session');
    });
  });

  describe('getOrCreateSession', () => {
    test('should create session if not exists', async () => {
      const session = await sessionManager.getOrCreateSession('new-session');

      expect(session.id).toBe('new-session');
    });

    test('should return existing session if exists', async () => {
      const session1 = await sessionManager.createSession({ id: 'existing' });
      const session2 = await sessionManager.getOrCreateSession('existing');

      expect(session1).toBe(session2);
    });
  });

  describe('getSession', () => {
    test('should return session if exists', async () => {
      const created = await sessionManager.createSession({ id: 'test' });
      const retrieved = sessionManager.getSession('test');

      expect(retrieved).toBe(created);
    });

    test('should return undefined if not exists', () => {
      const retrieved = sessionManager.getSession('nonexistent');

      expect(retrieved).toBeUndefined();
    });
  });

  describe('deleteSession', () => {
    test('should delete session and clean up resources', async () => {
      await sessionManager.createSession({ id: 'to-delete' });

      await sessionManager.deleteSession('to-delete');

      expect(sessionManager.getSession('to-delete')).toBeUndefined();
    });

    test('should handle deleting nonexistent session', async () => {
      // Should not throw
      await sessionManager.deleteSession('nonexistent');
    });
  });

  describe('touchSession', () => {
    test('should update lastActivityAt', async () => {
      const session = await sessionManager.createSession({ id: 'test' });
      const initialTime = session.lastActivityAt;

      // Wait a bit
      await new Promise((r) => setTimeout(r, 10));

      sessionManager.touchSession('test');

      expect(session.lastActivityAt).toBeGreaterThan(initialTime);
    });
  });

  describe('cleanupInactiveSessions', () => {
    test('should delete inactive sessions', async () => {
      // Create sessions with different activity times
      const session1 = await sessionManager.createSession({ id: 'old-session' });
      const session2 = await sessionManager.createSession({ id: 'new-session' });

      // Make session1 "old" by backdating lastActivityAt
      session1.lastActivityAt = Date.now() - 10000;

      // Cleanup sessions older than 5 seconds
      const deleted = await sessionManager.cleanupInactiveSessions(5000);

      expect(deleted).toContain('old-session');
      expect(deleted).not.toContain('new-session');
      expect(sessionManager.getSession('old-session')).toBeUndefined();
      expect(sessionManager.getSession('new-session')).toBeDefined();
    });
  });

  describe('session events', () => {
    test('should emit session:created event', async () => {
      const listener = jest.fn();
      sessionManager.addEventListener(listener);

      await sessionManager.createSession({ id: 'test' });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session:created',
          sessionId: 'test',
        })
      );
    });

    test('should emit session:deleted event', async () => {
      const listener = jest.fn();
      await sessionManager.createSession({ id: 'test' });
      sessionManager.addEventListener(listener);

      await sessionManager.deleteSession('test');

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session:deleted',
          sessionId: 'test',
        })
      );
    });

    test('should remove event listener', async () => {
      const listener = jest.fn();
      sessionManager.addEventListener(listener);
      sessionManager.removeEventListener(listener);

      await sessionManager.createSession({ id: 'test' });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('getSessionInfo / getAllSessionInfos', () => {
    test('should return session info', async () => {
      await sessionManager.createSession({ id: 'test', name: 'Test Session' });

      const info = sessionManager.getSessionInfo('test');

      expect(info).toEqual(
        expect.objectContaining({
          id: 'test',
          name: 'Test Session',
          tabCount: 0,
        })
      );
    });

    test('should return all session infos', async () => {
      await sessionManager.createSession({ id: 'session-1' });
      await sessionManager.createSession({ id: 'session-2' });

      const infos = sessionManager.getAllSessionInfos();

      expect(infos.length).toBe(2);
      expect(infos.map((i) => i.id).sort()).toEqual(['session-1', 'session-2']);
    });
  });
});
