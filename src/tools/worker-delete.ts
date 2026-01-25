/**
 * Worker Delete Tool - Delete a worker and close all its tabs
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'worker_delete',
  description: 'Deletes a worker and closes all its tabs. Cannot delete the default worker.',
  inputSchema: {
    type: 'object',
    properties: {
      workerId: {
        type: 'string',
        description: 'The ID of the worker to delete',
      },
    },
    required: ['workerId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const sessionManager = getSessionManager();
  const workerId = args.workerId as string;

  if (!workerId) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: workerId is required',
        },
      ],
      isError: true,
    };
  }

  try {
    const worker = sessionManager.getWorker(sessionId, workerId);
    if (!worker) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Worker ${workerId} not found`,
          },
        ],
        isError: true,
      };
    }

    const tabCount = worker.targets.size;
    await sessionManager.deleteWorker(sessionId, workerId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              deleted: true,
              workerId,
              closedTabs: tabCount,
              message: `Worker "${workerId}" deleted with ${tabCount} tab(s) closed`,
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
          text: `Error deleting worker: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerWorkerDeleteTool(server: MCPServer): void {
  server.registerTool('worker_delete', handler, definition);
}
