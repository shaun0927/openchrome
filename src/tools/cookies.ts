/**
 * Cookies Tool - Manage browser cookies
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { assertDomainAllowed } from '../security/domain-guard';

const definition: MCPToolDefinition = {
  name: 'cookies',
  description: 'Manage browser cookies for the current page (get, set, delete, clear).',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to manage cookies for',
      },
      action: {
        type: 'string',
        enum: ['get', 'set', 'delete', 'clear'],
        description: 'Action to perform',
      },
      name: {
        type: 'string',
        description: 'Cookie name',
      },
      value: {
        type: 'string',
        description: 'Cookie value',
      },
      domain: {
        type: 'string',
        description: 'Cookie domain. Default: current domain',
      },
      path: {
        type: 'string',
        description: 'Cookie path. Default: /',
      },
      secure: {
        type: 'boolean',
        description: 'Secure flag',
      },
      httpOnly: {
        type: 'boolean',
        description: 'HTTP-only flag',
      },
      sameSite: {
        type: 'string',
        enum: ['Strict', 'Lax', 'None'],
        description: 'SameSite attribute',
      },
      expires: {
        type: 'number',
        description: 'Expiration as Unix timestamp in seconds',
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
  const name = args.name as string | undefined;
  const value = args.value as string | undefined;
  const domain = args.domain as string | undefined;
  const path = (args.path as string | undefined) ?? '/';
  const secure = args.secure as boolean | undefined;
  const httpOnly = args.httpOnly as boolean | undefined;
  const sameSite = args.sameSite as 'Strict' | 'Lax' | 'None' | undefined;
  const expires = args.expires as number | undefined;

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
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'cookies');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    const currentUrl = new URL(page.url());

    // Domain blocklist check
    assertDomainAllowed(page.url());

    switch (action) {
      case 'get': {
        const cookies = await page.cookies();

        if (name) {
          // Get specific cookie
          const cookie = cookies.find(c => c.name === name);
          if (cookie) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    action: 'get',
                    cookie,
                  }),
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    action: 'get',
                    cookie: null,
                    message: `Cookie "${name}" not found`,
                  }),
                },
              ],
            };
          }
        }

        // Get all cookies
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'get',
                cookies,
                count: cookies.length,
              }),
            },
          ],
        };
      }

      case 'set': {
        if (!name) {
          return {
            content: [{ type: 'text', text: 'Error: name is required for set action' }],
            isError: true,
          };
        }
        if (value === undefined) {
          return {
            content: [{ type: 'text', text: 'Error: value is required for set action' }],
            isError: true,
          };
        }

        const cookieToSet: {
          name: string;
          value: string;
          domain?: string;
          path?: string;
          secure?: boolean;
          httpOnly?: boolean;
          sameSite?: 'Strict' | 'Lax' | 'None';
          expires?: number;
        } = {
          name,
          value,
          domain: domain ?? currentUrl.hostname,
          path,
        };

        if (secure !== undefined) cookieToSet.secure = secure;
        if (httpOnly !== undefined) cookieToSet.httpOnly = httpOnly;
        if (sameSite !== undefined) cookieToSet.sameSite = sameSite;
        if (expires !== undefined) cookieToSet.expires = expires;

        await page.setCookie(cookieToSet);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'set',
                cookie: cookieToSet,
                message: `Cookie "${name}" set successfully`,
              }),
            },
          ],
        };
      }

      case 'delete': {
        if (!name) {
          return {
            content: [{ type: 'text', text: 'Error: name is required for delete action' }],
            isError: true,
          };
        }

        const cookieToDelete = {
          name,
          domain: domain ?? currentUrl.hostname,
          path,
        };

        await page.deleteCookie(cookieToDelete);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'delete',
                name,
                message: `Cookie "${name}" deleted`,
              }),
            },
          ],
        };
      }

      case 'clear': {
        const cookies = await page.cookies();

        // Delete all cookies
        for (const cookie of cookies) {
          await page.deleteCookie({
            name: cookie.name,
            domain: cookie.domain,
            path: cookie.path,
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'clear',
                clearedCount: cookies.length,
                message: `Cleared ${cookies.length} cookies`,
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
              text: `Error: Unknown action "${action}". Use: get, set, delete, or clear`,
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
          text: `Cookie error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerCookiesTool(server: MCPServer): void {
  server.registerTool('cookies', handler, definition);
}
