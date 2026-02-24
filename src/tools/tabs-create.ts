/**
 * Tabs Create Tool - Create a new tab in the session with a specific URL
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'tabs_create_mcp',
  description: 'Creates a new tab with the specified URL. Use workerId for parallel browser operations.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to open in the new tab (required)',
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
  const sessionManager = getSessionManager();
  const url = args.url as string;
  const workerId = args.workerId as string | undefined;

  // URL is required
  if (!url) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: url is required. Use navigate tool without tabId to create a new tab with a URL.',
        },
      ],
      isError: true,
    };
  }

  try {
    const { targetId, page, workerId: assignedWorkerId } = await sessionManager.createTarget(sessionId, url, workerId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tabId: targetId,
              workerId: assignedWorkerId,
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
