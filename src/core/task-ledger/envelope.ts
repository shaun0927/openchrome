import type { TaskStore } from './store';
import type { RecordedToolCall } from './types';
import { applyToolCallToTask } from './budget';

export function extractTaskId(args: Record<string, unknown>): string | undefined {
  const taskId = args.taskId ?? args.task_id;
  return typeof taskId === 'string' && /^[0-9a-f]{16}$/.test(taskId) ? taskId : undefined;
}

export async function recordTaskToolCall(
  store: TaskStore,
  taskId: string | undefined,
  call: RecordedToolCall,
): Promise<void> {
  if (!taskId) return;
  const meta = store.readMetaSync(taskId);
  if (!meta) return;
  if (meta.status === 'COMPLETED' || meta.status === 'FAILED' || meta.status === 'CANCELLED') return;
  try {
    await store.update(taskId, (cur) => applyToolCallToTask(cur, call));
    store.appendEvent(taskId, {
      ts: call.ts,
      kind: 'tool_call',
      data: {
        tool: call.tool,
        ok: call.ok,
        durationMs: call.durationMs,
        sessionId: call.sessionId,
      },
    });
  } catch (err) {
    console.error(`[task-envelope] failed to record tool call for ${taskId}:`, err);
  }
}
