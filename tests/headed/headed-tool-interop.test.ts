/// <reference types="jest" />
/**
 * E2E unit tests for headed mode tool interoperability (#485).
 *
 * Verifies that tool handlers (read_page, interact, cookies, javascript_tool)
 * correctly route to headed pages registered via registerHeadedPage().
 * No display or real Chrome required — all Chrome/CDP calls are mocked.
 */

import { createMockSessionManager, createMockRefIdManager } from '../utils/mock-session';
import { createMockPage } from '../utils/mock-cdp';
import { parseResultJSON } from '../utils/test-helpers';
import type { MCPResult } from '../../src/types/mcp';

// ── Top-level module mocks (hoisted before imports) ──────────────────────────

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(),
}));

jest.mock('../../src/security/domain-guard', () => ({
  assertDomainAllowed: jest.fn(),
}));

jest.mock('../../src/utils/pagination-detector', () => ({
  detectPagination: jest.fn().mockResolvedValue({ type: 'none' }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: () => ({ port: 9222, security: { sanitize_content: false } }),
}));

jest.mock('../../src/compression/snapshot-store', () => ({
  SnapshotStore: { getInstance: () => ({ get: jest.fn().mockReturnValue(null), set: jest.fn(), computeDelta: jest.fn() }) },
}));

import { getSessionManager } from '../../src/session-manager';
import { getRefIdManager } from '../../src/utils/ref-id-manager';

// ── Shared fixture constants ──────────────────────────────────────────────────

const SESSION_ID = 'session-headed-tool-interop';
const WORKER_ID = 'headed';
const TARGET_ID = 'headed-target-tool-001';
const PAGE_URL = 'https://blocked-by-cdn.example.com/';

// ── Handler factory helpers (mirror the pattern from navigate-headed-fallback.test.ts) ──

type HandlerFn = (sessionId: string, args: Record<string, unknown>) => Promise<unknown>;

async function getReadPageHandler(
  mockSessionManager: ReturnType<typeof createMockSessionManager>,
  mockRefIdManager: ReturnType<typeof createMockRefIdManager>,
): Promise<HandlerFn> {
  jest.resetModules();
  jest.doMock('../../src/session-manager', () => ({
    getSessionManager: () => mockSessionManager,
  }));
  jest.doMock('../../src/utils/ref-id-manager', () => ({
    getRefIdManager: () => mockRefIdManager,
  }));
  jest.doMock('../../src/security/domain-guard', () => ({
    assertDomainAllowed: jest.fn(),
  }));
  jest.doMock('../../src/utils/pagination-detector', () => ({
    detectPagination: jest.fn().mockResolvedValue({ type: 'none' }),
  }));
  jest.doMock('../../src/config/global', () => ({
    getGlobalConfig: () => ({ port: 9222, security: { sanitize_content: false } }),
  }));
  jest.doMock('../../src/compression/snapshot-store', () => ({
    SnapshotStore: { getInstance: () => ({ get: jest.fn().mockReturnValue(null), set: jest.fn(), computeDelta: jest.fn() }) },
  }));
  // Provide a simple serializeDOM that returns page content
  jest.doMock('../../src/dom', () => ({
    serializeDOM: jest.fn().mockResolvedValue({
      content: '<html><body>Headed page content</body></html>',
      pageStats: {
        url: PAGE_URL,
        title: 'Headed Page',
        scrollX: 0,
        scrollY: 0,
        scrollWidth: 1280,
        scrollHeight: 720,
        viewportWidth: 1280,
        viewportHeight: 720,
      },
    }),
  }));

  const { registerReadPageTool } = await import('../../src/tools/read-page');
  const tools: Map<string, { handler: HandlerFn }> = new Map();
  const mockServer = {
    registerTool: (name: string, handler: unknown) => {
      tools.set(name, { handler: handler as HandlerFn });
    },
  };
  registerReadPageTool(mockServer as unknown as Parameters<typeof registerReadPageTool>[0]);
  return tools.get('read_page')!.handler;
}

async function getInteractHandler(
  mockSessionManager: ReturnType<typeof createMockSessionManager>,
): Promise<HandlerFn> {
  jest.resetModules();
  jest.doMock('../../src/session-manager', () => ({
    getSessionManager: () => mockSessionManager,
  }));
  jest.doMock('../../src/utils/ref-id-manager', () => ({
    getRefIdManager: () => createMockRefIdManager(),
  }));
  jest.doMock('../../src/security/domain-guard', () => ({
    assertDomainAllowed: jest.fn(),
  }));
  jest.doMock('../../src/utils/dom-delta', () => ({
    withDomDelta: jest.fn().mockResolvedValue({ domDelta: '' }),
  }));
  jest.doMock('../../src/utils/visual-summary', () => ({
    generateVisualSummary: jest.fn().mockResolvedValue(null),
  }));
  jest.doMock('../../src/stealth/human-behavior', () => ({
    humanMouseMove: jest.fn().mockResolvedValue(undefined),
    simulatePresence: jest.fn().mockResolvedValue(undefined),
  }));
  jest.doMock('../../src/utils/ralph/circuit-breaker', () => ({
    getCircuitBreaker: () => ({ isOpen: jest.fn().mockReturnValue(false), record: jest.fn() }),
  }));
  jest.doMock('../../src/utils/ralph/outcome-classifier', () => ({
    classifyOutcome: jest.fn().mockReturnValue({ type: 'success' }),
    formatOutcomeLine: jest.fn().mockReturnValue('success'),
  }));

  const { registerInteractTool } = await import('../../src/tools/interact');
  const tools: Map<string, { handler: HandlerFn }> = new Map();
  const mockServer = {
    registerTool: (name: string, handler: unknown) => {
      tools.set(name, { handler: handler as HandlerFn });
    },
  };
  registerInteractTool(mockServer as unknown as Parameters<typeof registerInteractTool>[0]);
  return tools.get('interact')!.handler;
}

async function getCookiesHandler(
  mockSessionManager: ReturnType<typeof createMockSessionManager>,
): Promise<HandlerFn> {
  jest.resetModules();
  jest.doMock('../../src/session-manager', () => ({
    getSessionManager: () => mockSessionManager,
  }));
  jest.doMock('../../src/security/domain-guard', () => ({
    assertDomainAllowed: jest.fn(),
  }));

  const { registerCookiesTool } = await import('../../src/tools/cookies');
  const tools: Map<string, { handler: HandlerFn }> = new Map();
  const mockServer = {
    registerTool: (name: string, handler: unknown) => {
      tools.set(name, { handler: handler as HandlerFn });
    },
  };
  registerCookiesTool(mockServer as unknown as Parameters<typeof registerCookiesTool>[0]);
  return tools.get('cookies')!.handler;
}

async function getJavascriptHandler(
  mockSessionManager: ReturnType<typeof createMockSessionManager>,
): Promise<HandlerFn> {
  jest.resetModules();
  jest.doMock('../../src/session-manager', () => ({
    getSessionManager: () => mockSessionManager,
  }));
  jest.doMock('../../src/security/domain-guard', () => ({
    assertDomainAllowed: jest.fn(),
  }));

  const { registerJavascriptTool } = await import('../../src/tools/javascript');
  const tools: Map<string, { handler: HandlerFn }> = new Map();
  const mockServer = {
    registerTool: (name: string, handler: unknown) => {
      tools.set(name, { handler: handler as HandlerFn });
    },
  };
  registerJavascriptTool(mockServer as unknown as Parameters<typeof registerJavascriptTool>[0]);
  return tools.get('javascript_tool')!.handler;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Headed Tool Interop (#485)', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockRefIdManager: ReturnType<typeof createMockRefIdManager>;
  let mockPage: ReturnType<typeof createMockPage>;

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    mockRefIdManager = createMockRefIdManager();

    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    (getRefIdManager as jest.Mock).mockReturnValue(mockRefIdManager);

    // Create session and headed worker
    await mockSessionManager.getOrCreateSession(SESSION_ID);
    await mockSessionManager.getOrCreateWorker(SESSION_ID, WORKER_ID);

    // Build a mock page as if headed Chrome opened it
    mockPage = createMockPage({ url: PAGE_URL, targetId: TARGET_ID, title: 'Headed Page' });

    // Register the page as a headed page (simulates what navigate tool does after Tier 3)
    mockSessionManager.registerHeadedPage(TARGET_ID, SESSION_ID, WORKER_ID, mockPage);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── 1. read_page ─────────────────────────────────────────────────────────────

  describe('read_page handler resolves headed page by targetId', () => {
    test('returns non-error response with page content for headed targetId', async () => {
      const handler = await getReadPageHandler(mockSessionManager, mockRefIdManager);

      // read_page uses mode=dom by default — serializeDOM is mocked above
      const result = await handler(SESSION_ID, { tabId: TARGET_ID, mode: 'dom' }) as MCPResult;

      expect(result.isError).toBeFalsy();
      expect(result.content).toBeDefined();
      expect(result.content!.length).toBeGreaterThan(0);
      const text = (result.content![0] as { type: string; text: string }).text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    test('calls sessionManager.getPage with the headed targetId', async () => {
      const handler = await getReadPageHandler(mockSessionManager, mockRefIdManager);

      await handler(SESSION_ID, { tabId: TARGET_ID, mode: 'dom' });

      expect(mockSessionManager.getPage).toHaveBeenCalledWith(SESSION_ID, TARGET_ID);
    });

    test('returns error when targetId is not registered', async () => {
      const handler = await getReadPageHandler(mockSessionManager, mockRefIdManager);

      const result = await handler(SESSION_ID, { tabId: 'non-existent-target', mode: 'dom' }) as MCPResult;

      expect(result.isError).toBe(true);
      const text = (result.content![0] as { type: string; text: string }).text;
      expect(text).toMatch(/not found|not belong/i);
    });
  });

  // ── 2. interact ──────────────────────────────────────────────────────────────

  describe('interact handler routes to headed page', () => {
    test('calls sessionManager.getPage with the headed targetId', async () => {
      const handler = await getInteractHandler(mockSessionManager);

      // Set up CDP responses for AX resolution and element discovery
      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ nodes: [] })  // Accessibility.getFullAXTree → no AX matches → fallback to DOM discovery
        .mockResolvedValue({});  // Remaining CDP calls (DOM.scrollIntoViewIfNeeded, etc.)

      // page.evaluate is used by element discovery — return empty discovery result
      (mockPage.evaluate as jest.Mock).mockResolvedValue([]);

      await handler(SESSION_ID, { tabId: TARGET_ID, query: 'submit button', action: 'click' });

      expect(mockSessionManager.getPage).toHaveBeenCalledWith(SESSION_ID, TARGET_ID, undefined, 'interact');
    });

    test('returns error when headed targetId is not registered', async () => {
      const handler = await getInteractHandler(mockSessionManager);

      const result = await handler(SESSION_ID, {
        tabId: 'unknown-headed-target',
        query: 'submit button',
      }) as MCPResult;

      expect(result.isError).toBe(true);
      const text = (result.content![0] as { type: string; text: string }).text;
      expect(text).toMatch(/not found|not belong/i);
    });
  });

  // ── 3. cookies ───────────────────────────────────────────────────────────────

  describe('cookies handler returns cookies from headed page', () => {
    test('returns cookies from the headed page', async () => {
      const handler = await getCookiesHandler(mockSessionManager);

      const mockCookies = [
        { name: 'session_id', value: 'abc123', domain: 'blocked-by-cdn.example.com', path: '/' },
        { name: '_ga', value: 'GA1.2.xxx', domain: 'blocked-by-cdn.example.com', path: '/' },
      ];

      // Add cookies() to the mock page (not in createMockPage by default)
      (mockPage as any).cookies = jest.fn().mockResolvedValue(mockCookies);

      const result = await handler(SESSION_ID, { tabId: TARGET_ID, action: 'get' }) as MCPResult;

      expect(result.isError).toBeFalsy();
      expect((mockPage as any).cookies).toHaveBeenCalled();

      const text = (result.content![0] as { type: string; text: string }).text;
      expect(text).toContain('session_id');
    });

    test('calls sessionManager.getPage with the headed targetId', async () => {
      const handler = await getCookiesHandler(mockSessionManager);

      (mockPage as any).cookies = jest.fn().mockResolvedValue([]);

      await handler(SESSION_ID, { tabId: TARGET_ID, action: 'get' });

      expect(mockSessionManager.getPage).toHaveBeenCalledWith(
        SESSION_ID, TARGET_ID, undefined, 'cookies',
      );
    });

    test('returns error when headed targetId is not registered', async () => {
      const handler = await getCookiesHandler(mockSessionManager);

      const result = await handler(SESSION_ID, {
        tabId: 'unknown-headed-target',
        action: 'get',
      }) as MCPResult;

      expect(result.isError).toBe(true);
    });
  });

  // ── 4. javascript_tool ───────────────────────────────────────────────────────

  describe('javascript_tool handler calls evaluate on headed page', () => {
    test('routes Runtime.evaluate to the headed page via cdpClient', async () => {
      const handler = await getJavascriptHandler(mockSessionManager);

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'string', value: PAGE_URL },
      });

      const result = await handler(SESSION_ID, {
        tabId: TARGET_ID,
        code: 'window.location.href',
      }) as MCPResult;

      expect(result.isError).toBeFalsy();
      expect(mockSessionManager.getPage).toHaveBeenCalledWith(
        SESSION_ID, TARGET_ID, undefined, 'javascript_tool',
      );
      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        mockPage,
        'Runtime.evaluate',
        expect.objectContaining({
          expression: 'window.location.href',
          returnByValue: false,
          awaitPromise: true,
        }),
      );
    });

    test('returns the evaluated result from the headed page', async () => {
      const handler = await getJavascriptHandler(mockSessionManager);

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'number', value: 42, description: '42' },
      });

      const result = await handler(SESSION_ID, {
        tabId: TARGET_ID,
        code: '6 * 7',
      }) as MCPResult;

      expect(result.isError).toBeFalsy();
      const text = (result.content![0] as { type: string; text: string }).text;
      expect(text).toBe('42');
    });

    test('returns error when headed targetId is not registered', async () => {
      const handler = await getJavascriptHandler(mockSessionManager);

      const result = await handler(SESSION_ID, {
        tabId: 'unknown-headed-target',
        code: 'document.title',
      }) as MCPResult;

      expect(result.isError).toBe(true);
    });
  });

  // ── 5. Registration invariants ───────────────────────────────────────────────

  describe('registerHeadedPage() wiring', () => {
    test('page is stored and retrievable via getPage after registration', async () => {
      const page = await mockSessionManager.getPage(SESSION_ID, TARGET_ID);
      expect(page).toBe(mockPage);
    });

    test('worker tracks the headed targetId', () => {
      const worker = mockSessionManager.getWorker(SESSION_ID, WORKER_ID);
      expect(worker).toBeDefined();
      expect(worker!.targets.has(TARGET_ID)).toBe(true);
    });

    test('registerHeadedPage called registerExternalTarget exactly once', () => {
      // registerHeadedPage delegates to registerExternalTarget internally
      expect(mockSessionManager.registerExternalTarget).toHaveBeenCalledWith(
        TARGET_ID, SESSION_ID, WORKER_ID,
      );
    });

    test('multiple headed pages can be registered to the same worker', async () => {
      const targetId2 = 'headed-target-tool-002';
      const page2 = createMockPage({ url: 'https://other-cdn.example.com/', targetId: targetId2 });
      mockSessionManager.registerHeadedPage(targetId2, SESSION_ID, WORKER_ID, page2);

      const retrieved = await mockSessionManager.getPage(SESSION_ID, targetId2);
      expect(retrieved).toBe(page2);

      const worker = mockSessionManager.getWorker(SESSION_ID, WORKER_ID);
      expect(worker!.targets.has(TARGET_ID)).toBe(true);
      expect(worker!.targets.has(targetId2)).toBe(true);
    });
  });
});
