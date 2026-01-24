/**
 * JavaScript Tool - Execute JavaScript in page context
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'javascript_tool',
  description:
    'Execute JavaScript code in the context of the current page. Returns the result of the last expression.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute the code in',
      },
      action: {
        type: 'string',
        const: 'javascript_exec',
        description: 'Must be set to "javascript_exec"',
      },
      text: {
        type: 'string',
        description:
          'The JavaScript code to execute. The result of the last expression will be returned.',
      },
    },
    required: ['action', 'text', 'tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const code = args.text as string;

  const sessionManager = getSessionManager();

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

  try {
    const page = await sessionManager.getPage(sessionId, tabId);
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Execute the JavaScript
    const result = await page.evaluate((jsCode: string): { success: boolean; value?: string; error?: string } => {
      try {
        // Use indirect eval to execute in global scope
        const evalResult = (0, eval)(jsCode);

        // Serialize the result
        if (evalResult === undefined) {
          return { success: true, value: 'undefined' };
        } else if (evalResult === null) {
          return { success: true, value: 'null' };
        } else if (typeof evalResult === 'function') {
          return { success: true, value: '[Function]' };
        } else if (typeof evalResult === 'symbol') {
          return { success: true, value: evalResult.toString() };
        } else if (evalResult instanceof Element) {
          const el = evalResult as Element;
          return {
            success: true,
            value: `<${el.tagName.toLowerCase()}${el.id ? ' id="' + el.id + '"' : ''}${el.className ? ' class="' + el.className + '"' : ''}>`,
          };
        } else if (evalResult instanceof NodeList || evalResult instanceof HTMLCollection) {
          return {
            success: true,
            value: `[${evalResult.length} elements]`,
          };
        } else {
          try {
            return { success: true, value: JSON.stringify(evalResult, null, 2) };
          } catch {
            return { success: true, value: String(evalResult) };
          }
        }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }, code);

    if (result.success) {
      return {
        content: [{ type: 'text', text: result.value || 'undefined' }],
      };
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `JavaScript error: ${result.error}`,
          },
        ],
        isError: true,
      };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `JavaScript execution error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerJavascriptTool(server: MCPServer): void {
  server.registerTool('javascript_tool', handler, definition);
}
