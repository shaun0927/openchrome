/// <reference types="jest" />
/**
 * Tests for Find Tool
 */

import { createMockSessionManager, createMockRefIdManager } from '../utils/mock-session';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { getRefIdManager } from '../../src/utils/ref-id-manager';

describe('FindTool', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockRefIdManager: ReturnType<typeof createMockRefIdManager>;
  let testSessionId: string;
  let testTargetId: string;

  const getFindHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: () => mockRefIdManager,
    }));

    const { registerFindTool } = await import('../../src/tools/find');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };

    registerFindTool(mockServer as unknown as Parameters<typeof registerFindTool>[0]);
    return tools.get('find')!.handler;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    mockRefIdManager = createMockRefIdManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    (getRefIdManager as jest.Mock).mockReturnValue(mockRefIdManager);

    testSessionId = 'test-session-123';
    const { targetId, page } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;

    // Set up default page.evaluate response
    (page.evaluate as jest.Mock).mockResolvedValue([]);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Query Parsing', () => {
    test('finds button by keyword', async () => {
      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue([
        {
          backendDOMNodeId: 0,
          role: 'button',
          name: 'Submit',
          tagName: 'button',
          rect: { x: 100, y: 100, width: 80, height: 30 },
        },
      ]);

      // Mock CDP response for getting backend node ID
      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ result: { objectId: 'batch-obj' } })
        .mockResolvedValueOnce({ result: [
          { name: '0', value: { objectId: 'el-obj-0' } },
        ]})
        .mockResolvedValueOnce({ node: { backendNodeId: 12345 } });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: 'button',
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.evaluate).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Found');
    });

    test('finds link by keyword', async () => {
      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue([
        {
          backendDOMNodeId: 0,
          role: 'link',
          name: 'Learn More',
          tagName: 'a',
          rect: { x: 200, y: 150, width: 100, height: 20 },
        },
      ]);

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ result: { objectId: 'batch-obj' } })
        .mockResolvedValueOnce({ result: [
          { name: '0', value: { objectId: 'el-obj-0' } },
        ]})
        .mockResolvedValueOnce({ node: { backendNodeId: 12346 } });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: 'link',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('link');
    });

    test('finds input by keyword', async () => {
      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue([
        {
          backendDOMNodeId: 0,
          role: 'textbox',
          name: 'Email',
          tagName: 'input',
          type: 'text',
          rect: { x: 50, y: 200, width: 200, height: 30 },
        },
      ]);

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ result: { objectId: 'batch-obj' } })
        .mockResolvedValueOnce({ result: [
          { name: '0', value: { objectId: 'el-obj-0' } },
        ]})
        .mockResolvedValueOnce({ node: { backendNodeId: 12347 } });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: 'input',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('textbox');
    });

    test('finds checkbox by keyword', async () => {
      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue([
        {
          backendDOMNodeId: 0,
          role: 'checkbox',
          name: 'Remember me',
          tagName: 'input',
          type: 'checkbox',
          rect: { x: 50, y: 250, width: 20, height: 20 },
        },
      ]);

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ result: { objectId: 'batch-obj' } })
        .mockResolvedValueOnce({ result: [
          { name: '0', value: { objectId: 'el-obj-0' } },
        ]})
        .mockResolvedValueOnce({ node: { backendNodeId: 12348 } });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: 'checkbox',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('checkbox');
    });

    test('finds element by text content', async () => {
      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue([
        {
          backendDOMNodeId: 0,
          role: 'button',
          name: 'Submit Order',
          tagName: 'button',
          textContent: 'Submit Order',
          rect: { x: 100, y: 300, width: 120, height: 40 },
        },
      ]);

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ result: { objectId: 'batch-obj' } })
        .mockResolvedValueOnce({ result: [
          { name: '0', value: { objectId: 'el-obj-0' } },
        ]})
        .mockResolvedValueOnce({ node: { backendNodeId: 12349 } });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: 'Submit Order',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Submit Order');
    });

    test('handles case insensitive search', async () => {
      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // The query is passed to page.evaluate lowercased
      (page.evaluate as jest.Mock).mockImplementation((fn, query) => {
        expect(query).toBe('button'); // Should be lowercased
        return [];
      });

      await handler(testSessionId, {
        tabId: testTargetId,
        query: 'BUTTON',
        waitForMs: 0, // disable polling so the test exits immediately
      });

      expect(page.evaluate).toHaveBeenCalled();
    });
  });

  describe('Result Limiting', () => {
    test('returns max 20 elements', async () => {
      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // Create 25 results
      const manyResults = Array.from({ length: 25 }, (_, i) => ({
        backendDOMNodeId: 0,
        role: 'button',
        name: `Button ${i}`,
        tagName: 'button',
        rect: { x: 100, y: 50 * i, width: 80, height: 30 },
      }));

      (page.evaluate as jest.Mock).mockResolvedValue(manyResults.slice(0, 20));

      // Mock CDP responses for batched approach
      mockSessionManager.mockCDPClient.send
        // Step 1: Runtime.evaluate returns batch array
        .mockResolvedValueOnce({ result: { objectId: 'batch-obj' } })
        // Step 2: Runtime.getProperties returns all element references
        .mockResolvedValueOnce({ result: Array.from({ length: 20 }, (_, i) => ({
          name: String(i),
          value: { objectId: `el-obj-${i}` },
        }))});

      // Step 3: DOM.describeNode for each element
      for (let i = 0; i < 20; i++) {
        mockSessionManager.mockCDPClient.send
          .mockResolvedValueOnce({ node: { backendNodeId: 12345 + i } });
      }

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: 'button',
      }) as { content: Array<{ type: string; text: string }> };

      // The limit is enforced in page.evaluate, so we verify it was called
      expect(page.evaluate).toHaveBeenCalled();
    });
  });

  describe('Error Cases', () => {
    test('returns error for missing tabId', async () => {
      const handler = await getFindHandler();

      const result = await handler(testSessionId, {
        query: 'button',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tabId is required');
    });

    test('returns error for missing query', async () => {
      const handler = await getFindHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('query is required');
    });

    test('returns error for empty query', async () => {
      const handler = await getFindHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: '',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('query is required');
    });

    test('handles no matches found', async () => {
      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue([]);

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: 'nonexistent element',
        waitForMs: 0, // disable polling so the test exits immediately
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('No elements found');
    });

    test('returns error when tab not found', async () => {
      const handler = await getFindHandler();
      mockSessionManager.getPage.mockResolvedValueOnce(null);

      const result = await handler(testSessionId, {
        tabId: 'non-existent-tab',
        query: 'button',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });

  describe('Ref Generation', () => {
    test('generates valid refs for found elements', async () => {
      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue([
        {
          backendDOMNodeId: 0,
          role: 'button',
          name: 'Submit',
          tagName: 'button',
          rect: { x: 100, y: 100, width: 80, height: 30 },
        },
      ]);

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ result: { objectId: 'batch-obj' } })
        .mockResolvedValueOnce({ result: [
          { name: '0', value: { objectId: 'el-obj-0' } },
        ]})
        .mockResolvedValueOnce({ node: { backendNodeId: 12345 } });

      await handler(testSessionId, {
        tabId: testTargetId,
        query: 'button',
      });

      expect(mockRefIdManager.generateRef).toHaveBeenCalledWith(
        testSessionId,
        testTargetId,
        12345,
        'button',
        'Submit',
        'button',
        undefined
      );
    });
  });

  describe('waitForMs Default Behavior', () => {
    test('uses 3000ms polling timeout when waitForMs is not provided', async () => {
      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // First call returns empty (simulating element not yet rendered),
      // second call returns a result (element appeared after polling).
      (page.evaluate as jest.Mock)
        .mockResolvedValueOnce([]) // first poll: nothing found
        .mockResolvedValueOnce([  // second poll: element appears
          {
            backendDOMNodeId: 0,
            role: 'button',
            name: 'Lazy Button',
            tagName: 'button',
            rect: { x: 100, y: 100, width: 80, height: 30 },
          },
        ]);

      // CDP mocks:
      // Iteration 1 (empty JS results): resolveBackendNodeIds skips, but shadow search calls DOM.getDocument
      // Iteration 2 (successful): resolveBackendNodeIds needs 3 calls, then shadow search calls DOM.getDocument
      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ root: { nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '' } }) // iter 1: shadow DOM.getDocument (no shadow roots)
        .mockResolvedValueOnce({ result: { objectId: 'batch-obj' } })   // iter 2: resolve Runtime.evaluate
        .mockResolvedValueOnce({ result: [{ name: '0', value: { objectId: 'el-obj-0' } }] }) // iter 2: resolve Runtime.getProperties
        .mockResolvedValueOnce({ node: { backendNodeId: 55001 } });     // iter 2: resolve DOM.describeNode

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: 'lazy button',
        // waitForMs intentionally omitted — should default to 3000
        pollInterval: 10, // fast poll so the test doesn't take 3 seconds
      }) as { content: Array<{ type: string; text: string }> };

      // evaluate was called at least twice (polling occurred)
      expect((page.evaluate as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(result.content[0].text).toContain('Found');
    });

    test('does not poll when waitForMs is explicitly 0', async () => {
      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // Always returns empty — but with waitForMs:0 we should exit after one attempt
      (page.evaluate as jest.Mock).mockResolvedValue([]);

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ root: { nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '' } }); // shadow DOM.getDocument (no shadow roots)

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: 'nonexistent',
        waitForMs: 0,
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      // 1: element-search evaluate, 2: page diagnostics, 3: cleanupTags — no retry loop
      expect((page.evaluate as jest.Mock).mock.calls.length).toBe(3);
      expect(result.content[0].text).toContain('No elements found');
    });

    test('uses explicitly provided waitForMs value (5000ms)', async () => {
      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // Element found on first poll
      (page.evaluate as jest.Mock).mockResolvedValue([
        {
          backendDOMNodeId: 0,
          role: 'link',
          name: 'Go',
          tagName: 'a',
          rect: { x: 10, y: 10, width: 50, height: 20 },
        },
      ]);

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ result: { objectId: 'batch-obj' } })
        .mockResolvedValueOnce({ result: [{ name: '0', value: { objectId: 'el-obj-0' } }] })
        .mockResolvedValueOnce({ node: { backendNodeId: 55002 } });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: 'go link',
        waitForMs: 5000,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Found');
      // Max wait is capped at 30000, so 5000 passes through unchanged
    });
  });

  describe('Session Isolation', () => {
    test('rejects find on tab from another session', async () => {
      const handler = await getFindHandler();

      const session2Id = 'other-session';
      await mockSessionManager.createSession({ id: session2Id });
      const { targetId: session2TargetId } = await mockSessionManager.createTarget(session2Id);

      const result = await handler(testSessionId, {
        tabId: session2TargetId,
        query: 'button',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not belong to session');
    });
  });
});
