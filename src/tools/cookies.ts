/**
 * Cookies Tool - Manage browser cookies
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { assertDomainAllowed } from '../security/domain-guard';

type CookieTier = 'auth' | 'functional' | 'tracking';

const AUTH_PATTERNS = /^(session|token|jwt|csrf|auth|sid|ssid|connect\.sid|__Host-|__Secure-|XSRF|_csrf)/i;
const TRACKING_PATTERNS = /^(_ga|_gid|_gat|_fbp|_fbc|__utm|NID|IDE|DSID|APISID|SAPISID|HSID|__gads|_gcl|_pin|_tt_|hubspot|_hj|_clck|_clsk|mp_|ajs_|amplitude|optimizely)/i;
const TRACKING_EXACT = new Set(['fr', 'tr']); // Facebook/Twitter pixel cookies — exact name only

function classifyCookie(name: string): CookieTier {
  if (AUTH_PATTERNS.test(name)) return 'auth';
  if (TRACKING_PATTERNS.test(name) || TRACKING_EXACT.has(name.toLowerCase())) return 'tracking';
  return 'functional';
}

function formatCookiesCompact(cookies: any[]): string {
  const auth: any[] = [];
  const functional: any[] = [];
  const tracking: { name: string; domain: string }[] = [];

  for (const cookie of cookies) {
    const tier = classifyCookie(cookie.name);
    if (tier === 'auth') {
      auth.push(cookie); // Full attributes
    } else if (tier === 'functional') {
      functional.push({ name: cookie.name, value: cookie.value, domain: cookie.domain });
    } else {
      tracking.push({ name: cookie.name, domain: cookie.domain });
    }
  }

  const sections: string[] = [];

  if (auth.length > 0) {
    sections.push(`Auth cookies (${auth.length}):\n${JSON.stringify(auth, null, 2)}`);
  }

  if (functional.length > 0) {
    sections.push(`Functional cookies (${functional.length}):\n${JSON.stringify(functional, null, 2)}`);
  }

  if (tracking.length > 0) {
    // Summary only — group by domain
    const domainCounts = new Map<string, number>();
    for (const t of tracking) {
      domainCounts.set(t.domain, (domainCounts.get(t.domain) || 0) + 1);
    }
    const domainSummary = Array.from(domainCounts.entries())
      .map(([domain, count]) => `${domain}: ${count}`)
      .join(', ');
    sections.push(`Tracking cookies: ${tracking.length} total (${domainSummary})`);
  }

  return sections.join('\n\n');
}

const definition: MCPToolDefinition = {
  name: 'cookies',
  description: 'Manage browser cookies (get, set, delete, clear).',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID',
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
        description: 'Expiration Unix timestamp (seconds)',
      },
      raw: {
        type: 'boolean',
        description: 'Return all cookies with full attributes, bypassing classification.',
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
  const raw = args.raw as boolean | undefined;

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
        if (raw === true) {
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

        // Classified format (default)
        const formatted = formatCookiesCompact(cookies);
        return {
          content: [
            {
              type: 'text',
              text: formatted.length > 0 ? formatted : 'No cookies found',
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

        // Validate that cookie domain is not on the blocklist
        const cookieDomain = domain ?? currentUrl.hostname;
        const { isDomainBlocked } = await import('../security/domain-guard');
        if (isDomainBlocked(`https://${cookieDomain}`)) {
          return {
            content: [{ type: 'text', text: `Error: Cannot set cookies for blocked domain "${cookieDomain}"` }],
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
