/// <reference types="jest" />
/**
 * Mock CDP Client for testing
 */

import { Page, Browser, Target, CDPSession } from 'puppeteer-core';

export interface MockPageOptions {
  url?: string;
  title?: string;
  targetId?: string;
}

export interface MockCDPResponse {
  method: string;
  response: unknown;
}

/**
 * Creates a mock Page object for testing
 */
export function createMockPage(options: MockPageOptions = {}): jest.Mocked<Page> {
  const { url = 'about:blank', title = 'Test Page', targetId = 'mock-target-id' } = options;

  const mockTarget = {
    _targetId: targetId,
    type: () => 'page',
    page: jest.fn(),
  } as unknown as Target;

  const mockCDPSession = {
    send: jest.fn(),
    detach: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  } as unknown as jest.Mocked<CDPSession>;

  const mockPage = {
    url: jest.fn().mockReturnValue(url),
    title: jest.fn().mockResolvedValue(title),
    goto: jest.fn().mockResolvedValue(null),
    goBack: jest.fn().mockResolvedValue(null),
    goForward: jest.fn().mockResolvedValue(null),
    close: jest.fn().mockResolvedValue(undefined),
    screenshot: jest.fn().mockResolvedValue('base64-screenshot-data'),
    evaluate: jest.fn(),
    createCDPSession: jest.fn().mockResolvedValue(mockCDPSession),
    target: jest.fn().mockReturnValue(mockTarget),
    mouse: {
      click: jest.fn().mockResolvedValue(undefined),
      move: jest.fn().mockResolvedValue(undefined),
      wheel: jest.fn().mockResolvedValue(undefined),
      down: jest.fn().mockResolvedValue(undefined),
      up: jest.fn().mockResolvedValue(undefined),
    },
    keyboard: {
      type: jest.fn().mockResolvedValue(undefined),
      press: jest.fn().mockResolvedValue(undefined),
      down: jest.fn().mockResolvedValue(undefined),
      up: jest.fn().mockResolvedValue(undefined),
    },
    setViewport: jest.fn().mockResolvedValue(undefined),
    content: jest.fn().mockResolvedValue('<html></html>'),
    $: jest.fn(),
    $$: jest.fn(),
    waitForSelector: jest.fn(),
    waitForNavigation: jest.fn(),
  } as unknown as jest.Mocked<Page>;

  (mockTarget as any).page = jest.fn().mockResolvedValue(mockPage);

  return mockPage;
}

/**
 * Creates a mock Browser object for testing
 */
export function createMockBrowser(): jest.Mocked<Browser> {
  const mockBrowser = {
    newPage: jest.fn(),
    pages: jest.fn().mockResolvedValue([]),
    targets: jest.fn().mockReturnValue([]),
    disconnect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    on: jest.fn(),
    off: jest.fn(),
    version: jest.fn().mockResolvedValue('Chrome/120.0.0.0'),
  } as unknown as jest.Mocked<Browser>;

  return mockBrowser;
}

/**
 * Creates a mock CDPClient for testing
 */
export function createMockCDPClient() {
  const mockBrowser = createMockBrowser();
  const pages: Map<string, Page> = new Map();
  const cdpResponses: Map<string, unknown> = new Map();

  return {
    browser: mockBrowser,
    pages,
    cdpResponses,

    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    getBrowser: jest.fn().mockReturnValue(mockBrowser),

    createPage: jest.fn().mockImplementation(async (url?: string) => {
      const targetId = `target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const page = createMockPage({ url: url || 'about:blank', targetId });
      pages.set(targetId, page);
      return page;
    }),

    getPageByTargetId: jest.fn().mockImplementation(async (targetId: string) => {
      return pages.get(targetId) || null;
    }),

    closePage: jest.fn().mockImplementation(async (targetId: string) => {
      pages.delete(targetId);
    }),

    send: jest.fn().mockImplementation(async (page: Page, method: string, params?: Record<string, unknown>) => {
      const responseKey = `${method}:${JSON.stringify(params || {})}`;
      if (cdpResponses.has(responseKey)) {
        return cdpResponses.get(responseKey);
      }
      // Return default responses for common methods
      switch (method) {
        case 'Accessibility.getFullAXTree':
          return { nodes: [] };
        case 'DOM.resolveNode':
          return { object: { objectId: 'mock-object-id' } };
        case 'DOM.scrollIntoViewIfNeeded':
          return {};
        case 'Runtime.evaluate':
          return { result: { value: null } };
        case 'Runtime.callFunctionOn':
          return { result: { value: { success: true, message: 'Mock success' } } };
        case 'DOM.describeNode':
          return { node: { backendNodeId: 12345 } };
        default:
          return {};
      }
    }),

    setCDPResponse: (method: string, params: Record<string, unknown> | undefined, response: unknown) => {
      const key = `${method}:${JSON.stringify(params || {})}`;
      cdpResponses.set(key, response);
    },

    getCDPSession: jest.fn().mockResolvedValue({
      send: jest.fn(),
      detach: jest.fn(),
    }),

    getTargets: jest.fn().mockReturnValue([]),
    findTarget: jest.fn().mockReturnValue(undefined),
  };
}

/**
 * Common CDP response fixtures
 */
export const cdpFixtures = {
  emptyAccessibilityTree: {
    nodes: [],
  },

  simpleAccessibilityTree: {
    nodes: [
      {
        nodeId: 1,
        backendDOMNodeId: 100,
        role: { value: 'document' },
        name: { value: 'Test Document' },
        childIds: [2, 3],
      },
      {
        nodeId: 2,
        backendDOMNodeId: 101,
        role: { value: 'button' },
        name: { value: 'Click Me' },
      },
      {
        nodeId: 3,
        backendDOMNodeId: 102,
        role: { value: 'textbox' },
        name: { value: 'Enter text' },
      },
    ],
  },

  resolvedNode: {
    object: { objectId: 'mock-object-id-12345' },
  },

  domDescribeNode: (backendNodeId: number = 12345) => ({
    node: { backendNodeId },
  }),
};
