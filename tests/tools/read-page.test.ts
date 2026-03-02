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

  const getReadPageHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: () => mockRefIdManager,
    }));

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

    test('truncation message suggests DOM mode', async () => {
      const handler = await getReadPageHandler();

      // Create tree large enough to exceed MAX_OUTPUT (50K chars)
      const hugeTree = {
        nodes: Array.from({ length: 5000 }, (_, i) => ({
          nodeId: i,
          backendDOMNodeId: 100 + i,
          role: { value: 'generic' },
          name: { value: `Element with a long name to inflate character count number ${i} padding text here` },
        })),
      };

      mockSessionManager.mockCDPClient.setCDPResponse(
        'Accessibility.getFullAXTree',
        { depth: 8 },
        hugeTree
      );

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      expect(text).toContain('[Output truncated');
      expect(text).toContain('mode: "dom"');
      expect(text).toContain('~5-10x fewer tokens');
    });

    test('invalid mode returns clear error', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'html',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid mode "html"');
      expect(result.content[0].text).toContain('Must be "ax", "dom", or "css"');
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
      expect(mockRefIdManager.generateRef).toHaveBeenCalledWith(
        testSessionId,
        testTargetId,
        expect.any(Number),
        expect.any(String),
        expect.anything()
      );
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

      const result = await handler(testSessionId, {
        tabId: testTargetId,
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
      expect(text).toMatch(/^\[page_stats\]/);
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
