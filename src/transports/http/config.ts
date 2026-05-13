import {
  DEFAULT_HTTP_JSON_RPC_BATCH_MAX_CONCURRENCY,
  DEFAULT_HTTP_JSON_RPC_BATCH_MAX_SIZE,
} from '../../config/defaults';

/** Maximum allowed HTTP request body size (10 MB) to prevent OOM from oversized requests */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** SSE keepalive ping interval in milliseconds */
export const SSE_KEEPALIVE_INTERVAL_MS = 30_000;

// ─── Request/socket timeouts (Slowloris defense) ─────────────────────────
// Node's http.Server has two of these built-in (requestTimeout,
// headersTimeout, keepAliveTimeout) but their defaults vary across Node
// versions and platforms. Explicit values make behavior deterministic.
// All values in milliseconds; override via OPENCHROME_HTTP_* env vars.

/** Max wall time between accepting the connection and finishing the request. */
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;
/** Max time to receive the full request headers. */
const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10_000;
/** Idle timeout between keep-alive requests on the same connection. */
const DEFAULT_HTTP_KEEPALIVE_TIMEOUT_MS = 5_000;
/** Per-socket idle timeout (triggers automatic socket destroy). */
const DEFAULT_HTTP_SOCKET_TIMEOUT_MS = 60_000;
/** Max time to receive the full request body after headers. */
const DEFAULT_HTTP_BODY_TIMEOUT_MS = 15_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const HTTP_REQUEST_TIMEOUT_MS = envInt('OPENCHROME_HTTP_REQUEST_TIMEOUT_MS', DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
export const HTTP_HEADERS_TIMEOUT_MS = envInt('OPENCHROME_HTTP_HEADERS_TIMEOUT_MS', DEFAULT_HTTP_HEADERS_TIMEOUT_MS);
export const HTTP_KEEPALIVE_TIMEOUT_MS = envInt('OPENCHROME_HTTP_KEEPALIVE_TIMEOUT_MS', DEFAULT_HTTP_KEEPALIVE_TIMEOUT_MS);
export const HTTP_SOCKET_TIMEOUT_MS = envInt('OPENCHROME_HTTP_SOCKET_TIMEOUT_MS', DEFAULT_HTTP_SOCKET_TIMEOUT_MS);
export const HTTP_BODY_TIMEOUT_MS = envInt('OPENCHROME_HTTP_BODY_TIMEOUT_MS', DEFAULT_HTTP_BODY_TIMEOUT_MS);
export const HTTP_JSON_RPC_BATCH_MAX_SIZE = envInt(
  'OPENCHROME_HTTP_JSON_RPC_BATCH_MAX_SIZE',
  DEFAULT_HTTP_JSON_RPC_BATCH_MAX_SIZE,
);
export const HTTP_JSON_RPC_BATCH_MAX_CONCURRENCY = Math.max(
  1,
  envInt(
    'OPENCHROME_HTTP_JSON_RPC_BATCH_MAX_CONCURRENCY',
    DEFAULT_HTTP_JSON_RPC_BATCH_MAX_CONCURRENCY,
  ),
);

/** Exported for tests to assert current effective values. */
export const HTTP_TIMEOUTS = Object.freeze({
  requestTimeoutMs: HTTP_REQUEST_TIMEOUT_MS,
  headersTimeoutMs: HTTP_HEADERS_TIMEOUT_MS,
  keepAliveTimeoutMs: HTTP_KEEPALIVE_TIMEOUT_MS,
  socketTimeoutMs: HTTP_SOCKET_TIMEOUT_MS,
  bodyTimeoutMs: HTTP_BODY_TIMEOUT_MS,
  jsonRpcBatchMaxSize: HTTP_JSON_RPC_BATCH_MAX_SIZE,
  jsonRpcBatchMaxConcurrency: HTTP_JSON_RPC_BATCH_MAX_CONCURRENCY,
});
