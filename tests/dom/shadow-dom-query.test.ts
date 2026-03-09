/// <reference types="jest" />
/**
 * Tests for query_dom shadow DOM CSS/XPath query handling
 */

import { createMockSessionManager } from '../utils/mock-session';

// ---------------------------------------------------------------------------
// Module-level mocks (avoid jest.resetModules / jest.doMock pattern which
// has known resolution issues with ts-jest)
// ---------------------------------------------------------------------------

// Mutable shadow-dom mock state — tests override these per-case
const shadowDomMockImpl = {
  getAllShadowRoots: jest.fn().mockResolvedValue({ shadowRoots: [], domTree: {} }),
  querySelectorInShadowRoots: jest.fn().mockResolvedValue([]),
  discoverShadowElements: jest.fn().mockResolvedValue([]),
  DEEP_QUERY_SELECTOR_ALL_JS: '',
  DEEP_WALK_ELEMENTS_JS: '',
};

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(),
}));

jest.mock('../../src/utils/shadow-dom', () => ({
  get getAllShadowRoots() { return shadowDomMockImpl.getAllShadowRoots; },
  get querySelectorInShadowRoots() { return shadowDomMockImpl.querySelectorInShadowRoots; },
  get discoverShadowElements() { return shadowDomMockImpl.discoverShadowElements; },
  get DEEP_QUERY_SELECTOR_ALL_JS() { return shadowDomMockImpl.DEEP_QUERY_SELECTOR_ALL_JS; },
  get DEEP_WALK_ELEMENTS_JS() { return shadowDomMockImpl.DEEP_WALK_ELEMENTS_JS; },
}));

import { getSessionManager } from '../../src/session-manager';
import { registerQueryDomTool } from '../../src/tools/query-dom';

// ---------------------------------------------------------------------------
// Shadow DOM mock factories
// ---------------------------------------------------------------------------

function makeShadowRoot(shadowRootNodeId: number, hostBackendNodeId = 100) {
  return {
    hostNodeId: 10,
    hostBackendNodeId,
    shadowRootNodeId,
    shadowRootType: 'open',
  };
}

function makeCSSElementInfo(overrides: Partial<{
  ref: string;
  tagName: string;
  id: string | null;
  className: string;
  attributes: Record<string, string>;
  textContent: string;
  isVisible: boolean;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}> = {}) {
  return {
    ref: 'el_0',
    tagName: 'button',
    id: 'shadow-btn',
    className: 'btn',
    attributes: {},
    textContent: 'Click me',
    isVisible: true,
    boundingBox: { x: 10, y: 20, width: 100, height: 40 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Handler factory — registers query_dom tool once per test via the static mock
// ---------------------------------------------------------------------------

function getQueryDomHandler(shadowDomMock?: {
  getAllShadowRoots?: jest.Mock;
  querySelectorInShadowRoots?: jest.Mock;
}) {
  // Reset to defaults then apply per-test overrides
  shadowDomMockImpl.getAllShadowRoots = jest.fn().mockResolvedValue({ shadowRoots: [], domTree: {} });
  shadowDomMockImpl.querySelectorInShadowRoots = jest.fn().mockResolvedValue([]);

  if (shadowDomMock?.getAllShadowRoots) {
    shadowDomMockImpl.getAllShadowRoots = shadowDomMock.getAllShadowRoots;
  }
  if (shadowDomMock?.querySelectorInShadowRoots) {
    shadowDomMockImpl.querySelectorInShadowRoots = shadowDomMock.querySelectorInShadowRoots;
  }

  const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
  const mockServer = {
    registerTool: (name: string, handler: unknown) => {
      tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
    },
  };
  registerQueryDomTool(mockServer as unknown as Parameters<typeof registerQueryDomTool>[0]);
  return tools.get('query_dom')!.handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('query_dom shadow DOM support', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let testSessionId: string;
  let testTargetId: string;

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);

    testSessionId = 'test-session-shadow';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'https://example.com');
    testTargetId = targetId;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. CSS query finds element inside open shadow root (single)
  // -------------------------------------------------------------------------

  describe('CSS single query - shadow DOM fallback', () => {
    test('returns element from shadow root when light DOM returns nothing', async () => {
      const shadowRoot = makeShadowRoot(200);
      const backendNodeId = 9001;
      const elementInfo = makeCSSElementInfo({ ref: 'el_0', tagName: 'button' });

      const getAllShadowRoots = jest.fn().mockResolvedValue({
        shadowRoots: [shadowRoot],
        domTree: {},
      });
      const querySelectorInShadowRoots = jest.fn().mockResolvedValue([backendNodeId]);

      const handler = getQueryDomHandler({ getAllShadowRoots, querySelectorInShadowRoots });
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // page.$ returns null → light DOM miss
      (page.$ as jest.Mock).mockResolvedValue(null);

      // CDP: DOM.resolveNode → Runtime.callFunctionOn
      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-9001' } })         // DOM.resolveNode
        .mockResolvedValueOnce({ result: { value: elementInfo } });           // Runtime.callFunctionOn

      // gatherDiagnostics page.evaluate (not called when shadow succeeds, but evaluate may be called)
      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'https://example.com',
        readyState: 'complete',
        totalElements: 50,
        framework: null,
        closestMatch: null,
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'css',
        selector: '.shadow-button',
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.shadowDOM).toBe(true);
      expect(parsed.element.tagName).toBe('button');
      expect(parsed.element.ref).toBe('el_0');
      expect(getAllShadowRoots).toHaveBeenCalled();
      expect(querySelectorInShadowRoots).toHaveBeenCalled();
    });

    test('returns null when no shadow roots exist and light DOM is empty', async () => {
      const getAllShadowRoots = jest.fn().mockResolvedValue({
        shadowRoots: [],
        domTree: {},
      });

      const handler = getQueryDomHandler({ getAllShadowRoots });
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.$ as jest.Mock).mockResolvedValue(null);
      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'https://example.com',
        readyState: 'complete',
        totalElements: 10,
        framework: null,
        closestMatch: null,
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'css',
        selector: '.ghost',
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.element).toBeNull();
      expect(parsed.shadowDOM).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 2. CSS multiple query - multiple shadow roots, multiple results
  // -------------------------------------------------------------------------

  describe('CSS multiple query - shadow DOM fallback', () => {
    test('returns elements from multiple shadow roots when light DOM is empty', async () => {
      const shadowRoots = [makeShadowRoot(201, 101), makeShadowRoot(202, 102)];
      const backendNodeIds = [9010, 9011];

      const el0 = makeCSSElementInfo({ ref: '', tagName: 'span', id: 'a' });
      const el1 = makeCSSElementInfo({ ref: '', tagName: 'div', id: 'b' });

      const getAllShadowRoots = jest.fn().mockResolvedValue({
        shadowRoots,
        domTree: {},
      });
      const querySelectorInShadowRoots = jest.fn().mockResolvedValue(backendNodeIds);

      const handler = getQueryDomHandler({ getAllShadowRoots, querySelectorInShadowRoots });
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // page.$$ returns empty array → light DOM miss
      (page.$$ as jest.Mock).mockResolvedValue([]);

      // CDP for node 9010
      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-9010' } })
        .mockResolvedValueOnce({ result: { value: el0 } })
        // CDP for node 9011
        .mockResolvedValueOnce({ object: { objectId: 'obj-9011' } })
        .mockResolvedValueOnce({ result: { value: el1 } });

      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'https://example.com',
        readyState: 'complete',
        totalElements: 30,
        framework: null,
        closestMatch: null,
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'css',
        selector: '.item',
        multiple: true,
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.shadowDOM).toBe(true);
      expect(parsed.multiple).toBe(true);
      expect(parsed.elements).toHaveLength(2);
      expect(parsed.elements[0].tagName).toBe('span');
      expect(parsed.elements[1].tagName).toBe('div');
    });

    test('assigns sequential refs to shadow DOM multiple results', async () => {
      const shadowRoots = [makeShadowRoot(203)];
      const backendNodeIds = [9020, 9021, 9022];

      const getAllShadowRoots = jest.fn().mockResolvedValue({
        shadowRoots,
        domTree: {},
      });
      const querySelectorInShadowRoots = jest.fn().mockResolvedValue(backendNodeIds);

      const handler = getQueryDomHandler({ getAllShadowRoots, querySelectorInShadowRoots });
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.$$ as jest.Mock).mockResolvedValue([]);

      // CDP for each node — Runtime.callFunctionOn returns element with ref: ''
      // The source sets ref to `el_${i}` after receiving the value
      for (let i = 0; i < 3; i++) {
        mockSessionManager.mockCDPClient.send
          .mockResolvedValueOnce({ object: { objectId: `obj-902${i}` } })
          .mockResolvedValueOnce({ result: { value: makeCSSElementInfo({ ref: '', tagName: 'li', id: `item-${i}` }) } });
      }

      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'https://example.com',
        readyState: 'complete',
        totalElements: 30,
        framework: null,
        closestMatch: null,
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'css',
        selector: 'li',
        multiple: true,
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.shadowDOM).toBe(true);
      expect(parsed.elements).toHaveLength(3);
      // The tool assigns el_0, el_1, el_2 to the refs
      expect(parsed.elements[0].ref).toBe('el_0');
      expect(parsed.elements[1].ref).toBe('el_1');
      expect(parsed.elements[2].ref).toBe('el_2');
    });
  });

  // -------------------------------------------------------------------------
  // 3. XPath query finds element inside open shadow root
  // -------------------------------------------------------------------------

  describe('XPath query - shadow DOM traversal', () => {
    test('returns element found inside shadow root via page.evaluate', async () => {
      const handler = getQueryDomHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // XPath single: page.evaluate returns element info (found in shadow root by JS)
      (page.evaluate as jest.Mock).mockResolvedValue({
        tagName: 'button',
        id: 'shadow-submit',
        className: 'btn',
        text: 'Submit',
        attributes: {},
        rect: { x: 50, y: 100, width: 80, height: 30 },
        xpath: '//button[@id="shadow-submit"]',
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'xpath',
        xpath: '//button[@id="shadow-submit"]',
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.method).toBe('xpath');
      expect(parsed.result).not.toBeNull();
      expect(parsed.result.tagName).toBe('button');
      expect(parsed.result.id).toBe('shadow-submit');
    });

    test('returns multiple XPath results including those from shadow roots', async () => {
      const handler = getQueryDomHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // XPath multiple: page.evaluate returns elements array with shadow DOM results included
      (page.evaluate as jest.Mock).mockResolvedValue({
        elements: [
          {
            tagName: 'li',
            id: 'item-1',
            className: '',
            text: 'Light DOM item',
            attributes: {},
            rect: { x: 0, y: 0, width: 200, height: 20 },
            xpath: '(//li)[1]',
          },
          {
            tagName: 'li',
            id: 'item-2',
            className: '',
            text: 'Shadow DOM item',
            attributes: {},
            rect: { x: 0, y: 20, width: 200, height: 20 },
            xpath: '(//li)[2]',
          },
        ],
        totalCount: 2,
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'xpath',
        xpath: '//li',
        multiple: true,
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.method).toBe('xpath');
      expect(parsed.multiple).toBe(true);
      expect(parsed.results).toHaveLength(2);
      expect(parsed.count).toBe(2);
      expect(parsed.results[0].text).toBe('Light DOM item');
      expect(parsed.results[1].text).toBe('Shadow DOM item');
    });

    test('returns null when XPath finds nothing in light DOM or shadow roots', async () => {
      const handler = getQueryDomHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue(null);

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'xpath',
        xpath: '//div[@id="nonexistent"]',
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.result).toBeNull();
      expect(parsed.message).toContain('No element found');
    });
  });

  // -------------------------------------------------------------------------
  // 4. pierceShadow: false disables shadow root piercing
  // -------------------------------------------------------------------------

  describe('pierceShadow: false', () => {
    test('does not attempt shadow fallback for CSS single when pierceShadow is false', async () => {
      const getAllShadowRoots = jest.fn().mockResolvedValue({
        shadowRoots: [makeShadowRoot(300)],
        domTree: {},
      });
      const querySelectorInShadowRoots = jest.fn().mockResolvedValue([9999]);

      const handler = getQueryDomHandler({ getAllShadowRoots, querySelectorInShadowRoots });
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.$ as jest.Mock).mockResolvedValue(null);
      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'https://example.com',
        readyState: 'complete',
        totalElements: 10,
        framework: null,
        closestMatch: null,
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'css',
        selector: '.shadow-only',
        pierceShadow: false,
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      // Shadow fallback must NOT have been called
      expect(getAllShadowRoots).not.toHaveBeenCalled();
      expect(querySelectorInShadowRoots).not.toHaveBeenCalled();
      // Result should be null (light DOM miss, no shadow fallback)
      expect(parsed.element).toBeNull();
      expect(parsed.shadowDOM).toBeUndefined();
    });

    test('does not attempt shadow fallback for CSS multiple when pierceShadow is false', async () => {
      const getAllShadowRoots = jest.fn().mockResolvedValue({
        shadowRoots: [makeShadowRoot(301)],
        domTree: {},
      });
      const querySelectorInShadowRoots = jest.fn().mockResolvedValue([9998]);

      const handler = getQueryDomHandler({ getAllShadowRoots, querySelectorInShadowRoots });
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.$$ as jest.Mock).mockResolvedValue([]);
      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'https://example.com',
        readyState: 'complete',
        totalElements: 5,
        framework: null,
        closestMatch: null,
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'css',
        selector: '.shadow-items',
        multiple: true,
        pierceShadow: false,
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(getAllShadowRoots).not.toHaveBeenCalled();
      expect(querySelectorInShadowRoots).not.toHaveBeenCalled();
      expect(parsed.elements).toHaveLength(0);
      expect(parsed.shadowDOM).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 5. CSS query returns light DOM result preferentially
  // -------------------------------------------------------------------------

  describe('CSS query - light DOM preference', () => {
    test('returns light DOM result and does not call shadow fallback when light DOM succeeds (single)', async () => {
      const getAllShadowRoots = jest.fn();
      const querySelectorInShadowRoots = jest.fn();

      const handler = getQueryDomHandler({ getAllShadowRoots, querySelectorInShadowRoots });
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // page.$ returns an element handle → light DOM hit
      const mockElementHandle = {} as import('puppeteer-core').ElementHandle;
      (page.$ as jest.Mock).mockResolvedValue(mockElementHandle);

      // page.evaluate returns element info for light DOM result
      (page.evaluate as jest.Mock).mockResolvedValue({
        ref: 'el_0',
        tagName: 'button',
        id: 'light-btn',
        className: 'primary',
        attributes: {},
        textContent: 'Light Button',
        isVisible: true,
        boundingBox: { x: 5, y: 10, width: 120, height: 35 },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'css',
        selector: 'button.primary',
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.element).not.toBeNull();
      expect(parsed.element.tagName).toBe('button');
      expect(parsed.shadowDOM).toBeUndefined();
      // Shadow utilities must not be called
      expect(getAllShadowRoots).not.toHaveBeenCalled();
      expect(querySelectorInShadowRoots).not.toHaveBeenCalled();
    });

    test('returns light DOM results and does not call shadow fallback when light DOM succeeds (multiple)', async () => {
      const getAllShadowRoots = jest.fn();
      const querySelectorInShadowRoots = jest.fn();

      const handler = getQueryDomHandler({ getAllShadowRoots, querySelectorInShadowRoots });
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // page.$$ returns two element handles → light DOM hit
      const mockHandle0 = {} as import('puppeteer-core').ElementHandle;
      const mockHandle1 = {} as import('puppeteer-core').ElementHandle;
      (page.$$ as jest.Mock).mockResolvedValue([mockHandle0, mockHandle1]);

      // page.evaluate is called per element for info extraction
      (page.evaluate as jest.Mock)
        .mockResolvedValueOnce({
          ref: 'el_0',
          tagName: 'li',
          id: null,
          className: 'item',
          attributes: {},
          textContent: 'Item 1',
          isVisible: true,
          boundingBox: { x: 0, y: 0, width: 200, height: 20 },
        })
        .mockResolvedValueOnce({
          ref: 'el_1',
          tagName: 'li',
          id: null,
          className: 'item',
          attributes: {},
          textContent: 'Item 2',
          isVisible: true,
          boundingBox: { x: 0, y: 20, width: 200, height: 20 },
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'css',
        selector: 'li.item',
        multiple: true,
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.elements).toHaveLength(2);
      expect(parsed.shadowDOM).toBeUndefined();
      expect(getAllShadowRoots).not.toHaveBeenCalled();
      expect(querySelectorInShadowRoots).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Error / edge cases
  // -------------------------------------------------------------------------

  describe('Error cases', () => {
    test('returns error when tabId is missing', async () => {
      const handler = getQueryDomHandler();

      const result = await handler(testSessionId, {
        method: 'css',
        selector: 'button',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tabId is required');
    });

    test('returns error when method is unknown', async () => {
      const handler = getQueryDomHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'fts',
        selector: 'button',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown method');
    });

    test('returns error when CSS selector is missing', async () => {
      const handler = getQueryDomHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'css',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('selector is required');
    });

    test('returns error when XPath expression is missing', async () => {
      const handler = getQueryDomHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'xpath',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('xpath is required');
    });

    test('returns error when tab is not found', async () => {
      const handler = getQueryDomHandler();
      mockSessionManager.getPage.mockResolvedValueOnce(null);

      const result = await handler(testSessionId, {
        tabId: 'nonexistent-tab',
        method: 'css',
        selector: 'button',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    test('shadow fallback returns null when querySelectorInShadowRoots finds nothing', async () => {
      const getAllShadowRoots = jest.fn().mockResolvedValue({
        shadowRoots: [makeShadowRoot(400)],
        domTree: {},
      });
      const querySelectorInShadowRoots = jest.fn().mockResolvedValue([]);

      const handler = getQueryDomHandler({ getAllShadowRoots, querySelectorInShadowRoots });
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.$ as jest.Mock).mockResolvedValue(null);
      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'https://example.com',
        readyState: 'complete',
        totalElements: 10,
        framework: null,
        closestMatch: null,
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        method: 'css',
        selector: '.nowhere',
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.element).toBeNull();
      expect(parsed.shadowDOM).toBeUndefined();
      expect(querySelectorInShadowRoots).toHaveBeenCalled();
    });
  });
});
