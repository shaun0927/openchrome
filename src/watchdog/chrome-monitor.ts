/**
 * Chrome Process Monitor — tracks Chrome RSS memory usage.
 * Emits 'warn' and 'critical' events when thresholds are exceeded.
 * Part of the reliability initiative: early warning before Chrome OOM-kills.
 */

import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import {
  DEFAULT_CHROME_MONITOR_INTERVAL_MS,
  DEFAULT_CHROME_MEMORY_WARN_BYTES,
  DEFAULT_CHROME_MEMORY_CRITICAL_BYTES,
} from '../config/defaults';

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

  constructor(opts?: { intervalMs?: number; warnBytes?: number; criticalBytes?: number }) {
    super();
    this.intervalMs = opts?.intervalMs ?? DEFAULT_CHROME_MONITOR_INTERVAL_MS;
    this.warnBytes = opts?.warnBytes ?? DEFAULT_CHROME_MEMORY_WARN_BYTES;
    this.criticalBytes = opts?.criticalBytes ?? DEFAULT_CHROME_MEMORY_CRITICAL_BYTES;
  }

  start(pid: number): void {
    if (process.platform === 'win32') {
      console.error('[ChromeMonitor] Memory monitoring not supported on Windows, skipping');
      return;
    }
    this.stop();
    this.pid = pid;
    this.check(); // immediate first check
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pid = null;
  }

  getStats(): ChromeProcessStats | null {
    return this.lastStats;
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
