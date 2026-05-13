/**
 * Task runner — drives a launched task through its state machine.
 *
 * The runner is deterministic (P4): it does no retries, no heuristics,
 * no LLM consultation. It accepts an inner async function ("the
 * underlying tool"), updates meta.json at the four transition points
 * (PENDING -> RUNNING, terminal completion / failure / cancellation),
 * appends advisory events, and persists the tool's result blob on
 * success.
 *
 * Cancellation is cooperative: the runner exposes an `AbortSignal` to
 * the underlying tool and flips `cancel_requested_at` in meta.json when
 * `oc_task_cancel` is called. Tools that participate honour the signal
 * between work units; tools that don't will still terminate when their
 * own clock runs out, at which point the runner records CANCELLED
 * (preferred — `cancel_requested_at` was set first) rather than FAILED.
 */

import type { TaskStore } from './store';
import type { TaskEvent, TaskMeta, TaskStatus } from './types';

export interface RunInput {
  taskId: string;
  /** Process pid that will own this task (typically `process.pid`). */
  pid: number;
  /** Underlying tool invocation. Must respect `signal` for cooperative cancel. */
  invoke: (signal: AbortSignal) => Promise<unknown>;
}

export interface RunOutcome {
  status: Exclude<TaskStatus, 'PENDING' | 'RUNNING'>;
  result?: unknown;
  error?: { message: string; code?: string };
}

/**
 * Drive a single task through its state machine. The caller is
 * responsible for having already created the PENDING meta row via
 * `TaskStore.create()` and for spawning this function in the
 * background (e.g. via `void runTask(...)`).
 */
export async function runTask(store: TaskStore, input: RunInput): Promise<RunOutcome> {
  const { taskId, pid, invoke } = input;
  const startTs = Date.now();

  // Transition PENDING -> RUNNING under the per-task lock. If the row
  // has been moved out of PENDING already (concurrent cancel before we
  // started executing) we honour that and skip invocation.
  const runningMeta = await store.update(taskId, (cur) => {
    if (cur.status !== 'PENDING') return undefined;
    return { ...cur, status: 'RUNNING' as TaskStatus, started_at: startTs, pid };
  });
  if (!runningMeta) {
    // Already cancelled or terminal. Re-read once for the caller.
    const finalMeta = store.readMetaSync(taskId);
    if (finalMeta?.status === 'CANCELLED') {
      return { status: 'CANCELLED' };
    }
    return { status: 'FAILED', error: { message: 'task not in PENDING state at runner start' } };
  }
  appendEventSafe(store, taskId, { ts: startTs, kind: 'started' });

  // Wire an AbortController whose signal is forwarded to the underlying
  // tool. A lightweight poll watches meta.json for `cancel_requested_at`
  // so external `oc_task_cancel` calls flip the signal. We poll at
  // 100ms — coarse enough to be cheap, fine enough to satisfy the
  // "<=1 work unit" cancellation latency requirement for typical crawl
  // pages that complete in 500ms+.
  const ac = new AbortController();
  let cancelDetectedAt: number | undefined;
  const cancelPoll = setInterval(() => {
    try {
      const cur = store.readMetaSync(taskId);
      if (cur?.cancel_requested_at && !ac.signal.aborted) {
        cancelDetectedAt = cur.cancel_requested_at;
        ac.abort();
      }
    } catch {
      // best-effort
    }
  }, 100);
  // Don't keep the event loop alive solely for the cancel poll.
  if (typeof cancelPoll.unref === 'function') cancelPoll.unref();

  let outcome: RunOutcome;
  try {
    const result = await invoke(ac.signal);
    const afterInvokeMeta = store.readMetaSync(taskId);
    if (afterInvokeMeta?.cancel_requested_at && cancelDetectedAt === undefined) {
      cancelDetectedAt = afterInvokeMeta.cancel_requested_at;
      if (!ac.signal.aborted) ac.abort();
    }
    // If cancellation was requested but the tool returned normally,
    // honour the cancel — the tool may have aborted mid-stride and
    // returned partial state, which is the contracted behaviour.
    if (cancelDetectedAt !== undefined) {
      await store.writeResult(taskId, result);
      outcome = { status: 'CANCELLED', result };
    } else if (isMcpErrorResult(result)) {
      await store.writeResult(taskId, result);
      outcome = { status: 'FAILED', result, error: { message: extractMcpErrorMessage(result) } };
    } else {
      await store.writeResult(taskId, result);
      outcome = { status: 'COMPLETED', result };
    }
  } catch (err) {
    if (cancelDetectedAt !== undefined || ac.signal.aborted) {
      outcome = { status: 'CANCELLED', error: errorToShape(err) };
    } else {
      outcome = { status: 'FAILED', error: errorToShape(err) };
    }
  } finally {
    clearInterval(cancelPoll);
  }

  const endTs = Date.now();
  await store.update(taskId, (cur) => {
    // Terminal states are immutable; another reaper may have already
    // marked us FAILED with `orphaned` — respect that and don't
    // overwrite history.
    if (cur.status === 'COMPLETED' || cur.status === 'FAILED' || cur.status === 'CANCELLED') {
      return undefined;
    }
    return {
      ...cur,
      status: outcome.status,
      ended_at: endTs,
      result_path: outcome.status === 'COMPLETED' ? store.resultPath(taskId) : cur.result_path,
      error: outcome.error,
    };
  });

  const finalEvent: TaskEvent['kind'] =
    outcome.status === 'COMPLETED'
      ? 'completed'
      : outcome.status === 'CANCELLED'
        ? 'cancelled'
        : 'failed';
  appendEventSafe(store, taskId, {
    ts: endTs,
    kind: finalEvent,
    data: outcome.error ? { error: outcome.error } : undefined,
  });
  return outcome;
}

function appendEventSafe(store: TaskStore, taskId: string, event: TaskEvent): void {
  try {
    store.appendEvent(taskId, event);
  } catch (err) {
    // Events are advisory — never let a logging failure derail the
    // state-machine transition. Stick to stderr so MCP stdout stays
    // JSON-RPC clean.
    console.error(`[task-ledger] appendEvent failed for ${taskId}:`, err);
  }
}

function errorToShape(err: unknown): { message: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? { message: err.message, code } : { message: err.message };
  }
  return { message: String(err) };
}

/**
 * Wait for a task to reach a terminal state. Uses `fs.watch` on the
 * meta.json file with a bounded poll fallback so the watcher works on
 * platforms (macOS in some configurations, network mounts) where
 * watch events drop silently.
 *
 * `timeoutMs` defaults to 60_000. On timeout we throw a TimeoutError
 * with `code = 'ETIMEDOUT'` to satisfy the contract requirement that
 * `oc_task_wait` returns a typed error rather than blocking forever.
 */
export class TaskWaitTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(taskId: string, timeoutMs: number) {
    super(`task_wait: task ${taskId} did not terminate within ${timeoutMs}ms`);
    this.name = 'TaskWaitTimeoutError';
  }
}

const TERMINAL = new Set<TaskStatus>(['COMPLETED', 'FAILED', 'CANCELLED']);

export async function waitForTerminal(
  store: TaskStore,
  taskId: string,
  timeoutMs = 60_000,
): Promise<TaskMeta> {
  // Fast path: already terminal.
  const initial = store.readMetaSync(taskId);
  if (!initial) {
    throw new Error(`task_wait: unknown task ${taskId}`);
  }
  if (TERMINAL.has(initial.status)) return initial;

  const fs = await import('node:fs');
  const metaPath = store.metaPath(taskId);

  return await new Promise<TaskMeta>((resolve, reject) => {
    let settled = false;
    let watcher: ReturnType<typeof fs.watch> | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // best-effort
        }
        watcher = undefined;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
    };

    const check = () => {
      if (settled) return;
      const cur = store.readMetaSync(taskId);
      if (cur && TERMINAL.has(cur.status)) {
        settled = true;
        cleanup();
        resolve(cur);
      }
    };

    try {
      watcher = fs.watch(metaPath, { persistent: false }, () => {
        check();
      });
      // Some platforms emit 'error' instead of throwing synchronously.
      watcher.on('error', () => {
        // Swallow — the poll fallback covers us.
      });
    } catch {
      // No watcher — rely entirely on the poll fallback below.
    }

    // Bounded poll: 250 ms is fast enough to satisfy the "<200 ms after
    // terminal transition" acceptance criterion in the common case
    // where fs.watch also fires (watcher + poll race resolves first).
    pollTimer = setInterval(check, 250);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new TaskWaitTimeoutError(taskId, timeoutMs));
    }, timeoutMs);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();

    // Immediate re-check in case the terminal transition happened
    // between the fast-path read above and the watcher attaching.
    check();
  });
}


function isMcpErrorResult(value: unknown): value is { isError: true; content?: Array<{ text?: string }> } {
  return Boolean(value && typeof value === 'object' && (value as { isError?: unknown }).isError === true);
}

function extractMcpErrorMessage(result: { content?: Array<{ text?: string }> }): string {
  const text = result.content?.find((item) => typeof item.text === 'string')?.text;
  return text && text.length > 0 ? text : 'MCP tool returned isError=true';
}
