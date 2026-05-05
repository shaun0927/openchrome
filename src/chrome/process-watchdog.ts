/**
 * Chrome Process Watchdog — monitors Chrome process health.
 * Detects Chrome crashes within intervalMs and emits events for recovery.
 * Part of #347 Layer 3: Chrome Process Supervisor.
 *
 * Idle-adaptive (issue #649 Part A): when the server is idle, the poll
 * cadence relaxes from 10 s to 60 s (6× reduction; still within the 10×
 * idle-rate cap specified in §3.1). `setTimeout` chain so each tick picks
 * its next delay fresh.
 */

import { EventEmitter } from 'events';
import { ChromeLauncher } from './launcher';
import { getIdleState, IDLE_WINDOW_MS, IdleState } from '../utils/idle-state';
import { shouldRateLimitRelaunch } from './exit-classifier';

/** Idle cadence. 60 s is 6× slower than the default 10 s active rate. */
const IDLE_INTERVAL_MS = 60_000;

export interface ProcessWatchdogOptions {
  /** Check interval in milliseconds. Default: 10000 (10s) */
  intervalMs?: number;
  /** Idle-state source. Defaults to the process-global singleton. */
  idleState?: IdleState;
}

export interface ProcessWatchdogEvents {
  'chrome-died': { pid: number; timestamp: number };
  'chrome-relaunched': { pid: number; timestamp: number };
  'relaunch-failed': { error: Error; timestamp: number };
  'watchdog-exhausted': { count: number; timestamp: number };
}

export class ChromeProcessWatchdog extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly launcher: ChromeLauncher;
  private readonly idleState: IdleState;
  private lastKnownPid: number | null = null;
  private relaunching = false;
  private cooldownUntil = 0;
  private relaunchCount = 0;
  private readonly maxRelaunchCycles = 10;
  private stopped = true;
  private lastDelayMs = 0;

  constructor(launcher: ChromeLauncher, opts?: ProcessWatchdogOptions) {
    super();
    this.launcher = launcher;
    this.intervalMs = opts?.intervalMs ?? 10000;
    this.idleState = opts?.idleState ?? getIdleState();
  }

  /**
   * Start monitoring Chrome process.
   * Timer is .unref()'d so it doesn't prevent process exit.
   */
  start(): void {
    this.stop(); // clear any existing timer
    this.stopped = false;
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
    // Do NOT reset relaunching — async check() may still be in-flight
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
      this.check()
        .catch((err) => {
          console.error('[ProcessWatchdog] Unexpected error in check():', err);
        })
        .finally(() => {
          this.scheduleNext(this.nextDelayMs());
        });
    }, delay);
    this.timer.unref();
  }

  /**
   * Check if Chrome process is still alive.
   * Uses process.kill(pid, 0) — signal 0 checks existence without killing.
   */
  private async check(): Promise<void> {
    if (this.relaunching) return; // already handling a crash
    // Cooldown after recent relaunch to let CDPClient fully reconnect
    if (Date.now() < this.cooldownUntil) {
      return;
    }
    if (this.launcher.intentionalStop) return; // Chrome was stopped intentionally — do not relaunch

    // #660: respect user-driven close (quiesce window).
    if (Date.now() < this.launcher.quiesceUntil) {
      return;
    }

    // #660 / #659 coordination: never relaunch a Chrome we did not spawn.
    const currentInstance = this.launcher.getInstance();
    if (currentInstance && currentInstance.launchMode === 'attach') {
      return;
    }

    // #660 Phase 3 rate-limit: if Chrome has crashed N times within window, pause relaunches.
    if (shouldRateLimitRelaunch(this.launcher.recentCrashesMs)) {
      console.error('[ProcessWatchdog] Chrome crashing repeatedly; pausing relaunches. Run oc_stop and inspect logs.');
      this.cooldownUntil = Date.now() + 60_000;
      return;
    }

    const instance = currentInstance;
    let pid: number | undefined;

    if (instance) {
      pid = instance.process?.pid;
      if (pid) this.lastKnownPid = pid;
    } else if (this.lastKnownPid) {
      // Instance was invalidated by CDPClient reconnection loop, but we
      // still know the last Chrome PID — check if it's alive so we can
      // trigger a relaunch when it's not.
      pid = this.lastKnownPid;
    }

    if (!pid) return; // no PID tracked

    try {
      process.kill(pid, 0); // signal 0 = check existence only
      return; // process alive
    } catch (err: any) {
      if (err?.code === 'EPERM') {
        return; // process exists but owned by another user (Windows)
      }
      // ESRCH = process truly dead, continue to relaunch
    }

    // Process is dead
    console.error(`[ProcessWatchdog] Chrome process (PID ${pid}) is dead, attempting relaunch...`);
    this.emit('chrome-died', { pid, timestamp: Date.now() });

    this.relaunching = true;
    try {
      await this.launcher.ensureChrome({ autoLaunch: true });
      const newInstance = this.launcher.getInstance();
      const newPid = newInstance?.process?.pid;
      console.error(`[ProcessWatchdog] Chrome relaunched successfully (PID ${newPid})`);
      this.emit('chrome-relaunched', { pid: newPid ?? 0, timestamp: Date.now() });
      this.relaunchCount++;
      // Cooldown: skip 3 check intervals to let CDPClient reconnect
      this.cooldownUntil = Date.now() + this.intervalMs * 3;

      if (this.relaunchCount >= this.maxRelaunchCycles) {
        console.error(`[ProcessWatchdog] Relaunch limit (${this.maxRelaunchCycles}) reached, stopping watchdog`);
        this.emit('watchdog-exhausted', { count: this.relaunchCount, timestamp: Date.now() });
        this.stop();
      }
    } catch (error) {
      console.error('[ProcessWatchdog] Chrome relaunch failed:', error);
      this.emit('relaunch-failed', {
        error: error instanceof Error ? error : new Error(String(error)),
        timestamp: Date.now(),
      });
    } finally {
      this.relaunching = false;
    }
  }

  /**
   * Whether the watchdog is currently running.
   */
  isRunning(): boolean {
    return !this.stopped && this.timer !== null;
  }

  /**
   * Get the last known Chrome PID being monitored.
   */
  getLastKnownPid(): number | null {
    return this.lastKnownPid;
  }
}
