/**
 * Navigate Tool - Navigate to URLs
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'navigate',
  description: 'Navigate to a URL, or go forward/back in browser history.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to navigate',
      },
      url: {
        type: 'string',
        description:
          'The URL to navigate to. Use "forward" to go forward in history or "back" to go back.',
      },
    },
    required: ['url', 'tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const url = args.url as string;
  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!url) {
    return {
      content: [{ type: 'text', text: 'Error: url is required' }],
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

    // Handle history navigation
    if (url === 'back') {
      await page.goBack({ waitUntil: 'domcontentloaded' });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'back',
              url: page.url(),
              title: await page.title(),
            }),
          },
        ],
      };
    }

    if (url === 'forward') {
      await page.goForward({ waitUntil: 'domcontentloaded' });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'forward',
              url: page.url(),
              title: await page.title(),
            }),
          },
        ],
      };
    }

    // Normalize URL
    let targetUrl = url;
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    // Validate URL
    try {
      const parsedUrl = new URL(targetUrl);

      // Only allow http and https protocols
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Invalid protocol "${parsedUrl.protocol}". Only http and https are allowed.`,
            },
          ],
          isError: true,
        };
      }

      // Check for valid hostname
      if (!parsedUrl.hostname || parsedUrl.hostname.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: Invalid URL - missing hostname',
            },
          ],
          isError: true,
        };
      }
    } catch (urlError) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Invalid URL format - ${urlError instanceof Error ? urlError.message : 'malformed URL'}`,
          },
        ],
        isError: true,
      };
    }

    // Navigate with proper wait
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'navigate',
            url: page.url(),
            title: await page.title(),
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Navigation error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerNavigateTool(server: MCPServer): void {
  server.registerTool('navigate', handler, definition);
}
