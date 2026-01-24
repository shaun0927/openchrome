/**
 * Tabs Create Tool - Create a new tab in the session
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'tabs_create_mcp',
  description: 'Creates a new empty tab in the MCP session.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  _args: Record<string, unknown>
): Promise<MCPResult> => {
  const sessionManager = getSessionManager();

  try {
    const { targetId, page } = await sessionManager.createTarget(sessionId, 'about:blank');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tabId: targetId,
              url: page.url(),
              title: await page.title(),
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
          text: `Error creating tab: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerTabsCreateTool(server: MCPServer): void {
  server.registerTool('tabs_create_mcp', handler, definition);
}
