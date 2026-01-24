/**
 * Navigation tool for MCP
 */

import type { MCPResult, MCPToolDefinition } from '../types/mcp';
import { SessionManager } from '../session-manager';

export function createNavigateTool(sessionManager: SessionManager) {
  return {
    handler: async (sessionId: string, params: Record<string, unknown>): Promise<MCPResult> => {
      const tabId = params.tabId as number;
      const url = params.url as string;

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

      if (!url) {
        return {
          content: [{ type: 'text', text: 'Error: url is required' }],
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
        // Handle special navigation commands
        if (url === 'back') {
          await chrome.tabs.goBack(tabId);
          return {
            content: [{ type: 'text', text: 'Navigated back' }],
          };
        }

        if (url === 'forward') {
          await chrome.tabs.goForward(tabId);
          return {
            content: [{ type: 'text', text: 'Navigated forward' }],
          };
        }

        // Normalize URL
        let normalizedUrl = url;
        if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('about:')) {
          normalizedUrl = `https://${url}`;
        }

        // Navigate using CDP for better control
        await sessionManager.executeCDP(sessionId, tabId, 'Page.navigate', {
          url: normalizedUrl,
        });

        // Wait for page to load
        await new Promise<void>((resolve) => {
          const listener = (
            updatedTabId: number,
            changeInfo: chrome.tabs.TabChangeInfo
          ) => {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);

          // Timeout after 30 seconds
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 30000);
        });

        // Get updated tab info
        const tab = await chrome.tabs.get(tabId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  url: tab.url,
                  title: tab.title,
                  status: 'complete',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Navigation error: ${message}` }],
          isError: true,
        };
      }
    },

    definition: {
      name: 'navigate',
      description:
        'Navigate to a URL, or go forward/back in browser history. Use "forward" or "back" as the URL for history navigation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID for isolation',
          },
          tabId: {
            type: 'number',
            description: 'Tab ID to navigate',
          },
          url: {
            type: 'string',
            description:
              'The URL to navigate to. Use "forward" to go forward or "back" to go back in history.',
          },
        },
        required: ['sessionId', 'tabId', 'url'],
      },
    } as MCPToolDefinition,
  };
}
