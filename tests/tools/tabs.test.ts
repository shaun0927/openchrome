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
      expect(parsed.tabs).toEqual([]);
      expect(parsed.tabCount).toBe(0);
    });

    test('returns all tabs for session with tabs', async () => {
      const handler = await getTabsContextHandler();

      // Create some tabs
      await mockSessionManager.createTarget(testSessionId, 'https://example.com');
      await mockSessionManager.createTarget(testSessionId, 'https://google.com');

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tabCount).toBe(2);
      expect(parsed.tabs.length).toBe(2);
    });

    test('includes tab info with tabId, url, title', async () => {
      const handler = await getTabsContextHandler();

      const { targetId, page } = await mockSessionManager.createTarget(testSessionId, 'https://example.com');
      (page.url as jest.Mock).mockReturnValue('https://example.com');
      (page.title as jest.Mock).mockResolvedValue('Example Domain');

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tabs[0]).toHaveProperty('tabId');
      expect(parsed.tabs[0]).toHaveProperty('url');
      expect(parsed.tabs[0]).toHaveProperty('title');
    });
  });

  describe('createIfEmpty Option', () => {
    test('creates new tab when createIfEmpty=true and no tabs', async () => {
      const handler = await getTabsContextHandler();

      const result = await handler(testSessionId, {
        createIfEmpty: true,
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tabCount).toBe(1);
      expect(parsed.tabs.length).toBe(1);
    });

    test('does not create tab when createIfEmpty=true and tabs exist', async () => {
      const handler = await getTabsContextHandler();

      // Create a tab first
      await mockSessionManager.createTarget(testSessionId, 'https://existing.com');

      const result = await handler(testSessionId, {
        createIfEmpty: true,
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tabCount).toBe(1); // Still just the one we created
    });

    test('does not create tab when createIfEmpty=false', async () => {
      const handler = await getTabsContextHandler();

      const result = await handler(testSessionId, {
        createIfEmpty: false,
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tabCount).toBe(0);
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
    test('creates a new empty tab', async () => {
      const handler = await getTabsCreateHandler();

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty('tabId');
      expect(parsed).toHaveProperty('url');
      expect(parsed).toHaveProperty('title');
    });

    test('returns tab info with correct properties', async () => {
      const handler = await getTabsCreateHandler();

      // Mock the page properties
      mockSessionManager.createTarget.mockImplementationOnce(async (sessionId, url) => {
        const { targetId, page } = await (createMockSessionManager().createTarget as jest.Mock)(sessionId, url);
        (page.url as jest.Mock).mockReturnValue('about:blank');
        (page.title as jest.Mock).mockResolvedValue('');
        return { targetId, page };
      });

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tabId).toBeDefined();
    });

    test('creates tab with about:blank URL', async () => {
      const handler = await getTabsCreateHandler();

      await handler(testSessionId, {});

      expect(mockSessionManager.createTarget).toHaveBeenCalledWith(testSessionId, 'about:blank');
    });
  });

  describe('Session Handling', () => {
    test('creates or uses existing session', async () => {
      const handler = await getTabsCreateHandler();

      await handler(testSessionId, {});

      // createTarget implicitly creates/uses session
      expect(mockSessionManager.createTarget).toHaveBeenCalledWith(testSessionId, 'about:blank');
    });
  });

  describe('Multiple Tab Creation', () => {
    test('can create multiple tabs in same session', async () => {
      const handler = await getTabsCreateHandler();

      await handler(testSessionId, {});
      await handler(testSessionId, {});
      await handler(testSessionId, {});

      expect(mockSessionManager.createTarget).toHaveBeenCalledTimes(3);
    });

    test('each tab has unique tabId', async () => {
      const handler = await getTabsCreateHandler();

      const result1 = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }> };
      const result2 = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }> };

      const parsed1 = JSON.parse(result1.content[0].text);
      const parsed2 = JSON.parse(result2.content[0].text);

      expect(parsed1.tabId).not.toBe(parsed2.tabId);
    });
  });

  describe('Error Handling', () => {
    test('handles tab creation failure', async () => {
      const handler = await getTabsCreateHandler();

      mockSessionManager.createTarget.mockRejectedValueOnce(new Error('Failed to create tab'));

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }>; isError?: boolean };

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

    // Create a tab
    await tabsCreate(testSessionId, {});

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
    await tabsCreate(session1, {});
    await tabsCreate(session1, {});

    // Create tab in session 2
    await tabsCreate(session2, {});

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
