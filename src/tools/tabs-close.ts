/**
 * Tabs Close Tool - Close tabs in the session
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'tabs_close',
  description: 'Close one or more tabs by tabId, tabIds, or workerId.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Specific tab ID to close',
      },
      tabIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of tab IDs to close (for batch closing)',
      },
      workerId: {
        type: 'string',
        description: 'Close all tabs in this worker (worker itself is preserved)',
      },
    },
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const sessionManager = getSessionManager();
  const tabId = args.tabId as string | undefined;
  const tabIds = args.tabIds as string[] | undefined;
  const workerId = args.workerId as string | undefined;

  // Validate at least one parameter is provided
  if (!tabId && !tabIds && !workerId) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Provide tabId, tabIds array, or workerId to close tabs',
        },
      ],
      isError: true,
    };
  }

  try {
    const results: { closed: string[]; failed: string[]; message: string } = {
      closed: [],
      failed: [],
      message: '',
    };

    // Close specific tab
    if (tabId) {
      const success = await sessionManager.closeTarget(sessionId, tabId);
      if (success) {
        results.closed.push(tabId);
      } else {
        results.failed.push(tabId);
      }
    }

    // Close multiple tabs
    if (tabIds && tabIds.length > 0) {
      for (const id of tabIds) {
        const success = await sessionManager.closeTarget(sessionId, id);
        if (success) {
          results.closed.push(id);
        } else {
          results.failed.push(id);
        }
      }
    }

    // Close all tabs in a worker
    if (workerId) {
      const closedCount = await sessionManager.closeWorkerTabs(sessionId, workerId);
      results.message = `Closed ${closedCount} tab(s) in worker "${workerId}"`;
    }

    // Build response message
    let responseMessage = '';
    if (results.closed.length > 0) {
      responseMessage += `Closed ${results.closed.length} tab(s)`;
    }
    if (results.failed.length > 0) {
      responseMessage += `${responseMessage ? '. ' : ''}Failed to close ${results.failed.length} tab(s): ${results.failed.join(', ')}`;
    }
    if (results.message) {
      responseMessage += `${responseMessage ? '. ' : ''}${results.message}`;
    }
    if (!responseMessage) {
      responseMessage = 'No tabs closed';
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: results.failed.length === 0,
              closedCount: results.closed.length,
              closed: results.closed,
              failed: results.failed,
              message: responseMessage,
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
          text: `Error closing tabs: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerTabsCloseTool(server: MCPServer): void {
  server.registerTool('tabs_close', handler, definition);
}
