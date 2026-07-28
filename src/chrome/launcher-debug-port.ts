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

export type DebugPortProbeResult =
  | { kind: 'ok'; statusCode: number; wsEndpoint: string }
  | { kind: 'http-error'; statusCode: number }
  | { kind: 'invalid-response'; statusCode: number }
  | { kind: 'network-error'; code?: string }
  | { kind: 'timeout' };

export async function probeDebugPort(
  port: number,
  timeoutMs: number = DEBUG_PORT_MAX_HTTP_TIMEOUT_MS,
): Promise<DebugPortProbeResult> {
  const clampedTimeout = Math.min(Math.max(1, timeoutMs), DEBUG_PORT_MAX_HTTP_TIMEOUT_MS);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DebugPortProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = http.request({ hostname: '127.0.0.1', port, path: '/json/version', method: 'GET', timeout: clampedTimeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          finish({ kind: 'http-error', statusCode });
          return;
        }
        try {
          const json = JSON.parse(data);
          if (typeof json.webSocketDebuggerUrl === 'string' && json.webSocketDebuggerUrl) {
            finish({ kind: 'ok', statusCode, wsEndpoint: json.webSocketDebuggerUrl });
            return;
          }
        } catch {
          // Fall through to the invalid-response result.
        }
        finish({ kind: 'invalid-response', statusCode });
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => finish({ kind: 'network-error', code: err.code }));
    req.on('timeout', () => {
      finish({ kind: 'timeout' });
      req.destroy();
    });
    req.end();
  });
}

export async function checkDebugPort(port: number, timeoutMs: number = DEBUG_PORT_MAX_HTTP_TIMEOUT_MS): Promise<string | null> {
  const result = await probeDebugPort(port, timeoutMs);
  return result.kind === 'ok' ? result.wsEndpoint : null;
}

export async function waitForDebugPort(port: number, timeout = 30000, chromeProcess?: ChildProcess): Promise<string> {
  if (!Number.isFinite(timeout) || timeout < 0) throw new DebugPortTimeoutError(port, 0, 0);
  const deadline = Date.now() + timeout;
  let attempts = 0;
  let backoff = DEBUG_PORT_INITIAL_BACKOFF_MS;
  let onProcessError: ((err: Error) => void) | undefined;
  const canObserveProcessError = typeof chromeProcess?.once === 'function';
  const processError = canObserveProcessError
    ? new Promise<never>((_, reject) => {
        onProcessError = (err: Error) => reject(err);
        chromeProcess.once('error', onProcessError);
      })
    : null;

  try {
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
      const wsEndpoint = await (processError
        ? Promise.race([checkDebugPort(port, Math.min(remaining, DEBUG_PORT_MAX_HTTP_TIMEOUT_MS)), processError])
        : checkDebugPort(port, Math.min(remaining, DEBUG_PORT_MAX_HTTP_TIMEOUT_MS)));
      if (wsEndpoint) return wsEndpoint;
      if (attempts % DEBUG_PORT_PROGRESS_LOG_INTERVAL === 0) {
        const elapsed = timeout - remaining;
        console.error(`[Launcher] Debug port ${port} not ready yet ` + `(attempt ${attempts}, elapsed ${elapsed}ms, remaining ${Math.max(0, deadline - Date.now())}ms)`);
      }
      const remainingAfterProbe = deadline - Date.now();
      if (remainingAfterProbe <= 0) throw new DebugPortTimeoutError(port, timeout, attempts);
      const sleepFor = Math.min(backoff, DEBUG_PORT_MAX_BACKOFF_MS, Math.max(0, remainingAfterProbe - 1));
      if (sleepFor > 0) {
        await (processError
          ? Promise.race([new Promise((r) => setTimeout(r, sleepFor)), processError])
          : new Promise((r) => setTimeout(r, sleepFor)));
      }
      backoff = Math.min(backoff * DEBUG_PORT_BACKOFF_FACTOR, DEBUG_PORT_MAX_BACKOFF_MS);
    }
    throw new DebugPortTimeoutError(port, timeout, attempts);
  } finally {
    if (canObserveProcessError && onProcessError) chromeProcess.off('error', onProcessError);
  }
}
