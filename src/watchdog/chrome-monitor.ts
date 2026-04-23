/**
 * Chrome Process Monitor — tracks Chrome RSS memory usage.
 * Emits 'warn' and 'critical' events when thresholds are exceeded.
 * Part of the reliability initiative: early warning before Chrome OOM-kills.
 *
 * Idle-adaptive (issue #649 Part A): when the server is idle, the `ps`
 * sampling cadence relaxes from 30 s to 180 s (6× reduction). `setTimeout`
 * chain so each tick picks its next delay fresh.
 */

import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import {
  DEFAULT_CHROME_MONITOR_INTERVAL_MS,
  DEFAULT_CHROME_MEMORY_WARN_BYTES,
  DEFAULT_CHROME_MEMORY_CRITICAL_BYTES,
} from '../config/defaults';
import { getIdleState, IDLE_WINDOW_MS, IdleState } from '../utils/idle-state';

/** Idle cadence. 180 s is 6× slower than the default 30 s active rate. */
const IDLE_INTERVAL_MS = 180_000;

export interface ChromeProcessStats {
  pid: number;
  rssBytes: number;
  timestamp: number;
}

export class ChromeProcessMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private pid: number | null = null;
  private lastStats: ChromeProcessStats | null = null;
  private readonly intervalMs: number;
  private readonly warnBytes: number;
  private readonly criticalBytes: number;
  private readonly idleState: IdleState;
  private stopped = true;
  private lastDelayMs = 0;

  constructor(opts?: { intervalMs?: number; warnBytes?: number; criticalBytes?: number; idleState?: IdleState }) {
    super();
    this.intervalMs = opts?.intervalMs ?? DEFAULT_CHROME_MONITOR_INTERVAL_MS;
    this.warnBytes = opts?.warnBytes ?? DEFAULT_CHROME_MEMORY_WARN_BYTES;
    this.criticalBytes = opts?.criticalBytes ?? DEFAULT_CHROME_MEMORY_CRITICAL_BYTES;
    this.idleState = opts?.idleState ?? getIdleState();
  }

  start(pid: number): void {
    if (process.platform === 'win32') {
      console.error('[ChromeMonitor] Memory monitoring not supported on Windows, skipping');
      return;
    }
    this.stop();
    this.stopped = false;
    this.pid = pid;
    this.check(); // immediate first check
    this.scheduleNext(this.nextDelayMs());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pid = null;
  }

  getStats(): ChromeProcessStats | null {
    return this.lastStats;
  }

  /**
   * Current scheduling delay in ms — exposed for tests asserting the
   * active/idle rate transition (issue #649 §3.1).
   */
  getCurrentDelayMs(): number {
    return this.lastDelayMs;
  }

  private nextDelayMs(): number {
    return this.idleState.isIdle(IDLE_WINDOW_MS) ? IDLE_INTERVAL_MS : this.intervalMs;
  }

  private scheduleNext(delay: number): void {
    if (this.stopped) return;
    this.lastDelayMs = delay;
    this.timer = setTimeout(() => {
      this.check();
      this.scheduleNext(this.nextDelayMs());
    }, delay);
    this.timer.unref();
  }

  private check(): void {
    if (!this.pid) return;
    execFile('ps', ['-o', 'rss=', '-p', String(this.pid)], (err, stdout) => {
      if (err) {
        // Chrome process may have died; clear stats silently
        this.lastStats = null;
        return;
      }
      const rssKb = parseInt(stdout.trim(), 10);
      if (isNaN(rssKb)) return;
      const rssBytes = rssKb * 1024;
      this.lastStats = { pid: this.pid!, rssBytes, timestamp: Date.now() };

      if (rssBytes > this.criticalBytes) {
        console.error(
          `[ChromeMonitor] CRITICAL: Chrome RSS ${Math.round(rssBytes / 1024 / 1024)}MB exceeds ${Math.round(this.criticalBytes / 1024 / 1024)}MB`,
        );
        this.emit('critical', this.lastStats);
      } else if (rssBytes > this.warnBytes) {
        console.error(
          `[ChromeMonitor] WARN: Chrome RSS ${Math.round(rssBytes / 1024 / 1024)}MB exceeds ${Math.round(this.warnBytes / 1024 / 1024)}MB`,
        );
        this.emit('warn', this.lastStats);
      }
    });
  }
}
