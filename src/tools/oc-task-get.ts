/**
 * oc_task_get — fetch a single task's meta.json, optionally including
 * the persisted result payload.
 */

import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolHandler } from '../types/mcp';
import { getTaskStore } from './oc-task-start';

const definition: MCPToolDefinition = {
  name: 'oc_task_get',
  description:
    'Fetch a single task by task_id. By default returns meta only; pass ' +
    'include_result=true to also resolve the persisted result payload.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      include_result: {
        type: 'boolean',
        description: 'When true, also returns the persisted result.json contents.',
      },
    },
    required: ['task_id'],
  },
};

const handler: ToolHandler = async (
  _sessionId: string,
  params: Record<string, unknown>,
): Promise<MCPResult> => {
  const taskId = String(params.task_id ?? '');
  if (!taskId) {
    return { isError: true, content: [{ type: 'text', text: 'oc_task_get: task_id is required' }] };
  }
  const store = getTaskStore();
  const meta = store.readMetaSync(taskId);
  if (!meta) {
    return {
      isError: true,
      content: [{ type: 'text', text: `oc_task_get: unknown task ${taskId}` }],
    };
  }
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
    ...(includeResult ? { result } : {}),
  };
};

export function registerOcTaskGetTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
