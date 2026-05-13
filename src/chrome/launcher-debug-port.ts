import type { ChildProcess } from 'child_process';
import * as http from 'http';

export class DebugPortTimeoutError extends Error {
  readonly port: number;
  readonly timeoutMs: number;
  readonly attempts: number;

  constructor(port: number, timeoutMs: number, attempts: number) {
    super(
      `Chrome debug port ${port} not available after ${timeoutMs}ms ` +
      `(${attempts} probe attempts). Chrome may still be starting, ` +
      `or the port may be blocked by a firewall or in use by another process.`
    );
    this.name = 'DebugPortTimeoutError';
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;
  }
}

const DEBUG_PORT_MAX_HTTP_TIMEOUT_MS = 2000;
const DEBUG_PORT_INITIAL_BACKOFF_MS = 200;
const DEBUG_PORT_MAX_BACKOFF_MS = 2000;
const DEBUG_PORT_BACKOFF_FACTOR = 1.5;
const DEBUG_PORT_PROGRESS_LOG_INTERVAL = 10;

export async function checkDebugPort(port: number, timeoutMs: number = DEBUG_PORT_MAX_HTTP_TIMEOUT_MS): Promise<string | null> {
  const clampedTimeout = Math.min(Math.max(1, timeoutMs), DEBUG_PORT_MAX_HTTP_TIMEOUT_MS);
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/json/version', method: 'GET', timeout: clampedTimeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.webSocketDebuggerUrl || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

export async function waitForDebugPort(port: number, timeout = 30000, chromeProcess?: ChildProcess): Promise<string> {
  if (!Number.isFinite(timeout) || timeout < 0) throw new DebugPortTimeoutError(port, 0, 0);
  const deadline = Date.now() + timeout;
  let attempts = 0;
  let backoff = DEBUG_PORT_INITIAL_BACKOFF_MS;

  while (Date.now() <= deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DebugPortTimeoutError(port, timeout, attempts);
    if (chromeProcess && (chromeProcess.exitCode !== null || chromeProcess.signalCode !== null)) {
      throw new Error(
        `Chrome exited with code ${chromeProcess.exitCode} signal ${chromeProcess.signalCode} before debug port ${port} became available. ` +
        `Likely cause: --user-data-dir is locked by another Chrome instance.`
      );
    }
    attempts += 1;
    const wsEndpoint = await checkDebugPort(port, Math.min(remaining, DEBUG_PORT_MAX_HTTP_TIMEOUT_MS));
    if (wsEndpoint) return wsEndpoint;
    if (attempts % DEBUG_PORT_PROGRESS_LOG_INTERVAL === 0) {
      const elapsed = timeout - remaining;
      console.error(`[Launcher] Debug port ${port} not ready yet ` + `(attempt ${attempts}, elapsed ${elapsed}ms, remaining ${Math.max(0, deadline - Date.now())}ms)`);
    }
    const remainingAfterProbe = deadline - Date.now();
    if (remainingAfterProbe <= 0) throw new DebugPortTimeoutError(port, timeout, attempts);
    const sleepFor = Math.min(backoff, DEBUG_PORT_MAX_BACKOFF_MS, Math.max(0, remainingAfterProbe - 1));
    if (sleepFor > 0) await new Promise((r) => setTimeout(r, sleepFor));
    backoff = Math.min(backoff * DEBUG_PORT_BACKOFF_FACTOR, DEBUG_PORT_MAX_BACKOFF_MS);
  }
  throw new DebugPortTimeoutError(port, timeout, attempts);
}
