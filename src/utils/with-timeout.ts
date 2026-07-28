import { OpenChromeTimeoutError } from '../errors/timeout';
import { ToolContext, getRemainingBudget } from '../types/mcp';

export const MAX_TIMEOUT_RESPONSE_GRACE_MS = 250;

export function getTimeoutResponseGraceMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 1) return 0;
  return Math.min(
    MAX_TIMEOUT_RESPONSE_GRACE_MS,
    Math.max(1, Math.ceil(ms * 0.2)),
  );
}

/** Host-side wait budget that lets a bounded inner operation report its timeout. */
export function addTimeoutResponseGraceMs(ms: number): number {
  return ms + getTimeoutResponseGraceMs(ms);
}

/** Inner operation budget when the outer deadline leaves no separate response grace. */
export function reserveTimeoutResponseGraceMs(outerMs: number): number {
  if (!Number.isFinite(outerMs) || outerMs <= 0) return 0;
  if (outerMs <= 1) return 1;
  return Math.max(1, Math.floor(outerMs - getTimeoutResponseGraceMs(outerMs)));
}

export function getEffectiveTimeoutMs(ms: number, context?: ToolContext): number {
  return context
    ? Math.min(ms, getRemainingBudget(context))
    : ms;
}

/** One absolute deadline shared by every phase of a bounded operation. */
export function getTimeoutDeadlineAt(ms: number, context?: ToolContext): number {
  const operationDeadlineAt = Date.now() + ms;
  return context
    ? Math.min(operationDeadlineAt, context.startTime + context.deadlineMs)
    : operationDeadlineAt;
}

export function getRemainingTimeoutMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

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
  const effectiveMs = getEffectiveTimeoutMs(ms, context);

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
