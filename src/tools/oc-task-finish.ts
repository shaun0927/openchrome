/**
 * oc_task_finish — close a host-driven task envelope with a terminal status.
 */

import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolHandler } from '../types/mcp';
import { getTaskStore } from '../core/task-ledger';
import type { TaskStatus } from '../core/task-ledger';

const definition: MCPToolDefinition = {
  name: 'oc_task_finish',
  description: 'Finish a host-driven task envelope as completed, failed, or cancelled.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      taskId: { type: 'string', description: 'Alias for task_id.' },
      outcome: { type: 'string', enum: ['completed', 'failed', 'cancelled'] },
      note: { type: 'string' },
    },
    required: ['outcome'],
  },
};

const handler: ToolHandler = async (_sessionId, params): Promise<MCPResult> => {
  const taskId = taskIdFrom(params);
  if (!taskId) return errorResult('oc_task_finish: task_id is required');
  const status = statusFrom(params.outcome);
  if (!status) return errorResult('oc_task_finish: outcome must be completed, failed, or cancelled');
  const note = typeof params.note === 'string' ? params.note : undefined;
  const store = getTaskStore();
  const meta = store.readMetaSync(taskId);
  if (!meta) return errorResult(`oc_task_finish: unknown task ${taskId}`);
  if (meta.kind !== 'browser_task') return errorResult('oc_task_finish: only host-driven browser_task envelopes can be finished directly');
  const endedAt = Date.now();
  const updated = await store.update(taskId, (cur) => {
    if (cur.status === 'COMPLETED' || cur.status === 'FAILED' || cur.status === 'CANCELLED') return undefined;
    return {
      ...cur,
      status,
      phase: 'done',
      ended_at: endedAt,
      last_activity_at: endedAt,
      ...(note ? { args_summary: { ...cur.args_summary, final_note: note.slice(0, 500) } } : {}),
    };
  });
  if (!updated) return errorResult(`oc_task_finish: task ${taskId} is already terminal`);
  store.appendEvent(taskId, {
    ts: endedAt,
    kind: status === 'COMPLETED' ? 'completed' : status === 'CANCELLED' ? 'cancelled' : 'failed',
    data: { note },
  });
  return {
    content: [{ type: 'text', text: `task_id=${taskId} status=${status}` }],
    meta: updated,
  };
};

function taskIdFrom(params: Record<string, unknown>): string {
  const v = params.task_id ?? params.taskId;
  return typeof v === 'string' ? v : '';
}

function statusFrom(value: unknown): TaskStatus | undefined {
  if (value === 'completed') return 'COMPLETED';
  if (value === 'failed') return 'FAILED';
  if (value === 'cancelled') return 'CANCELLED';
  return undefined;
}

function errorResult(message: string): MCPResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function registerOcTaskFinishTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
