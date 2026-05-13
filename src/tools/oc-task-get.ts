/**
 * oc_task_get — fetch a single task's meta.json, optionally including
 * the persisted result payload.
 */

import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolContext, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { canAccessTask, getTaskStore, taskAccessDeniedResult, waitForTaskStartupReap } from './oc-task-start';
import { buildTaskEvidenceDigest } from '../core/task-ledger';

const definition: MCPToolDefinition = {
  name: 'oc_task_get',
  description:
    'Fetch a single task by task_id. By default returns meta only; pass ' +
    'include_result=true to also resolve the persisted result payload.',
  annotations: TOOL_ANNOTATIONS.oc_task_get,
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'REQUIRED task_id returned by oc_task_start.' },
      include_result: {
        type: 'boolean',
        description: 'When true, also returns the persisted result.json contents.',
      },
      includeDigest: {
        type: 'boolean',
        description: 'When true, also returns a deterministic bounded task evidence digest.',
      },
      include_digest: {
        type: 'boolean',
        description: 'Alias for includeDigest.',
      },
    },
    required: ['task_id'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  params: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  const taskId = String(params.task_id ?? '');
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
  const includeDigest = params.includeDigest === true || params.include_digest === true;
  const result = includeResult ? store.readResultSync(taskId) : undefined;
  const digest = includeDigest ? buildTaskEvidenceDigest(store, taskId) : undefined;
  return {
    content: [
      {
        type: 'text',
        text: `task_id=${meta.task_id} status=${meta.status} kind=${meta.kind}`,
      },
    ],
    meta,
    ...(includeResult ? { result } : {}),
    ...(includeDigest ? { digest } : {}),
  };
};

export function registerOcTaskGetTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
