/// <reference types="jest" />
/**
 * Tests for Navigate Tool - Auto-fallback: stealth retry on CDN/WAF block detection (#459)
 */

import { createMockSessionManager } from '../utils/mock-session';
import { createMockPage } from '../utils/mock-cdp';
import { parseResultJSON } from '../utils/test-helpers';
import type { MCPResult } from '../../src/types/mcp';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NavResult = Record<string, any>;

// Mock session-manager
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

// Mock smart-goto
import type { SmartGotoResult } from '../../src/utils/smart-goto';
const mockSmartGotoFn = jest.fn<Promise<SmartGotoResult>, [any, string, any?]>(
  async (page, url, opts) => {
    await page.goto(url, opts);
    return { response: null };
  },
);
jest.mock('../../src/utils/smart-goto', () => ({
  smartGoto: mockSmartGotoFn,
}));

// Mock page-diagnostics to control blocking detection
const mockDetectBlockingPage = jest.fn().mockResolvedValue(null);
jest.mock('../../src/utils/page-diagnostics', () => ({
  detectBlockingPage: (...args: any[]) => mockDetectBlockingPage(...args),
  BlockingInfo: {},
}));

// Mock visual-summary
jest.mock('../../src/utils/visual-summary', () => ({
  generateVisualSummary: jest.fn().mockResolvedValue(null),
}));

// Mock stealth human behavior
const mockSimulatePresence = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/stealth/human-behavior', () => ({
  simulatePresence: mockSimulatePresence,
}));

import { getSessionManager } from '../../src/session-manager';

describe('NavigateTool - Auto-fallback (#459)', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let testSessionId: string;

  const getNavigateHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/smart-goto', () => ({
      smartGoto: mockSmartGotoFn,
    }));
    jest.doMock('../../src/utils/page-diagnostics', () => ({
      detectBlockingPage: (...args: any[]) => mockDetectBlockingPage(...args),
      BlockingInfo: {},
    }));
    jest.doMock('../../src/utils/visual-summary', () => ({
      generateVisualSummary: jest.fn().mockResolvedValue(null),
    }));
    jest.doMock('../../src/stealth/human-behavior', () => ({
      simulatePresence: mockSimulatePresence,
    }));
    const { registerNavigateTool } = await import('../../src/tools/navigate');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };

    registerNavigateTool(mockServer as unknown as Parameters<typeof registerNavigateTool>[0]);
    return tools.get('navigate')!.handler;
  };

  beforeEach(() => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    testSessionId = 'test-session-fallback';
    mockDetectBlockingPage.mockResolvedValue(null);
    mockSimulatePresence.mockResolvedValue(undefined);

    // Add createTargetStealth mock
    (mockSessionManager as any).createTargetStealth = jest.fn().mockImplementation(
      async (sessionId: string, url: string, workerId?: string) => {
        const resolvedWorkerId = workerId || 'default';
        const targetId = `stealth-target-${Date.now()}`;
        const page = createMockPage({ url, targetId, title: 'Stealth Page' });
        return { targetId, page, workerId: resolvedWorkerId };
      },
    );

    // Add closeTarget mock
    (mockSessionManager as any).closeTarget = jest.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('new-tab auto-fallback', () => {
    test('retries with stealth when access-denied block detected', async () => {
      const handler = await getNavigateHandler();

      // First call to detectBlockingPage returns access-denied (for the normal tab)
      // Second call returns null (stealth tab succeeds)
      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Access Denied' })
        .mockResolvedValueOnce(null);

      const result = await handler(testSessionId, { url: 'https://www.coupang.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.stealth).toBe(true);
      expect(parsed.fallbackTier).toBe(2);
      expect(parsed.fallbackReason).toBe('access-denied');
      expect(parsed.created).toBe(true);
      // Original blocked tab should be closed
      expect((mockSessionManager as any).closeTarget).toHaveBeenCalled();
      // Stealth target should be created
      expect((mockSessionManager as any).createTargetStealth).toHaveBeenCalled();
    });

    test('retries with stealth when bot-check block detected', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'bot-check', detail: 'Security Check' })
        .mockResolvedValueOnce(null);

      const result = await handler(testSessionId, { url: 'https://www.example.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.fallbackTier).toBe(2);
      expect(parsed.fallbackReason).toBe('bot-check');
      expect(parsed.stealth).toBe(true);
    });

    test('retries with stealth when captcha block detected', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'captcha', detail: 'Turnstile' })
        .mockResolvedValueOnce(null);

      const result = await handler(testSessionId, { url: 'https://www.example.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.fallbackTier).toBe(2);
      expect(parsed.fallbackReason).toBe('captcha');
    });

    test('does NOT retry for js-required block type', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'js-required', detail: 'Page requires JavaScript' });

      const result = await handler(testSessionId, { url: 'https://www.example.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      // Should return the original result with blockingPage, no fallback
      expect(parsed.blockingPage).toBeDefined();
      expect(parsed.blockingPage.type).toBe('js-required');
      expect(parsed.fallbackTier).toBeUndefined();
      expect((mockSessionManager as any).createTargetStealth).not.toHaveBeenCalled();
    });

    test('does NOT retry when stealth was already explicitly used', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Access Denied' });

      const result = await handler(testSessionId, { url: 'https://www.coupang.com', stealth: true });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      // Stealth was already used — should NOT trigger auto-fallback
      expect(parsed.stealth).toBe(true);
      expect(parsed.blockingPage).toBeDefined();
      expect(parsed.fallbackTier).toBeUndefined();
      // createTargetStealth called once (original stealth request), not twice
      expect((mockSessionManager as any).createTargetStealth).toHaveBeenCalledTimes(1);
    });

    test('does NOT retry when autoFallback is false', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Access Denied' });

      const result = await handler(testSessionId, { url: 'https://www.coupang.com', autoFallback: false });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.blockingPage).toBeDefined();
      expect(parsed.fallbackTier).toBeUndefined();
      expect((mockSessionManager as any).createTargetStealth).not.toHaveBeenCalled();
    });

    test('no fallback when page loads normally (no block)', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage.mockResolvedValueOnce(null);

      const result = await handler(testSessionId, { url: 'https://www.naver.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.fallbackTier).toBeUndefined();
      expect(parsed.fallbackReason).toBeUndefined();
      expect(parsed.stealth).toBeUndefined();
      expect((mockSessionManager as any).createTargetStealth).not.toHaveBeenCalled();
    });

    test('returns blocked result if stealth retry also gets blocked', async () => {
      const handler = await getNavigateHandler();

      // Both normal and stealth get blocked
      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Access Denied' })
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Still Denied' });

      const result = await handler(testSessionId, { url: 'https://www.coupang.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      // Should return the stealth result WITH blockingPage (not loop)
      expect(parsed.fallbackTier).toBe(2);
      expect(parsed.stealth).toBe(true);
      expect(parsed.blockingPage).toBeDefined();
      expect(parsed.blockingPage.type).toBe('access-denied');
    });

    test('closes original blocked tab before stealth retry', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Access Denied' })
        .mockResolvedValueOnce(null);

      await handler(testSessionId, { url: 'https://www.coupang.com' });

      expect((mockSessionManager as any).closeTarget).toHaveBeenCalledWith(
        testSessionId,
        expect.any(String),
      );
    });

    test('simulatePresence is called on stealth fallback tab', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'bot-check', detail: 'Bot Check' })
        .mockResolvedValueOnce(null);

      await handler(testSessionId, { url: 'https://www.example.com' });

      expect(mockSimulatePresence).toHaveBeenCalled();
    });
  });

  describe('tab-reuse auto-fallback', () => {
    test('retries with stealth when reused tab hits a block', async () => {
      const handler = await getNavigateHandler();

      // Set up an existing tab for the worker
      const existingTabId = 'existing-tab-1';
      const existingPage = createMockPage({ url: 'https://www.coupang.com', targetId: existingTabId, title: 'Access Denied' });
      mockSessionManager.getWorkerTargetIds.mockReturnValue([existingTabId]);
      mockSessionManager.isTargetValid.mockResolvedValue(true);
      mockSessionManager.getPage.mockResolvedValue(existingPage);

      // Tab reuse detects block, stealth retry succeeds
      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Access Denied' })
        .mockResolvedValueOnce(null);

      const result = await handler(testSessionId, { url: 'https://www.coupang.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.fallbackTier).toBe(2);
      expect(parsed.fallbackReason).toBe('access-denied');
      expect(parsed.stealth).toBe(true);
      // Reused tab should NOT be closed (it existed before)
      expect((mockSessionManager as any).closeTarget).not.toHaveBeenCalled();
    });

    test('does NOT retry reused tab when autoFallback is false', async () => {
      const handler = await getNavigateHandler();

      const existingTabId = 'existing-tab-2';
      const existingPage = createMockPage({ url: 'https://www.coupang.com', targetId: existingTabId });
      mockSessionManager.getWorkerTargetIds.mockReturnValue([existingTabId]);
      mockSessionManager.isTargetValid.mockResolvedValue(true);
      mockSessionManager.getPage.mockResolvedValue(existingPage);

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Access Denied' });

      const result = await handler(testSessionId, { url: 'https://www.coupang.com', autoFallback: false });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.blockingPage).toBeDefined();
      expect(parsed.fallbackTier).toBeUndefined();
      expect((mockSessionManager as any).createTargetStealth).not.toHaveBeenCalled();
    });
  });

  describe('response schema', () => {
    test('fallbackTier and fallbackReason are present when fallback triggered', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Akamai CDN' })
        .mockResolvedValueOnce(null);

      const result = await handler(testSessionId, { url: 'https://www.coupang.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed).toHaveProperty('fallbackTier', 2);
      expect(parsed).toHaveProperty('fallbackReason', 'access-denied');
      expect(parsed).toHaveProperty('stealth', true);
      expect(parsed).toHaveProperty('created', true);
      expect(parsed).toHaveProperty('action', 'navigate');
    });

    test('fallbackTier and fallbackReason are absent when no fallback', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage.mockResolvedValueOnce(null);

      const result = await handler(testSessionId, { url: 'https://www.naver.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.fallbackTier).toBeUndefined();
      expect(parsed.fallbackReason).toBeUndefined();
    });
  });
});
