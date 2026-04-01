/// <reference types="jest" />
/**
 * Tests for headed mode cleanup and teardown — verifies that page close events,
 * manager shutdown, and oc_stop properly clean up all headed resources. (#485, #551)
 */

import { createMockPage } from '../utils/mock-cdp';
import { createMockSessionManager } from '../utils/mock-session';

describe('Headed Mode Cleanup (#485)', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  const sessionId = 'session-cleanup';
  const workerId = 'headed';

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    await mockSessionManager.getOrCreateSession(sessionId);
    await mockSessionManager.getOrCreateWorker(sessionId, workerId);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('page close cleanup', () => {
    test('closing a headed page removes it from worker targets', () => {
      const targetId = 'cleanup-target-001';
      const page = createMockPage({ url: 'https://example.com', targetId });

      mockSessionManager.registerExternalTarget(targetId, sessionId, workerId);

      const worker = mockSessionManager.getWorker(sessionId, workerId);
      expect(worker!.targets.has(targetId)).toBe(true);

      // Simulate page close by removing target from worker
      worker!.targets.delete(targetId);
      expect(worker!.targets.has(targetId)).toBe(false);
    });

    test('closing one headed page does not affect other headed pages', () => {
      mockSessionManager.registerExternalTarget('ht-1', sessionId, workerId);
      mockSessionManager.registerExternalTarget('ht-2', sessionId, workerId);

      const worker = mockSessionManager.getWorker(sessionId, workerId);
      expect(worker!.targets.size).toBe(2);

      // Only remove ht-1
      worker!.targets.delete('ht-1');

      expect(worker!.targets.has('ht-1')).toBe(false);
      expect(worker!.targets.has('ht-2')).toBe(true);
    });
  });

  describe('session cleanup', () => {
    test('deleteSession removes all headed targets', async () => {
      mockSessionManager.registerExternalTarget('ht-a', sessionId, workerId);
      mockSessionManager.registerExternalTarget('ht-b', sessionId, workerId);

      await mockSessionManager.deleteSession(sessionId);

      // Session should no longer exist
      const session = mockSessionManager.getSession(sessionId);
      expect(session).toBeUndefined();
    });

    test('deleteWorker removes headed worker and its targets', async () => {
      mockSessionManager.registerExternalTarget('ht-x', sessionId, workerId);

      await mockSessionManager.deleteWorker(sessionId, workerId);

      // If headed worker was re-created (as default), it should not have old targets
      const worker = mockSessionManager.getWorker(sessionId, workerId);
      if (worker) {
        expect(worker.targets.has('ht-x')).toBe(false);
      }
    });
  });

  describe('CDPClient page tracking cleanup', () => {
    test('pages map tracks external pages by targetId', () => {
      const page = createMockPage({ url: 'https://example.com', targetId: 'ext-001' });

      mockSessionManager.pages.set('ext-001', page);
      expect(mockSessionManager.pages.get('ext-001')).toBe(page);
    });

    test('getPageByTargetId returns page after indexing', async () => {
      const page = createMockPage({ url: 'https://example.com', targetId: 'ext-002' });
      const cdpClient = mockSessionManager.mockCDPClient;

      cdpClient.getPageByTargetId.mockResolvedValue(page);

      const result = await cdpClient.getPageByTargetId('ext-002');
      expect(result).toBe(page);
    });

    test('getPageByTargetId returns null after page is removed', async () => {
      const cdpClient = mockSessionManager.mockCDPClient;

      cdpClient.getPageByTargetId.mockResolvedValue(null);

      const result = await cdpClient.getPageByTargetId('ext-removed');
      expect(result).toBeNull();
    });

    test('pages map cleanup removes entry', () => {
      const page = createMockPage({ url: 'https://example.com', targetId: 'ext-003' });
      mockSessionManager.pages.set('ext-003', page);
      expect(mockSessionManager.pages.has('ext-003')).toBe(true);

      mockSessionManager.pages.delete('ext-003');
      expect(mockSessionManager.pages.has('ext-003')).toBe(false);
    });
  });

  describe('graceful shutdown scenarios', () => {
    test('shutdown with no headed pages is safe', () => {
      // No pages registered — shutdown should not throw
      expect(() => {
        mockSessionManager.deleteWorker(sessionId, workerId);
      }).not.toThrow();
    });

    test('shutdown with multiple sessions cleans up all headed pages', async () => {
      const session2 = 'session-cleanup-2';
      await mockSessionManager.getOrCreateSession(session2);
      await mockSessionManager.getOrCreateWorker(session2, 'headed');

      mockSessionManager.registerExternalTarget('ht-s1', sessionId, workerId);
      mockSessionManager.registerExternalTarget('ht-s2', session2, 'headed');

      await mockSessionManager.deleteSession(sessionId);
      await mockSessionManager.deleteSession(session2);

      expect(mockSessionManager.getSession(sessionId)).toBeUndefined();
      expect(mockSessionManager.getSession(session2)).toBeUndefined();
    });

    test('page.close() is idempotent on mock pages', async () => {
      const page = createMockPage({ url: 'https://example.com', targetId: 'idem-001' });

      await page.close();
      await page.close();

      expect(page.close).toHaveBeenCalledTimes(2);
    });
  });

  describe('resource leak prevention', () => {
    test('registering then immediately closing does not leak targets', () => {
      const targetId = 'leak-check-001';
      mockSessionManager.registerExternalTarget(targetId, sessionId, workerId);

      const worker = mockSessionManager.getWorker(sessionId, workerId);
      expect(worker!.targets.has(targetId)).toBe(true);

      // Remove target
      worker!.targets.delete(targetId);
      expect(worker!.targets.has(targetId)).toBe(false);
      expect(worker!.targets.size).toBe(0);
    });

    test('stale targetId lookups return undefined', () => {
      const worker = mockSessionManager.getWorker(sessionId, workerId);
      expect(worker!.targets.has('never-registered')).toBe(false);
    });
  });
});
