/**
 * HTTP Auth Tool - Handle HTTP Basic Authentication
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'http_auth',
  description: `Set or clear HTTP Basic Authentication credentials.
Use this before navigating to pages that require HTTP authentication.
Actions:
- "set": Set credentials for HTTP authentication
- "clear": Clear previously set credentials`,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to set authentication for',
      },
      action: {
        type: 'string',
        enum: ['set', 'clear'],
        description: 'Action: set or clear credentials',
      },
      username: {
        type: 'string',
        description: 'Username for HTTP authentication (required for "set" action)',
      },
      password: {
        type: 'string',
        description: 'Password for HTTP authentication (required for "set" action)',
      },
    },
    required: ['tabId', 'action'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const action = args.action as string;
  const username = args.username as string | undefined;
  const password = args.password as string | undefined;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!action) {
    return {
      content: [{ type: 'text', text: 'Error: action is required' }],
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

    switch (action) {
      case 'set': {
        if (!username) {
          return {
            content: [{ type: 'text', text: 'Error: username is required for set action' }],
            isError: true,
          };
        }
        if (password === undefined) {
          return {
            content: [{ type: 'text', text: 'Error: password is required for set action' }],
            isError: true,
          };
        }

        await page.authenticate({ username, password });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'http_auth',
                status: 'credentials_set',
                username,
                message: `HTTP authentication credentials set for user: ${username}`,
              }),
            },
          ],
        };
      }

      case 'clear': {
        await page.authenticate(null);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'http_auth',
                status: 'credentials_cleared',
                message: 'HTTP authentication credentials cleared',
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
              text: `Error: Unknown action "${action}". Use: set or clear`,
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
          text: `HTTP auth error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerHttpAuthTool(server: MCPServer): void {
  server.registerTool('http_auth', handler, definition);
}
