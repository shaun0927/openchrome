/// <reference types="jest" />
/**
 * Tests for JavaScript Tool
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
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({ success: true, value: '42' });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: '1 + 1',
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.evaluate).toHaveBeenCalled();
      expect(result.content[0].text).toBe('42');
    });

    test('returns undefined result', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({ success: true, value: 'undefined' });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'undefined',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toBe('undefined');
    });

    test('returns null result', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({ success: true, value: 'null' });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'null',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toBe('null');
    });

    test('returns object result as JSON', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({
        success: true,
        value: JSON.stringify({ name: 'test', value: 123 }, null, 2),
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: '({name: "test", value: 123})',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('name');
      expect(result.content[0].text).toContain('test');
    });

    test('returns array result as JSON', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({
        success: true,
        value: JSON.stringify([1, 2, 3], null, 2),
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: '[1, 2, 3]',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('[');
      expect(result.content[0].text).toContain('1');
    });

    test('returns function as [Function]', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({ success: true, value: '[Function]' });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'function test() {}',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toBe('[Function]');
    });

    test('returns Element as tag string', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({
        success: true,
        value: '<div id="test" class="container">',
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'document.getElementById("test")',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('<div');
    });

    test('returns NodeList as count', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({
        success: true,
        value: '[5 elements]',
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'document.querySelectorAll("div")',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('elements');
    });

    test('returns Symbol as string', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({
        success: true,
        value: 'Symbol(test)',
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'Symbol("test")',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Symbol');
    });
  });

  describe('Error Handling', () => {
    test('catches and returns runtime errors', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({
        success: false,
        error: 'ReferenceError: undefinedVar is not defined',
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'undefinedVar',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('JavaScript error');
      expect(result.content[0].text).toContain('ReferenceError');
    });

    test('handles syntax errors', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({
        success: false,
        error: 'SyntaxError: Unexpected token',
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'function { }',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('SyntaxError');
    });

    test('handles page.evaluate failures', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockRejectedValue(new Error('Execution context was destroyed'));

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'while(true){}',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('JavaScript execution error');
    });

    test('returns error for missing tabId', async () => {
      const handler = await getJavascriptHandler();

      const result = await handler(testSessionId, {
        action: 'javascript_exec',
        text: '1 + 1',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tabId is required');
    });

    test('returns error for missing text', async () => {
      const handler = await getJavascriptHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('text');
    });

    test('returns error when tab not found', async () => {
      const handler = await getJavascriptHandler();
      mockSessionManager.getPage.mockResolvedValueOnce(null);

      const result = await handler(testSessionId, {
        tabId: 'non-existent-tab',
        action: 'javascript_exec',
        text: '1 + 1',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });

  describe('Page Context Execution', () => {
    test('executes in page context', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({ success: true, value: 'true' });

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'typeof window !== "undefined"',
      });

      // page.evaluate executes code in page context
      expect(page.evaluate).toHaveBeenCalledWith(
        expect.any(Function),
        'typeof window !== "undefined"'
      );
    });

    test('can access window object', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({
        success: true,
        value: JSON.stringify({ href: 'about:blank' }),
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'window.location.href',
      }) as { content: Array<{ type: string; text: string }> };

      expect(page.evaluate).toHaveBeenCalled();
    });

    test('can access document object', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({ success: true, value: '"Test Page"' });

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'document.title',
      });

      expect(page.evaluate).toHaveBeenCalled();
    });
  });

  describe('Session Isolation', () => {
    test('rejects execution on tab from another session', async () => {
      const handler = await getJavascriptHandler();

      const session2Id = 'other-session';
      await mockSessionManager.createSession({ id: session2Id });
      const { targetId: session2TargetId } = await mockSessionManager.createTarget(session2Id);

      const result = await handler(testSessionId, {
        tabId: session2TargetId,
        action: 'javascript_exec',
        text: '1 + 1',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not belong to session');
    });
  });

  describe('Complex Expressions', () => {
    test('handles multi-line code', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({ success: true, value: '6' });

      const code = `
        const x = 1;
        const y = 2;
        x + y * 2 + 1
      `;

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: code,
      });

      expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), code);
    });

    test('handles async/await expressions', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockResolvedValue({ success: true, value: '"fetched"' });

      await handler(testSessionId, {
        tabId: testTargetId,
        action: 'javascript_exec',
        text: 'Promise.resolve("fetched")',
      });

      expect(page.evaluate).toHaveBeenCalled();
    });
  });

  describe('Top-level Await Support', () => {
    // Simulates the 3-tier eval strategy from javascript.ts without browser globals.
    // This mirrors the exact logic in the source so the tests verify the wrapping behaviour.
    async function evalWithAwaitSupport(jsCode: string): Promise<{ success: boolean; value?: string; error?: string }> {
      try {
        let evalResult: unknown;
        try {
          // Tier 1: direct eval
          evalResult = (0, eval)(jsCode);
        } catch (e) {
          if (!(e instanceof SyntaxError) || !jsCode.includes('await')) {
            throw e;
          }
          const trimmed = jsCode.trim().replace(/;$/, '');
          try {
            // Tier 2: single async expression
            evalResult = (0, eval)(`(async()=>{return(\n${trimmed}\n)})()`);
          } catch {
            // Tier 3: multi-statement with return-last heuristic
            const lastSemiIdx = trimmed.lastIndexOf(';');
            if (lastSemiIdx !== -1) {
              const head = trimmed.substring(0, lastSemiIdx + 1);
              const tail = trimmed.substring(lastSemiIdx + 1).trim();
              if (tail && !/^(const|let|var|function|class|if|for|while|switch|try|throw|return)\b/.test(tail)) {
                evalResult = (0, eval)(`(async()=>{${head}\nreturn(${tail})})()`);
              } else {
                evalResult = (0, eval)(`(async()=>{${trimmed}})()`);
              }
            } else {
              evalResult = (0, eval)(`(async()=>{${trimmed}})()`);
            }
          }
        }

        if (evalResult && typeof evalResult === 'object' && typeof (evalResult as Promise<unknown>).then === 'function') {
          evalResult = await (evalResult as Promise<unknown>);
        }

        if (evalResult === undefined) {
          return { success: true, value: 'undefined' };
        } else if (evalResult === null) {
          return { success: true, value: 'null' };
        } else if (typeof evalResult === 'function') {
          return { success: true, value: '[Function]' };
        } else if (typeof evalResult === 'symbol') {
          return { success: true, value: (evalResult as symbol).toString() };
        } else {
          try {
            return { success: true, value: JSON.stringify(evalResult, null, 2) };
          } catch {
            return { success: true, value: String(evalResult) };
          }
        }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    test('supports top-level await with Promise', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockImplementation(async (_fn: unknown, code: string) => {
        return evalWithAwaitSupport(code);
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'await Promise.resolve(42)',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('42');
    });

    test('supports await with setTimeout via Promise', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockImplementation(async (_fn: unknown, code: string) => {
        return evalWithAwaitSupport(code);
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: "await new Promise(r => setTimeout(() => r('done'), 10))",
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('"done"');
    });

    test('supports multi-statement await with last-expression return', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockImplementation(async (_fn: unknown, code: string) => {
        return evalWithAwaitSupport(code);
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'const val = await Promise.resolve(10); val * 2',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('20');
    });

    test('non-await code still works via real eval', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockImplementation(async (_fn: unknown, code: string) => {
        return evalWithAwaitSupport(code);
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: '1 + 1',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('2');
    });

    test('non-await string expression is JSON stringified', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockImplementation(async (_fn: unknown, code: string) => {
        return evalWithAwaitSupport(code);
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: '"hello"',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('"hello"');
    });

    test('syntax errors without await still produce clear errors', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockImplementation(async (_fn: unknown, code: string) => {
        return evalWithAwaitSupport(code);
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'function { }',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/SyntaxError|Unexpected token/);
    });

    test('await undefined/null resolves to null', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockImplementation(async (_fn: unknown, code: string) => {
        return evalWithAwaitSupport(code);
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'await Promise.resolve(null)',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('null');
    });

    test('supports multiple awaits in sequence', async () => {
      const handler = await getJavascriptHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      (page.evaluate as jest.Mock).mockImplementation(async (_fn: unknown, code: string) => {
        return evalWithAwaitSupport(code);
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        text: 'const a = await Promise.resolve(1); const b = await Promise.resolve(2); a + b',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('3');
    });
  });
});
