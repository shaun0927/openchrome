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
const mockHeadedNavigatePersistent = jest.fn().mockResolvedValue({
  url: 'https://www.coupang.com/',
  title: 'Coupang',
  elementCount: 500,
  blockingPage: null,
  targetId: 'headed-target-123',
});
const mockHeadedGetPort = jest.fn().mockReturnValue(9322);
const mockHeadedGetPage = jest.fn().mockReturnValue(null);
jest.mock('../../src/chrome/headed-fallback', () => ({
  getHeadedFallback: () => ({
    isAvailable: mockHeadedIsAvailable,
    navigate: mockHeadedNavigate,
    navigatePersistent: mockHeadedNavigatePersistent,
    getPort: mockHeadedGetPort,
    getPage: mockHeadedGetPage,
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
        navigatePersistent: mockHeadedNavigatePersistent,
        getPort: mockHeadedGetPort,
        getPage: mockHeadedGetPage,
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
    mockHeadedNavigatePersistent.mockResolvedValue({
      url: 'https://www.coupang.com/',
      title: 'Coupang',
      elementCount: 500,
      blockingPage: null,
      targetId: 'headed-target-123',
    });

    mockHeadedGetPage.mockReturnValue(null);

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
      expect(mockHeadedNavigatePersistent).toHaveBeenCalledWith('https://www.coupang.com');
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
      expect(mockHeadedNavigatePersistent).not.toHaveBeenCalled();
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
      expect(mockHeadedNavigatePersistent).not.toHaveBeenCalled();
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
      expect(mockHeadedNavigatePersistent).not.toHaveBeenCalled();
    });

    test('escalates to Tier 3 when stealth produces empty page (elementCount=0)', async () => {
      const handler = await getNavigateHandler();

      // Normal tab blocked; stealth page has elementCount=0 (evaluate throws) and no JS blocking detected
      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Akamai CDN' })  // Tier 1
        .mockResolvedValueOnce(null);  // Tier 2: blocking detection returns null (can't run JS)

      // Make the stealth page's evaluate throw so elementCount=0 and readyState='unknown'
      (mockSessionManager as any).createTargetStealth = jest.fn().mockImplementation(
        async (sessionId: string, url: string, workerId?: string) => {
          const resolvedWorkerId = workerId || 'default';
          const targetId = `stealth-broken-${Date.now()}`;
          const page = createMockPage({ url, targetId, title: '' });
          (page.evaluate as jest.Mock).mockRejectedValue(new Error('Target closed'));
          return { targetId, page, workerId: resolvedWorkerId };
        },
      );

      const result = await handler(testSessionId, { url: 'https://www.coupang.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.headed).toBe(true);
      expect(parsed.fallbackTier).toBe(3);
      expect(parsed.fallbackReason).toBe('access-denied');
      expect(mockHeadedNavigatePersistent).toHaveBeenCalledWith('https://www.coupang.com');
    });

    test('escalates to Tier 3 when stealth produces broken page (readyState=unknown)', async () => {
      const handler = await getNavigateHandler();

      // Normal tab blocked; stealth page's readyState evaluation throws → 'unknown'
      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'bot-check', detail: 'Security Check' })  // Tier 1
        .mockResolvedValueOnce(null);  // Tier 2: can't detect blocking

      (mockSessionManager as any).createTargetStealth = jest.fn().mockImplementation(
        async (sessionId: string, url: string, workerId?: string) => {
          const resolvedWorkerId = workerId || 'default';
          const targetId = `stealth-broken-${Date.now()}`;
          const page = createMockPage({ url, targetId, title: '' });
          // evaluate throws so readyState becomes 'unknown' and elementCount stays 0
          (page.evaluate as jest.Mock).mockRejectedValue(new Error('Execution context destroyed'));
          return { targetId, page, workerId: resolvedWorkerId };
        },
      );

      const result = await handler(testSessionId, { url: 'https://www.coupang.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.headed).toBe(true);
      expect(parsed.fallbackTier).toBe(3);
      expect(parsed.fallbackReason).toBe('bot-check');
      expect(mockHeadedNavigatePersistent).toHaveBeenCalledWith('https://www.coupang.com');
    });

    test('does NOT escalate to Tier 3 when autoFallback is false and stealth page is empty', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Akamai CDN' });

      // autoFallback: false means Tier 2 never happens, so no stealth retry at all
      const result = await handler(testSessionId, { url: 'https://www.coupang.com', autoFallback: false });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.fallbackTier).toBeUndefined();
      expect(parsed.headed).toBeUndefined();
      expect(mockHeadedNavigate).not.toHaveBeenCalled();
    });

    test('Tier 3 returns blockingPage if headed Chrome also gets blocked', async () => {
      const handler = await getNavigateHandler();

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Akamai CDN' })
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Still Denied' });

      // Headed Chrome also gets blocked
      mockHeadedNavigatePersistent.mockResolvedValue({
        url: 'https://www.coupang.com/',
        title: 'Access Denied',
        elementCount: 7,
        blockingPage: { type: 'access-denied', detail: 'Access Denied' },
        targetId: 'headed-target-blocked',
      });

      const result = await handler(testSessionId, { url: 'https://www.coupang.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.fallbackTier).toBe(3);
      expect(parsed.headed).toBe(true);
      expect(parsed.blockingPage).toBeDefined();
    });
  });

  describe('headed parameter (direct)', () => {
    test('headed=true navigates directly in headed Chrome without fake BlockingInfo (#560)', async () => {
      const handler = await getNavigateHandler();

      const result = await handler(testSessionId, { url: 'https://www.coupang.com', headed: true });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.headed).toBe(true);
      expect(parsed.userRequested).toBe(true);
      // #560: should NOT have fallbackTier/fallbackReason (no fake BlockingInfo)
      expect(parsed.fallbackTier).toBeUndefined();
      expect(parsed.fallbackReason).toBeUndefined();
      expect(parsed.title).toBe('Coupang');
      expect(mockHeadedNavigatePersistent).toHaveBeenCalledWith('https://www.coupang.com', undefined);
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

  describe('session integration (#485)', () => {
    test('headed=true registers page via registerHeadedPage when getPage returns a page', async () => {
      const handler = await getNavigateHandler();
      const mockPage = createMockPage({ url: 'https://www.coupang.com/', targetId: 'headed-target-123' });
      mockHeadedGetPage.mockReturnValue(mockPage);

      const result = await handler(testSessionId, { url: 'https://www.coupang.com', headed: true });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.headed).toBe(true);
      expect(parsed.tabId).toBe('headed-target-123');
      expect(parsed.workerId).toBe('headed');
      expect(mockSessionManager.registerHeadedPage).toHaveBeenCalledWith(
        'headed-target-123',
        testSessionId,
        'headed',
        mockPage,
      );
    });

    test('headed=true falls back to registerExternalTarget when getPage returns null', async () => {
      const handler = await getNavigateHandler();
      mockHeadedGetPage.mockReturnValue(null);

      const result = await handler(testSessionId, { url: 'https://www.coupang.com', headed: true });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.headed).toBe(true);
      expect(parsed.tabId).toBe('headed-target-123');
      expect(mockSessionManager.registerExternalTarget).toHaveBeenCalledWith(
        'headed-target-123',
        testSessionId,
        'headed',
      );
    });

    test('headed worker is created with the headed Chrome port (#561)', async () => {
      const handler = await getNavigateHandler();
      const mockPage = createMockPage({ url: 'https://www.coupang.com/', targetId: 'headed-target-123' });
      mockHeadedGetPage.mockReturnValue(mockPage);

      await handler(testSessionId, { url: 'https://www.coupang.com', headed: true });

      expect(mockSessionManager.getOrCreateWorker).toHaveBeenCalledWith(
        testSessionId,
        'headed',
        { shareCookies: true, port: 9322 },
      );
      const callArgs = (mockSessionManager.getOrCreateWorker as jest.Mock).mock.calls;
      const headedCall = callArgs.find((args: any[]) => args[1] === 'headed');
      expect(headedCall).toBeDefined();
      // #561: port must be present so getCDPClientForWorker routes to the correct Chrome
      expect(headedCall![2]).toHaveProperty('port', 9322);
    });

    test('headed=true with profileDirectory passes profile to headed Chrome (#562)', async () => {
      const handler = await getNavigateHandler();
      const mockPage = createMockPage({ url: 'https://aws.amazon.com/', targetId: 'headed-profile-123' });
      mockHeadedGetPage.mockReturnValue(mockPage);

      const result = await handler(testSessionId, {
        url: 'https://aws.amazon.com',
        headed: true,
        profileDirectory: 'Profile 1',
      });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      // Should use profile-scoped workerId, not "headed"
      expect(parsed.workerId).toBe('profile:Profile 1');
      expect(parsed.profileDirectory).toBe('Profile 1');
      expect(parsed.headed).toBe(true);
      expect(parsed.userRequested).toBe(true);
      // profileDirectory should be passed to navigatePersistent
      expect(mockHeadedNavigatePersistent).toHaveBeenCalledWith(
        'https://aws.amazon.com',
        'Profile 1',
      );
      // Worker should be created with profile-scoped ID and port
      expect(mockSessionManager.getOrCreateWorker).toHaveBeenCalledWith(
        testSessionId,
        'profile:Profile 1',
        expect.objectContaining({
          shareCookies: true,
          port: 9322,
          profileDirectory: 'Profile 1',
        }),
      );
    });

    test('Tier 3 auto-escalation registers headed page via registerHeadedPage', async () => {
      const handler = await getNavigateHandler();
      const mockPage = createMockPage({ url: 'https://www.coupang.com/', targetId: 'headed-target-123' });
      mockHeadedGetPage.mockReturnValue(mockPage);

      mockDetectBlockingPage
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Akamai CDN' })
        .mockResolvedValueOnce({ type: 'access-denied', detail: 'Still Denied' });

      const result = await handler(testSessionId, { url: 'https://www.coupang.com' });
      const parsed = parseResultJSON<NavResult>(result as MCPResult);

      expect(parsed.headed).toBe(true);
      expect(parsed.fallbackTier).toBe(3);
      expect(mockSessionManager.registerHeadedPage).toHaveBeenCalledWith(
        'headed-target-123',
        testSessionId,
        'headed',
        mockPage,
      );
    });
  });
});
