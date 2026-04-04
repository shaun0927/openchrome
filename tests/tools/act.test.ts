/// <reference types="jest" />
/**
 * Tests for Act Tool (#578)
 *
 * Focuses on input validation, parse error handling, and step execution logic
 * using mocked session manager and page objects.
 */

import { createMockSessionManager } from '../utils/mock-session';
import { createMockPage } from '../utils/mock-cdp';

// Mock session manager
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

// Mock ref id manager
jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(() => ({
    generateRef: jest.fn().mockReturnValue('ref_1'),
  })),
}));

// Mock AX resolver — returns no matches by default; tests override as needed
jest.mock('../../src/utils/ax-element-resolver', () => ({
  resolveElementsByAXTree: jest.fn().mockResolvedValue([]),
  invalidateAXCache: jest.fn(),
  MATCH_LEVEL_LABELS: { 1: 'exact match', 2: 'role match', 3: 'name match', 4: 'partial match' },
}));

// Mock DOM delta — returns empty delta by default
jest.mock('../../src/utils/dom-delta', () => ({
  withDomDelta: jest.fn().mockImplementation(async (_page: unknown, fn: () => Promise<void>) => {
    await fn();
    return { delta: '+ button "Login"\n~ aria-pressed: false → true' };
  }),
}));

// Mock human behavior
jest.mock('../../src/stealth/human-behavior', () => ({
  humanMouseMove: jest.fn().mockResolvedValue(undefined),
  humanType: jest.fn().mockResolvedValue(undefined),
}));

// Mock element discovery cleanup
jest.mock('../../src/utils/element-discovery', () => ({
  cleanupTags: jest.fn().mockResolvedValue(undefined),
  DISCOVERY_TAG: 'data-oc-discovery',
}));

// Mock puppeteer-helpers
jest.mock('../../src/utils/puppeteer-helpers', () => ({
  getTargetId: jest.fn().mockReturnValue('mock-target'),
}));

// Mock outcome classifier
jest.mock('../../src/utils/ralph/outcome-classifier', () => ({
  classifyOutcome: jest.fn().mockReturnValue('SUCCESS'),
  formatOutcomeLine: jest.fn().mockImplementation(
    (_outcome: string, verb: string, desc: string, ref: string, source: string) =>
      `\u2713 ${verb} ${desc} ${ref} ${source}`
  ),
}));

// Mock with-timeout — pass through
jest.mock('../../src/utils/with-timeout', () => ({
  withTimeout: jest.fn().mockImplementation(async (promise: Promise<unknown>) => promise),
}));

import { getSessionManager } from '../../src/session-manager';
import { resolveElementsByAXTree } from '../../src/utils/ax-element-resolver';

describe('ActTool', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let testSessionId: string;
  let testTargetId: string;

  const getActHandler = async () => {
    jest.resetModules();

    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: jest.fn(() => ({
        generateRef: jest.fn().mockReturnValue('ref_1'),
      })),
    }));
    jest.doMock('../../src/utils/ax-element-resolver', () => ({
      resolveElementsByAXTree: (resolveElementsByAXTree as jest.Mock),
      invalidateAXCache: jest.fn(),
      MATCH_LEVEL_LABELS: { 1: 'exact match', 2: 'role match', 3: 'name match', 4: 'partial match' },
    }));
    jest.doMock('../../src/utils/dom-delta', () => ({
      withDomDelta: jest.fn().mockImplementation(async (_page: unknown, fn: () => Promise<void>) => {
        await fn();
        return { delta: '+ button "Login"\n~ aria-pressed: false → true' };
      }),
    }));
    jest.doMock('../../src/stealth/human-behavior', () => ({
      humanMouseMove: jest.fn().mockResolvedValue(undefined),
      humanType: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../../src/utils/element-discovery', () => ({
      cleanupTags: jest.fn().mockResolvedValue(undefined),
      DISCOVERY_TAG: 'data-oc-discovery',
    }));
    jest.doMock('../../src/utils/puppeteer-helpers', () => ({
      getTargetId: jest.fn().mockReturnValue('mock-target'),
    }));
    jest.doMock('../../src/utils/ralph/outcome-classifier', () => ({
      classifyOutcome: jest.fn().mockReturnValue('SUCCESS'),
      formatOutcomeLine: jest.fn().mockImplementation(
        (_outcome: string, verb: string, desc: string, ref: string, source: string) =>
          `\u2713 ${verb} ${desc} ${ref} ${source}`
      ),
    }));
    jest.doMock('../../src/utils/with-timeout', () => ({
      withTimeout: jest.fn().mockImplementation(async (promise: Promise<unknown>) => promise),
    }));

    const { registerActTool } = await import('../../src/tools/act');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };

    registerActTool(mockServer as unknown as Parameters<typeof registerActTool>[0]);
    return tools.get('act')!.handler;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);

    testSessionId = 'test-session-act';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'https://example.com');
    testTargetId = targetId;

    // Default: stealth = false
    (mockSessionManager as any).isStealthTarget = jest.fn().mockReturnValue(false);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─── Input Validation ───

  describe('Input validation', () => {
    test('returns error when tabId is missing', async () => {
      const handler = await getActHandler();
      const result = await handler(testSessionId, { instruction: 'click login' }) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tabId is required');
    });

    test('returns error when instruction is missing', async () => {
      const handler = await getActHandler();
      const result = await handler(testSessionId, { tabId: testTargetId }) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('instruction is required');
    });

    test('returns error when instruction is empty string', async () => {
      const handler = await getActHandler();
      const result = await handler(testSessionId, { tabId: testTargetId, instruction: '   ' }) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('instruction is required');
    });

    test('returns error when tab is not found', async () => {
      const handler = await getActHandler();
      const result = await handler(testSessionId, {
        tabId: 'nonexistent-tab',
        instruction: 'click login',
      }) as any;

      expect(result.isError).toBe(true);
    });
  });

  // ─── Parse failure ───

  describe('Parse failure', () => {
    test('returns error with suggestion when instruction cannot be parsed', async () => {
      const handler = await getActHandler();
      // A pure noun phrase with no action verb
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        instruction: 'the frobulator widget gadget',
      }) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Parse error');
      expect(result.content[0].text).toContain('Suggestion');
    });
  });

  // ─── Single step execution ───

  describe('Single step execution', () => {
    test('executes a click step when AX resolves element', async () => {
      // Arrange: AX resolver returns a valid element
      (resolveElementsByAXTree as jest.Mock).mockResolvedValue([{
        backendDOMNodeId: 100,
        role: 'button',
        name: 'Login',
        matchLevel: 1,
        rect: { x: 50, y: 50, width: 80, height: 30 },
        properties: {},
        source: 'ax',
      }]);

      // Mock CDP send for scroll/box model
      mockSessionManager.mockCDPClient.send.mockResolvedValue({ model: { content: [10, 20, 90, 20, 90, 50, 10, 50] } });

      // Mock page.evaluate for verification state
      const page = await mockSessionManager.getPage(testSessionId, testTargetId);
      (page!.evaluate as jest.Mock).mockResolvedValue({ url: 'https://example.com', title: 'Example' });

      const handler = await getActHandler();
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        instruction: 'click login',
      }) as any;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('[act] Executed 1/1 steps');
      expect(result.content[0].text).toContain('\u2713'); // checkmark
    });

    test('reports ELEMENT_NOT_FOUND when AX resolves nothing', async () => {
      (resolveElementsByAXTree as jest.Mock).mockResolvedValue([]);

      const handler = await getActHandler();
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        instruction: 'click missing-button',
        verify: false,
      }) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not find');
    });

    test('navigate step calls page.goto', async () => {
      const page = await mockSessionManager.getPage(testSessionId, testTargetId);
      (page!.evaluate as jest.Mock).mockResolvedValue({ url: 'https://target.com', title: 'Target' });

      const handler = await getActHandler();
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        instruction: 'navigate to https://target.com',
      }) as any;

      expect(result.isError).toBeFalsy();
      expect(page!.goto).toHaveBeenCalledWith('https://target.com', expect.objectContaining({ waitUntil: 'domcontentloaded' }));
      expect(result.content[0].text).toContain('Executed 1/1 steps');
    });
  });

  // ─── Multi-step execution ───

  describe('Multi-step execution', () => {
    test('executes two steps in sequence', async () => {
      (resolveElementsByAXTree as jest.Mock).mockResolvedValue([{
        backendDOMNodeId: 101,
        role: 'button',
        name: 'Submit',
        matchLevel: 1,
        rect: { x: 100, y: 100, width: 80, height: 30 },
        properties: {},
        source: 'ax',
      }]);
      mockSessionManager.mockCDPClient.send.mockResolvedValue({ model: { content: [80, 85, 160, 85, 160, 115, 80, 115] } });

      const page = await mockSessionManager.getPage(testSessionId, testTargetId);
      (page!.evaluate as jest.Mock).mockResolvedValue({ url: 'https://example.com/done', title: 'Done' });

      const handler = await getActHandler();
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        instruction: 'click login, then click submit',
      }) as any;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Executed 2/2 steps');
      expect(result.content[0].text).toContain('Step 1');
      expect(result.content[0].text).toContain('Step 2');
    });

    test('stops at first failure and reports partial results', async () => {
      // First call: element found; second call: not found
      (resolveElementsByAXTree as jest.Mock)
        .mockResolvedValueOnce([{
          backendDOMNodeId: 200,
          role: 'button',
          name: 'Login',
          matchLevel: 1,
          rect: { x: 50, y: 50, width: 80, height: 30 },
          properties: {},
          source: 'ax',
        }])
        .mockResolvedValueOnce([]); // second step fails

      mockSessionManager.mockCDPClient.send.mockResolvedValue({ model: { content: [30, 35, 110, 35, 110, 65, 30, 65] } });

      const handler = await getActHandler();
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        instruction: 'click login, click nonexistent-thing',
        verify: false,
      }) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('failed at step 2');
      expect(result.content[0].text).toContain('Step 1: \u2713');
      expect(result.content[0].text).toContain('Step 2: \u2717');
    });
  });

  // ─── Verify flag ───

  describe('Verify flag', () => {
    test('verify=false skips verification block', async () => {
      (resolveElementsByAXTree as jest.Mock).mockResolvedValue([{
        backendDOMNodeId: 300,
        role: 'button',
        name: 'Go',
        matchLevel: 1,
        rect: { x: 10, y: 10, width: 50, height: 20 },
        properties: {},
        source: 'ax',
      }]);
      mockSessionManager.mockCDPClient.send.mockResolvedValue({ model: { content: [0, 0, 50, 0, 50, 20, 0, 20] } });

      const page = await mockSessionManager.getPage(testSessionId, testTargetId);

      const handler = await getActHandler();
      await handler(testSessionId, {
        tabId: testTargetId,
        instruction: 'click go',
        verify: false,
      }) as any;

      // page.evaluate should NOT have been called for verification
      expect(page!.evaluate).not.toHaveBeenCalled();
    });

    test('verify=true (default) calls page.evaluate for state summary', async () => {
      (resolveElementsByAXTree as jest.Mock).mockResolvedValue([{
        backendDOMNodeId: 301,
        role: 'button',
        name: 'Go',
        matchLevel: 1,
        rect: { x: 10, y: 10, width: 50, height: 20 },
        properties: {},
        source: 'ax',
      }]);
      mockSessionManager.mockCDPClient.send.mockResolvedValue({ model: { content: [0, 0, 50, 0, 50, 20, 0, 20] } });

      const page = await mockSessionManager.getPage(testSessionId, testTargetId);
      (page!.evaluate as jest.Mock).mockResolvedValue({ url: 'https://example.com', title: 'Example' });

      const handler = await getActHandler();
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        instruction: 'click go',
        // verify defaults to true
      }) as any;

      expect(result.content[0].text).toContain('[Verification]');
      expect(result.content[0].text).toContain('https://example.com');
    });
  });

  // ─── Type step ───

  describe('Type step', () => {
    test('type without target clears and types into focused element', async () => {
      const page = await mockSessionManager.getPage(testSessionId, testTargetId);
      (page!.evaluate as jest.Mock).mockResolvedValue({ url: 'https://example.com', title: 'Example' });

      const handler = await getActHandler();
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        instruction: 'type hello world',
      }) as any;

      expect(result.isError).toBeFalsy();
      expect(page!.keyboard.type).toHaveBeenCalledWith('hello world', expect.any(Object));
    });

    test('type with target finds element first', async () => {
      (resolveElementsByAXTree as jest.Mock).mockResolvedValue([{
        backendDOMNodeId: 400,
        role: 'textbox',
        name: 'Username',
        matchLevel: 1,
        rect: { x: 200, y: 100, width: 200, height: 30 },
        properties: {},
        source: 'ax',
      }]);
      mockSessionManager.mockCDPClient.send.mockResolvedValue({ model: { content: [180, 85, 380, 85, 380, 115, 180, 115] } });

      const page = await mockSessionManager.getPage(testSessionId, testTargetId);
      (page!.evaluate as jest.Mock).mockResolvedValue({ url: 'https://example.com', title: 'Example' });

      const handler = await getActHandler();
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        instruction: 'type admin in username',
      }) as any;

      expect(result.isError).toBeFalsy();
      expect(page!.mouse.click).toHaveBeenCalled();
      expect(page!.keyboard.type).toHaveBeenCalledWith('admin', expect.any(Object));
    });
  });
});
