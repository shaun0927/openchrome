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
import {
  buildJavascriptExpression,
  formatCDPResult,
  JAVASCRIPT_HELPER_INJECTION,
} from '../../src/tools/javascript';
import { addTimeoutResponseGraceMs } from '../../src/utils/with-timeout';

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

    const tools: Map<string, {
      handler: (
        sessionId: string,
        args: Record<string, unknown>,
        context?: { startTime: number; deadlineMs: number; signal?: AbortSignal },
      ) => Promise<unknown>;
    }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, {
          handler: handler as (
            sessionId: string,
            args: Record<string, unknown>,
            context?: { startTime: number; deadlineMs: number; signal?: AbortSignal },
          ) => Promise<unknown>,
        });
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
          expression: expect.stringContaining('1 + 1'),
          returnByValue: false,
          awaitPromise: true,
          userGesture: true,
          timeout: 30000,
        }),
        expect.objectContaining({
          timeoutMs: addTimeoutResponseGraceMs(30000),
          reserveRuntimeEvaluateResponseGrace: true,
        }),
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

    test('includes explicit diagnostic text for exception details', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'object', subtype: 'error' },
        exceptionDetails: {
          text: 'Uncaught ReferenceError',
          exception: { description: 'ReferenceError: missingThing is not defined' },
        },
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        code: 'missingThing',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('JavaScript error: ReferenceError');
      expect(result.content[0].text).toContain('Diagnostic: Uncaught ReferenceError');
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
        expect.objectContaining({ awaitPromise: true }),
        expect.objectContaining({ reserveRuntimeEvaluateResponseGrace: true }),
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
        expect.objectContaining({ awaitPromise: true }),
        expect.objectContaining({ reserveRuntimeEvaluateResponseGrace: true }),
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
        expect.objectContaining({ awaitPromise: true }),
        expect.objectContaining({ reserveRuntimeEvaluateResponseGrace: true }),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('3');
    });
  });

  describe('Result formatting diagnostics', () => {
    test('resolves Promise remote object before formatting result', async () => {
      const mockSender = {
        send: jest.fn()
          .mockResolvedValueOnce({ result: { type: 'number', value: 42, description: '42' } })
          .mockResolvedValue({}),
      };

      const result = await formatCDPResult(
        {
          type: 'object',
          subtype: 'promise',
          className: 'Promise',
          description: 'Promise',
          objectId: 'promise-1',
        },
        mockSender,
        {}
      );

      expect(result).toBe('42');
      expect(mockSender.send).toHaveBeenCalledWith({}, 'Runtime.awaitPromise', {
        promiseObjectId: 'promise-1',
        returnByValue: false,
      });
      expect(mockSender.send).toHaveBeenCalledWith({}, 'Runtime.releaseObject', { objectId: 'promise-1' });
    });

    test('threads the caller guard into Runtime.awaitPromise', async () => {
      const controller = new AbortController();
      const sendOptions = {
        timeoutMs: 300,
        deadlineAt: Date.now() + 1_000,
        signal: controller.signal,
        reserveRuntimeEvaluateResponseGrace: true,
      };
      const mockSender = {
        send: jest.fn()
          .mockResolvedValueOnce({ result: { type: 'number', value: 42, description: '42' } })
          .mockResolvedValue({}),
      };

      await expect(formatCDPResult(
        {
          type: 'object',
          subtype: 'promise',
          className: 'Promise',
          description: 'Promise',
          objectId: 'promise-guarded',
        },
        mockSender,
        {},
        0,
        sendOptions,
      )).resolves.toBe('42');

      expect(mockSender.send).toHaveBeenCalledWith(
        {},
        'Runtime.awaitPromise',
        {
          promiseObjectId: 'promise-guarded',
          returnByValue: false,
        },
        sendOptions,
      );
    });

    test('resolves Promise remote object to object output', async () => {
      const mockSender = {
        send: jest.fn()
          .mockResolvedValueOnce({
            result: { type: 'object', objectId: 'obj-1', description: 'Object', className: 'Object' },
          })
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ result: { value: '{\n  "ok": true\n}' } })
          .mockResolvedValue({}),
      };

      const result = await formatCDPResult(
        {
          type: 'object',
          subtype: 'promise',
          className: 'Promise',
          description: 'Promise',
          objectId: 'promise-1',
        },
        mockSender,
        {}
      );

      expect(result).toContain('"ok": true');
      expect(mockSender.send).toHaveBeenCalledWith({}, 'Runtime.awaitPromise', {
        promiseObjectId: 'promise-1',
        returnByValue: false,
      });
    });

    test('throws when Promise remote object cannot be resolved', async () => {
      const mockSender = { send: jest.fn().mockRejectedValue(new Error('Protocol error')) };

      await expect(formatCDPResult(
        {
          type: 'object',
          subtype: 'promise',
          className: 'Promise',
          description: 'Promise',
          objectId: 'promise-1',
        },
        mockSender,
        {}
      )).rejects.toThrow(/Runtime\.awaitPromise failed/);
    });
  });

  describe('Shadow DOM helpers', () => {
    test('helper injection expression exposes helper APIs', () => {
      const expression = buildJavascriptExpression('__pierce(".feed-shared-update-v2").length');

      expect(expression).toContain('globalThis.__openchrome');
      expect(expression).toContain('querySelectorAllDeep');
      expect(expression).toContain('globalThis.__pierce');
      expect(expression).toContain('__pierce(".feed-shared-update-v2").length');
    });

    test('pierces nested open shadow roots with LinkedIn-style selectors using mocks', () => {
      type MockNode = {
        shadowRoot?: MockNode;
        querySelectorAll: (selector: string) => MockNode[];
      };

      const linkedInButton: MockNode = {
        querySelectorAll: jest.fn(() => []),
      };
      const nestedShadow: MockNode = {
        querySelectorAll: jest.fn((selector: string) =>
          selector === '.artdeco-button' ? [linkedInButton] : []
        ),
      };
      const nestedHost: MockNode = {
        shadowRoot: nestedShadow,
        querySelectorAll: jest.fn(() => []),
      };
      const topShadow: MockNode = {
        querySelectorAll: jest.fn((selector: string) =>
          selector === '*' ? [nestedHost] : []
        ),
      };
      const topHost: MockNode = {
        shadowRoot: topShadow,
        querySelectorAll: jest.fn(() => []),
      };
      const documentMock: MockNode = {
        querySelectorAll: jest.fn((selector: string) =>
          selector === '*' ? [topHost] : []
        ),
      };
      const sandbox = { document: documentMock };

      const installAndPierce = new Function(
        'globalThis',
        'document',
        `${JAVASCRIPT_HELPER_INJECTION}; return globalThis.__pierce('.artdeco-button');`
      );

      expect(installAndPierce(sandbox, documentMock)).toEqual([linkedInButton]);
    });
  });

  describe('Timeout', () => {
    test('reserves response grace inside a custom timeout', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'number', value: 42, description: '42' },
      });

      await handler(testSessionId, {
        tabId: testTargetId,
        text: '21 * 2',
        timeout: 250,
      });

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Runtime.evaluate',
        expect.objectContaining({ timeout: 250 }),
        expect.objectContaining({
          timeoutMs: addTimeoutResponseGraceMs(250),
          reserveRuntimeEvaluateResponseGrace: true,
        }),
      );
    });

    test('threads the absolute parent deadline to the CDP dispatch guard', async () => {
      const handler = await getJavascriptHandler();

      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({
        result: { type: 'number', value: 42, description: '42' },
      });

      const startTime = Date.now() - 750;
      await handler(
        testSessionId,
        { tabId: testTargetId, text: '21 * 2', timeout: 5_000 },
        { startTime, deadlineMs: 1_000 },
      );

      const params = mockSessionManager.mockCDPClient.send.mock.calls[0][2];
      const options = mockSessionManager.mockCDPClient.send.mock.calls[0][3];
      expect(params.timeout).toBe(5_000);
      expect(options).toMatchObject({
        timeoutMs: addTimeoutResponseGraceMs(5_000),
        deadlineAt: startTime + 1_000,
        reserveRuntimeEvaluateResponseGrace: true,
      });
    });

    test('shares one timeout window with Runtime.awaitPromise formatting', async () => {
      const handler = await getJavascriptHandler();
      jest.useFakeTimers({ now: 10_000 });
      try {
        mockSessionManager.mockCDPClient.send
          .mockImplementationOnce(() => new Promise((resolve) => {
            setTimeout(() => resolve({
              result: {
                type: 'object',
                subtype: 'promise',
                className: 'Promise',
                description: 'Promise',
                objectId: 'pending-promise',
              },
            }), 250);
          }))
          .mockImplementationOnce(() => new Promise(() => {}));

        let settled = false;
        const resultPromise = handler(testSessionId, {
          tabId: testTargetId,
          text: 'new Promise(() => {})',
          timeout: 250,
        }).then((result) => {
          settled = true;
          return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
        });

        await jest.advanceTimersByTimeAsync(299);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(2);

        const result = await resultPromise;
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Promise resolution timed out');
        expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledTimes(2);
        expect(mockSessionManager.mockCDPClient.send.mock.calls[0][3].deadlineAt).toBe(10_300);
        expect(mockSessionManager.mockCDPClient.send.mock.calls[1][3].deadlineAt).toBe(10_300);
      } finally {
        jest.useRealTimers();
      }
    });

    test('does not dispatch JavaScript after the parent budget is exhausted', async () => {
      const handler = await getJavascriptHandler();

      const result = await handler(
        testSessionId,
        { tabId: testTargetId, text: 'window.__shouldNotRun = true', timeout: 5_000 },
        { startTime: Date.now() - 2_000, deadlineMs: 1_000 },
      ) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('deadline exceeded');
      expect(mockSessionManager.mockCDPClient.send).not.toHaveBeenCalled();
    });

    test('rejects a negative timeout without dispatching JavaScript', async () => {
      const handler = await getJavascriptHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'window.__shouldNotRun = true',
        timeout: -1,
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('positive finite number');
      expect(mockSessionManager.mockCDPClient.send).not.toHaveBeenCalled();
    });

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
