/**
 * Standard pagination helper for paginated tool results (#881).
 *
 * Convention (mirrors MCP spec opaque-cursor pagination already used for
 * `tools/list` / `resources/list`):
 *
 *   input:  optional `cursor: string` (opaque to clients)
 *   output (inside `structuredContent`):
 *     {
 *       items: T[],          // or a tool-specific top-level key
 *       nextCursor?: string, // present iff hasMore is true
 *       hasMore: boolean,    // duplicates "nextCursor != null" for clarity
 *       total: number,       // cheap-to-compute total of the underlying set
 *     }
 *
 * Cursor encoding: base64url JSON `{ v: 1, offset: number, hash?: string }`.
 * Including an optional content hash lets the server detect cursor reuse on
 * stale data and reject explicitly — a stale cursor returns a JSON-RPC
 * `-32003` error rather than a silent reset (clients should auto-retry from
 * the start instead of surfacing a tool error to the LLM).
 *
 * The helper is intentionally `T[]`-only at this layer — cursor semantics
 * for char-offset paginated outputs (e.g. `read_page` text) live in the
 * adopting tool, using the same encode/decode primitives.
 */

const CURSOR_VERSION = 1;
const DEFAULT_MAX_SAMPLES = 10;

export interface PaginateOpts {
  /** Caller-provided cursor; absent for the first page. */
  cursor?: string;
  /** Items per page. Must be > 0. */
  pageSize: number;
  /**
   * Optional content hash of the underlying input set. When supplied, the
   * helper compares it to the cursor's recorded hash; a mismatch surfaces as
   * `staleCursor: true` so the dispatcher can convert it to a JSON-RPC
   * `-32003` error. Skip the hash for unstable / streamed datasets — the
   * cursor becomes a pure offset reference.
   */
  contentHash?: string;
}

export interface CursorState {
  v: 1;
  offset: number;
  hash?: string;
}

export interface PaginateResult<T> {
  items: T[];
  /** Present iff there are more pages. Opaque to callers. */
  nextCursor?: string;
  /** Duplicates `nextCursor != null` for clarity in the wire format. */
  hasMore: boolean;
  /** Total items in the underlying set, including pages already consumed. */
  total: number;
  /**
   * Set when the incoming cursor referenced a different content hash than the
   * current input set. The dispatcher should reject the call with JSON-RPC
   * code `-32003` (data: `{ code: 'stale_cursor', retry: 'restart_from_no_cursor' }`).
   */
  staleCursor?: true;
}

/** Stable base64url encode (Node 16+). */
function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** Stable base64url decode. Throws on malformed input. */
function fromBase64Url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

export function encodeCursor(state: { offset: number; hash?: string }): string {
  if (!Number.isInteger(state.offset) || state.offset < 0) {
    throw new Error(`encodeCursor: offset must be a non-negative integer, got ${state.offset}`);
  }
  const obj: CursorState = { v: CURSOR_VERSION, offset: state.offset };
  if (state.hash !== undefined) obj.hash = state.hash;
  return toBase64Url(JSON.stringify(obj));
}

/**
 * Decode a previously-emitted cursor. Throws `Error('invalid_cursor')` on
 * any structural problem (bad base64, bad JSON, missing/wrong version,
 * non-integer offset). The caller should map that error to JSON-RPC
 * `-32602` (Invalid params).
 */
export function decodeCursor(cursor: string): CursorState {
  let decoded: unknown;
  try {
    decoded = JSON.parse(fromBase64Url(cursor));
  } catch {
    throw new Error('invalid_cursor');
  }
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    (decoded as { v?: unknown }).v !== CURSOR_VERSION ||
    !Number.isInteger((decoded as { offset?: unknown }).offset) ||
    (decoded as { offset: number }).offset < 0
  ) {
    throw new Error('invalid_cursor');
  }
  const out: CursorState = { v: CURSOR_VERSION, offset: (decoded as { offset: number }).offset };
  if (typeof (decoded as { hash?: unknown }).hash === 'string') {
    out.hash = (decoded as { hash: string }).hash;
  }
  return out;
}

/**
 * Slice a stable array into a page. The caller is responsible for ensuring
 * the input ordering is deterministic across pages (the cursor records only
 * the offset, not the ordering rule).
 */
export function paginate<T>(items: readonly T[], opts: PaginateOpts): PaginateResult<T> {
  if (!Number.isInteger(opts.pageSize) || opts.pageSize <= 0) {
    throw new Error(`paginate: pageSize must be a positive integer, got ${opts.pageSize}`);
  }

  let offset = 0;
  if (opts.cursor !== undefined) {
    const state = decodeCursor(opts.cursor);
    // Stale-cursor detection: if the caller is tracking content hash and the
    // cursor's recorded hash diverges, the underlying set has changed.
    if (opts.contentHash !== undefined && state.hash !== undefined && state.hash !== opts.contentHash) {
      return { items: [], hasMore: false, total: items.length, staleCursor: true };
    }
    offset = state.offset;
  }

  const end = Math.min(offset + opts.pageSize, items.length);
  const slice = items.slice(offset, end);
  const hasMore = end < items.length;
  const result: PaginateResult<T> = {
    items: slice,
    hasMore,
    total: items.length,
  };
  if (hasMore) {
    result.nextCursor = encodeCursor({ offset: end, hash: opts.contentHash });
  }
  return result;
}

/** Convenience for telemetry / debug-only summarization. */
export function summarizeCursor(cursor: string | undefined): string {
  if (!cursor) return '(none)';
  try {
    const s = decodeCursor(cursor);
    return `cursor(v${s.v}, offset=${s.offset}${s.hash ? `, hash=${s.hash.slice(0, 8)}` : ''})`;
  } catch {
    return `cursor(invalid)`;
  }
}

export const DEFAULT_MAX_PAGINATE_SAMPLES = DEFAULT_MAX_SAMPLES;
