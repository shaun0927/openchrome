/**
 * Navigate Tool - Navigate to URLs
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { smartGoto } from '../utils/smart-goto';
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from '../config/defaults';

const definition: MCPToolDefinition = {
  name: 'navigate',
  description: 'Navigate to a URL, or go forward/back in browser history. If tabId is not provided, creates a new tab with the URL. Use workerId to specify which worker context to use for parallel operations.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to navigate. If not provided, a new tab will be created.',
      },
      url: {
        type: 'string',
        description:
          'The URL to navigate to. Use "forward" to go forward in history or "back" to go back.',
      },
      workerId: {
        type: 'string',
        description: 'Worker ID for parallel operations. Uses default worker if not specified.',
      },
    },
    required: ['url'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  let tabId = args.tabId as string | undefined;
  const url = args.url as string;
  const workerId = args.workerId as string | undefined;
  const sessionManager = getSessionManager();

  if (!url) {
    return {
      content: [{ type: 'text', text: 'Error: url is required' }],
      isError: true,
    };
  }

  // If no tabId provided and not a history navigation, create a new tab with the URL
  if (!tabId && url !== 'back' && url !== 'forward') {
    try {
      // Normalize URL first
      let targetUrl = url;
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
      }

      // Validate URL before creating tab
      try {
        const parsedUrl = new URL(targetUrl);
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
        if (!parsedUrl.hostname || parsedUrl.hostname.length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: Invalid URL - missing hostname' }],
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

      // Tab reuse: if worker has exactly 1 existing tab, reuse it instead of creating new
      const resolvedWorkerId = workerId || 'default';
      const existingTargets = sessionManager.getWorkerTargetIds(sessionId, resolvedWorkerId);
      if (existingTargets.length === 1) {
        const existingTabId = existingTargets[0];
        if (await sessionManager.isTargetValid(existingTabId)) {
          const page = await sessionManager.getPage(sessionId, existingTabId, undefined, 'navigate');
          if (page) {
            await smartGoto(page, targetUrl, { timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    action: 'navigate',
                    url: page.url(),
                    title: await page.title(),
                    tabId: existingTabId,
                    workerId: resolvedWorkerId,
                    reused: true,
                  }),
                },
              ],
            };
          }
        }
      }

      // Create new tab with URL directly (in specified worker or default)
      const { targetId, page, workerId: assignedWorkerId } = await sessionManager.createTarget(sessionId, targetUrl, workerId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'navigate',
              url: page.url(),
              title: await page.title(),
              tabId: targetId,
              workerId: assignedWorkerId,
              created: true,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error creating tab: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  // tabId is required for history navigation
  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required for back/forward navigation' }],
      isError: true,
    };
  }

  try {
    // Validate target is still valid
    if (!await sessionManager.isTargetValid(tabId)) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} is no longer available` }],
        isError: true,
      };
    }

    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'navigate');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Handle history navigation
    if (url === 'back') {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
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
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
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

    // Navigate with smart auth redirect detection
    const { authRedirect } = await smartGoto(page, targetUrl, { timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'navigate',
            url: page.url(),
            title: await page.title(),
            ...(authRedirect && { redirectedFrom: authRedirect.from, authRedirect: true }),
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
