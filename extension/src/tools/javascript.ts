/**
 * JavaScript execution tool for MCP
 */

import type { MCPResult, MCPToolDefinition } from '../types/mcp';
import { SessionManager } from '../session-manager';

export function createJavaScriptTool(sessionManager: SessionManager) {
  return {
    handler: async (sessionId: string, params: Record<string, unknown>): Promise<MCPResult> => {
      const tabId = params.tabId as number;
      const code = params.text as string;

      if (!sessionId) {
        return {
          content: [{ type: 'text', text: 'Error: sessionId is required' }],
          isError: true,
        };
      }

      if (!tabId) {
        return {
          content: [{ type: 'text', text: 'Error: tabId is required' }],
          isError: true,
        };
      }

      if (!code) {
        return {
          content: [{ type: 'text', text: 'Error: text (JavaScript code) is required' }],
          isError: true,
        };
      }

      // Validate tab ownership
      if (!sessionManager.validateTabOwnership(sessionId, tabId)) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Tab ${tabId} does not belong to session ${sessionId}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await sessionManager.executeCDP<{
          result: {
            type: string;
            value?: unknown;
            description?: string;
            className?: string;
          };
          exceptionDetails?: {
            text: string;
            exception?: { description?: string };
          };
        }>(sessionId, tabId, 'Runtime.evaluate', {
          expression: code,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        });

        // Check for exceptions
        if (result.exceptionDetails) {
          const errorMsg =
            result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text ||
            'Unknown error';
          return {
            content: [{ type: 'text', text: `JavaScript error: ${errorMsg}` }],
            isError: true,
          };
        }

        // Format the result
        let output: string;
        const evalResult = result.result;

        if (evalResult.type === 'undefined') {
          output = 'undefined';
        } else if (evalResult.value !== undefined) {
          if (typeof evalResult.value === 'object') {
            output = JSON.stringify(evalResult.value, null, 2);
          } else {
            output = String(evalResult.value);
          }
        } else if (evalResult.description) {
          output = evalResult.description;
        } else {
          output = `[${evalResult.type}]`;
        }

        return {
          content: [{ type: 'text', text: output }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `JavaScript execution error: ${message}` }],
          isError: true,
        };
      }
    },

    definition: {
      name: 'javascript_tool',
      description:
        "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID for isolation',
          },
          tabId: {
            type: 'number',
            description: 'Tab ID to execute the code in',
          },
          text: {
            type: 'string',
            description:
              'The JavaScript code to execute. The code will be evaluated in the page context. The result of the last expression will be returned automatically.',
          },
        },
        required: ['sessionId', 'tabId', 'text'],
      },
    } as MCPToolDefinition,
  };
}
