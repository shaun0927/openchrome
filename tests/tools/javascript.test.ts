/// <reference types="jest" />
/**
 * Tests for JavaScript Tool
 * Uses CDP Runtime.evaluate mocking instead of page.evaluate
 */

import { createMockSessionManager } from '../utils/mock-session';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';

describe('JavaScriptTool', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let testSessionId: string;
  let testTargetId: string;

  const getJavascriptHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));

    const { registerJavascriptTool } = await import('../../src/tools/javascript');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };

    registerJavascriptTool(mockServer as unknown as Parameters<typeof registerJavascriptTool>[0]);
    return tools.get('javascript_tool')!.handler;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);

    testSessionId = 'test-session-123';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Code Execution', () => {
    test('executes simple expression', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'number', value: 42, description: '42' },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: '1 + 1',
      }) as { content: Array<{ type: string; text: string }> };

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Runtime.evaluate',
        expect.objectContaining({
          expression: '1 + 1',
          returnByValue: false,
          awaitPromise: true,
          userGesture: true,
        })
      );

      expect(result.content[0].text).toBe('42');
    });

    test('returns undefined result', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'undefined' },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'undefined',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toBe('undefined');
    });

    test('returns null result', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'object', subtype: 'null', value: null },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'null',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toBe('null');
    });

    test('returns object result as JSON', async () => {
      const handler = await getJavascriptHandler();

      // With returnByValue: false, objects come back with objectId instead of value
      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({
          result: { type: 'object', objectId: 'obj-1', description: 'Object', className: 'Object' },
        })
        // callFunctionOn to serialize
        .mockResolvedValueOnce({
          result: { value: '{\n  "name": "test",\n  "value": 123\n}' },
        })
        // releaseObject
        .mockResolvedValueOnce({});

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: '({name: "test", value: 123})',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('name');
      expect(result.content[0].text).toContain('test');
    });

    test('returns array result as JSON', async () => {
      const handler = await getJavascriptHandler();

      // With returnByValue: false, arrays come back with objectId
      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({
          result: { type: 'object', subtype: 'array', objectId: 'arr-1', description: 'Array(3)', className: 'Array' },
        })
        // callFunctionOn to serialize
        .mockResolvedValueOnce({
          result: { value: '[\n  1,\n  2,\n  3\n]' },
        })
        // releaseObject
        .mockResolvedValueOnce({});

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: '[1, 2, 3]',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('[');
      expect(result.content[0].text).toContain('1');
    });

    test('returns function description', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'function', description: 'function test() {}' },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'function test() {}',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('function test() {}');
    });

    test('returns Symbol description', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'symbol', description: 'Symbol(test)' },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'Symbol("test")',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Symbol(test)');
    });

    test('returns DOM element description', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({
          result: {
            type: 'object',
            subtype: 'node',
            className: 'HTMLDivElement',
            description: 'div#test.container',
            objectId: 'node-1',
          },
        })
        // releaseObject
        .mockResolvedValueOnce({});

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'document.getElementById("test")',
      }) as { content: Array<{ type: string; text: string }> };

      // Source reformats "div#test.container" → '<div id="test" class="container">'
      expect(result.content[0].text).toContain('<div');
    });

    test('returns DOM element with id and classes (regression)', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({
          result: {
            type: 'object',
            subtype: 'node',
            className: 'HTMLSpanElement',
            description: 'span#info.highlight.bold',
            objectId: 'node-2',
          },
        })
        .mockResolvedValueOnce({});

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        code: 'document.querySelector("span#info")',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toBe('<span id="info" class="highlight bold">');
    });

    test('returns NodeList with element count (previously returned {})', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({
          result: {
            type: 'object',
            subtype: 'array',
            className: 'NodeList',
            description: 'NodeList(5)',
            objectId: 'nodelist-1',
          },
        })
        // releaseObject
        .mockResolvedValueOnce({});

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        code: 'document.querySelectorAll("div")',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toBe('[5 elements]');
    });

    test('returns HTMLCollection with element count (previously returned {})', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({
          result: {
            type: 'object',
            subtype: 'array',
            className: 'HTMLCollection',
            description: 'HTMLCollection(3)',
            objectId: 'htmlcol-1',
          },
        })
        .mockResolvedValueOnce({});

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        code: 'document.getElementsByTagName("p")',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toBe('[3 elements]');
    });

    test('returns DOMTokenList with element count (previously returned {})', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({
          result: {
            type: 'object',
            className: 'DOMTokenList',
            description: 'DOMTokenList(2)',
            objectId: 'dtl-1',
          },
        })
        .mockResolvedValueOnce({});

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        code: 'document.body.classList',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toBe('[2 elements]');
    });

    test('returns Map with element count (previously returned {})', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({
          result: {
            type: 'object',
            subtype: 'map',
            className: 'Map',
            description: 'Map(4)',
            objectId: 'map-1',
          },
        })
        .mockResolvedValueOnce({});

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        code: 'new Map([["a",1],["b",2],["c",3],["d",4]])',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toBe('[4 elements]');
    });

    test('returns Set with element count (previously returned {})', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({
          result: {
            type: 'object',
            subtype: 'set',
            className: 'Set',
            description: 'Set(2)',
            objectId: 'set-1',
          },
        })
        .mockResolvedValueOnce({});

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        code: 'new Set([1, 2])',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toBe('[2 elements]');
    });
  });

  describe('Error Handling', () => {
    test('catches and returns runtime errors', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'object', subtype: 'error' },
        exceptionDetails: {
          text: 'Uncaught ReferenceError',
          exception: { description: 'ReferenceError: undefinedVar is not defined' },
        },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'undefinedVar',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ReferenceError');
    });

    test('handles syntax errors', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'object', subtype: 'error' },
        exceptionDetails: {
          text: 'Uncaught SyntaxError',
          exception: { description: 'SyntaxError: Unexpected token' },
        },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'function { }',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('SyntaxError');
    });

    test('handles CDP call failures', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockRejectedValueOnce(new Error('Protocol error'));

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'while(true){}',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('JavaScript execution error');
    });

    test('returns error for missing tabId', async () => {
      const handler = await getJavascriptHandler();

      const result = await handler(testSessionId, {
        text: '1 + 1',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tabId is required');
    });

    test('returns error for missing code', async () => {
      const handler = await getJavascriptHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('code is required');
    });

    test('returns error when tab not found', async () => {
      const handler = await getJavascriptHandler();
      mockSessionManager.getPage.mockResolvedValueOnce(null);

      const result = await handler(testSessionId, {
        tabId: 'non-existent-tab',
        text: '1 + 1',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });

  describe('Top-level Await', () => {
    test('supports top-level await', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'number', value: 42, description: '42' },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'await Promise.resolve(42)',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Runtime.evaluate',
        expect.objectContaining({ awaitPromise: true })
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('42');
    });

    test('supports multi-statement with await', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'number', value: 20, description: '20' },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'const val = await Promise.resolve(10); val * 2',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Runtime.evaluate',
        expect.objectContaining({ awaitPromise: true })
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('20');
    });

    test('supports multiple awaits in sequence', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'number', value: 3, description: '3' },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'const a = await Promise.resolve(1); const b = await Promise.resolve(2); a + b',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Runtime.evaluate',
        expect.objectContaining({ awaitPromise: true })
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('3');
    });
  });

  describe('Timeout', () => {
    test('handles timeout', async () => {
      const handler = await getJavascriptHandler();

      // Return a promise that never resolves to simulate a hang
      mockSessionManager.mockCDPClient.send.mockReturnValueOnce(new Promise(() => {}));

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'while(true){}',
        timeout: 100,
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/timeout|timed out/i);
    }, 5000);
  });

  describe('Session Isolation', () => {
    test('rejects execution on tab from another session', async () => {
      const handler = await getJavascriptHandler();

      const session2Id = 'other-session';
      await mockSessionManager.createSession({ id: session2Id });
      const { targetId: session2TargetId } = await mockSessionManager.createTarget(session2Id);

      const result = await handler(testSessionId, {
        tabId: session2TargetId,
        text: '1 + 1',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not belong to session');
    });
  });

  describe('Block statement support (previously broken with eval)', () => {
    test('handles code with for loops containing semicolons', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'number', value: 10, description: '10' },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'let sum = 0; for (let i = 1; i <= 4; i++) { sum += i; } sum',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('10');
    });

    test('handles code with if/else blocks', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'string', value: 'yes', description: 'yes' },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'const x = 5; if (x > 3) { "yes" } else { "no" }',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('yes');
    });

    test('handles template literals with expressions', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'string', value: 'Hello, world!', description: 'Hello, world!' },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'const name = "world"; `Hello, ${name}!`',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Hello, world!');
    });
  });
});
