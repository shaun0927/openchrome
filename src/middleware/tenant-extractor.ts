/**
 * Tenant extraction for HTTP requests.
 *
 * Reads the `X-Tenant-Id` header (case-insensitive) and returns a validated
 * TenantId. In non-strict mode (default) a missing header falls back to
 * `DEFAULT_TENANT_ID` so stdio and single-user HTTP deployments keep working.
 * In strict mode the caller is responsible for rejecting the request with 400
 * via `TenantIdError` when `required = true`.
 *
 * This module is transport-agnostic: it only depends on a plain headers bag,
 * so both the HTTP transport and unit tests can feed it without a real server.
 */

import { DEFAULT_TENANT_ID, type TenantId } from '../tenant/types';

/** Canonical header name (lowercase). Node lowercases headers before lookup. */
export const TENANT_HEADER = 'x-tenant-id';

/**
 * Max length of a tenant identifier. 64 is enough for UUIDs and external
 * account IDs without becoming a memory / log-bloat attack vector.
 */
export const MAX_TENANT_ID_LENGTH = 64;

/**
 * Allowed tenant ID format: starts with alphanumeric, then alphanumerics
 * plus `-` and `_`. Deliberately excludes `/`, `\`, `.`, whitespace, and
 * shell / path-traversal metacharacters.
 */
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export class TenantIdError extends Error {
  readonly code: 'missing' | 'invalid';
  constructor(code: 'missing' | 'invalid', message: string) {
    super(message);
    this.name = 'TenantIdError';
    this.code = code;
  }
}

/**
 * Flexible headers type so callers can pass `IncomingHttpHeaders`, a plain
 * `Record<string, string>`, or a `Headers` instance (via toJSON-style object).
 */
export type TenantHeaders = Record<string, string | string[] | undefined>;

export interface TenantExtractionOptions {
  /**
   * When true, a missing `X-Tenant-Id` header throws `TenantIdError('missing')`
   * instead of falling back to `DEFAULT_TENANT_ID`. Callers should map the
   * throw to HTTP 400. Leave false for stdio / single-user compat.
   */
  required?: boolean;
}

/**
 * Validate a raw tenant id string. Throws `TenantIdError('invalid')` on
 * failure. Returns the normalized id (trimmed) on success.
 */
export function assertValidTenantId(raw: string): TenantId {
  const value = raw.trim();
  if (value.length === 0) {
    throw new TenantIdError('invalid', 'tenant id must not be empty');
  }
  if (value.length > MAX_TENANT_ID_LENGTH) {
    throw new TenantIdError(
      'invalid',
      `tenant id exceeds max length (${MAX_TENANT_ID_LENGTH})`,
    );
  }
  if (!TENANT_ID_PATTERN.test(value)) {
    throw new TenantIdError(
      'invalid',
      'tenant id must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',
    );
  }
  return value;
}

function readHeader(headers: TenantHeaders, name: string): string | undefined {
  const direct = headers[name];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && direct.length > 0) return direct[0];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) {
      const v = headers[key];
      if (typeof v === 'string') return v;
      if (Array.isArray(v) && v.length > 0) return v[0];
    }
  }
  return undefined;
}

/**
 * Extract the tenant id from an HTTP request's headers.
 *
 * - If the header is present → validate + return it.
 * - If the header is missing:
 *    - `options.required === true` → throw `TenantIdError('missing')`.
 *    - otherwise → return `DEFAULT_TENANT_ID`.
 */
export function extractTenantId(
  headers: TenantHeaders,
  options: TenantExtractionOptions = {},
): TenantId {
  const raw = readHeader(headers, TENANT_HEADER);
  if (raw === undefined) {
    if (options.required) {
      throw new TenantIdError(
        'missing',
        `missing required ${TENANT_HEADER.toUpperCase()} header`,
      );
    }
    return DEFAULT_TENANT_ID;
  }
  return assertValidTenantId(raw);
}
