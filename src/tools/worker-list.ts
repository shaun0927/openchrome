/**
 * Worker List Tool - List all workers in the current session
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'worker_list',
  description: 'Lists all workers in the current session. Shows worker IDs, names, tab counts, and activity timestamps.',
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
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ workers: [], message: 'No session found' }, null, 2),
          },
        ],
      };
    }

    const workers = sessionManager.getWorkers(sessionId);
    const defaultWorkerId = session.defaultWorkerId;

    const workerDetails = workers.map((w) => ({
      ...w,
      isDefault: w.id === defaultWorkerId,
      tabs: sessionManager.getWorkerTargetIds(sessionId, w.id),
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              sessionId,
              workerCount: workers.length,
              defaultWorkerId,
              workers: workerDetails,
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
          text: `Error listing workers: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerWorkerListTool(server: MCPServer): void {
  server.registerTool('worker_list', handler, definition);
}
