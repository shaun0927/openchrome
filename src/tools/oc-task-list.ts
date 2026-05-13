/**
 * oc_task_list — enumerate tasks in the ledger.
 *
 * Defaults: limit=50, sort by created_at descending. Filters: status,
 * kind, since. Returns meta.json rows only — never the result payload.
 */

import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolContext, ToolHandler } from '../types/mcp';
import type { TaskKind, TaskListFilter, TaskStatus } from '../core/task-ledger';
import { canAccessTask, getTaskStore, waitForTaskStartupReap } from './oc-task-start';

const VALID_STATUS: ReadonlyArray<TaskStatus> = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

const definition: MCPToolDefinition = {
  name: 'oc_task_list',
  description:
    'List background tasks in the ledger. Default limit=50, sorted by ' +
    'created_at descending. Supports status/kind/since/limit filters.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        oneOf: [
          { type: 'string', enum: VALID_STATUS as unknown as string[] },
          { type: 'array', items: { type: 'string', enum: VALID_STATUS as unknown as string[] } },
        ],
      },
      kind: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
      since: { type: 'number', description: 'Only tasks created at or after this ms epoch.' },
      limit: { type: 'number', minimum: 1, maximum: 1000 },
    },
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  params: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  const filter: TaskListFilter = {};
  if (params.status !== undefined) {
    filter.status = params.status as TaskStatus | TaskStatus[];
  }
  if (params.kind !== undefined) {
    filter.kind = params.kind as TaskKind | TaskKind[];
  }
  if (typeof params.since === 'number') filter.since = params.since;
  if (typeof params.limit === 'number') filter.limit = params.limit;

  await waitForTaskStartupReap();
  const rows = (await getTaskStore().list(filter)).filter((row) => canAccessTask(row, sessionId, context?.principal));
  const summary = rows
    .map((r) => `${r.task_id}\t${r.status}\t${r.kind}\t${new Date(r.created_at).toISOString()}`)
    .join('\n');
  return {
    content: [
      {
        type: 'text',
        text: rows.length === 0 ? '(no tasks)' : summary,
      },
    ],
    tasks: rows,
    count: rows.length,
  };
};

export function registerOcTaskListTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
