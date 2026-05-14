/**
 * Structured logging wrapper for `notifications/message` (#870).
 *
 * Modules emit log events via `log.info/log.warning/log.error/log.debug`. When
 * an MCP server is wired up via `setLogSender`, events at or above the active
 * level are converted to `notifications/message` notifications. Events below
 * the active level are dropped (per MCP spec).
 *
 * Fallback to `console.error` happens when:
 *   - No MCP sender is wired (e.g. server has not booted yet).
 *   - The event level is `error` — operators get a copy on stderr regardless
 *     of whether a client is listening or what level the client requested.
 *   - The sender call itself throws (best-effort isolation).
 *
 * The wrapper deliberately stays process-global. Per-session level state is a
 * follow-up; for the dominant stdio use case there is one client per process
 * so the process-wide level is equivalent. HTTP clients today still receive
 * notifications — but every connected session gets the same level. This is
 * called out in the issue (#870) and is acceptable for v1.
 *
 * Security: the wrapper does no automatic data sanitization. Call sites must
 * not pass secrets (Bearer tokens, JWT payloads, X-API-Key headers, cookies)
 * in `data`. See `tests/unit/log.test.ts` for the leakage smoke test.
 */

import { MCPErrorCodes } from '../types/mcp';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

/** MCP-spec ranking (lower = more verbose). */
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
};

/**
 * Sender signature — wired by MCPServer to its `sendNotification` path.
 * `logger` is a stable identifier (e.g. `captcha`, `event-loop`); `data` is the
 * MCP-spec free-form payload (structured object, NOT a stringified message).
 */
export type LogSender = (level: LogLevel, logger: string, data: Record<string, unknown>) => void;

let activeSender: LogSender | null = null;
let activeLevel: LogLevel = 'info';

/** Wire (or unwire) the MCP-side sender. Call with `null` to disable. */
export function setLogSender(sender: LogSender | null): void {
  activeSender = sender;
}

/** Switch the minimum emission level. Drops out-of-range values silently. */
export function setLogLevel(level: string): boolean {
  if (level === 'debug' || level === 'info' || level === 'warning' || level === 'error') {
    activeLevel = level;
    return true;
  }
  return false;
}

/** Current active level — exposed for the `logging/setLevel` reflector and tests. */
export function getLogLevel(): LogLevel {
  return activeLevel;
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[activeLevel];
}

function emit(level: LogLevel, logger: string, message: string, data?: Record<string, unknown>): void {
  const payload: Record<string, unknown> = { message };
  if (data !== undefined) payload.data = data;

  if (activeSender && shouldEmit(level)) {
    try {
      activeSender(level, logger, payload);
    } catch (err) {
      // Best-effort isolation: a wedged transport must not break callers.
      console.error('[log] notification emit failed:', err);
    }
  }

  // Always mirror `error` to stderr so a disconnected client cannot silence
  // operator-visible failures. Also fall back to stderr when no sender is
  // wired yet (typical during boot).
  if (level === 'error' || !activeSender) {
    const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : '';
    console.error(`[${logger}] ${level}: ${message}${dataStr}`);
  }
}

export const log = {
  debug(logger: string, message: string, data?: Record<string, unknown>): void {
    emit('debug', logger, message, data);
  },
  info(logger: string, message: string, data?: Record<string, unknown>): void {
    emit('info', logger, message, data);
  },
  warning(logger: string, message: string, data?: Record<string, unknown>): void {
    emit('warning', logger, message, data);
  },
  error(logger: string, message: string, data?: Record<string, unknown>): void {
    emit('error', logger, message, data);
  },
};

/**
 * Builds an MCP error response for malformed `logging/setLevel` requests. Returns
 * `null` when the input level is valid so the caller can use a truthy check.
 */
export function logLevelSetErrorOrNull(level: unknown): { code: number; message: string } | null {
  if (typeof level !== 'string') {
    return { code: MCPErrorCodes.INVALID_PARAMS, message: 'logging/setLevel: `level` must be a string' };
  }
  if (!setLogLevel(level)) {
    return {
      code: MCPErrorCodes.INVALID_PARAMS,
      message: `logging/setLevel: unknown level '${level}'. Allowed: debug, info, warning, error.`,
    };
  }
  return null;
}
