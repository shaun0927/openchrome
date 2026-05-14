/**
 * Request correlation ID utilities.
 *
 * Every inbound MCP request is tagged with a requestId that is propagated
 * across metrics labels, audit log entries, and log lines, so operators can
 * trace a single request end-to-end. IDs follow UUID v7
 * (draft-ietf-uuidrev-rfc4122bis): 48-bit Unix millisecond timestamp + 12-bit
 * random + 4-bit version + 62 random bits — lexicographically sortable.
 */
import * as crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Canonical header name for request correlation IDs. */
export const REQUEST_ID_HEADER = 'X-Request-Id';
/** Lower-cased variant for Node's IncomingHttpHeaders lookups. */
export const REQUEST_ID_HEADER_LOWER = 'x-request-id';

/** Max accepted length for a client-supplied request ID. */
export const MAX_REQUEST_ID_LEN = 128;

/**
 * Accept ASCII letters, digits, and a small set of delimiters. This keeps IDs
 * safe to embed in Prometheus label values and log prefixes without escaping.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Generate a UUID v7 (48-bit ms timestamp + random).
 * Node's crypto.randomUUID() produces v4; we need v7 for time ordering.
 */
export function generateRequestId(): string {
  const bytes = crypto.randomBytes(16);
  const ms = BigInt(Date.now());

  // Bytes 0-5: big-endian 48-bit millisecond timestamp
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  // Byte 6: version (0111) in high nibble
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Byte 8: variant (10) in high bits
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Validate and normalise a client-supplied request ID. Returns the trimmed
 * value when it matches the allowed pattern and fits within the length limit,
 * otherwise returns null so the caller can generate a fresh ID.
 */
export function normalizeRequestId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_REQUEST_ID_LEN) return null;
  if (!REQUEST_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve the request ID for an inbound request: honour a well-formed client
 * header, otherwise generate a new UUID v7.
 */
export function resolveRequestId(headerValue: unknown): string {
  return normalizeRequestId(headerValue) ?? generateRequestId();
}

/**
 * Context carried through the async call tree for the duration of a single
 * request. Lets deep-nested code (audit log, logger, metrics) attach the
 * correlation ID without threading it through every function signature.
 */
export interface RequestContext {
  requestId: string;
  /** tenantId flows in here once B-1/B-3 land; defaults to 'unknown'. */
  tenantId?: string;
  /** keyId (hashed) when per-tenant auth identifies a specific API key. */
  keyId?: string;
  /** HTTP MCP session id when the transport provides one. */
  mcpSessionId?: string;
}

const requestStore = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `ctx` bound as the active request context. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestStore.run(ctx, fn);
}

/** Get the active request context, if any. */
export function currentRequestContext(): RequestContext | undefined {
  return requestStore.getStore();
}

/** Get just the active requestId, if any. */
export function currentRequestId(): string | undefined {
  return requestStore.getStore()?.requestId;
}
