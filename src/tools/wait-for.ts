/**
 * Wait For Tool - Wait for various conditions
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { safeTitle } from '../utils/safe-title';

const definition: MCPToolDefinition = {
  name: 'wait_for',
  description: 'Wait for a condition to be met before proceeding. Supports waiting for selectors, text, functions, URL changes, and network idle.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to wait on',
      },
      type: {
        type: 'string',
        enum: ['selector', 'selector_hidden', 'function', 'navigation', 'timeout'],
        description: 'Type of condition to wait for',
      },
      value: {
        type: 'string',
        description: 'For "selector"/"selector_hidden": CSS selector. For "function": JavaScript code returning boolean. For "timeout": milliseconds as string.',
      },
      timeout: {
        type: 'number',
        description: 'Maximum time to wait in milliseconds. Default: 30000 (30 seconds)',
      },
      visible: {
        type: 'boolean',
        description: 'For "selector" type: if true, waits for element to be visible. Default: false',
      },
    },
    required: ['tabId', 'type'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const type = args.type as string;
  const value = args.value as string | undefined;
  const timeout = (args.timeout as number) ?? 30000;
  const visible = (args.visible as boolean) ?? false;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!type) {
    return {
      content: [{ type: 'text', text: 'Error: type is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'wait_for');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    const startTime = Date.now();

    switch (type) {
      case 'selector': {
        if (!value) {
          return {
            content: [{ type: 'text', text: 'Error: value (CSS selector) is required for selector type' }],
            isError: true,
          };
        }

        await page.waitForSelector(value, {
          timeout,
          visible,
        });

        const elapsed = Date.now() - startTime;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'wait_for',
                type: 'selector',
                selector: value,
                visible,
                elapsed,
                message: `Element "${value}" found after ${elapsed}ms`,
              }),
            },
          ],
        };
      }

      case 'selector_hidden': {
        if (!value) {
          return {
            content: [{ type: 'text', text: 'Error: value (CSS selector) is required for selector_hidden type' }],
            isError: true,
          };
        }

        await page.waitForSelector(value, {
          timeout,
          hidden: true,
        });

        const elapsed = Date.now() - startTime;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'wait_for',
                type: 'selector_hidden',
                selector: value,
                elapsed,
                message: `Element "${value}" hidden/removed after ${elapsed}ms`,
              }),
            },
          ],
        };
      }

      case 'function': {
        if (!value) {
          return {
            content: [{ type: 'text', text: 'Error: value (JavaScript function) is required for function type' }],
            isError: true,
          };
        }

        await page.waitForFunction(value, { timeout });

        const elapsed = Date.now() - startTime;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'wait_for',
                type: 'function',
                elapsed,
                message: `Function returned truthy after ${elapsed}ms`,
              }),
            },
          ],
        };
      }

      case 'navigation': {
        await page.waitForNavigation({
          timeout,
          waitUntil: 'domcontentloaded',
        });

        const elapsed = Date.now() - startTime;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'wait_for',
                type: 'navigation',
                url: page.url(),
                title: await safeTitle(page),
                elapsed,
                message: `Navigation completed after ${elapsed}ms`,
              }),
            },
          ],
        };
      }

      case 'timeout': {
        const delay = value ? parseInt(value, 10) : 1000;

        if (isNaN(delay) || delay < 0) {
          return {
            content: [{ type: 'text', text: 'Error: value must be a valid positive number for timeout type' }],
            isError: true,
          };
        }

        if (delay > 60000) {
          return {
            content: [{ type: 'text', text: 'Error: timeout value cannot exceed 60000ms (1 minute)' }],
            isError: true,
          };
        }

        await new Promise(resolve => setTimeout(resolve, delay));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'wait_for',
                type: 'timeout',
                delay,
                message: `Waited ${delay}ms`,
              }),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown type "${type}". Use: selector, selector_hidden, function, navigation, or timeout`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for timeout errors
    if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'wait_for',
              type,
              error: 'timeout',
              message: `Wait timed out after ${timeout}ms`,
            }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Wait error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerWaitForTool(server: MCPServer): void {
  server.registerTool('wait_for', handler, definition);
}
