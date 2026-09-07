/**
 * Chrome Process Monitor — tracks the root and descendants' resident memory.
 * Windows reports summed working sets; Unix reports summed RSS. Shared pages
 * may appear in multiple processes, so this is not private-byte accounting.
 * Emits 'warn' and 'critical' events when thresholds are exceeded.
 * Part of the reliability initiative: early warning before Chrome OOM-kills.
 *
 * Idle-adaptive (issue #649 Part A): when the server is idle, the `ps`
 * sampling cadence relaxes from 30 s to 180 s (6× reduction). `setTimeout`
 * chain so each tick picks its next delay fresh.
 */

import { readProcessMemory, ProcessMemorySample } from '../core/process/memory';
import { EventEmitter } from 'events';
import {
  DEFAULT_CHROME_MONITOR_INTERVAL_MS,
  DEFAULT_CHROME_MEMORY_WARN_BYTES,
  DEFAULT_CHROME_MEMORY_CRITICAL_BYTES,
} from '../config/defaults';
import { getIdleState, IDLE_WINDOW_MS, IdleState } from '../core/activity/idle-state';

/** Idle cadence. 180 s is 6× slower than the default 30 s active rate. */
const IDLE_INTERVAL_MS = 180_000;

export interface ChromeProcessStats {
  pid: number;
  rssBytes: number;
  timestamp: number;
  processCount?: number;
  processIds?: number[];
  scope?: ProcessMemorySample['scope'];
  metric?: ProcessMemorySample['metric'];
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
  private generation = 0;
  private sampling = false;
  private identity: string | undefined;
  private sampleAbort: AbortController | undefined;

  constructor(opts?: { intervalMs?: number; warnBytes?: number; criticalBytes?: number; idleState?: IdleState }) {
    super();
    this.intervalMs = opts?.intervalMs ?? DEFAULT_CHROME_MONITOR_INTERVAL_MS;
    this.warnBytes = opts?.warnBytes ?? DEFAULT_CHROME_MEMORY_WARN_BYTES;
    this.criticalBytes = opts?.criticalBytes ?? DEFAULT_CHROME_MEMORY_CRITICAL_BYTES;
    this.idleState = opts?.idleState ?? getIdleState();
  }

  start(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid Chrome process id');
    this.stop();
    this.identity = undefined;
    this.stopped = false;
    this.pid = pid;
    this.check(); // immediate first check
    this.scheduleNext(this.nextDelayMs());
  }

  stop(): void {
    this.sampleAbort?.abort();
    this.sampleAbort = undefined;
    this.generation++;
    this.sampling = false;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pid = null;
    this.lastStats = null;
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
    if (!this.pid || this.sampling || this.stopped) return;
    const pid = this.pid;
    const generation = this.generation;
    this.sampling = true;
    this.sampleAbort = new AbortController();
    void readProcessMemory(pid, true, this.sampleAbort.signal).then(sample => {
      if (generation !== this.generation || this.stopped) return;
      if (this.identity !== undefined && sample.identity !== this.identity) throw new Error('Chrome process identity changed');
      this.identity = sample.identity;
      const rssBytes = sample.residentBytes;
      this.lastStats = {
        pid, rssBytes, timestamp: sample.timestamp, processCount: sample.processCount,
        processIds: sample.processIds, scope: sample.scope, metric: sample.metric,
      };

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
    }).catch(error => {
      if (generation !== this.generation || this.stopped) return;
      this.lastStats = null;
      this.emit('unavailable', { pid, reason: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      if (generation === this.generation) { this.sampling = false; this.sampleAbort = undefined; }
    });
  }
}

/** Attach after transport startup without causing a browser connection. */
export function monitorChromeConnection(monitor: ChromeProcessMonitor, client: {
  getChromePid(): number | null;
  addConnectionListener(listener: (event: { type: string }) => void): void;
  removeConnectionListener(listener: (event: { type: string }) => void): void;
}): () => void {
  let activePid: number | null = null;
  const sync = () => {
    const pid = client.getChromePid();
    if (pid === activePid) return;
    monitor.stop();
    activePid = pid;
    if (pid !== null) monitor.start(pid);
  };
  const listener = (event: { type: string }) => {
    if (event.type === 'connected' || event.type === 'reconnected') sync();
    if (event.type === 'disconnected' || event.type === 'reconnect_failed') {
      activePid = null;
      monitor.stop();
    }
  };
  client.addConnectionListener(listener);
  sync();
  return () => { client.removeConnectionListener(listener); monitor.stop(); };
}
