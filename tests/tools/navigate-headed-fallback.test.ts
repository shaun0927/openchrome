/// <reference types="jest" />
/**
 * Tests for Navigate Tool - Tier 3: Headed Chrome fallback (#459)
 */

import { createMockSessionManager } from '../utils/mock-session';
import { createMockPage } from '../utils/mock-cdp';
import { parseResultJSON } from '../utils/test-helpers';
import type { MCPResult } from '../../src/types/mcp';

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

// Mock page-diagnostics
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
jest.mock('../../src/stealth/human-behavior', () => ({
  simulatePresence: jest.fn().mockResolvedValue(undefined),
}));

// Mock headed-fallback
const mockHeadedIsAvailable = jest.fn().mockReturnValue(true);
const mockHeadedNavigate = jest.fn().mockResolvedValue({
  url: 'https://www.coupang.com/',
  title: 'Coupang',
  elementCount: 500,
  blockingPage: null,
});
jest.mock('../../src/chrome/headed-fallback', () => ({
  getHeadedFallback: () => ({
    isAvailable: mockHeadedIsAvailable,
    navigate: mockHeadedNavigate,
  }),
}));

// Mock global config
jest.mock('../../src/config/global', () => ({
  getGlobalConfig: () => ({ port: 9222 }),
}));

import { getSessionManager } from '../../src/session-manager';

describe('NavigateTool - Headed Chrome Fallback (#459)', () => {
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
      simulatePresence: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../../src/chrome/headed-fallback', () => ({
      getHeadedFallback: () => ({
        isAvailable: mockHeadedIsAvailable,
        navigate: mockHeadedNavigate,
      }),
    }));
    jest.doMock('../../src/config/global', () => ({
      getGlobalConfig: () => ({ port: 9222 }),
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
    testSessionId = 'test-session-headed';
    mockDetectBlockingPage.mockResolvedValue(null);
    mockHeadedIsAvailable.mockReturnValue(true);
    mockHeadedNavigate.mockResolvedValue({
      url: 'https://www.coupang.com/',
      title: 'Coupang',
      elementCount: 500,
      blockingPage: null,
    });

    (mockSessionManager as any).createTargetStealth = jest.fn().mockImplementation(
      async (sessionId: string, url: string, workerId?: string) => {
        const resolvedWorkerId = workerId || 'default';
        const targetId = `stealth-target-${Date.now()}`;
        const page = createMockPage({ url, targetId, title: 'Access Denied' });
        return { targetId, page, workerId: resolvedWorkerId };
      },
    );
    (mockSessionManager as any).closeTarget = jest.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Tier 3: automatic escalation from Tier 2', () => {
    test('escalates to headed Chrome when both normal and stealth are blocked', async () => {
      const handler = await getNavigateHandler();

      // Normal and stealth both get blocked → Tier 3 triggers
      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Akamai CDN' })  // Tier 1
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Still Denied' }); // Tier 2

      const result = await handler(testSessionId, { url: 'https://www.coupang.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.headed).toBe(true);
      expect(parsed.fallbackTier).toBe(3);
      expect(parsed.fallbackReason).toBe('access-denied');
      expect(parsed.title).toBe('Coupang');
      expect(mockHeadedNavigate).toHaveBeenCalledWith('https://www.coupang.com');
    });

    test('does not escalate to Tier 3 when Tier 2 succeeds', async () => {
      const handler = await getNavigateHandler();

      // Normal blocked, stealth succeeds
      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Akamai CDN' })
        .mockResolvedValueOnce(null);

      const result = await handler(testSessionId, { url: 'https://www.coupang.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.fallbackTier).toBe(2);
      expect(parsed.headed).toBeUndefined();
      expect(mockHeadedNavigate).not.toHaveBeenCalled();
    });

    test('skips Tier 3 when no display available', async () => {
      const handler = await getNavigateHandler();
      mockHeadedIsAvailable.mockReturnValue(false);

      // Both tiers blocked, no display
      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Akamai CDN' })
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Still Denied' });

      const result = await handler(testSessionId, { url: 'https://www.coupang.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      // Falls back to Tier 2 result (with blockingPage)
      expect(parsed.fallbackTier).toBe(2);
      expect(parsed.headed).toBeUndefined();
      expect(parsed.blockingPage).toBeDefined();
      expect(mockHeadedNavigate).not.toHaveBeenCalled();
    });

    test('does not escalate to Tier 3 when autoFallback is false', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Akamai CDN' });

      const result = await handler(testSessionId, { url: 'https://www.coupang.com', autoFallback: false });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      // No fallback at all
      expect(parsed.blockingPage).toBeDefined();
      expect(parsed.fallbackTier).toBeUndefined();
      expect(mockHeadedNavigate).not.toHaveBeenCalled();
    });

    test('Tier 3 returns blockingPage if headed Chrome also gets blocked', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Akamai CDN' })
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Still Denied' });

      // Headed Chrome also gets blocked
      mockHeadedNavigate.mockResolvedValue({
        url: 'https://www.coupang.com/',
        title: 'Access Denied',
        elementCount: 7,
        blockingPage: { type: 'access-denied', detail: 'Access Denied' },
      });

      const result = await handler(testSessionId, { url: 'https://www.coupang.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.fallbackTier).toBe(3);
      expect(parsed.headed).toBe(true);
      expect(parsed.blockingPage).toBeDefined();
    });
  });

  describe('headed parameter (direct)', () => {
    test('headed=true navigates directly in headed Chrome', async () => {
      const handler = await getNavigateHandler();

      const result = await handler(testSessionId, { url: 'https://www.coupang.com', headed: true });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.headed).toBe(true);
      expect(parsed.fallbackTier).toBe(3);
      expect(parsed.title).toBe('Coupang');
      expect(mockHeadedNavigate).toHaveBeenCalledWith('https://www.coupang.com');
      // Should NOT create normal or stealth targets
      expect(mockSessionManager.createTarget).not.toHaveBeenCalled();
      expect((mockSessionManager as any).createTargetStealth).not.toHaveBeenCalled();
    });

    test('headed=true returns error when no display available', async () => {
      const handler = await getNavigateHandler();
      mockHeadedIsAvailable.mockReturnValue(false);

      const result = await handler(testSessionId, { url: 'https://www.coupang.com', headed: true });
      const mcpResult = result as MCPResult;

      expect(mcpResult.isError).toBe(true);
      expect(mcpResult.content![0]).toHaveProperty('text', expect.stringContaining('no display'));
    });
  });

  describe('response schema', () => {
    test('Tier 3 response includes headed, fallbackTier, fallbackReason', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'bot-check', detail: 'Bot Check' })
        .mockResolvedValueOnce({ type: 'bot-check', detail: 'Still Bot Check' });

      const result = await handler(testSessionId, { url: 'https://www.example.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed).toHaveProperty('headed', true);
      expect(parsed).toHaveProperty('fallbackTier', 3);
      expect(parsed).toHaveProperty('fallbackReason', 'bot-check');
      expect(parsed).toHaveProperty('action', 'navigate');
    });
  });
});
