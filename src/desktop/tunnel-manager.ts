/**
 * Tunnel Resilience Manager — manages cloudflared tunnel lifecycle with
 * auto-reconnect, blip detection, and local-only fallback.
 * Part of #524 Desktop App: Error handling + local fallback + CLI coexistence.
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type TunnelStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'local-only';

export interface TunnelOptions {
  cloudflaredPath?: string;
  targetPort: number;
  maxReconnectAttempts?: number;
  reconnectIntervalMs?: number;
  blipThresholdMs?: number;
}

export interface TunnelState {
  status: TunnelStatus;
  tunnelUrl: string | null;
  reconnectAttempt: number;
  lastError: string | null;
  disconnectedAt: number | null;
  localModeReason: string | null;
}

/**
 * TunnelManager manages the cloudflared tunnel process with:
 * - Auto-reconnect on crash (up to maxReconnectAttempts)
 * - Blip detection (transparent for short disconnects)
 * - Local-only fallback when all reconnects fail
 * - Antivirus/permission block detection
 *
 * Events emitted:
 * - 'connected'      → { tunnelUrl: string }
 * - 'disconnected'   → { reason: string }
 * - 'reconnecting'   → { attempt: number, maxAttempts: number }
 * - 'reconnected'    → { tunnelUrl: string }
 * - 'local-only'     → { reason: string, guidance: string }
 * - 'status-changed' → { oldStatus: TunnelStatus, newStatus: TunnelStatus }
 * - 'blocked'        → { reason: string, guidance: string }
 */
export class TunnelManager extends EventEmitter {
  private readonly options: Required<TunnelOptions>;
  private process: ChildProcess | null = null;
  private state: TunnelState;
  private intentionalStop = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: TunnelOptions) {
    super();
    this.options = {
      cloudflaredPath: options.cloudflaredPath ?? '',
      targetPort: options.targetPort,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 3,
      reconnectIntervalMs: options.reconnectIntervalMs ?? 10000,
      blipThresholdMs: options.blipThresholdMs ?? 10000,
    };
    this.state = {
      status: 'disconnected',
      tunnelUrl: null,
      reconnectAttempt: 0,
      lastError: null,
      disconnectedAt: null,
      localModeReason: null,
    };
  }

  /**
   * Start the tunnel. Finds cloudflared binary and spawns the process.
   * Resolves once the process is spawned (not once URL is received).
   */
  async start(): Promise<void> {
    this.intentionalStop = false;
    this.state.reconnectAttempt = 0;
    await this._launchTunnel();
  }

  /**
   * Stop the tunnel gracefully. Does not trigger reconnect.
   */
  stop(): void {
    this.intentionalStop = true;
    this._clearReconnectTimer();
    if (this.process) {
      try { this.process.kill('SIGTERM'); } catch { /* already exited */ }
      this.process = null;
    }
    this._setStatus('disconnected');
  }

  /**
   * Manual retry from local-only mode.
   */
  async retry(): Promise<void> {
    if (this.state.status !== 'local-only') return;
    this.intentionalStop = false;
    this.state.reconnectAttempt = 0;
    this.state.localModeReason = null;
    this.state.lastError = null;
    await this._launchTunnel();
  }

  /**
   * Get the current tunnel state snapshot.
   */
  getState(): TunnelState {
    return { ...this.state };
  }

  /**
   * Find the cloudflared binary path.
   * Checks known install locations and PATH.
   */
  async findCloudflared(): Promise<string | null> {
    // If explicitly configured, verify it exists
    if (this.options.cloudflaredPath) {
      if (fs.existsSync(this.options.cloudflaredPath)) {
        return this.options.cloudflaredPath;
      }
    }

    const candidates: string[] = [];
    const platform = os.platform();

    if (platform === 'darwin') {
      candidates.push(
        '/usr/local/bin/cloudflared',
        '/opt/homebrew/bin/cloudflared',
      );
    } else if (platform === 'win32') {
      const localAppData =
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
      candidates.push(path.join(localAppData, 'cloudflared', 'cloudflared.exe'));
    } else {
      // Linux and others
      candidates.push(
        '/usr/local/bin/cloudflared',
        '/usr/bin/cloudflared',
      );
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    // Try PATH via which/where
    try {
      const whichCmd = platform === 'win32' ? 'where' : 'which';
      const result = await this._runCommand(whichCmd, ['cloudflared']);
      const resolved = result.trim().split('\n')[0].trim();
      if (resolved && fs.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Not in PATH
    }

    return null;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async _launchTunnel(): Promise<void> {
    this._setStatus('connecting');

    let binaryPath: string | null = null;
    try {
      binaryPath = await this.findCloudflared();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._transitionToLocalOnly(`Failed to locate cloudflared: ${msg}`);
      return;
    }

    if (!binaryPath) {
      this._transitionToLocalOnly('cloudflared binary not found');
      return;
    }

    this._spawnProcess(binaryPath);
  }

  /**
   * Synchronously spawn the cloudflared process and register all event handlers.
   * This is separated from _launchTunnel so handlers are registered in the same
   * synchronous tick as the spawn call.
   */
  private _spawnProcess(binaryPath: string): void {
    const args = ['tunnel', '--url', `http://localhost:${this.options.targetPort}`];

    let proc: ChildProcess;
    try {
      proc = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      this._handleSpawnError(err);
      return;
    }

    this.process = proc;

    // Handle spawn errors (e.g. EPERM from antivirus) — must register before any emit
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (this.process === proc) {
        this.process = null;
      }
      this._handleSpawnError(err);
    });

    // Parse tunnel URL from stdout
    proc.stdout?.on('data', (chunk: Buffer) => {
      this._parseOutput(chunk.toString());
    });

    // Parse tunnel URL from stderr (cloudflared uses stderr for its URL output)
    proc.stderr?.on('data', (chunk: Buffer) => {
      this._parseOutput(chunk.toString());
    });

    proc.on('exit', (code, signal) => {
      if (this.process === proc) {
        this.process = null;
      }
      this._handleExit(code, signal);
    });
  }

  private _parseOutput(output: string): void {
    // cloudflared prints the tunnel URL to stderr, e.g.:
    // Your quick Tunnel has been created! Visit it at https://xxx.trycloudflare.com
    const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (urlMatch && this.state.status !== 'connected') {
      const tunnelUrl = urlMatch[0];
      this.state.tunnelUrl = tunnelUrl;
      const wasReconnecting = this.state.reconnectAttempt > 0;
      this.state.reconnectAttempt = 0;
      this.state.disconnectedAt = null;
      this._setStatus('connected');

      if (wasReconnecting) {
        this.emit('reconnected', { tunnelUrl });
      } else {
        this.emit('connected', { tunnelUrl });
      }
    }
  }

  private _handleSpawnError(err: NodeJS.ErrnoException): void {
    const code = err.code;
    if (code === 'EPERM' || code === 'EACCES') {
      const guidance =
        'cloudflared was blocked by security software. ' +
        'Please add cloudflared to your antivirus whitelist or use local-only mode.';
      this.state.lastError = err.message;
      this.state.localModeReason = guidance;
      this._setStatus('local-only');
      this.emit('blocked', { reason: err.message, guidance });
      this.emit('local-only', { reason: err.message, guidance });
      return;
    }

    const reason = err.message;
    this.state.lastError = reason;
    console.error('[TunnelManager] Spawn error:', err);
    this._scheduleReconnect(reason);
  }

  private _handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.intentionalStop) return;

    const reason = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
    console.error(`[TunnelManager] cloudflared ${reason}`);

    const wasConnected = this.state.status === 'connected';
    this.state.disconnectedAt = Date.now();
    this.state.tunnelUrl = null;

    if (wasConnected) {
      this.emit('disconnected', { reason });
    }

    this._scheduleReconnect(reason);
  }

  private _scheduleReconnect(reason: string): void {
    if (this.intentionalStop) return;

    const attempt = this.state.reconnectAttempt + 1;

    if (attempt > this.options.maxReconnectAttempts) {
      this._transitionToLocalOnly(reason);
      return;
    }

    this.state.reconnectAttempt = attempt;
    this.state.lastError = reason;

    const blip = this._isBlip();

    if (!blip) {
      this._setStatus('reconnecting');
      this.emit('reconnecting', { attempt, maxAttempts: this.options.maxReconnectAttempts });
    }

    this._clearReconnectTimer();
    const delay = blip ? 0 : this.options.reconnectIntervalMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalStop) {
        this._launchTunnel().catch((err) => {
          console.error('[TunnelManager] Error during reconnect launch:', err);
        });
      }
    }, delay);

    if (this.reconnectTimer.unref) {
      this.reconnectTimer.unref();
    }
  }

  private _transitionToLocalOnly(reason: string): void {
    const guidance =
      'Tunnel could not be established. ' +
      'Local connections (Cursor, Claude Desktop) are still available. ' +
      'Click Retry to attempt reconnection.';
    this.state.localModeReason = reason;
    this.state.lastError = reason;
    this.state.tunnelUrl = null;
    this._setStatus('local-only');
    this.emit('local-only', { reason, guidance });
  }

  private _isBlip(): boolean {
    if (this.state.disconnectedAt === null) return false;
    return Date.now() - this.state.disconnectedAt < this.options.blipThresholdMs;
  }

  private _setStatus(newStatus: TunnelStatus): void {
    const oldStatus = this.state.status;
    if (oldStatus === newStatus) return;
    this.state.status = newStatus;
    this.emit('status-changed', { oldStatus, newStatus });
  }

  private _clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private _runCommand(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => { if (!settled) { settled = true; fn(); } };
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      const timer = setTimeout(() => done(() => reject(new Error(`${cmd} timed out`))), 5000);
      if (timer.unref) timer.unref();
      let output = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      proc.on('error', (err) => done(() => { clearTimeout(timer); reject(err); }));
      proc.on('exit', (code) => done(() => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`${cmd} exited with code ${code}`));
        }
      }));
    });
  }
}
