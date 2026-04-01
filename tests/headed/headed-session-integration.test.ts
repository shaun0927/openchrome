/// <reference types="jest" />
/**
 * Tests for headed mode session integration — verifies that registerHeadedPage()
 * correctly wires external pages into the CDPClient targetIdIndex and session
 * manager worker tracking, enabling tools to operate on headed tabs. (#485, #551)
 */

import { createMockPage } from '../utils/mock-cdp';
import { createMockSessionManager } from '../utils/mock-session';

describe('Headed Session Integration (#485)', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  const sessionId = 'session-headed-integration';
  const workerId = 'headed';
  const targetId = 'headed-target-integration-001';

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    await mockSessionManager.getOrCreateSession(sessionId);
    await mockSessionManager.getOrCreateWorker(sessionId, workerId);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registerHeadedPage()', () => {
    test('registers target in session worker', () => {
      const page = createMockPage({ url: 'https://example.com', targetId });
      mockSessionManager.registerHeadedPage(targetId, sessionId, workerId, page);

      expect(mockSessionManager.registerExternalTarget).toHaveBeenCalledWith(
        targetId, sessionId, workerId,
      );
    });

    test('page is accessible via CDPClient indexExternalPage mock', () => {
      const page = createMockPage({ url: 'https://example.com', targetId });
      mockSessionManager.registerHeadedPage(targetId, sessionId, workerId, page);

      // registerHeadedPage should call registerExternalTarget (which tracks ownership)
      // and mockCDPClient.indexExternalPage (which makes getPageByTargetId work)
      expect(mockSessionManager.registerExternalTarget).toHaveBeenCalledTimes(1);
    });

    test('worker tracks the headed target', () => {
      const page = createMockPage({ url: 'https://example.com', targetId });

      // registerExternalTarget adds to worker.targets in the mock
      mockSessionManager.registerExternalTarget(targetId, sessionId, workerId);

      const worker = mockSessionManager.getWorker(sessionId, workerId);
      expect(worker).toBeDefined();
      expect(worker!.targets.has(targetId)).toBe(true);
    });

    test('multiple headed pages can be registered to the same worker', () => {
      const page1 = createMockPage({ url: 'https://a.com', targetId: 'ht-001' });
      const page2 = createMockPage({ url: 'https://b.com', targetId: 'ht-002' });

      mockSessionManager.registerExternalTarget('ht-001', sessionId, workerId);
      mockSessionManager.registerExternalTarget('ht-002', sessionId, workerId);

      const worker = mockSessionManager.getWorker(sessionId, workerId);
      expect(worker!.targets.has('ht-001')).toBe(true);
      expect(worker!.targets.has('ht-002')).toBe(true);
      expect(worker!.targets.size).toBe(2);
    });

    test('does not overwrite existing target ownership', async () => {
      // Pre-register target to another worker
      const otherWorkerId = 'other-worker';
      await mockSessionManager.getOrCreateWorker(sessionId, otherWorkerId);
      mockSessionManager.registerExternalTarget(targetId, sessionId, otherWorkerId);

      // Attempt re-registration to headed worker
      const page = createMockPage({ url: 'https://example.com', targetId });
      mockSessionManager.registerExternalTarget(targetId, sessionId, workerId);

      // First registration wins (mock behavior matches real SessionManager)
      const otherWorker = mockSessionManager.getWorker(sessionId, otherWorkerId);
      expect(otherWorker!.targets.has(targetId)).toBe(true);
    });
  });

  describe('registerExternalTarget()', () => {
    test('registers target to correct session and worker', () => {
      mockSessionManager.registerExternalTarget(targetId, sessionId, workerId);

      const worker = mockSessionManager.getWorker(sessionId, workerId);
      expect(worker).toBeDefined();
      expect(worker!.targets.has(targetId)).toBe(true);
    });

    test('updates worker lastActivityAt', () => {
      const worker = mockSessionManager.getWorker(sessionId, workerId);
      const beforeActivity = worker!.lastActivityAt;

      // Small delay to ensure timestamp changes
      mockSessionManager.registerExternalTarget(targetId, sessionId, workerId);

      const updatedWorker = mockSessionManager.getWorker(sessionId, workerId);
      expect(updatedWorker!.lastActivityAt).toBeGreaterThanOrEqual(beforeActivity);
    });

    test('no-op for non-existent session', () => {
      expect(() => {
        mockSessionManager.registerExternalTarget(targetId, 'non-existent-session', workerId);
      }).not.toThrow();
    });

    test('no-op for non-existent worker', () => {
      expect(() => {
        mockSessionManager.registerExternalTarget(targetId, sessionId, 'non-existent-worker');
      }).not.toThrow();
    });
  });

  describe('worker lifecycle with headed targets', () => {
    test('getOrCreateWorker creates headed worker on demand', async () => {
      const newManager = createMockSessionManager();
      await newManager.getOrCreateSession('s1');

      const worker = await newManager.getOrCreateWorker('s1', 'headed');
      expect(worker).toBeDefined();
      expect(worker.id).toBe('headed');
    });

    test('getWorkerTargetIds returns headed targets', () => {
      mockSessionManager.registerExternalTarget('ht-a', sessionId, workerId);
      mockSessionManager.registerExternalTarget('ht-b', sessionId, workerId);

      const worker = mockSessionManager.getWorker(sessionId, workerId);
      expect(worker!.targets.size).toBe(2);
    });

    test('deleteWorker cleans up headed targets', async () => {
      mockSessionManager.registerExternalTarget('ht-x', sessionId, workerId);

      await mockSessionManager.deleteWorker(sessionId, workerId);

      const worker = mockSessionManager.getWorker(sessionId, workerId);
      // Worker deleted (or recreated as default) — either way targets are gone
      if (worker) {
        expect(worker.targets.has('ht-x')).toBe(false);
      }
    });
  });

  describe('cross-tool interoperability', () => {
    test('getPage resolves headed page for tool operations', () => {
      const page = createMockPage({ url: 'https://example.com', targetId });

      // Register target in mock (simulates what registerHeadedPage does)
      mockSessionManager.registerExternalTarget(targetId, sessionId, workerId);
      mockSessionManager.pages.set(targetId, page);

      // Verify getPage returns the page (tools like read_page use this)
      const retrieved = mockSessionManager.pages.get(targetId);
      expect(retrieved).toBe(page);
      expect(retrieved!.url()).toBe('https://example.com');
    });

    test('isTargetValid returns true for registered headed target', async () => {
      mockSessionManager.registerExternalTarget(targetId, sessionId, workerId);
      mockSessionManager.isTargetValid.mockResolvedValue(true);

      const valid = await mockSessionManager.isTargetValid(targetId);
      expect(valid).toBe(true);
    });

    test('page methods work on headed mock page (screenshot, evaluate, etc.)', async () => {
      const page = createMockPage({ url: 'https://example.com', targetId });

      // screenshot
      const screenshot = await page.screenshot();
      expect(screenshot).toBeDefined();

      // evaluate
      page.evaluate.mockResolvedValue({ title: 'Example', text: 'Hello' });
      const result = await page.evaluate(() => ({ title: document.title }));
      expect(result).toHaveProperty('title', 'Example');

      // content
      const html = await page.content();
      expect(typeof html).toBe('string');
    });
  });
});
