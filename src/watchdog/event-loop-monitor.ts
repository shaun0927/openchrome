/**
 * Event Loop Monitor — detects Node.js event loop blocking.
 * Uses timer drift detection (lightweight, ~0.5% CPU overhead).
 * Part of #347 Layer 4: Application Watchdog.
 */

import { EventEmitter } from 'events';

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
  private lastCheckAt = 0;
  private maxDriftObserved = 0;
  private warnCount = 0;

  constructor(opts?: EventLoopMonitorOptions) {
    super();
    this.checkIntervalMs = opts?.checkIntervalMs ?? 200;
    this.warnThresholdMs = opts?.warnThresholdMs ?? 2000;
    this.fatalThresholdMs = opts?.fatalThresholdMs ?? 0; // disabled by default
  }

  /**
   * Start monitoring the event loop.
   */
  start(): void {
    this.stop();
    this.lastCheckAt = Date.now();

    this.timer = setInterval(() => {
      const now = Date.now();
      const drift = now - this.lastCheckAt - this.checkIntervalMs;
      this.lastCheckAt = now;

      if (drift > this.maxDriftObserved) {
        this.maxDriftObserved = drift;
      }

      if (this.fatalThresholdMs > 0 && drift > this.fatalThresholdMs) {
        console.error(`[EventLoopMonitor] FATAL: Event loop blocked for ${drift}ms (threshold: ${this.fatalThresholdMs}ms)`);
        // Emits 'fatal' event — callers MUST attach a listener to handle recovery (e.g., process.exit(1)).
        // No automatic termination: intentional for testability and caller control.
        this.emit('fatal', { driftMs: drift, timestamp: now } as BlockEvent);
      } else if (drift > this.warnThresholdMs) {
        this.warnCount++;
        console.error(`[EventLoopMonitor] WARN: Event loop blocked for ${drift}ms (warn #${this.warnCount})`);
        this.emit('warn', { driftMs: drift, timestamp: now } as BlockEvent);
      }
    }, this.checkIntervalMs);
    this.timer.unref();
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Whether monitoring is active.
   */
  isRunning(): boolean {
    return this.timer !== null;
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
}
