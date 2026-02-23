/**
 * Worker Create Tool - Create a new isolated worker within a session
 * Each worker has its own browser context (cookies, localStorage, sessionStorage)
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'worker_create',
  description: 'Creates a new isolated worker within the session. Each worker has its own browser context with separate cookies, localStorage, and sessionStorage. Use workers for parallel browser operations that should not share state.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Optional name for the worker (e.g., "login-worker", "search-worker")',
      },
      id: {
        type: 'string',
        description: 'Optional custom ID for the worker. Auto-generated if not provided.',
      },
    },
    required: [],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const sessionManager = getSessionManager();
  const name = args.name as string | undefined;
  const id = args.id as string | undefined;

  try {
    const worker = await sessionManager.createWorker(sessionId, { name, id });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              workerId: worker.id,
              name: worker.name,
              message: `Worker "${worker.name}" created with isolated browser context. Use workerId "${worker.id}" with other tools to operate in this worker.`,
              createdAt: worker.createdAt,
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
          text: `Error creating worker: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerWorkerCreateTool(server: MCPServer): void {
  server.registerTool('worker_create', handler, definition);
}
