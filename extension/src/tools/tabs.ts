/**
 * Tab management tools for MCP
 */

import type { MCPResult, MCPToolDefinition } from '../types/mcp';
import { SessionManager } from '../session-manager';

export function createTabsTools(sessionManager: SessionManager) {
  return {
    tabs_context_mcp: {
      handler: async (sessionId: string, params: Record<string, unknown>): Promise<MCPResult> => {
        const createIfEmpty = params.createIfEmpty as boolean ?? true;

        if (!sessionId) {
          return {
            content: [{ type: 'text', text: 'Error: sessionId is required' }],
            isError: true,
          };
        }

        // Get or create session
        const session = await sessionManager.getOrCreateSession(sessionId);

        // Ensure tab group exists if createIfEmpty
        if (createIfEmpty && session.tabGroupId === -1) {
          await sessionManager.ensureTabGroup(sessionId);
        }

        // Get tabs
        const tabs = await sessionManager.getSessionTabs(sessionId);
        const tabInfos = tabs.map((tab) => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          active: tab.active,
          index: tab.index,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  sessionId,
                  tabGroupId: session.tabGroupId,
                  tabs: tabInfos,
                },
                null,
                2
              ),
            },
          ],
        };
      },
      definition: {
        name: 'tabs_context_mcp',
        description:
          "Get context information about the current MCP session's tabs. Returns all tab IDs inside the session's group.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID for isolation',
            },
            createIfEmpty: {
              type: 'boolean',
              description:
                'Creates a new tab group if none exists for this session. Default: true',
            },
          },
          required: ['sessionId'],
        },
      } as MCPToolDefinition,
    },

    tabs_create_mcp: {
      handler: async (sessionId: string, params: Record<string, unknown>): Promise<MCPResult> => {
        if (!sessionId) {
          return {
            content: [{ type: 'text', text: 'Error: sessionId is required' }],
            isError: true,
          };
        }

        const url = params.url as string | undefined;

        // Get or create session
        await sessionManager.getOrCreateSession(sessionId);

        // Create tab in session's group
        const tab = await sessionManager.createTab(sessionId, url);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  tabId: tab.id,
                  url: tab.url,
                  title: tab.title,
                  sessionId,
                },
                null,
                2
              ),
            },
          ],
        };
      },
      definition: {
        name: 'tabs_create_mcp',
        description: "Creates a new empty tab in the MCP session's tab group.",
        inputSchema: {
          type: 'object' as const,
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID for isolation',
            },
            url: {
              type: 'string',
              description: 'Optional URL to navigate to',
            },
          },
          required: ['sessionId'],
        },
      } as MCPToolDefinition,
    },
  };
}
