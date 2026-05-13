/**
 * Trace recorder — subscribes to the lifecycle bus and persists events to
 * the JSONL-backed `TraceStorage` (issue #857, subsumes the PR-2 follow-up
 * called out in `src/core/trace/storage.ts:1-29`).
 *
 * Behaviour:
 *   - Listens on `'*'` so every lifecycle event flows through one queue
 *     ordered by `ts`. We do NOT reorder; events are appended in the order
 *     they were observed.
 *   - Buffers up to `flushIntervalMs` (default 500 ms) or up to
 *     `maxBatchSize` (default 256 events) before calling
 *     `TraceStorage.appendEvents`. The smaller of the two wins.
 *   - One in-flight `appendEvents` at a time. Late events queue behind the
 *     current flush so the on-disk JSONL ordering matches observation order.
 *   - Shutdown via the same `chrome:exit` event the watchdog observes, or
 *     an explicit `stop()` call. Either path flushes the remaining buffer
 *     and detaches the bus subscription. The flush is fire-and-forget on the
 *     exit path so the launcher's exit handler does not block on disk I/O.
 *   - Each `appendEvents` call is wrapped in a try/catch; a storage error
 *     is logged via `console.error` and the events are dropped (the bus
 *     contract is fire-and-forget — we never throw back into emit()).
 *
 * The recorder is not auto-started. Callers wire it via `startTraceRecorder`
 * after constructing a `TraceStorage` and choosing a session id. The MCP
 * server entry point (`src/index.ts`) is the canonical wire-up site.
 */

import { getLifecycleBus, isLifecycleBusEnabled } from '../lifecycle';
import type { LifecycleEvent, Unsubscribe } from '../lifecycle';
import { redactTraceEvent } from './redactor';
import type { TraceStorage } from './storage';
import type { TraceEvent } from './types';

export interface TraceRecorderOptions {
  /** Where to persist events. */
  storage: TraceStorage;
  /** Session id under which events are recorded. */
  sessionId: string;
  /** Flush cadence in milliseconds. Default: 500. */
  flushIntervalMs?: number;
  /** Maximum events buffered before forcing an early flush. Default: 256. */
  maxBatchSize?: number;
  /** Bus to subscribe on. Defaults to the process-wide singleton. */
  bus?: ReturnType<typeof getLifecycleBus>;
}

const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_MAX_BATCH_SIZE = 256;

export class TraceRecorder {
  private readonly storage: TraceStorage;
  private readonly sessionId: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly bus: ReturnType<typeof getLifecycleBus>;

  private buffer: TraceEvent[] = [];
  private seq = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  /** Bus subscription handle. Cleared on `stop()` to drop the strong ref. */
  private unsubscribe: Unsubscribe | null = null;
  /** Process-exit listeners we attach so a crashing host still flushes once. */
  private readonly exitListener = () => {
    // Best-effort sync flush. Promise rejections are swallowed; we cannot
    // hold up process teardown on disk I/O.
    void this.flush().catch(() => {
      /* swallow — process is exiting */
    });
  };

  constructor(opts: TraceRecorderOptions) {
    this.storage = opts.storage;
    this.sessionId = opts.sessionId;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.bus = opts.bus ?? getLifecycleBus();
  }

  /**
   * Subscribe to the bus and start the flush timer. No-op when the bus
   * off-switch is engaged (`OPENCHROME_LIFECYCLE_BUS=0`) — the recorder
   * stays inert in that mode so the off-switch path is identical to
   * v1.11.0 behavior.
   */
  start(): void {
    if (this.stopped) return;
    if (this.unsubscribe) return; // already started
    if (!isLifecycleBusEnabled()) return;
    // Use a NAMED function so the metrics label is stable: when this
    // listener throws, the counter is incremented with
    // `listener="traceRecorder"`. The integration test relies on that name.
    const traceRecorder = (ev: LifecycleEvent): void => {
      this.enqueue(ev);
    };
    this.unsubscribe = this.bus.on('*', traceRecorder);
    this.armFlushTimer();
    // Make a best-effort attempt to flush on process exit so a SIGTERM
    // doesn't lose the last batch. We don't attempt async work here.
    process.once('beforeExit', this.exitListener);
  }

  /**
   * Detach from the bus, flush any buffered events, and clear the timer.
   * Safe to call multiple times. Returns the in-flight flush promise so
   * tests can await complete drain.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      // Still surface any in-flight flush so callers can deterministically
      // await drain.
      if (this.inFlight) await this.inFlight.catch(() => undefined);
      return;
    }
    this.stopped = true;
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {
        /* idempotent */
      }
      this.unsubscribe = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      process.removeListener('beforeExit', this.exitListener);
    } catch {
      /* listener may already be gone */
    }
    await this.flush();
  }

  /** Force a flush regardless of the timer or buffer fill level. */
  async flush(): Promise<void> {
    // Chain on any in-flight flush so order is preserved across rapid
    // back-to-back calls (e.g. timer fires while stop() is awaiting flush).
    const previous = this.inFlight ?? Promise.resolve();
    const next = previous.then(() => this.flushOnce());
    this.inFlight = next.finally(() => {
      if (this.inFlight === next) this.inFlight = null;
    });
    await this.inFlight;
  }

  /** Number of events currently buffered. Exposed for tests. */
  bufferedCount(): number {
    return this.buffer.length;
  }

  private enqueue(ev: LifecycleEvent): void {
    if (this.stopped) return;
    const traceEvent: TraceEvent = redactTraceEvent({
      ts: ev.ts,
      seq: ++this.seq,
      kind: ev.kind,
      body: ev,
    });
    this.buffer.push(traceEvent);
    if (this.buffer.length >= this.maxBatchSize) {
      // Don't await — bus listeners must return promptly. Failures are
      // logged inside flushOnce().
      void this.flush().catch(() => undefined);
    }
  }

  private armFlushTimer(): void {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush()
        .catch(() => undefined)
        .finally(() => {
          if (!this.stopped) this.armFlushTimer();
        });
    }, this.flushIntervalMs);
    // Don't keep the event loop alive solely for the recorder timer.
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  private async flushOnce(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.storage.appendEvents(this.sessionId, batch);
    } catch (err) {
      // Storage failures are isolated: log and move on. The bus contract
      // forbids re-throwing into emit(); the recorder mirrors that
      // contract toward its own callers (flush() is best-effort).
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[trace-recorder] appendEvents failed (sessionId=${this.sessionId}): ${msg}\n`,
      );
    }
  }
}

/**
 * Convenience wrapper that constructs, starts, and returns a recorder. The
 * MCP server bootstrap should call this once per process when the trace
 * family is enabled.
 */
export function startTraceRecorder(opts: TraceRecorderOptions): TraceRecorder {
  const recorder = new TraceRecorder(opts);
  recorder.start();
  return recorder;
}
