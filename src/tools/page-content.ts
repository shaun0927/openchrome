/**
 * Page Content Tool - Get HTML content from page
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'page_content',
  description: `Get HTML content from the current page.
Returns the full page HTML or content from a specific element using a CSS selector.
Useful for scraping and extracting page structure.`,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to get content from',
      },
      selector: {
        type: 'string',
        description: 'Optional CSS selector to get content from a specific element. If not provided, returns full page HTML.',
      },
      outerHTML: {
        type: 'boolean',
        description: 'If true, returns outerHTML (includes the element itself). If false, returns innerHTML. Default: true',
      },
    },
    required: ['tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const selector = args.selector as string | undefined;
  const outerHTML = (args.outerHTML as boolean) ?? true;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'page_content');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    if (selector) {
      // Get content from specific element
      const element = await page.$(selector);

      if (!element) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'page_content',
                selector,
                content: null,
                message: `No element found matching "${selector}"`,
              }),
            },
          ],
        };
      }

      const html = await page.evaluate(
        (el: Element, getOuter: boolean) => {
          return getOuter ? el.outerHTML : el.innerHTML;
        },
        element,
        outerHTML
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'page_content',
              selector,
              outerHTML,
              contentLength: html.length,
              content: html,
            }),
          },
        ],
      };
    } else {
      // Get full page content
      const html = await page.content();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'page_content',
              selector: null,
              contentLength: html.length,
              content: html,
            }),
          },
        ],
      };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Page content error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerPageContentTool(server: MCPServer): void {
  server.registerTool('page_content', handler, definition);
}
