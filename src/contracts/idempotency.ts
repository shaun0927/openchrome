/**
 * Idempotency cache for Outcome Contract transactions.
 *
 * Per #706 v2:
 *   - Cache **only success** verdicts. A cached `postcondition_violation`
 *     is intentionally NOT honored — page state may have changed; re-run.
 *   - Cache key = sha256(canonical(contract) + canonical(args)). Caller
 *     supplies a stable `contract.idempotency_key` so logically-identical
 *     transactions hash the same.
 *   - 24h TTL via `used_at` mtime sweep on read. Storage at
 *     `~/.openchrome/transactions/idempotency.sqlite`.
 *   - "Used at" advances on every cache hit so popular keys stay hot.
 *
 * The store is intentionally separate from the audit log — the audit log
 * is append-only history; this cache is mutable working state.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Contract, TransactionRecord } from './runtime';

type BetterSqlite3 = typeof import('better-sqlite3');
type Database = import('better-sqlite3').Database;

let _Sqlite: BetterSqlite3 | null = null;
function loadSqlite(): BetterSqlite3 {
  if (_Sqlite) return _Sqlite;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _Sqlite = require('better-sqlite3') as BetterSqlite3;
  return _Sqlite;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS idempotency_cache (
  key         TEXT PRIMARY KEY,
  txn_id      TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  used_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_used_at ON idempotency_cache(used_at);
`;

export interface IdempotencyStoreOptions {
  rootDir?: string;
  /** TTL in ms; defaults to 24h. */
  ttlMs?: number;
  /** Test hook: clock. */
  now?: () => number;
}

export function defaultIdempotencyRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'transactions');
}

/**
 * Canonical-JSON helper: object keys sorted recursively. Stable across
 * authoring order — safe for hashing as the cache key input.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Derive the cache key for a (contract, args) pair. Operator-supplied
 * `contract.idempotency_key` is the primary uniqueness scope; the
 * canonical-JSON hash makes equivalent contract+args pairs collide
 * regardless of property authoring order.
 *
 * `hookActive` must be `!!args.beforeIrreversibleAction` at the call
 * site. A critical contract cached when no hook was configured MUST NOT
 * be replayed after a hook is enabled — the new safety gate would be
 * silently skipped. Including hook participation in the key ensures that
 * enabling a hook invalidates prior cached results for those contracts.
 */
export function computeIdempotencyKey(
  contract: Contract,
  args?: unknown,
  hookActive?: boolean,
): string {
  const subject = canonicalJson({
    idempotency_key: contract.idempotency_key ?? null,
    contract_id: contract.id,
    pre: contract.pre,
    post: contract.post,
    on_fail: contract.on_fail,
    // critical gates whether beforeIrreversibleAction fires; a cached
    // non-critical success MUST NOT short-circuit a critical run that
    // would invoke the voting hook. Include it in the key so they are
    // stored and retrieved independently.
    critical: contract.critical ?? false,
    // hook_active distinguishes "hook configured at call time" from
    // "no hook". A cached result from a hookless run must not be replayed
    // after a hook is introduced during gradual rollout.
    hook_active: hookActive ?? false,
    args: args ?? null,
  });
  return crypto.createHash('sha256').update(subject).digest('hex');
}

export interface IdempotencyStore {
  /** Read a cached record. Side-effect: bumps `used_at` on hit. */
  get(key: string): TransactionRecord | undefined;
  /** Write a record. Caller MUST only call on `verdict === 'success'`. */
  put(key: string, record: TransactionRecord): void;
  /** Sweep entries older than `beforeMs`. Returns count purged. */
  purgeOlderThan(beforeMs: number): number;
  close(): void;
}

/**
 * SQLite-backed idempotency store. Reads sweep stale entries lazily so
 * callers don't pay a separate cron's worth of latency.
 */
export class SqliteIdempotencyStore implements IdempotencyStore {
  private readonly db: Database;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: IdempotencyStoreOptions = {}) {
    const rootDir = opts.rootDir ?? defaultIdempotencyRootDir();
    fs.mkdirSync(rootDir, { recursive: true });
    const Sqlite = loadSqlite();
    this.db = new Sqlite(path.join(rootDir, 'idempotency.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA_V1);
    this.ttlMs = opts.ttlMs ?? ONE_DAY_MS;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): TransactionRecord | undefined {
    const t = this.now();
    // Sweep before read so a hit always reflects a non-stale row.
    this.purgeOlderThan(t - this.ttlMs);
    const row = this.db
      .prepare('SELECT record_json FROM idempotency_cache WHERE key = ?')
      .get(key) as { record_json: string } | undefined;
    if (!row) return undefined;
    this.db.prepare('UPDATE idempotency_cache SET used_at = ? WHERE key = ?').run(t, key);
    try {
      return JSON.parse(row.record_json) as TransactionRecord;
    } catch {
      // Malformed row — treat as miss (defensive)
      return undefined;
    }
  }

  put(key: string, record: TransactionRecord): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO idempotency_cache (key, txn_id, record_json, created_at, used_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           txn_id      = excluded.txn_id,
           record_json = excluded.record_json,
           used_at     = excluded.used_at`,
      )
      .run(key, record.txn_id, JSON.stringify(record), t, t);
  }

  purgeOlderThan(beforeMs: number): number {
    const r = this.db
      .prepare('DELETE FROM idempotency_cache WHERE used_at < ?')
      .run(beforeMs);
    return r.changes;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}
