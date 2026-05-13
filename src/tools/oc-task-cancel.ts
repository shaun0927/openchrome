/**
 * oc_task_cancel — request cooperative cancellation of a RUNNING task.
 *
 * Sets `cancel_requested_at` on the meta row and appends a
 * `cancel_requested` event. The runner's cancel poll picks this up
 * within ~100 ms and aborts the underlying tool's signal. Terminal
 * tasks remain immutable; PENDING tasks transition straight to
 * CANCELLED (no work was ever started).
 */

import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolContext, ToolHandler } from '../types/mcp';
import { canAccessTask, getTaskStore, taskAccessDeniedResult, waitForTaskStartupReap } from './oc-task-start';
import type { TaskStatus } from '../core/task-ledger';

const definition: MCPToolDefinition = {
  name: 'oc_task_cancel',
  description:
    'Request cancellation of a background task. Best-effort: the runner ' +
    'aborts the underlying tool at the next work-unit boundary. Terminal ' +
    'tasks are unaffected. PENDING tasks transition straight to CANCELLED.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'REQUIRED task_id returned by oc_task_start.' },
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
    return { isError: true, content: [{ type: 'text', text: 'oc_task_cancel: task_id is required' }] };
  }
  await waitForTaskStartupReap();
  const store = getTaskStore();
  const existing = store.readMetaSync(taskId);
  if (!existing) {
    return {
      isError: true,
      content: [{ type: 'text', text: `oc_task_cancel: unknown task ${taskId}` }],
    };
  }
  if (!canAccessTask(existing, sessionId, context?.principal)) return taskAccessDeniedResult(taskId);
  const now = Date.now();
  try {
    const next = await store.update(taskId, (cur) => {
      // Terminal: nothing to do.
      if (cur.status === 'COMPLETED' || cur.status === 'FAILED' || cur.status === 'CANCELLED') {
        return undefined;
      }
      if (cur.status === 'PENDING') {
        return {
          ...cur,
          status: 'CANCELLED' as TaskStatus,
          cancel_requested_at: now,
          ended_at: now,
          last_activity_at: now,
        };
      }
      if (cur.kind === 'browser_task') {
        return {
          ...cur,
          status: 'CANCELLED' as TaskStatus,
          phase: 'done',
          cancel_requested_at: now,
          ended_at: now,
          last_activity_at: now,
        };
      }
      // RUNNING — set the cancel flag; the runner finishes the
      // transition once its cooperative poll observes the flag.
      return { ...cur, cancel_requested_at: now };
    });
    if (next) {
      store.appendEvent(taskId, {
        ts: now,
        kind: next.status === 'CANCELLED' ? 'cancelled' : 'cancel_requested',
      });
    }
    const final = store.readMetaSync(taskId) ?? existing;
    return {
      content: [
        {
          type: 'text',
          text: `task_id=${final.task_id} status=${final.status}`,
        },
      ],
      meta: final,
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `oc_task_cancel failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
};

export function registerOcTaskCancelTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}

export const __test__ = { definition, handler };
