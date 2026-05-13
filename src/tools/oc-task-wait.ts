/**
 * oc_task_wait — block until a task reaches a terminal state.
 *
 * Uses `fs.watch` plus a bounded poll fallback so the wait is event-
 * driven and does not CPU-spin. Default timeout is 60 s; on expiry the
 * call returns a typed timeout error (`isError: true`, `code:
 * "ETIMEDOUT"`).
 */

import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolContext, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { TaskWaitTimeoutError, waitForTerminal } from '../core/task-ledger';
import { canAccessTask, getTaskStore, taskAccessDeniedResult, waitForTaskStartupReap } from './oc-task-start';

const definition: MCPToolDefinition = {
  name: 'oc_task_wait',
  description:
    'Block until the task reaches a terminal state (COMPLETED / FAILED / ' +
    'CANCELLED) or timeout_ms elapses. Default timeout_ms is 60000.',
  annotations: TOOL_ANNOTATIONS.oc_task_wait,
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'REQUIRED task_id returned by oc_task_start.' },
      timeout_ms: { type: 'number', minimum: 1, maximum: 24 * 60 * 60 * 1000 },
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
    return { isError: true, content: [{ type: 'text', text: 'oc_task_wait: task_id is required' }] };
  }
  const timeoutMs = typeof params.timeout_ms === 'number' ? params.timeout_ms : 60_000;
  try {
    await waitForTaskStartupReap();
    const store = getTaskStore();
    const existing = store.readMetaSync(taskId);
    if (existing && !canAccessTask(existing, sessionId, context?.principal)) return taskAccessDeniedResult(taskId);
    const meta = await waitForTerminal(store, taskId, timeoutMs);
    if (!canAccessTask(meta, sessionId, context?.principal)) return taskAccessDeniedResult(taskId);
    return {
      content: [
        {
          type: 'text',
          text: `task_id=${meta.task_id} status=${meta.status}`,
        },
      ],
      meta,
    };
  } catch (err) {
    if (err instanceof TaskWaitTimeoutError) {
      return {
        isError: true,
        code: err.code,
        content: [{ type: 'text', text: err.message }],
      };
    }
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `oc_task_wait failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
};

export function registerOcTaskWaitTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
