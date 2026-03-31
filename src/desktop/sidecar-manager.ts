/**
 * Sidecar Manager — manages a Node.js child process sidecar with crash recovery.
 * Detects crashes via process exit event, auto-restarts up to maxCrashes times
 * within a sliding window, and handles port conflicts via auto-increment.
 * Part of #524: Desktop App error handling + local fallback + CLI coexistence.
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';

export interface SidecarOptions {
  /** Executable command, e.g. 'node' */
  command: string;
  /** Arguments, e.g. ['dist/index.js', 'serve'] */
  args: string[];
  /** Base port for the sidecar server. Default: 3100 */
  basePort?: number;
  /** Maximum crash count before giving up. Default: 3 */
  maxCrashes?: number;
  /** Sliding window in ms to count crashes. Default: 300000 (5 min) */
  crashWindowMs?: number;
  /** Additional environment variables for the child process */
  env?: Record<string, string>;
}

export type SidecarStatus = 'stopped' | 'starting' | 'running' | 'restarting' | 'crashed' | 'exhausted';

export interface SidecarState {
  status: SidecarStatus;
  pid: number | null;
  port: number;
  crashCount: number;
  lastError: string | null;
  /** Milliseconds since last successful start, or 0 if not started */
  uptime: number;
}

/** Resolved options with all defaults applied */
interface ResolvedOptions {
  command: string;
  args: string[];
  basePort: number;
  maxCrashes: number;
  crashWindowMs: number;
  env?: Record<string, string>;
}

/**
 * SidecarManager events:
 *
 * 'started'      → { pid: number | undefined, port: number }
 * 'restarting'   → { crashCount: number, reason: string }
 * 'running'      → { pid: number | undefined, port: number }
 * 'crashed'      → { reason: string, crashCount: number }
 * 'exhausted'    → { crashCount: number, message: string }
 * 'port-changed' → { oldPort: number, newPort: number }
 * 'stderr'       → { data: string }
 */
export class SidecarManager extends EventEmitter {
  private readonly options: ResolvedOptions;
  private child: ChildProcess | null = null;
  private status: SidecarStatus = 'stopped';
  private currentPort: number;
  private crashTimestamps: number[] = [];
  private lastError: string | null = null;
  private startedAt: number | null = null;
  private intentionalStop = false;
  private stderrLines: string[] = [];
  private readonly maxStderrLines = 500;

  /** SIGKILL delay after SIGTERM in milliseconds */
  private readonly killTimeoutMs = 5000;

  constructor(options: SidecarOptions) {
    super();
    this.options = {
      command: options.command,
      args: options.args,
      basePort: options.basePort ?? 3100,
      maxCrashes: options.maxCrashes ?? 3,
      crashWindowMs: options.crashWindowMs ?? 300000,
      env: options.env,
    };
    this.currentPort = this.options.basePort;
  }

  /**
   * Start the sidecar child process.
   * Idempotent: no-op if already starting or running.
   */
  start(): void {
    if (this.status === 'starting' || this.status === 'running') {
      return;
    }
    this.intentionalStop = false;
    this._spawn();
  }

  /**
   * Stop the sidecar gracefully.
   * Sends SIGTERM, then SIGKILL after killTimeoutMs if still alive.
   */
  stop(): Promise<void> {
    this.intentionalStop = true;
    return this._killChild();
  }

  /**
   * Returns current sidecar state snapshot.
   */
  getState(): SidecarState {
    return {
      status: this.status,
      pid: this.child?.pid ?? null,
      port: this.currentPort,
      crashCount: this.crashTimestamps.length,
      lastError: this.lastError,
      uptime: this.startedAt !== null ? Date.now() - this.startedAt : 0,
    };
  }

  /**
   * Returns last N lines of captured stderr output.
   */
  getStderrLog(lines = 100): string[] {
    return this.stderrLines.slice(-lines);
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private _spawn(): void {
    this.status = 'starting';
    this.startedAt = null;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
      PORT: String(this.currentPort),
    };

    let child: ChildProcess;
    try {
      child = spawn(this.options.command, this.options.args, {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this._handleCrash(reason);
      return;
    }

    // Guard: if spawn returns a non-process object (e.g. in tests when mock is exhausted)
    if (!child || typeof child.on !== 'function') {
      this._handleCrash('spawn returned invalid process');
      return;
    }

    this.child = child;
    this.startedAt = Date.now();
    this.status = 'running';

    // Capture stderr BEFORE emitting events so that listeners attached in tests
    // see a fully-initialized state.
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data: string) => {
        this._appendStderr(data);
        this.emit('stderr', { data });
      });
    }

    // Register exit/error handlers before emitting 'started'/'running' so
    // synchronous crashes in tests are handled correctly.
    child.on('exit', (code, signal) => {
      if (this.intentionalStop) {
        this.status = 'stopped';
        this.child = null;
        return;
      }

      const reason = signal
        ? `killed by signal ${signal}`
        : `exited with code ${code ?? 'unknown'}`;

      this._handleCrash(reason);
    });

    child.on('error', (err) => {
      if (!this.intentionalStop) {
        this._handleCrash(err.message);
      }
    });

    this.emit('started', { pid: child.pid, port: this.currentPort });
    this.emit('running', { pid: child.pid, port: this.currentPort });
  }

  private _handleCrash(reason: string): void {
    this.lastError = reason;
    this.child = null;

    const now = Date.now();
    // Evict timestamps outside the sliding window
    this.crashTimestamps = this.crashTimestamps.filter(
      (ts) => now - ts < this.options.crashWindowMs,
    );
    this.crashTimestamps.push(now);

    const crashCount = this.crashTimestamps.length;
    this.status = 'crashed';

    console.error(`[SidecarManager] Sidecar crashed (${crashCount}/${this.options.maxCrashes}): ${reason}`);
    this.emit('crashed', { reason, crashCount });

    if (crashCount >= this.options.maxCrashes) {
      this.status = 'exhausted';
      console.error('[SidecarManager] Crash limit reached — giving up');
      this.emit('exhausted', { crashCount, message: 'Server keeps crashing' });
      return;
    }

    // Check if recent stderr suggests port conflict
    const recentStderr = this.stderrLines.slice(-20).join('\n');
    if (recentStderr.includes('EADDRINUSE')) {
      const oldPort = this.currentPort;
      this.currentPort = oldPort + 1;
      console.error(`[SidecarManager] Port ${oldPort} in use, incrementing to ${this.currentPort}`);
      this.emit('port-changed', { oldPort, newPort: this.currentPort });
    }

    this.status = 'restarting';
    this.emit('restarting', { crashCount, reason });
    this._spawn();
  }

  private _killChild(): Promise<void> {
    const child = this.child;
    this.child = null;

    if (!child || child.exitCode !== null) {
      this.status = 'stopped';
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let killTimer: NodeJS.Timeout | null = null;

      const onExit = (): void => {
        if (killTimer) clearTimeout(killTimer);
        this.status = 'stopped';
        resolve();
      };

      child.once('exit', onExit);

      child.kill('SIGTERM');

      killTimer = setTimeout(() => {
        child.removeListener('exit', onExit);
        try {
          child.kill('SIGKILL');
        } catch {
          // Already dead
        }
        this.status = 'stopped';
        resolve();
      }, this.killTimeoutMs);

      if (killTimer.unref) killTimer.unref();
    });
  }

  private _appendStderr(data: string): void {
    const lines = data.split('\n');
    this.stderrLines.push(...lines);
    if (this.stderrLines.length > this.maxStderrLines) {
      this.stderrLines = this.stderrLines.slice(-this.maxStderrLines);
    }
  }
}
