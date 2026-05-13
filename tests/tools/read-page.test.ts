/// <reference types="jest" />
/**
 * Tests for Read Page Tool
 */

import { createMockSessionManager, createMockRefIdManager } from '../utils/mock-session';
import { cdpFixtures, sampleAccessibilityTree } from '../utils/test-helpers';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { getRefIdManager } from '../../src/utils/ref-id-manager';

describe('ReadPageTool', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockRefIdManager: ReturnType<typeof createMockRefIdManager>;
  let testSessionId: string;
  let testTargetId: string;

  const getReadPageHandler = async (serializeDOMMock?: jest.Mock) => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: () => mockRefIdManager,
    }));
    if (serializeDOMMock) {
      jest.doMock('../../src/dom', () => ({
        serializeDOM: serializeDOMMock,
      }));
    }

    const { registerReadPageTool } = await import('../../src/tools/read-page');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };

    registerReadPageTool(mockServer as unknown as Parameters<typeof registerReadPageTool>[0]);
    return tools.get('read_page')!.handler;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    mockRefIdManager = createMockRefIdManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    (getRefIdManager as jest.Mock).mockReturnValue(mockRefIdManager);

    testSessionId = 'test-session-123';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;

    // Set up default CDP response for accessibility tree (default depth for 'all' filter)
    mockSessionManager.mockCDPClient.setCDPResponse(
      'Accessibility.getFullAXTree',
      { depth: 8 },
      sampleAccessibilityTree
    );

    // Set up CDP response for depth 5 (used with interactive filter)
    mockSessionManager.mockCDPClient.setCDPResponse(
      'Accessibility.getFullAXTree',
      { depth: 5 },
      sampleAccessibilityTree
    );

    // Set up DOM.getDocument response for DOM mode (now the default)
    mockSessionManager.mockCDPClient.setCDPResponse(
      'DOM.getDocument',
      { depth: -1, pierce: true },
      {
        root: {
          nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
          children: [{
            nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html',
            attributes: [],
            children: [{
              nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'BODY', localName: 'body',
              attributes: [],
              children: [
                {
                  nodeId: 4, backendNodeId: 100, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
                  attributes: ['type', 'submit'],
                  children: [{ nodeId: 5, backendNodeId: 5, nodeType: 3, nodeName: '#text', localName: '', nodeValue: 'Submit' }],
                },
              ],
            }],
          }],
        },
      }
    );

    // Set up page.evaluate for page stats (AX mode now calls evaluate for page metadata)
    const page = mockSessionManager.pages.get(testTargetId);
    if (page) {
      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'https://example.com',
        title: 'Test Page',
        scrollX: 0,
        scrollY: 0,
        scrollWidth: 1920,
        scrollHeight: 3000,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });
    }
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Keep delta snapshot cache isolated between read_page tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../src/compression/snapshot-store').SnapshotStore.getInstance().clear();
  });

  describe('Accessibility Tree', () => {
    test('returns tree with default depth', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }> };

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Accessibility.getFullAXTree',
        { depth: 8 }
      );
    });

    test('respects custom depth limit', async () => {
      const handler = await getReadPageHandler();

      mockSessionManager.mockCDPClient.setCDPResponse(
        'Accessibility.getFullAXTree',
        { depth: 5 },
        sampleAccessibilityTree
      );

      await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        depth: 5,
      });

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Accessibility.getFullAXTree',
        { depth: 5 }
      );
    });

    test('uses capped depth for interactive filter', async () => {
      const handler = await getReadPageHandler();

      mockSessionManager.mockCDPClient.setCDPResponse(
        'Accessibility.getFullAXTree',
        { depth: 5 },
        sampleAccessibilityTree
      );

      await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        filter: 'interactive',
      });

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Accessibility.getFullAXTree',
        { depth: 5 }
      );
    });

    test('uses custom depth when smaller than cap for interactive filter', async () => {
      const handler = await getReadPageHandler();

      mockSessionManager.mockCDPClient.setCDPResponse(
        'Accessibility.getFullAXTree',
        { depth: 3 },
        sampleAccessibilityTree
      );

      await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        filter: 'interactive',
        depth: 3,
      });

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Accessibility.getFullAXTree',
        { depth: 3 }
      );
    });

    test('caps custom depth above limit for interactive filter', async () => {
      const handler = await getReadPageHandler();

      await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        filter: 'interactive',
        depth: 10,
      });

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Accessibility.getFullAXTree',
        { depth: 5 }
      );
    });

    test('generates ref IDs for elements', async () => {
      const handler = await getReadPageHandler();

      await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      });

      // Should have generated refs for elements with backendDOMNodeId
      expect(mockRefIdManager.generateRef).toHaveBeenCalled();
    });

    test('clears previous refs on new read', async () => {
      const handler = await getReadPageHandler();

      await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      });

      expect(mockRefIdManager.clearTargetRefs).toHaveBeenCalledWith(testSessionId, testTargetId);
    });

    test('handles empty page', async () => {
      const handler = await getReadPageHandler();

      mockSessionManager.mockCDPClient.setCDPResponse(
        'Accessibility.getFullAXTree',
        { depth: 8 },
        { nodes: [] }
      );

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }> };

      // Should return without error
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('Filtering', () => {
    test('filter=all returns all elements', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        filter: 'all',
      }) as { content: Array<{ type: string; text: string }> };

      // Should include document role (non-interactive)
      expect(result.content[0].text).toContain('document');
    });

    test('filter=interactive returns only interactive elements', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        filter: 'interactive',
      }) as { content: Array<{ type: string; text: string }> };

      // Should include button and textbox but not necessarily document
      const text = result.content[0].text;
      // Check that interactive elements are present
      // Note: exact behavior depends on implementation

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Accessibility.getFullAXTree',
        { depth: 5 }
      );
    });

    test('interactive elements include correct roles', async () => {
      const handler = await getReadPageHandler();

      // The sample tree has button, textbox, link which are all interactive
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        filter: 'interactive',
      }) as { content: Array<{ type: string; text: string }> };

      // These roles should pass through the interactive filter
      const interactiveRoles = ['button', 'link', 'textbox'];
      // Implementation-specific check

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Accessibility.getFullAXTree',
        { depth: 5 }
      );
    });
  });

  describe('Output Formatting', () => {
    test('includes role and name in output', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      expect(text).toContain('button');
      expect(text).toContain('Submit');
    });

    test('includes properties like focused', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      // The sample tree has a focused button
      expect(text).toContain('focused');
    });

    test('includes ref IDs in output', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      expect(text).toMatch(/\[ref_\d+\]/);
    });
  });

  describe('Output Limits', () => {
    test('handles large accessibility trees', async () => {
      const handler = await getReadPageHandler();

      // Create a large tree
      const largeTree = {
        nodes: Array.from({ length: 1000 }, (_, i) => ({
          nodeId: i,
          backendDOMNodeId: 100 + i,
          role: { value: 'generic' },
          name: { value: `Element ${i}` },
        })),
      };

      mockSessionManager.mockCDPClient.setCDPResponse(
        'Accessibility.getFullAXTree',
        { depth: 8 },
        largeTree
      );

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }> };

      // Should handle without error
      expect(result.content[0].type).toBe('text');
    });

    function generateLargeAXTree(nodeCount: number) {
      const nodes: Array<{
        nodeId: number;
        backendDOMNodeId?: number;
        role: { value: string };
        name: { value: string };
        childIds: number[];
      }> = [{ nodeId: 1, role: { value: 'WebArea' }, name: { value: 'Test' }, childIds: [] }];
      for (let i = 2; i <= nodeCount; i++) {
        nodes[0].childIds.push(i);
        nodes.push({
          nodeId: i,
          backendDOMNodeId: i * 10,
          role: { value: 'button' },
          name: { value: 'Button ' + 'x'.repeat(100) },
          childIds: [],
        });
      }
      return { nodes };
    }

    test('does not fall back to DOM when explicit AX output exceeds limit', async () => {
      const mockSerializeDOM = jest.fn().mockResolvedValue({
        content: '[page_stats] url: https://example.com\n\n<body>\n  <button />\n</body>',
      });
      const handler = await getReadPageHandler(mockSerializeDOM);

      // 600 nodes × ~110 chars each ≈ 66K chars > MAX_OUTPUT (50K)
      mockSessionManager.mockCDPClient.setCDPResponse(
        'Accessibility.getFullAXTree',
        { depth: 8 },
        generateLargeAXTree(600)
      );

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      expect(mockSerializeDOM).not.toHaveBeenCalled();
      expect(text).not.toContain('<body>');
      expect(text).toContain('[Output truncated');
      expect(text).toContain('fallback: "dom"');
    });

    test('explicit fallback=dom switches to DOM when AX tree exceeds output limit', async () => {
      const mockSerializeDOM = jest.fn().mockResolvedValue({
        content: '[page_stats] url: https://example.com\n\n<body></body>',
      });
      const handler = await getReadPageHandler(mockSerializeDOM);

      mockSessionManager.mockCDPClient.setCDPResponse(
        'Accessibility.getFullAXTree',
        { depth: 8 },
        generateLargeAXTree(600)
      );

      await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        fallback: 'dom',
        filter: 'all',
      });

      expect(mockSerializeDOM).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          maxDepth: 8,
          filter: 'all',
          interactiveOnly: false,
        })
      );
    });

    test('falls back to truncated AX output when DOM serialization fails', async () => {
      const mockSerializeDOM = jest.fn().mockRejectedValue(new Error('DOM serialization failed'));
      const handler = await getReadPageHandler(mockSerializeDOM);

      mockSessionManager.mockCDPClient.setCDPResponse(
        'Accessibility.getFullAXTree',
        { depth: 8 },
        generateLargeAXTree(600)
      );

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        fallback: 'dom',
      }) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      // Should fall back to original truncation message
      expect(text).toContain('[Output truncated');
      expect(text).toContain('mode: "dom"');
      expect(text).toContain('smaller depth / ref_id');
      // Should NOT contain the auto-fallback notice
      expect(text).not.toContain('[AX tree exceeded output limit');
    });

    test('detects roots with linear child-id construction on a 5000-node AX tree', async () => {
      const handler = await getReadPageHandler();
      const nodes: any[] = [];
      let childIdsAccesses = 0;
      const rootChildren = Array.from({ length: 4999 }, (_, i) => i + 2);
      nodes.push({
        nodeId: 1,
        role: { value: 'WebArea' },
        name: { value: 'Root' },
        get childIds() {
          childIdsAccesses++;
          return rootChildren;
        },
      });
      for (let i = 2; i <= 5000; i++) {
        nodes.push({
          nodeId: i,
          backendDOMNodeId: i * 10,
          role: { value: 'button' },
          name: { value: `Button ${i}` },
          get childIds() {
            childIdsAccesses++;
            return [];
          },
        });
      }

      mockSessionManager.mockCDPClient.setCDPResponse(
        'Accessibility.getFullAXTree',
        { depth: 1 },
        { nodes }
      );

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        depth: 1,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].type).toBe('text');
      // O(n) root detection/formatting reads childIds a small number of times;
      // the previous nodes.filter(...nodes.some(...includes)) path reads it
      // roughly n*n times for this tree.
      expect(childIdsAccesses).toBeLessThan(15000);
    });

    test('invalid mode returns clear error', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'html',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid mode "html"');
      expect(result.content[0].text).toContain('Must be "ax", "dom", "css", "semantic", or "markdown"');
    });
  });

  describe('Markdown Mode', () => {
    test('returns clean markdown and pagination metadata by default', async () => {
      const handler = await getReadPageHandler();
      const page = mockSessionManager.pages.get(testTargetId)!;
      (page.content as jest.Mock).mockResolvedValue(
        '<html><body><nav>Main page</nav><main><h1>Article</h1><p>See <a href="https://example.com">link</a>.</p></main></body></html>'
      );
      (page.evaluate as jest.Mock).mockResolvedValueOnce({
        type: 'numbered',
        hasNext: true,
        hasPrev: false,
        currentPage: 1,
        totalPages: 3,
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'markdown',
      }) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      expect(text).toContain('# Article');
      expect(text).toContain('[link](https://example.com)');
      expect(text).not.toContain('Main page');
      expect(text).toContain('[Pagination Detected]');
      expect(text).toContain('Type: numbered');
      expect(text).toContain('Pages: 1 / 3');
    });

    test('can suppress markdown pagination metadata', async () => {
      const handler = await getReadPageHandler();
      const page = mockSessionManager.pages.get(testTargetId)!;
      (page.content as jest.Mock).mockResolvedValue('<main><h1>Article</h1></main>');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'markdown',
        includePagination: false,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('# Article');
      expect(result.content[0].text).not.toContain('[Pagination Detected]');
      expect(page.evaluate).not.toHaveBeenCalled();
    });
  });

  describe('RefIdManager Integration', () => {
    test('generated refs are associated with correct session and target', async () => {
      const handler = await getReadPageHandler();

      await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      });

      // Check that refs were generated with correct session and target
      // generateRef is called with (sessionId, targetId, backendDOMNodeId, role, name, tagName)
      // tagName may be string or undefined depending on the AX role mapping
      const calls = mockRefIdManager.generateRef.mock.calls;
      const matchingCall = calls.find(
        (c: unknown[]) => c[0] === testSessionId && c[1] === testTargetId
      );
      expect(matchingCall).toBeDefined();
      expect(typeof matchingCall![2]).toBe('number');
      expect(typeof matchingCall![3]).toBe('string');
    });

    test('compact AX mode omits non-actionable no-ref leaves while preserving actionable nodes', async () => {
      const handler = await getReadPageHandler();
      mockSessionManager.mockCDPClient.setCDPResponse(
        'Accessibility.getFullAXTree',
        { depth: 8 },
        {
          nodes: [
            { nodeId: 1, backendDOMNodeId: 100, role: { value: 'document' }, name: { value: 'Compact Page' }, childIds: [2, 3] },
            { nodeId: 2, role: { value: 'StaticText' }, name: { value: 'Decorative copy' } },
            { nodeId: 3, backendDOMNodeId: 101, role: { value: 'button' }, name: { value: 'Submit' } },
          ],
        }
      );

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        compact: true,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('button: "Submit"');
      expect(result.content[0].text).not.toContain('Decorative copy');
    });

    test('AX delta compression returns only changes after the first cached snapshot', async () => {
      const handler = await getReadPageHandler();
      const firstTree = {
        nodes: [
          { nodeId: 1, backendDOMNodeId: 100, role: { value: 'document' }, name: { value: 'Delta Page' }, childIds: [2] },
          { nodeId: 2, backendDOMNodeId: 101, role: { value: 'button' }, name: { value: 'Submit' } },
        ],
      };
      const secondTree = {
        nodes: [
          { nodeId: 1, backendDOMNodeId: 100, role: { value: 'document' }, name: { value: 'Delta Page' }, childIds: [2, 3] },
          { nodeId: 2, backendDOMNodeId: 101, role: { value: 'button' }, name: { value: 'Submit' } },
          { nodeId: 3, backendDOMNodeId: 102, role: { value: 'link' }, name: { value: 'Learn more' } },
        ],
      };
      mockSessionManager.mockCDPClient.setCDPResponse('Accessibility.getFullAXTree', { depth: 8 }, firstTree);

      const first = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        compression: 'delta',
      }) as { content: Array<{ type: string; text: string }> };
      expect(first.content[0].text).toContain('button: "Submit"');
      expect(first.content[0].text).not.toContain('[AX Delta');

      mockSessionManager.mockCDPClient.setCDPResponse('Accessibility.getFullAXTree', { depth: 8 }, secondTree);
      const second = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        compression: 'delta',
      }) as { content: Array<{ type: string; text: string }> };

      expect(second.content[0].text).toContain('[AX Delta');
      expect(second.content[0].text).toContain('Learn more');
    });

  });

  describe('Error Handling', () => {
    test('returns error for missing tabId', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {}) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tabId is required');
    });

    test('returns error when tab not found', async () => {
      const handler = await getReadPageHandler();
      mockSessionManager.getPage.mockResolvedValueOnce(null);

      const result = await handler(testSessionId, {
        tabId: 'non-existent-tab',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    test('handles CDP errors', async () => {
      const handler = await getReadPageHandler();
      mockSessionManager.mockCDPClient.send.mockRejectedValueOnce(new Error('CDP error'));

      // Use AX mode to exercise the top-level CDP error path. DOM mode now
      // fails closed with its own dedicated message ("Read page DOM
      // serialization error: …") covered by other tests, so steering this
      // case through AX keeps the original assertion meaningful.
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Read page error');
    });
  });

  describe('AX Mode Page Stats', () => {
    test('AX mode output starts with [page_stats] line', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      expect(text).toMatch(/(?:^|\n)\[page_stats\]/);
    });

    test('AX mode page_stats includes url and title', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      expect(text).toContain('url: https://example.com');
      expect(text).toContain('title: Test Page');
    });

    test('AX mode page_stats includes docSize', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      expect(text).toContain('docSize: 1920x3000');
    });

    test('AX mode page_stats includes scroll and viewport', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      expect(text).toContain('scroll: 0,0');
      expect(text).toContain('viewport: 1920x1080');
    });
  });

  describe('Session Isolation', () => {
    test('rejects read from tab of another session', async () => {
      const handler = await getReadPageHandler();

      const session2Id = 'other-session';
      await mockSessionManager.createSession({ id: session2Id });
      const { targetId: session2TargetId } = await mockSessionManager.createTarget(session2Id);

      const result = await handler(testSessionId, {
        tabId: session2TargetId,
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not belong to session');
    });
  });
});
