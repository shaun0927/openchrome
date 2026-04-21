import { OpenChromeTimeoutError } from '../errors/timeout';
import { ToolContext, getRemainingBudget } from '../types/mcp';

/**
 * Race a promise against a timeout. Rejects with an OpenChromeTimeoutError if the timeout fires first.
 *
 * When a `ToolContext` is provided:
 *  - the effective timeout is capped to the remaining budget (prevents
 *    cumulative timeout stacking when individual ops carry their own 15s
 *    timeout but only 3s of overall tool budget remains).
 *  - if `context.signal` is wired (B-2 / issue #8) and aborts during the
 *    race, the returned promise rejects with the signal's reason — caller
 *    returns immediately so HTTP transport, audit logs, etc. are not
 *    blocked by an orphaned background CDP call.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'Operation', context?: ToolContext): Promise<T> {
  const effectiveMs = context
    ? Math.min(ms, getRemainingBudget(context))
    : ms;

  if (effectiveMs <= 0) {
    return Promise.reject(new OpenChromeTimeoutError(label, 0, false, true));
  }

  const signal = context?.signal;
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('Aborted'));
  }

  const isDeadlineCapped = context !== undefined && effectiveMs < ms;

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OpenChromeTimeoutError(label, effectiveMs, false, isDeadlineCapped)),
      effectiveMs,
    );
  });

  const racers: Promise<T>[] = [promise, timeout];
  let removeAbortListener: (() => void) | undefined;
  if (signal) {
    racers.push(new Promise<never>((_, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error('Aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }));
  }

  return Promise.race(racers).finally(() => {
    clearTimeout(timer);
    removeAbortListener?.();
  });
}
