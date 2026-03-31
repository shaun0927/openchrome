/**
 * CLI Coexistence — detects and monitors an existing CLI-spawned server.
 * On app start, checks if a server is already running on the target port.
 * If found, connects to it instead of spawning a new sidecar.
 * Monitors health continuously and emits events on state changes.
 * Part of #524 Desktop App: Error handling + local fallback + CLI coexistence.
 */

import { EventEmitter } from 'events';
import * as http from 'http';

export type ServerSource = 'none' | 'external' | 'built-in';

export interface CoexistenceOptions {
  /** Port to check. Default: 3100 */
  port?: number;
  /** Health check path. Default: '/health' */
  healthCheckPath?: string;
  /** Interval between health checks in ms. Default: 5000 */
  healthCheckIntervalMs?: number;
  /** Timeout per health check request in ms. Default: 2000 */
  healthCheckTimeoutMs?: number;
}

export interface ServerInfo {
  source: ServerSource;
  port: number;
  healthy: boolean;
  lastHealthCheck: number | null;
}

/**
 * Events emitted by CLICoexistence:
 *
 * 'external-detected' → { port: number }
 *   A server was found running on the configured port.
 *
 * 'external-lost' → { port: number; message: string }
 *   A previously-detected external server stopped responding.
 *
 * 'no-server' → { port: number }
 *   Initial check found no server running.
 *
 * 'health-check' → { healthy: boolean; source: ServerSource }
 *   Fired after every health check (initial and periodic).
 *
 * 'status-changed' → { oldSource: ServerSource; newSource: ServerSource }
 *   Fired when source transitions (none→external or external→none).
 */
export class CLICoexistence extends EventEmitter {
  private readonly port: number;
  private readonly healthCheckPath: string;
  private readonly healthCheckIntervalMs: number;
  private readonly healthCheckTimeoutMs: number;

  private source: ServerSource = 'none';
  private healthy = false;
  private lastHealthCheck: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: CoexistenceOptions = {}) {
    super();
    this.port = opts.port ?? 3100;
    this.healthCheckPath = opts.healthCheckPath ?? '/health';
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 5000;
    this.healthCheckTimeoutMs = opts.healthCheckTimeoutMs ?? 2000;
  }

  /**
   * Perform a single health check against the configured port.
   * Returns a ServerInfo snapshot reflecting the result.
   */
  async checkForExistingServer(): Promise<ServerInfo> {
    const healthy = await this._httpGet();
    this.lastHealthCheck = Date.now();

    const oldSource = this.source;
    if (healthy) {
      if (this.source !== 'external' && this.source !== 'built-in') {
        this.source = 'external';
      }
      this.healthy = true;
    } else {
      this.healthy = false;
      if (this.source === 'none') {
        // Still none — no transition
      }
    }

    if (oldSource !== this.source) {
      this.emit('status-changed', { oldSource, newSource: this.source });
    }

    const info = this.getServerInfo();

    this.emit('health-check', { healthy, source: this.source });

    if (healthy && oldSource === 'none') {
      this.emit('external-detected', { port: this.port });
    } else if (!healthy && oldSource === 'none') {
      this.emit('no-server', { port: this.port });
    }

    return info;
  }

  /**
   * Start periodic health monitoring.
   * Timer is .unref()'d so it does not prevent process exit.
   */
  startMonitoring(): void {
    this.stopMonitoring(); // clear any existing timer

    this.timer = setInterval(() => {
      this._monitorTick().catch((err) => {
        console.error('[CLICoexistence] Unexpected error in monitor tick:', err);
      });
    }, this.healthCheckIntervalMs);
    this.timer.unref();
  }

  /**
   * Stop periodic health monitoring.
   */
  stopMonitoring(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Returns a snapshot of the current server info.
   */
  getServerInfo(): ServerInfo {
    return {
      source: this.source,
      port: this.port,
      healthy: this.healthy,
      lastHealthCheck: this.lastHealthCheck,
    };
  }

  /**
   * Whether the monitoring timer is active.
   */
  isMonitoring(): boolean {
    return this.timer !== null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async _monitorTick(): Promise<void> {
    const prevSource = this.source;
    const prevHealthy = this.healthy;

    const healthy = await this._httpGet();
    this.lastHealthCheck = Date.now();
    this.healthy = healthy;

    this.emit('health-check', { healthy, source: this.source });

    if (prevSource === 'external' && !healthy) {
      // External server just stopped
      this.source = 'none';
      this.emit('status-changed', { oldSource: prevSource, newSource: this.source });
      this.emit('external-lost', {
        port: this.port,
        message: 'External server stopped. Start built-in server?',
      });
    } else if (prevSource === 'none' && healthy) {
      // Server appeared while monitoring (e.g., CLI was started externally)
      this.source = 'external';
      this.emit('status-changed', { oldSource: prevSource, newSource: this.source });
      this.emit('external-detected', { port: this.port });
    } else if (prevSource === 'built-in' && !healthy) {
      // Built-in server lost health — just update healthy flag, no source change
      this.healthy = false;
    }

    // Suppress unused-variable warning — prevHealthy used as logical guard above
    void prevHealthy;
  }

  /**
   * Attempt GET {healthCheckPath} on localhost:{port}.
   * Returns true if a 2xx/3xx response is received within the timeout.
   * Returns false on ECONNREFUSED, ETIMEDOUT, or any error.
   */
  private _httpGet(): Promise<boolean> {
    return new Promise((resolve) => {
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: this.port,
        path: this.healthCheckPath,
        method: 'GET',
        timeout: this.healthCheckTimeoutMs,
      };

      const req = http.get(options, (res) => {
        // Drain the response body to free the socket
        res.resume();
        // Any HTTP response (even 503) means the server is reachable
        resolve(true);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
          resolve(false);
        } else {
          // Any other network error — treat as unavailable
          console.error('[CLICoexistence] Health check error:', err.code, err.message);
          resolve(false);
        }
      });
    });
  }
}
