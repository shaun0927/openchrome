/// <reference types="jest" />
/**
 * Tests for Read Page Tool - DOM Mode
 */

import { createMockSessionManager, createMockRefIdManager } from '../utils/mock-session';
import { sampleAccessibilityTree } from '../utils/test-helpers';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { getRefIdManager } from '../../src/utils/ref-id-manager';

describe('ReadPageTool - DOM Mode', () => {
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

  // Sample DOM tree matching the structure described in the task
  const sampleDOMTree = {
    nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
    children: [{
      nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html',
      attributes: [],
      children: [{
        nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'HEAD', localName: 'head',
        attributes: [],
        children: [],
      }, {
        nodeId: 4, backendNodeId: 4, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [
          {
            nodeId: 5, backendNodeId: 100, nodeType: 1, nodeName: 'H1', localName: 'h1',
            attributes: ['id', 'main-title'],
            children: [{ nodeId: 6, backendNodeId: 6, nodeType: 3, nodeName: '#text', localName: '', nodeValue: 'Hello World' }],
          },
          {
            nodeId: 7, backendNodeId: 101, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
            attributes: ['type', 'submit'],
            children: [{ nodeId: 8, backendNodeId: 8, nodeType: 3, nodeName: '#text', localName: '', nodeValue: 'Click Me' }],
          },
          {
            nodeId: 9, backendNodeId: 102, nodeType: 1, nodeName: 'INPUT', localName: 'input',
            attributes: ['type', 'text', 'placeholder', 'Enter name'],
          },
          {
            nodeId: 10, backendNodeId: 103, nodeType: 1, nodeName: 'A', localName: 'a',
            attributes: ['href', '/about'],
            children: [{ nodeId: 11, backendNodeId: 11, nodeType: 3, nodeName: '#text', localName: '', nodeValue: 'About' }],
          },
        ],
      }],
    }],
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    mockRefIdManager = createMockRefIdManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    (getRefIdManager as jest.Mock).mockReturnValue(mockRefIdManager);

    testSessionId = 'test-session-123';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;

    // Set up default CDP responses for AX tree (for backward compat tests)
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

    // Set up DOM.getDocument response for DOM mode
    mockSessionManager.mockCDPClient.setCDPResponse(
      'DOM.getDocument',
      { depth: -1, pierce: true },
      { root: sampleDOMTree }
    );

    // Set up page.evaluate for page stats (DOM mode)
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

  describe('DOM Mode', () => {
    test('mode=dom returns compact DOM output with backendNodeId identifiers', async () => {
      const handler = await getReadPageHandler();
      const result = await handler(testSessionId, { tabId: testTargetId, mode: 'dom' }) as any;

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;

      // Should contain page_stats header
      expect(text).toContain('[page_stats]');
      expect(text).toContain('url: https://example.com');

      // Should contain backendNodeId identifiers (NOT ref_N)
      expect(text).toContain('[100]');
      expect(text).toContain('[101]');
      expect(text).toContain('[102]');
      expect(text).not.toContain('ref_');

      // Should contain tag names
      expect(text).toContain('<h1');
      expect(text).toContain('<button');
      expect(text).toContain('<input');

      // Should contain text content
      expect(text).toContain('Hello World');
      expect(text).toContain('Click Me');
    });

    test('mode=dom does NOT clear ref IDs', async () => {
      const handler = await getReadPageHandler();
      await handler(testSessionId, { tabId: testTargetId, mode: 'dom' });

      // clearTargetRefs should NOT be called in DOM mode
      expect(mockRefIdManager.clearTargetRefs).not.toHaveBeenCalled();
    });

    test('mode=dom does NOT generate ref IDs', async () => {
      const handler = await getReadPageHandler();
      await handler(testSessionId, { tabId: testTargetId, mode: 'dom' });

      // generateRef should NOT be called in DOM mode
      expect(mockRefIdManager.generateRef).not.toHaveBeenCalled();
    });

    test('mode=dom filters HEAD section', async () => {
      const handler = await getReadPageHandler();
      const result = await handler(testSessionId, { tabId: testTargetId, mode: 'dom' }) as any;
      const text = result.content[0].text;

      // HEAD should be filtered out by the serializer
      expect(text).not.toContain('<head');
    });

    test('mode=dom passes depth parameter', async () => {
      const handler = await getReadPageHandler();
      const result = await handler(testSessionId, { tabId: testTargetId, mode: 'dom', depth: 2 }) as any;

      expect(result.isError).toBeUndefined();
      // Output should still be valid
      expect(result.content[0].text).toContain('[page_stats]');
    });

    test('mode=dom with filter=interactive shows only interactive elements', async () => {
      const handler = await getReadPageHandler();
      const result = await handler(testSessionId, { tabId: testTargetId, mode: 'dom', filter: 'interactive' }) as any;
      const text = result.content[0].text;

      // Should contain interactive elements
      expect(text).toContain('<button');
      expect(text).toContain('<input');
      expect(text).toContain('<a');

      // Should NOT contain non-interactive elements
      expect(text).not.toContain('<h1');
    });
  });

  describe('Backward Compatibility', () => {
    test('default mode (no mode param) returns AX tree with ref_N', async () => {
      const handler = await getReadPageHandler();
      const result = await handler(testSessionId, { tabId: testTargetId }) as any;
      const text = result.content[0].text;

      // Default should be AX tree mode
      expect(text).toContain('ref_');
      expect(text).not.toContain('[page_stats]');

      // clearTargetRefs SHOULD be called in AX mode
      expect(mockRefIdManager.clearTargetRefs).toHaveBeenCalled();
    });

    test('mode=ax explicitly returns AX tree', async () => {
      const handler = await getReadPageHandler();
      const result = await handler(testSessionId, { tabId: testTargetId, mode: 'ax' }) as any;
      const text = result.content[0].text;

      // Explicit ax mode should work same as default
      expect(text).toContain('ref_');
    });

  });

  describe('Error Handling', () => {
    test('mode=dom handles missing tabId', async () => {
      const handler = await getReadPageHandler();
      const result = await handler(testSessionId, { mode: 'dom' }) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tabId is required');
    });

    test('mode=dom handles invalid tab', async () => {
      const handler = await getReadPageHandler();
      const result = await handler(testSessionId, { tabId: 'invalid-tab', mode: 'dom' }) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not belong to session');
    });
  });
});
