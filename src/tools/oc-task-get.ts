/**
 * oc_task_get — fetch a single task's meta.json, optionally including
 * the persisted result payload.
 */

import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolContext, ToolHandler } from '../types/mcp';
import { canAccessTask, getTaskStore, taskAccessDeniedResult, waitForTaskStartupReap } from './oc-task-start';

const definition: MCPToolDefinition = {
  name: 'oc_task_get',
  description:
    'Fetch a single task by task_id. By default returns meta only; pass ' +
    'include_result=true to also resolve the persisted result payload.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      taskId: { type: 'string', description: 'Alias for task_id.' },
      include_result: {
        type: 'boolean',
        description: 'When true, also returns the persisted result.json contents.',
      },
      includeDigest: {
        type: 'boolean',
        description: 'Reserved for #1036; currently returns the same task envelope summary fields.',
      },
    },
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  params: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  const taskId = String(params.task_id ?? params.taskId ?? '');
  if (!taskId) {
    return { isError: true, content: [{ type: 'text', text: 'oc_task_get: task_id is required' }] };
  }
  await waitForTaskStartupReap();
  const store = getTaskStore();
  const meta = store.readMetaSync(taskId);
  if (!meta) {
    return {
      isError: true,
      content: [{ type: 'text', text: `oc_task_get: unknown task ${taskId}` }],
    };
  }
  if (!canAccessTask(meta, sessionId, context?.principal)) return taskAccessDeniedResult(taskId);
  const includeResult = params.include_result === true;
  const result = includeResult ? store.readResultSync(taskId) : undefined;
  return {
    content: [
      {
        type: 'text',
        text: `task_id=${meta.task_id} status=${meta.status} kind=${meta.kind}`,
      },
    ],
    meta,
    counters: meta.counters,
    budget_status: meta.budget_status,
    budget_exceeded: meta.budget_exceeded,
    recommended_next: meta.recommended_next,
    recent_events: meta.recent_events ?? [],
    phase: meta.phase,
    objective: meta.objective,
    ...(includeResult ? { result } : {}),
  };
};

export function registerOcTaskGetTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}

export const __test__ = { definition, handler };
