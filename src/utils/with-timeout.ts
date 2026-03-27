import { OpenChromeTimeoutError } from '../errors/timeout';
import { ToolContext, getRemainingBudget } from '../types/mcp';

/**
 * Race a promise against a timeout. Rejects with an OpenChromeTimeoutError if the timeout fires first.
 *
 * When a `ToolContext` is provided, the effective timeout is capped to the remaining budget.
 * This prevents individual CDP operations from being started with a 15s timeout when only
 * 3s of overall tool budget remains, eliminating cumulative timeout stacking.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'Operation', context?: ToolContext): Promise<T> {
  const effectiveMs = context
    ? Math.min(ms, getRemainingBudget(context))
    : ms;

  if (effectiveMs <= 0) {
    return Promise.reject(new OpenChromeTimeoutError(label, 0, false, true));
  }

  const isDeadlineCapped = context !== undefined && effectiveMs < ms;

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OpenChromeTimeoutError(label, effectiveMs, false, isDeadlineCapped)),
      effectiveMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
