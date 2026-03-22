/**
 * Chrome Process Watchdog — monitors Chrome process health.
 * Detects Chrome crashes within intervalMs and emits events for recovery.
 * Part of #347 Layer 3: Chrome Process Supervisor.
 */

import { EventEmitter } from 'events';
import { ChromeLauncher } from './launcher';

export interface ProcessWatchdogOptions {
  /** Check interval in milliseconds. Default: 10000 (10s) */
  intervalMs?: number;
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
  private lastKnownPid: number | null = null;
  private relaunching = false;
  private cooldownUntil = 0;
  private relaunchCount = 0;
  private readonly maxRelaunchCycles = 10;

  constructor(launcher: ChromeLauncher, opts?: ProcessWatchdogOptions) {
    super();
    this.launcher = launcher;
    this.intervalMs = opts?.intervalMs ?? 10000;
  }

  /**
   * Start monitoring Chrome process.
   * Timer is .unref()'d so it doesn't prevent process exit.
   */
  start(): void {
    this.stop(); // clear any existing timer

    this.timer = setInterval(() => {
      this.check().catch((err) => {
        console.error('[ProcessWatchdog] Unexpected error in check():', err);
      });
    }, this.intervalMs);
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
    // Do NOT reset relaunching — async check() may still be in-flight
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

    const instance = this.launcher.getInstance();
    if (!instance) return; // Chrome not launched by us — nothing to watch

    const pid = instance.process?.pid;
    if (!pid) return; // no PID tracked

    this.lastKnownPid = pid;

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
    return this.timer !== null;
  }

  /**
   * Get the last known Chrome PID being monitored.
   */
  getLastKnownPid(): number | null {
    return this.lastKnownPid;
  }
}
