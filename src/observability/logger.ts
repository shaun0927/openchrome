/**
 * Structured logger wrapper that prefixes every line with the active request
 * correlation ID when one is available.
 *
 * Usage:
 *   import { log } from './observability/logger';
 *   log.error('[mcp-server] tool failed:', err);
 *
 * Writes to stderr (console.error) — never stdout, which carries the MCP
 * JSON-RPC stream on stdio transport. Format:
 *   [req=0193abc-1234] [mcp-server] tool failed: ...
 *
 * When no RequestContext is active (stdio startup, background tasks), the
 * prefix is omitted so existing log greps keep working.
 */
import { currentRequestId } from './request-id';

function emit(args: unknown[]): void {
  const rid = currentRequestId();
  if (rid) {
    console.error(`[req=${rid}]`, ...args);
  } else {
    console.error(...args);
  }
}

export const log = {
  error(...args: unknown[]): void { emit(args); },
  warn(...args: unknown[]): void { emit(args); },
  info(...args: unknown[]): void { emit(args); },
};
