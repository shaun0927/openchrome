/**
 * Lightpanda Launcher - Manages the Lightpanda browser process lifecycle
 */

import { spawn, ChildProcess } from 'child_process';
import * as puppeteer from 'puppeteer-core';
import type { Browser } from 'puppeteer-core';
import { DEFAULT_PUPPETEER_CONNECT_TIMEOUT_MS } from '../config/defaults';

export interface LightpandaLauncherConfig {
  port: number;
  binaryPath?: string;
  startupTimeoutMs?: number;
  healthCheckIntervalMs?: number;
}

export class LightpandaLauncher {
  private process: ChildProcess | null = null;
  private port: number;
  private binaryPath: string;
  private startupTimeoutMs: number;
  private healthCheckIntervalMs: number;
  private _isRunning: boolean = false;
  private browser: Browser | null = null;

  constructor(config: LightpandaLauncherConfig) {
    this.port = config.port;
    this.binaryPath = config.binaryPath ?? (process.platform === 'win32' ? 'lightpanda.exe' : 'lightpanda');
    this.startupTimeoutMs = config.startupTimeoutMs ?? 10000;
    this.healthCheckIntervalMs = config.healthCheckIntervalMs ?? 500;
  }

  /**
   * Start Lightpanda process on the configured port
   */
  async start(): Promise<void> {
    if (this._isRunning) {
      return;
    }

    this.process = spawn(this.binaryPath, ['--port', String(this.port)], {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: process.platform === 'win32',
    });

    this.process.on('exit', () => {
      this._isRunning = false;
      this.process = null;
    });

    await this.waitForReady();
    this._isRunning = true;
  }

  /**
   * Stop the Lightpanda process
   */
  async stop(): Promise<void> {
    if (!this.process || !this._isRunning) {
      this._isRunning = false;
      this.process = null;
      return;
    }

    const proc = this.process;
    this._isRunning = false;
    this.process = null;

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          // On Windows, SIGKILL is not supported; use default kill (TerminateProcess)
          if (process.platform === 'win32') {
            proc.kill();
          } else {
            proc.kill('SIGKILL');
          }
        } catch {
          // ignore
        }
        resolve();
      }, 5000);

      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        // On Windows, SIGTERM is not supported; use default kill which calls TerminateProcess
        if (process.platform === 'win32') {
          proc.kill();
        } else {
          proc.kill('SIGTERM');
        }
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }

  /**
   * Check if Lightpanda is running
   */
  isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Get the port Lightpanda is running on
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Connect via puppeteer-core and return Browser instance.
   * Includes a timeout to prevent hanging if Lightpanda is listening but unresponsive
   * (mirrors the timeout pattern used in CDPClient.connectInternal()).
   */
  async connect(): Promise<Browser> {
    let connectTimeout: ReturnType<typeof setTimeout> | undefined;
    this.browser = await Promise.race([
      puppeteer.connect({
        browserWSEndpoint: `ws://localhost:${this.port}`,
      }).finally(() => {
        if (connectTimeout !== undefined) clearTimeout(connectTimeout);
      }),
      new Promise<never>((_, reject) => {
        connectTimeout = setTimeout(
          () => reject(new Error(`Lightpanda puppeteer.connect() timed out after ${DEFAULT_PUPPETEER_CONNECT_TIMEOUT_MS}ms`)),
          DEFAULT_PUPPETEER_CONNECT_TIMEOUT_MS
        );
      }),
    ]);
    return this.browser;
  }

  /**
   * Disconnect browser (without stopping process)
   */
  async disconnect(): Promise<void> {
    if (this.browser) {
      await this.browser.disconnect();
      this.browser = null;
    }
  }

  /**
   * Get the connected browser instance
   */
  getBrowser(): Browser | null {
    return this.browser;
  }

  /**
   * Health check - verify Lightpanda is responsive.
   * Uses AbortSignal.timeout to prevent hanging on unresponsive processes.
   */
  private async healthCheck(): Promise<boolean> {
    try {
      await fetch(`http://localhost:${this.port}/json/version`, {
        signal: AbortSignal.timeout(5000),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wait for Lightpanda to become ready using setInterval-based polling.
   * Compatible with jest fake timers.
   */
  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const startTime = Date.now();
      let settled = false;

      const intervalId = setInterval(() => {
        if (settled) return;

        if (Date.now() - startTime >= this.startupTimeoutMs) {
          settled = true;
          clearInterval(intervalId);
          reject(new Error(`Lightpanda not ready: timed out after ${this.startupTimeoutMs}ms`));
          return;
        }

        this.healthCheck().then((ok) => {
          if (settled) return;
          if (ok) {
            settled = true;
            clearInterval(intervalId);
            resolve();
          }
        });
      }, this.healthCheckIntervalMs);

      // Also check immediately (before first interval fires)
      this.healthCheck().then((ok) => {
        if (settled) return;
        if (ok) {
          settled = true;
          clearInterval(intervalId);
          resolve();
        }
      });
    });
  }
}
