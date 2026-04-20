import { ToolContext } from '../types/mcp';

/**
 * Race a CDP / Puppeteer promise against the ToolContext's AbortSignal.
 *
 * Puppeteer only accepts an explicit `signal` parameter on a few APIs (e.g. `page.goto`).
 * For everything else (`Runtime.evaluate`, `page.click`, `page.type`, etc.) the underlying
 * call cannot truly be cancelled — but we can let the *caller* return immediately when the
 * signal fires so HTTP request handlers, timers, and audit logs proceed without waiting
 * for an orphaned background promise.
 *
 * Behaviour:
 *  - No context or no signal → returns the original promise unchanged (zero overhead).
 *  - Signal already aborted → rejects synchronously with the abort reason.
 *  - Signal aborts during execution → rejects with the abort reason; background promise
 *    is intentionally left to settle on its own (the resource cleanup belongs to the
 *    forceful tier in `transports/http.ts`, see B-2 issue §3-4).
 */
export function cdpRace<T>(promise: Promise<T>, context?: ToolContext): Promise<T> {
  const signal = context?.signal;
  if (!signal) return promise;

  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error('Aborted'));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
