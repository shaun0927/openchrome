/**
 * Tabs Context Tool - Get context about browser tabs
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'tabs_context_mcp',
  description:
    'Get context information about the current MCP session tabs. Returns all tab IDs. Use createIfEmpty to create a new tab if none exists.',
  inputSchema: {
    type: 'object',
    properties: {
      createIfEmpty: {
        type: 'boolean',
        description: 'Creates a new tab if the session has no tabs',
      },
    },
    required: [],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const createIfEmpty = args.createIfEmpty as boolean | undefined;
  const sessionManager = getSessionManager();

  try {
    const session = await sessionManager.getOrCreateSession(sessionId);
    let targetIds = sessionManager.getSessionTargetIds(sessionId);

    // Create a new tab if requested and none exist
    if (createIfEmpty && targetIds.length === 0) {
      const { targetId } = await sessionManager.createTarget(sessionId, 'about:blank');
      targetIds = [targetId];
    }

    // Get tab info for each target
    const tabInfos = await Promise.all(
      targetIds.map(async (targetId) => {
        const page = await sessionManager.getPage(sessionId, targetId);
        if (!page) {
          return { tabId: targetId, url: 'unknown', title: 'unknown' };
        }

        return {
          tabId: targetId,
          url: page.url(),
          title: await page.title(),
        };
      })
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              sessionId,
              tabs: tabInfos,
              tabCount: tabInfos.length,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting tab context: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerTabsContextTool(server: MCPServer): void {
  server.registerTool('tabs_context_mcp', handler, definition);
}
