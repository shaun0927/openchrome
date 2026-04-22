/**
 * safeAsyncListener — wraps an async EventEmitter handler so that thrown
 * errors and rejected promises surface via metric + stderr instead of
 * becoming silent unhandled rejections.
 *
 * Issue #5 (A-5): Background async listener errors were being swallowed by
 * puppeteer/EventEmitter, producing zombie targets and silent memory leaks.
 * This wrapper converts every async listener into a synchronous callback
 * whose internal promise is always `.catch()`'d.
 *
 * Usage:
 *   browser.on('targetcreated', safeAsyncListener('targetcreated', async (target) => {
 *     // async work that may throw or reject
 *   }));
 */

import { getMetricsCollector } from '../metrics/collector';

interface ListenerErrorBucket {
  minuteEpoch: number;
  count: number;
}

const LISTENER_ERROR_BUCKETS = 60;
const listenerErrorBuckets: ListenerErrorBucket[] = Array.from({ length: LISTENER_ERROR_BUCKETS }, () => ({
  minuteEpoch: 0,
  count: 0,
}));

function bucketFor(now = Date.now()): ListenerErrorBucket {
  const minuteEpoch = Math.floor(now / 60_000);
  const index = minuteEpoch % LISTENER_ERROR_BUCKETS;
  const bucket = listenerErrorBuckets[index];
  if (bucket.minuteEpoch !== minuteEpoch) {
    bucket.minuteEpoch = minuteEpoch;
    bucket.count = 0;
  }
  return bucket;
}

function recordListenerError(_listener: string): void {
  const bucket = bucketFor(Date.now());
  bucket.count += 1;
}

export function getListenerErrorStats(now = Date.now()): { errorCount1m: number; errorCount1h: number } {
  const currentMinute = Math.floor(now / 60_000);
  let errorCount1m = 0;
  let errorCount1h = 0;
  for (const bucket of listenerErrorBuckets) {
    if (currentMinute - bucket.minuteEpoch >= LISTENER_ERROR_BUCKETS) continue;
    errorCount1h += bucket.count;
    if (bucket.minuteEpoch === currentMinute) {
      errorCount1m += bucket.count;
    }
  }
  return { errorCount1m, errorCount1h };
}

export function resetListenerErrorStatsForTests(): void {
  for (const bucket of listenerErrorBuckets) {
    bucket.minuteEpoch = 0;
    bucket.count = 0;
  }
}

/**
 * Wraps an async listener so its rejections are caught, counted, and logged.
 * The returned function is synchronous (returns `void`), which matches the
 * EventEmitter contract and prevents accidental blocking.
 *
 * @param name short identifier for the listener (shows up as metric label).
 * @param handler the async function to wrap.
 * @param onError optional extra error hook (e.g. for cleanup like evictTarget).
 */
export function safeAsyncListener<A extends unknown[]>(
  name: string,
  handler: (...args: A) => Promise<void>,
  onError?: (err: unknown, args: A) => void,
): (...args: A) => void {
  return (...args: A) => {
    // Using `void` to explicitly discard the Promise — required to keep the
    // EventEmitter callback synchronous.
    void handler(...args).catch((err) => {
      recordListenerError(name);
      try {
        getMetricsCollector().inc('openchrome_listener_errors_total', { listener: name });
      } catch {
        // Metric collector not initialized yet (very early startup) —
        // we must not crash the listener over observability.
      }
      console.error(`[Listener:${name}] swallowed error:`, err);
      if (onError) {
        try {
          onError(err, args);
        } catch (hookErr) {
          console.error(`[Listener:${name}] onError hook failed:`, hookErr);
        }
      }
    });
  };
}

/**
 * Install a process-wide `unhandledRejection` safety net. Any promise
 * rejection that escapes every other handler still gets counted and logged
 * instead of eventually crashing the process (Node 15+ default).
 *
 * The safety net MUST NOT call process.exit() — it is a last-resort
 * observability hook, not a crash handler. Primary handling belongs at
 * the rejecting call site.
 */
export function installUnhandledRejectionSafetyNet(): void {
  process.on('unhandledRejection', (reason) => {
    try {
      getMetricsCollector().inc('openchrome_unhandled_rejections_total');
    } catch {
      // ignore — see above
    }
    console.error('[process] unhandledRejection:', reason);
  });
}
