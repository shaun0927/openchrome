/**
 * Worker Tool - Consolidated worker management (create, list, delete)
 *
 * Replaces: worker_create, worker_list, worker_delete
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'worker',
  description:
    'Manage workers. Actions: "create" (isolated context), "list" (show all), "delete" (remove and close tabs).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'delete'],
        description: 'Action: create, list, or delete',
      },
      name: {
        type: 'string',
        description: '(create) Worker name, e.g. "login-worker"',
      },
      id: {
        type: 'string',
        description: '(create) Custom ID. Auto-generated if omitted',
      },
      workerId: {
        type: 'string',
        description: '(delete) Worker ID to delete',
      },
    },
    required: ['action'],
  },
};

// ---------------------------------------------------------------------------
// Handlers per action
// ---------------------------------------------------------------------------

async function handleCreate(
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> {
  const sessionManager = getSessionManager();
  const name = args.name as string | undefined;
  const id = args.id as string | undefined;

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
}

async function handleList(
  sessionId: string
): Promise<MCPResult> {
  const sessionManager = getSessionManager();

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
}

async function handleDelete(
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> {
  const sessionManager = getSessionManager();
  const workerId = args.workerId as string;

  if (!workerId) {
    return {
      content: [{ type: 'text', text: 'Error: workerId is required for delete action' }],
      isError: true,
    };
  }

  const worker = sessionManager.getWorker(sessionId, workerId);
  if (!worker) {
    return {
      content: [{ type: 'text', text: `Error: Worker ${workerId} not found` }],
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
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const action = args.action as string;

  try {
    switch (action) {
      case 'create':
        return await handleCreate(sessionId, args);
      case 'list':
        return await handleList(sessionId);
      case 'delete':
        return await handleDelete(sessionId, args);
      default:
        return {
          content: [{ type: 'text', text: `Error: Unknown action "${action}". Use "create", "list", or "delete".` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error in worker ${action}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerWorkerTool(server: MCPServer): void {
  server.registerTool('worker', handler, definition);
}
