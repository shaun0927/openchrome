import { AsyncLocalStorage } from 'node:async_hooks';
export class ToolAttemptError extends Error {
  constructor(readonly code: 'TOOL_CANCELLED' | 'TOOL_DEADLINE', readonly execution: 'not_started' | 'unknown') {
    super(`${code}: execution=${execution}; inspect current state before retrying`);
    this.name = 'ToolAttemptError';
  }
}

/** Stop admission promptly and notify cooperative handlers. CDP already sent is not rolled back. */
export async function runToolAttempt<T>(
  action: (signal: AbortSignal) => Promise<T>, deadline: number, parent?: AbortSignal,
): Promise<T> {
  if (parent?.aborted) throw new ToolAttemptError('TOOL_CANCELLED', 'not_started');
  if (Date.now() >= deadline) throw new ToolAttemptError('TOOL_DEADLINE', 'not_started');
  const controller = new AbortController();
  let started = false;
  let rejectInterrupted!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  const stop = (code: 'TOOL_CANCELLED' | 'TOOL_DEADLINE'): void => {
    const error = new ToolAttemptError(code, started ? 'unknown' : 'not_started');
    controller.abort(error);
    rejectInterrupted(error);
  };
  const abort = (): void => stop('TOOL_CANCELLED');
  parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('TOOL_DEADLINE'), Math.min(deadline - Date.now(), 2_147_483_647));
  try {
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      started = true;
      return attemptScope.run({ signal: controller.signal, commands: new Set() }, () => action(controller.signal));
    });
    return await Promise.race([work, interrupted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}

const attemptScope = new AsyncLocalStorage<{ signal: AbortSignal; commands: Set<Promise<unknown>> }>();
export const currentAttemptSignal = (): AbortSignal | undefined => attemptScope.getStore()?.signal;
export function assertToolAttemptActive(): void {
  const signal = currentAttemptSignal();
  if (signal?.aborted) throw signal.reason;
}

/** Keep raw CDP promises tracked even if a tool-local timeout abandons its await. */
export function trackAttemptCommand<T>(command: Promise<T>): Promise<T> {
  const state = attemptScope.getStore();
  if (state) {
    state.commands.add(command);
    void command.then(() => state.commands.delete(command), () => state.commands.delete(command));
  }
  return command;
}
export async function drainAttemptCommands(): Promise<void> {
  const state = attemptScope.getStore();
  while (state?.commands.size) await Promise.allSettled([...state.commands]);
}

/** Nested handlers own only the commands they dispatch, not their parent's work. */
export function runWithCommandScope<T>(action: () => T): T {
  const parent = attemptScope.getStore();
  return parent ? attemptScope.run({ signal: parent.signal, commands: new Set() }, action) : action();
}
