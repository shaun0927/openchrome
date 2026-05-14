/**
 * Canonical SHA-256 hash of normalised tool arguments (#879).
 *
 * The snapshot cache key includes a `paramsHash`. We canonicalise the
 * input so that:
 *   - field ordering does not matter (`{ a, b }` and `{ b, a }` hash to
 *     the same value);
 *   - volatile / trace-only fields (`caller_trace_id`, `_seq`) are
 *     stripped before hashing so they never participate in cache
 *     identity;
 *   - per-tool allow-lists prevent silent drift: every contributing
 *     field is enumerated in JSDoc for that tool's wrapper.
 *
 * The hash is plain `crypto.createHash('sha256')` — no external deps,
 * portable under the harness contract (P5).
 */

import { createHash } from 'node:crypto';

type Json = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [k: string]: Json };
type JsonArray = readonly Json[];

/** Canonical JSON: object keys sorted lexicographically, no whitespace. */
function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalise).join(',') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      '{' +
      entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalise(v)).join(',') +
      '}'
    );
  }
  // numbers, symbols, functions etc. — coerce defensively.
  return JSON.stringify(String(value));
}

/**
 * Compute the SHA-256 hex of the canonical JSON form of `args`. Returns
 * a 64-character lowercase hex string. Always stable across calls.
 */
export function paramsHash(args: unknown): string {
  return createHash('sha256').update(canonicalise(args)).digest('hex');
}

/**
 * Pick a fixed allow-list of fields from `args` and hash the resulting
 * subset. Fields with `undefined` values are dropped (so adding an
 * unrelated optional field cannot change an existing call's hash).
 *
 * @param args The raw tool arguments.
 * @param allowList The exact set of normalised field names that
 *   contribute to cache identity. Documented per-tool in the caller.
 */
export function paramsHashFromArgs(
  args: Record<string, unknown>,
  allowList: readonly string[],
): string {
  const subset: Record<string, unknown> = {};
  for (const field of allowList) {
    const value = args[field];
    if (value !== undefined) subset[field] = value;
  }
  return paramsHash(subset);
}

/**
 * Allow-list for `read_page` cache identity.
 *
 * Contributing fields: `mode`, `filter`, `depth`, `ref_id`, `selector`,
 * `compression`, `fallback`, `includePagination`.
 *
 * Volatile fields explicitly excluded:
 *   - `tabId` (tab identity is captured by the cache registry).
 *   - `caller_trace_id`, `_seq` (trace identifiers).
 */
export const READ_PAGE_PARAMS = Object.freeze([
  'mode',
  'filter',
  'depth',
  'ref_id',
  'selector',
  'compression',
  'fallback',
  'includePagination',
] as const);

/**
 * Allow-list for `find` cache identity.
 *
 * Contributing fields: `query`, `waitForMs`, `pollInterval`,
 * `vision_fallback`.
 */
export const FIND_PARAMS = Object.freeze([
  'query',
  'waitForMs',
  'pollInterval',
  'vision_fallback',
] as const);

/**
 * Allow-list for `query_dom` cache identity.
 *
 * Contributing fields: `method`, `selector`, `xpath`, `multiple`,
 * `pierceShadow`, `limit`.
 */
export const QUERY_DOM_PARAMS = Object.freeze([
  'method',
  'selector',
  'xpath',
  'multiple',
  'pierceShadow',
  'limit',
] as const);
