/// <reference types="jest" />
/**
 * Tests for Tabs Tools (tabs-context and tabs-create)
 */

import { createMockSessionManager } from '../utils/mock-session';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';

describe('TabsContextTool', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let testSessionId: string;

  const getTabsContextHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));

    const { registerTabsContextTool } = await import('../../src/tools/tabs-context');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };

    registerTabsContextTool(mockServer as unknown as Parameters<typeof registerTabsContextTool>[0]);
    return tools.get('tabs_context_mcp')!.handler;
  };

  beforeEach(() => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    testSessionId = 'test-session-123';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Get Tab Context', () => {
    test('returns empty tabs for new session', async () => {
      const handler = await getTabsContextHandler();

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sessionId).toBe(testSessionId);
      expect(parsed.tabCount).toBe(0);
      expect(parsed.workerCount).toBeGreaterThanOrEqual(1); // At least default worker
    });

    test('returns all tabs for session with tabs', async () => {
      const handler = await getTabsContextHandler();

      // Create some tabs
      await mockSessionManager.createTarget(testSessionId, 'https://example.com');
      await mockSessionManager.createTarget(testSessionId, 'https://google.com');

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tabCount).toBe(2);
      // Tabs are now grouped by worker
      const totalTabs = parsed.workers.reduce((sum: number, w: { tabs: unknown[] }) => sum + w.tabs.length, 0);
      expect(totalTabs).toBe(2);
    });

    test('includes tab info with tabId, url, title, workerId', async () => {
      const handler = await getTabsContextHandler();

      const { page } = await mockSessionManager.createTarget(testSessionId, 'https://example.com');
      (page.url as jest.Mock).mockReturnValue('https://example.com');
      (page.title as jest.Mock).mockResolvedValue('Example Domain');

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      // Find the default worker and its tabs
      const defaultWorker = parsed.workers.find((w: { id: string }) => w.id === 'default');
      expect(defaultWorker).toBeDefined();
      expect(defaultWorker.tabs[0]).toHaveProperty('tabId');
      expect(defaultWorker.tabs[0]).toHaveProperty('url');
      expect(defaultWorker.tabs[0]).toHaveProperty('title');
      expect(defaultWorker.tabs[0]).toHaveProperty('workerId');
    });
  });

  describe('No createIfEmpty Option (removed to prevent about:blank accumulation)', () => {
    test('never auto-creates tabs, returns empty when no tabs exist', async () => {
      const handler = await getTabsContextHandler();

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tabCount).toBe(0);
      // Workers exist but have no tabs
      expect(parsed.workers[0].tabs.length).toBe(0);
    });

    test('returns existing tabs when they exist', async () => {
      const handler = await getTabsContextHandler();

      // Create a tab first
      await mockSessionManager.createTarget(testSessionId, 'https://existing.com');

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tabCount).toBe(1);
    });

    test('ignores any createIfEmpty argument (deprecated)', async () => {
      const handler = await getTabsContextHandler();

      // Even with createIfEmpty, should not create tabs
      const result = await handler(testSessionId, {
        createIfEmpty: true,
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tabCount).toBe(0);
      expect(parsed.workers[0].tabs.length).toBe(0);
    });
  });

  describe('Session Creation', () => {
    test('creates session if not exists', async () => {
      const handler = await getTabsContextHandler();

      const newSessionId = 'brand-new-session';

      await handler(newSessionId, {});

      expect(mockSessionManager.getOrCreateSession).toHaveBeenCalledWith(newSessionId);
    });
  });

  describe('Error Handling', () => {
    test('handles errors gracefully', async () => {
      const handler = await getTabsContextHandler();

      mockSessionManager.getOrCreateSession.mockRejectedValueOnce(new Error('Session creation failed'));

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error getting tab context');
    });
  });
});

describe('TabsCreateTool', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let testSessionId: string;

  const getTabsCreateHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));

    const { registerTabsCreateTool } = await import('../../src/tools/tabs-create');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };

    registerTabsCreateTool(mockServer as unknown as Parameters<typeof registerTabsCreateTool>[0]);
    return tools.get('tabs_create_mcp')!.handler;
  };

  beforeEach(() => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    testSessionId = 'test-session-123';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Create New Tab', () => {
    test('creates a new tab with URL', async () => {
      const handler = await getTabsCreateHandler();

      const result = await handler(testSessionId, { url: 'https://example.com' }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty('tabId');
      expect(parsed).toHaveProperty('workerId');
      expect(parsed).toHaveProperty('url');
      expect(parsed).toHaveProperty('title');
    });

    test('returns tab info with correct properties', async () => {
      const handler = await getTabsCreateHandler();

      // Mock the page properties
      mockSessionManager.createTarget.mockImplementationOnce(async (sessionId, url, workerId) => {
        const { targetId, page, workerId: assignedWorkerId } = await (createMockSessionManager().createTarget as jest.Mock)(sessionId, url, workerId);
        (page.url as jest.Mock).mockReturnValue('https://example.com');
        (page.title as jest.Mock).mockResolvedValue('Example');
        return { targetId, page, workerId: assignedWorkerId };
      });

      const result = await handler(testSessionId, { url: 'https://example.com' }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tabId).toBeDefined();
      expect(parsed.workerId).toBeDefined();
    });

    test('creates tab with specified URL (not about:blank)', async () => {
      const handler = await getTabsCreateHandler();

      await handler(testSessionId, { url: 'https://google.com' });

      // Now includes optional workerId parameter
      expect(mockSessionManager.createTarget).toHaveBeenCalledWith(testSessionId, 'https://google.com', undefined);
    });

    test('returns error when URL is not provided', async () => {
      const handler = await getTabsCreateHandler();

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('url is required');
    });
  });

  describe('Session Handling', () => {
    test('creates or uses existing session', async () => {
      const handler = await getTabsCreateHandler();

      await handler(testSessionId, { url: 'https://example.com' });

      // createTarget implicitly creates/uses session, now with optional workerId
      expect(mockSessionManager.createTarget).toHaveBeenCalledWith(testSessionId, 'https://example.com', undefined);
    });
  });

  describe('Multiple Tab Creation', () => {
    test('can create multiple tabs in same session', async () => {
      const handler = await getTabsCreateHandler();

      await handler(testSessionId, { url: 'https://example1.com' });
      await handler(testSessionId, { url: 'https://example2.com' });
      await handler(testSessionId, { url: 'https://example3.com' });

      expect(mockSessionManager.createTarget).toHaveBeenCalledTimes(3);
    });

    test('each tab has unique tabId', async () => {
      const handler = await getTabsCreateHandler();

      const result1 = await handler(testSessionId, { url: 'https://example1.com' }) as { content: Array<{ type: string; text: string }> };
      const result2 = await handler(testSessionId, { url: 'https://example2.com' }) as { content: Array<{ type: string; text: string }> };

      const parsed1 = JSON.parse(result1.content[0].text);
      const parsed2 = JSON.parse(result2.content[0].text);

      expect(parsed1.tabId).not.toBe(parsed2.tabId);
    });
  });

  describe('Error Handling', () => {
    test('handles tab creation failure', async () => {
      const handler = await getTabsCreateHandler();

      mockSessionManager.createTarget.mockRejectedValueOnce(new Error('Failed to create tab'));

      const result = await handler(testSessionId, { url: 'https://example.com' }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error creating tab');
    });
  });
});

describe('Tabs Tools Integration', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let testSessionId: string;

  const getHandlers = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));

    const { registerTabsContextTool } = await import('../../src/tools/tabs-context');
    const { registerTabsCreateTool } = await import('../../src/tools/tabs-create');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };

    registerTabsContextTool(mockServer as unknown as Parameters<typeof registerTabsContextTool>[0]);
    registerTabsCreateTool(mockServer as unknown as Parameters<typeof registerTabsCreateTool>[0]);

    return {
      tabsContext: tools.get('tabs_context_mcp')!.handler,
      tabsCreate: tools.get('tabs_create_mcp')!.handler,
    };
  };

  beforeEach(() => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    testSessionId = 'test-session-123';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('context reflects newly created tabs', async () => {
    const { tabsContext, tabsCreate } = await getHandlers();

    // Check initial state
    const initial = await tabsContext(testSessionId, {}) as { content: Array<{ type: string; text: string }> };
    const initialParsed = JSON.parse(initial.content[0].text);
    expect(initialParsed.tabCount).toBe(0);

    // Create a tab with URL
    await tabsCreate(testSessionId, { url: 'https://example.com' });

    // Check updated state
    const updated = await tabsContext(testSessionId, {}) as { content: Array<{ type: string; text: string }> };
    const updatedParsed = JSON.parse(updated.content[0].text);
    expect(updatedParsed.tabCount).toBe(1);
  });

  test('different sessions have independent tabs', async () => {
    const { tabsContext, tabsCreate } = await getHandlers();

    const session1 = 'session-1';
    const session2 = 'session-2';

    // Create tabs in session 1
    await tabsCreate(session1, { url: 'https://example1.com' });
    await tabsCreate(session1, { url: 'https://example2.com' });

    // Create tab in session 2
    await tabsCreate(session2, { url: 'https://example3.com' });

    // Check session 1
    const result1 = await tabsContext(session1, {}) as { content: Array<{ type: string; text: string }> };
    const parsed1 = JSON.parse(result1.content[0].text);
    expect(parsed1.tabCount).toBe(2);

    // Check session 2
    const result2 = await tabsContext(session2, {}) as { content: Array<{ type: string; text: string }> };
    const parsed2 = JSON.parse(result2.content[0].text);
    expect(parsed2.tabCount).toBe(1);
  });
});
