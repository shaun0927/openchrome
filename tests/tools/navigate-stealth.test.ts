/// <reference types="jest" />
/**
 * Tests for Navigate Tool - Stealth (CDP-free) mode
 */

import { createMockSessionManager } from '../utils/mock-session';
import { createMockPage } from '../utils/mock-cdp';
import { parseResultJSON } from '../utils/test-helpers';

// Mock the session manager module
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

import { getSessionManager } from '../../src/session-manager';

describe('NavigateTool - Stealth Mode', () => {
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
    testSessionId = 'test-session-stealth';

    // Add createTargetStealth mock to the session manager
    (mockSessionManager as any).createTargetStealth = jest.fn().mockImplementation(
      async (sessionId: string, url: string, workerId?: string, settleMs?: number) => {
        const resolvedWorkerId = workerId || 'default';
        const targetId = `stealth-target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const page = createMockPage({ url, targetId });
        return { targetId, page, workerId: resolvedWorkerId };
      }
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('stealth parameter', () => {
    test('stealth=true uses createTargetStealth instead of createTarget', async () => {
      const handler = await getNavigateHandler();

      await handler(testSessionId, {
        url: 'https://example.com',
        stealth: true,
      });

      expect((mockSessionManager as any).createTargetStealth).toHaveBeenCalledTimes(1);
      expect(mockSessionManager.createTarget).not.toHaveBeenCalled();
    });

    test('stealth=false (or absent) uses normal createTarget', async () => {
      const handler = await getNavigateHandler();

      await handler(testSessionId, {
        url: 'https://example.com',
      });

      expect(mockSessionManager.createTarget).toHaveBeenCalledTimes(1);
      expect((mockSessionManager as any).createTargetStealth).not.toHaveBeenCalled();
    });

    test('stealth mode passes default settleMs of 5000', async () => {
      const handler = await getNavigateHandler();

      await handler(testSessionId, {
        url: 'https://example.com',
        stealth: true,
      });

      expect((mockSessionManager as any).createTargetStealth).toHaveBeenCalledWith(
        testSessionId,
        'https://example.com',
        undefined,
        5000
      );
    });

    test('stealth mode passes custom stealthSettleMs', async () => {
      const handler = await getNavigateHandler();

      await handler(testSessionId, {
        url: 'https://example.com',
        stealth: true,
        stealthSettleMs: 10000,
      });

      expect((mockSessionManager as any).createTargetStealth).toHaveBeenCalledWith(
        testSessionId,
        'https://example.com',
        undefined,
        10000
      );
    });

    test('stealthSettleMs is clamped to minimum 1000', async () => {
      const handler = await getNavigateHandler();

      await handler(testSessionId, {
        url: 'https://example.com',
        stealth: true,
        stealthSettleMs: 100,
      });

      expect((mockSessionManager as any).createTargetStealth).toHaveBeenCalledWith(
        testSessionId,
        'https://example.com',
        undefined,
        1000
      );
    });

    test('stealthSettleMs is clamped to maximum 30000', async () => {
      const handler = await getNavigateHandler();

      await handler(testSessionId, {
        url: 'https://example.com',
        stealth: true,
        stealthSettleMs: 999999,
      });

      expect((mockSessionManager as any).createTargetStealth).toHaveBeenCalledWith(
        testSessionId,
        'https://example.com',
        undefined,
        30000
      );
    });

    test('stealth mode response includes standard fields', async () => {
      const handler = await getNavigateHandler();

      const result = await handler(testSessionId, {
        url: 'https://example.com',
        stealth: true,
      });

      const parsed = parseResultJSON(result as any) as Record<string, unknown>;

      expect(parsed).toMatchObject({
        action: 'navigate',
        tabId: expect.any(String),
        workerId: expect.any(String),
        created: true,
      });
      expect(typeof parsed['url']).toBe('string');
      expect(typeof parsed['title']).toBe('string');
    });

    test('stealth mode passes workerId to createTargetStealth', async () => {
      const handler = await getNavigateHandler();

      await handler(testSessionId, {
        url: 'https://example.com',
        stealth: true,
        workerId: 'worker-1',
      });

      expect((mockSessionManager as any).createTargetStealth).toHaveBeenCalledWith(
        testSessionId,
        'https://example.com',
        'worker-1',
        5000
      );
    });

    test('stealth mode adds https:// prefix when missing', async () => {
      const handler = await getNavigateHandler();

      await handler(testSessionId, {
        url: 'example.com',
        stealth: true,
      });

      expect((mockSessionManager as any).createTargetStealth).toHaveBeenCalledWith(
        testSessionId,
        'https://example.com',
        undefined,
        5000
      );
    });
  });
});
