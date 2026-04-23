/**
 * Event Loop Monitor — detects Node.js event loop blocking.
 * Uses timer drift detection (lightweight, ~0.5% CPU overhead).
 * Part of #347 Layer 4: Application Watchdog.
 *
 * Idle-adaptive (issue #649 Part A): when the server is idle, the sampling
 * cadence relaxes from 200 ms to 2 s (10× reduction). The tick reads
 * `idleState.isIdle(IDLE_WINDOW_MS)` and picks the next delay locally via a
 * `setTimeout` chain, so a truly idle instance does one-tenth the work.
 */

import { EventEmitter } from 'events';
import { DEFAULT_EVENT_LOOP_HEAVY_OP_FATAL_MS } from '../config/defaults';
import { getIdleState, IDLE_WINDOW_MS, IdleState } from '../utils/idle-state';

/** Idle rate caps at 10× active rate per issue #649 §3.1 / acceptance criterion 4. */
const IDLE_RATE_MS = 2_000;

export interface EventLoopMonitorOptions {
  /** Check interval in ms. Default: 200 */
  checkIntervalMs?: number;
  /** Warn threshold in ms. Default: 2000 (2s) */
  warnThresholdMs?: number;
  /**
   * Fatal threshold in ms. Default: 0 (disabled).
   * Emits 'fatal' event when threshold exceeded.
   * Callers MUST attach a 'fatal' listener to handle recovery (e.g., process.exit(1)).
   * No automatic process termination — this is intentional for testability.
   */
  fatalThresholdMs?: number;
  /**
   * Fatal threshold in ms during heavy tool operations (screenshot, bulk cookies).
   * Default: 120000 (120s). Heavy ops legitimately block the event loop longer
   * than the normal threshold without indicating a true hang.
   */
  heavyOpFatalThresholdMs?: number;
  /**
   * Idle-state source. Defaults to the process-global singleton. Injected
   * for unit tests that want to assert active/idle cadence.
   */
  idleState?: IdleState;
}

export interface BlockEvent {
  driftMs: number;
  timestamp: number;
}

export class EventLoopMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private readonly checkIntervalMs: number;
  private readonly warnThresholdMs: number;
  private readonly fatalThresholdMs: number;
  private readonly heavyOpThresholdMs: number;
  private readonly idleState: IdleState;
  private lastCheckAt = 0;
  private lastDelayMs = 0;
  private maxDriftObserved = 0;
  private warnCount = 0;
  private heavyOpCount = 0;
  private stopped = true;

  constructor(opts?: EventLoopMonitorOptions) {
    super();
    this.checkIntervalMs = opts?.checkIntervalMs ?? 200;
    this.warnThresholdMs = opts?.warnThresholdMs ?? 2000;
    this.fatalThresholdMs = opts?.fatalThresholdMs ?? 0; // disabled by default
    this.heavyOpThresholdMs = opts?.heavyOpFatalThresholdMs ?? DEFAULT_EVENT_LOOP_HEAVY_OP_FATAL_MS;
    this.idleState = opts?.idleState ?? getIdleState();
  }

  /**
   * Start monitoring the event loop.
   */
  start(): void {
    this.stop();
    this.stopped = false;
    this.lastCheckAt = Date.now();
    this.scheduleNext(this.nextDelayMs());
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Whether monitoring is active.
   */
  isRunning(): boolean {
    return !this.stopped && this.timer !== null;
  }

  /**
   * Signal the start of a heavy tool operation that may legitimately block the event loop.
   * While active, the monitor uses heavyOpThresholdMs instead of fatalThresholdMs.
   * Uses a reference counter so concurrent heavy tools are handled correctly.
   */
  beginHeavyOperation(): void {
    this.heavyOpCount++;
  }

  /**
   * Signal the end of a heavy tool operation, reverting to the normal fatal threshold
   * once all concurrent heavy operations have completed.
   */
  endHeavyOperation(): void {
    if (this.heavyOpCount > 0) this.heavyOpCount--;
  }

  /**
   * Get monitoring statistics.
   */
  getStats(): {
    maxDriftMs: number;
    warnCount: number;
    isRunning: boolean;
  } {
    return {
      maxDriftMs: this.maxDriftObserved,
      warnCount: this.warnCount,
      isRunning: this.isRunning(),
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.maxDriftObserved = 0;
    this.warnCount = 0;
  }

  /**
   * Current scheduling delay in ms — exposed for tests that assert the
   * active/idle rate transition specified by issue #649 §3.1.
   */
  getCurrentDelayMs(): number {
    return this.lastDelayMs;
  }

  /** Active vs idle selection, single source of truth for this monitor. */
  private nextDelayMs(): number {
    return this.idleState.isIdle(IDLE_WINDOW_MS) ? IDLE_RATE_MS : this.checkIntervalMs;
  }

  private scheduleNext(delay: number): void {
    if (this.stopped) return;
    this.lastDelayMs = delay;
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref();
  }

  private tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    const expected = this.lastDelayMs;
    const drift = now - this.lastCheckAt - expected;
    this.lastCheckAt = now;

    if (drift > this.maxDriftObserved) {
      this.maxDriftObserved = drift;
    }

    const effectiveThreshold = (this.fatalThresholdMs === 0)
      ? 0
      : (this.heavyOpCount > 0 ? this.heavyOpThresholdMs : this.fatalThresholdMs);
    if (effectiveThreshold > 0 && drift > effectiveThreshold) {
      console.error(`[EventLoopMonitor] FATAL: Event loop blocked for ${drift}ms (threshold: ${effectiveThreshold}ms${this.heavyOpCount > 0 ? ', heavy-op mode' : ''})`);
      this.emit('fatal', { driftMs: drift, timestamp: now } as BlockEvent);
      // Intentionally fall through and reschedule — emitting 'fatal' does
      // not stop the monitor; the listener decides whether to process.exit.
    } else if (drift > this.warnThresholdMs) {
      this.warnCount++;
      console.error(`[EventLoopMonitor] WARN: Event loop blocked for ${drift}ms (warn #${this.warnCount})`);
      this.emit('warn', { driftMs: drift, timestamp: now } as BlockEvent);
    }

    this.scheduleNext(this.nextDelayMs());
  }
}

// ─── Singleton accessor ───────────────────────────────────────────────────────

let monitorInstance: EventLoopMonitor | null = null;

/**
 * Register the global EventLoopMonitor singleton.
 * Called once from src/index.ts after creating the monitor.
 */
export function setGlobalEventLoopMonitor(monitor: EventLoopMonitor): void {
  monitorInstance = monitor;
}

/**
 * Retrieve the global EventLoopMonitor singleton.
 * Returns null if the monitor has not been registered yet (e.g., in tests).
 */
export function getGlobalEventLoopMonitor(): EventLoopMonitor | null {
  return monitorInstance;
}
