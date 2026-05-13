/**
 * oc_task_update — update host-declared task envelope fields without executing browser actions.
 */

import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolHandler } from '../types/mcp';
import { getTaskStore, normalizeTaskPhase } from '../core/task-ledger';
import { canAccessTask, taskAccessDeniedResult } from './oc-task-start';

const definition: MCPToolDefinition = {
  name: 'oc_task_update',
  description: 'Update a task envelope phase or note. Does not execute browser actions.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      taskId: { type: 'string', description: 'Alias for task_id.' },
      phase: {
        type: 'string',
        enum: ['explore', 'act', 'verify', 'recover', 'done'],
      },
      note: { type: 'string' },
    },
    required: [],
  },
};

const handler: ToolHandler = async (sessionId, params, context): Promise<MCPResult> => {
  const taskId = taskIdFrom(params);
  if (!taskId) return errorResult('oc_task_update: task_id is required');
  const phase = params.phase !== undefined ? normalizeTaskPhase(params.phase) : undefined;
  const note = typeof params.note === 'string' ? params.note : undefined;
  const store = getTaskStore();
  const meta = store.readMetaSync(taskId);
  if (!meta) return errorResult(`oc_task_update: unknown task ${taskId}`);
  if (!canAccessTask(meta, sessionId, context?.principal)) return taskAccessDeniedResult(taskId);
  if (meta.kind !== 'browser_task') return errorResult('oc_task_update: only host-driven browser_task envelopes can be updated');
  const updated = await store.update(taskId, (cur) => {
    if (cur.status === 'COMPLETED' || cur.status === 'FAILED' || cur.status === 'CANCELLED') return undefined;
    return {
      ...cur,
      ...(phase ? { phase } : {}),
      ...(note ? { args_summary: { ...cur.args_summary, last_note: note.slice(0, 500) } } : {}),
      last_activity_at: Date.now(),
    };
  });
  if (!updated) return errorResult(`oc_task_update: task ${taskId} is terminal and cannot be updated`);
  store.appendEvent(taskId, { ts: Date.now(), kind: 'log', data: { phase, note } });
  return {
    content: [{ type: 'text', text: `task_id=${taskId} phase=${updated.phase ?? 'explore'} status=${updated.status}` }],
    meta: updated,
  };
};

function taskIdFrom(params: Record<string, unknown>): string {
  const v = params.task_id ?? params.taskId;
  return typeof v === 'string' ? v : '';
}

function errorResult(message: string): MCPResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function registerOcTaskUpdateTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}

export const __test__ = { definition, handler };
