/// <reference types="jest" />
/**
 * Tests for Navigate Tool
 */

import { createMockSessionManager } from '../utils/mock-session';
import { createMockPage } from '../utils/mock-cdp';
import { getResultText, isErrorResult, parseResultJSON, urlPatterns } from '../utils/test-helpers';

// Mock the session manager module
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';

describe('NavigateTool', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let testSessionId: string;
  let testTargetId: string;

  // Import the handler dynamically to use mocked dependencies
  const getNavigateHandler = async () => {
    // Clear module cache to get fresh handler with mocks
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    const { registerNavigateTool } = await import('../../src/tools/navigate');

    // Create a mock server to extract the handler
    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };

    registerNavigateTool(mockServer as unknown as Parameters<typeof registerNavigateTool>[0]);
    return tools.get('navigate')!.handler;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);

    testSessionId = 'test-session-123';
    const { targetId, page } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('URL Handling', () => {
    test('adds https:// to URL without protocol', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        url: 'example.com',
      });

      expect(page.goto).toHaveBeenCalledWith(
        'https://example.com',
        expect.any(Object)
      );
    });

    test('preserves http:// if explicitly provided', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        url: 'http://example.com',
      });

      expect(page.goto).toHaveBeenCalledWith(
        'http://example.com',
        expect.any(Object)
      );
    });

    test('preserves https:// if provided', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        url: 'https://secure.example.com',
      });

      expect(page.goto).toHaveBeenCalledWith(
        'https://secure.example.com',
        expect.any(Object)
      );
    });

    test('handles URLs with ports', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        url: 'localhost:3000',
      });

      expect(page.goto).toHaveBeenCalledWith(
        'https://localhost:3000',
        expect.any(Object)
      );
    });

    test('handles URLs with query parameters', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        url: 'https://example.com/search?q=test&page=1',
      });

      expect(page.goto).toHaveBeenCalledWith(
        'https://example.com/search?q=test&page=1',
        expect.any(Object)
      );
    });

    test('handles URLs with fragments', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        url: 'https://example.com/page#section',
      });

      expect(page.goto).toHaveBeenCalledWith(
        'https://example.com/page#section',
        expect.any(Object)
      );
    });

    test('handles complex URLs with all components', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      const complexUrl = 'https://user:pass@subdomain.example.com:8080/path/to/page?query=value&foo=bar#section';

      await handler(testSessionId, {
        tabId: testTargetId,
        url: complexUrl,
      });

      expect(page.goto).toHaveBeenCalledWith(
        complexUrl,
        expect.any(Object)
      );
    });

    test('adds https:// to www URLs', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        url: 'www.example.com',
      });

      expect(page.goto).toHaveBeenCalledWith(
        'https://www.example.com',
        expect.any(Object)
      );
    });

    test('handles unicode URLs', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        url: 'https://例え.jp/パス',
      });

      expect(page.goto).toHaveBeenCalledWith(
        'https://例え.jp/パス',
        expect.any(Object)
      );
    });
  });

  describe('History Navigation', () => {
    test('goes back in history', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
      (page.url as jest.Mock).mockReturnValue('https://previous.page.com');
      (page.title as jest.Mock).mockResolvedValue('Previous Page');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        url: 'back',
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.goBack).toHaveBeenCalledWith({ waitUntil: 'domcontentloaded', timeout: 30000 });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.action).toBe('back');
    });

    test('goes forward in history', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
      (page.url as jest.Mock).mockReturnValue('https://next.page.com');
      (page.title as jest.Mock).mockResolvedValue('Next Page');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        url: 'forward',
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.goForward).toHaveBeenCalledWith({ waitUntil: 'domcontentloaded', timeout: 30000 });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.action).toBe('forward');
    });

    test('returns current URL after navigation', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
      (page.url as jest.Mock).mockReturnValue('https://navigated.page.com');
      (page.title as jest.Mock).mockResolvedValue('Navigated Page');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        url: 'https://navigated.page.com',
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.action).toBe('navigate');
      expect(parsed.url).toBe('https://navigated.page.com');
      expect(parsed.title).toBe('Navigated Page');
    });
  });

  describe('Error Handling', () => {
    test('creates new tab when tabId not provided', async () => {
      const handler = await getNavigateHandler();

      const result = await handler(testSessionId, {
        url: 'https://example.com',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      // New behavior: navigates (reusing or creating a tab) instead of returning error
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tabId).toBeDefined();
    });

    test('returns error for missing url', async () => {
      const handler = await getNavigateHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('url is required');
    });

    test('returns error when tab is no longer available', async () => {
      const handler = await getNavigateHandler();

      // Mock isTargetValid to return false for non-existent tab
      mockSessionManager.isTargetValid.mockResolvedValueOnce(false);

      const result = await handler(testSessionId, {
        tabId: 'non-existent-tab',
        url: 'https://example.com',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no longer available');
    });

    test('handles navigation timeout', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.goto as jest.Mock).mockRejectedValueOnce(new Error('Navigation timeout of 30000 ms exceeded'));

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        url: 'https://slow-site.com',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Navigation error');
      expect(result.content[0].text).toContain('timeout');
    });

    test('handles network errors', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.goto as jest.Mock).mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        url: 'https://nonexistent.invalid',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Navigation error');
    });

    test('handles SSL certificate errors', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.goto as jest.Mock).mockRejectedValueOnce(new Error('net::ERR_CERT_AUTHORITY_INVALID'));

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        url: 'https://self-signed.badssl.com',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Navigation error');
    });
  });

  describe('Session Isolation', () => {
    test('rejects navigation to tab from another session', async () => {
      const handler = await getNavigateHandler();

      // Create a second session with its own tab
      const session2Id = 'other-session';
      await mockSessionManager.createSession({ id: session2Id });
      const { targetId: session2TargetId } = await mockSessionManager.createTarget(session2Id);

      // Try to access session2's tab from session1
      const result = await handler(testSessionId, {
        tabId: session2TargetId,
        url: 'https://example.com',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      // Should fail because of ownership validation
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not belong to session');
    });

    test('allows navigation to own session tab', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
      (page.url as jest.Mock).mockReturnValue('https://example.com');
      (page.title as jest.Mock).mockResolvedValue('Example');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        url: 'https://example.com',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(page.goto).toHaveBeenCalled();
    });
  });

  describe('Navigation Options', () => {
    test('uses domcontentloaded wait condition', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        url: 'https://example.com',
      });

      expect(page.goto).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ waitUntil: 'domcontentloaded' })
      );
    });

    test('uses 30 second timeout', async () => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        url: 'https://example.com',
      });

      expect(page.goto).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeout: 30000 })
      );
    });
  });

  describe('Valid URL patterns', () => {
    test.each(urlPatterns.valid)('accepts valid URL: %s', async (url) => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        url,
      });

      expect(page.goto).toHaveBeenCalled();
    });

    test.each(urlPatterns.needsProtocol)('adds https:// to URL without protocol: %s', async (url) => {
      const handler = await getNavigateHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      await handler(testSessionId, {
        tabId: testTargetId,
        url,
      });

      expect(page.goto).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\//),
        expect.any(Object)
      );
    });
  });
});
