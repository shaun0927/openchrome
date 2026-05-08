/**
 * Trace storage backend.
 *
 * Two surfaces:
 *   • A SQLite index at `<rootDir>/index.sqlite` for fast `oc trace list`
 *     queries (status, domain, since, limit).
 *   • Per-session JSONL files under `<rootDir>/<sessionId>/<ts>-<seq>.jsonl`
 *     containing the actual event stream.
 *
 * The recorder (PR-2) is responsible for batching events and calling
 * `appendEvents` periodically. This module only handles persistence.
 *
 * The SQLite library (`better-sqlite3`) is loaded lazily so consumers that
 * never invoke trace storage do not pay its startup cost.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  TraceEvent,
  TraceListFilter,
  TraceSessionMeta,
  TraceStatus,
} from './types';

// Lazy import — `better-sqlite3` carries a native binding; we don't want to
// pay its cost (or fail tests) when storage is not actually used.
type BetterSqlite3 = typeof import('better-sqlite3');
type Database = import('better-sqlite3').Database;

let _Sqlite: BetterSqlite3 | null = null;
function loadSqlite(): BetterSqlite3 {
  if (_Sqlite) return _Sqlite;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _Sqlite = require('better-sqlite3') as BetterSqlite3;
  return _Sqlite;
}

const CURRENT_SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS applied_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
  session_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  domain     TEXT,
  status     TEXT NOT NULL,
  byte_size  INTEGER NOT NULL DEFAULT 0,
  parent_op  TEXT
);

CREATE INDEX IF NOT EXISTS idx_traces_started_at ON traces(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_status     ON traces(status);
CREATE INDEX IF NOT EXISTS idx_traces_domain     ON traces(domain);
`;

export interface TraceStorageOptions {
  /** Root directory for the index DB and per-session JSONL files. */
  rootDir?: string;
}

export interface AppendResult {
  /** Bytes appended in this call. */
  bytes: number;
  /** Path of the JSONL file written to. */
  filePath: string;
}

/** Default rootDir resolves to `${HOME}/.openchrome/traces`. */
export function defaultTraceRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'traces');
}

/**
 * Opaque handle to the trace store. Multiple instances against the same
 * `rootDir` are safe — SQLite WAL mode handles concurrent readers, and
 * filesystem appends are O_APPEND atomic for sub-PIPE_BUF writes.
 */
export class TraceStorage {
  private readonly rootDir: string;
  private readonly db: Database;
  /** Last-flush sequence per session, used to derive the JSONL filename. */
  private readonly seqCounters = new Map<string, number>();

  constructor(opts: TraceStorageOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultTraceRootDir();
    fs.mkdirSync(this.rootDir, { recursive: true });
    const Sqlite = loadSqlite();
    this.db = new Sqlite(path.join(this.rootDir, 'index.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.applyMigrations();
  }

  private applyMigrations(): void {
    this.db.exec(SCHEMA_V1);
    const applied = (this.db.prepare('SELECT version FROM applied_migrations').all() as { version: number }[])
      .map((r) => r.version);
    if (!applied.includes(1)) {
      this.db
        .prepare('INSERT INTO applied_migrations (version, applied_at) VALUES (?, ?)')
        .run(1, Date.now());
    }
  }

  /** For tests / consumers that need to inspect schema state. */
  getSchemaVersion(): number {
    return CURRENT_SCHEMA_VERSION;
  }

  /**
   * Insert a row marking the start of a new trace session. When the same
   * `session_id` is reused (restart/retry flow), terminal fields are reset so
   * the row reflects the new session, not stale state from the previous run.
   */
  recordSessionStart(meta: Omit<TraceSessionMeta, 'byteSize'> & { byteSize?: number }): void {
    this.db
      .prepare(
        `INSERT INTO traces (session_id, started_at, ended_at, domain, status, byte_size, parent_op)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           started_at = excluded.started_at,
           ended_at   = excluded.ended_at,
           domain     = excluded.domain,
           status     = excluded.status,
           byte_size  = excluded.byte_size,
           parent_op  = excluded.parent_op`,
      )
      .run(
        meta.sessionId,
        meta.startedAt,
        meta.endedAt ?? null,
        meta.domain ?? null,
        meta.status,
        meta.byteSize ?? 0,
        meta.parentOp ?? null,
      );
    // Reset the in-process per-session sequence counter so a reused session
    // ID starts JSONL filenames at 1 again.
    this.seqCounters.delete(meta.sessionId);
  }

  /** Update terminal fields when a session ends. */
  recordSessionEnd(
    sessionId: string,
    args: { endedAt: number; status: TraceStatus; byteSize?: number },
  ): void {
    if (args.byteSize !== undefined) {
      this.db
        .prepare('UPDATE traces SET ended_at = ?, status = ?, byte_size = ? WHERE session_id = ?')
        .run(args.endedAt, args.status, args.byteSize, sessionId);
    } else {
      this.db
        .prepare('UPDATE traces SET ended_at = ?, status = ? WHERE session_id = ?')
        .run(args.endedAt, args.status, sessionId);
    }
  }

  /** Look up a single session row. */
  get(sessionId: string): TraceSessionMeta | undefined {
    const row = this.db
      .prepare(
        'SELECT session_id, started_at, ended_at, domain, status, byte_size, parent_op FROM traces WHERE session_id = ?',
      )
      .get(sessionId) as
      | {
          session_id: string;
          started_at: number;
          ended_at: number | null;
          domain: string | null;
          status: TraceStatus;
          byte_size: number;
          parent_op: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      domain: row.domain ?? undefined,
      status: row.status,
      byteSize: row.byte_size,
      parentOp: row.parent_op ?? undefined,
    };
  }

  /** Filter rows; defaults: limit=100, ordered by started_at DESC. */
  list(filter: TraceListFilter = {}): TraceSessionMeta[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filter.since !== undefined) {
      where.push('started_at >= ?');
      params.push(filter.since);
    }
    if (filter.domain) {
      where.push('domain = ?');
      params.push(filter.domain);
    }
    if (filter.status) {
      const arr = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }

    const limit = filter.limit ?? 100;
    const sql =
      'SELECT session_id, started_at, ended_at, domain, status, byte_size, parent_op FROM traces' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY started_at DESC LIMIT ?';

    const rows = this.db.prepare(sql).all(...params, limit) as Array<{
      session_id: string;
      started_at: number;
      ended_at: number | null;
      domain: string | null;
      status: TraceStatus;
      byte_size: number;
      parent_op: string | null;
    }>;

    return rows.map((row) => ({
      sessionId: row.session_id,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      domain: row.domain ?? undefined,
      status: row.status,
      byteSize: row.byte_size,
      parentOp: row.parent_op ?? undefined,
    }));
  }

  /**
   * Append a batch of events to the session's current JSONL file. Returns
   * the bytes written and the file path. Each event is serialised one-per-line.
   */
  appendEvents(sessionId: string, events: TraceEvent[]): AppendResult {
    if (events.length === 0) {
      return { bytes: 0, filePath: '' };
    }
    // Verify the session is registered before touching disk. Without this
    // check the JSONL file would be written and orphaned: invisible to
    // get/list and never reclaimed by purgeOlderThan, leaking trace data.
    const exists = this.db
      .prepare('SELECT 1 FROM traces WHERE session_id = ?')
      .get(sessionId);
    if (!exists) {
      throw new Error(
        `TraceStorage.appendEvents: unknown session_id=${sessionId} (call recordSessionStart first)`,
      );
    }
    const sessionDir = path.join(this.rootDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const seq = (this.seqCounters.get(sessionId) ?? 0) + 1;
    this.seqCounters.set(sessionId, seq);
    const ts = events[0].ts;
    const filePath = path.join(sessionDir, `${ts}-${seq}.jsonl`);
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(filePath, lines, 'utf8');
    const bytes = Buffer.byteLength(lines, 'utf8');
    this.db
      .prepare('UPDATE traces SET byte_size = byte_size + ? WHERE session_id = ?')
      .run(bytes, sessionId);
    return { bytes, filePath };
  }

  /**
   * Delete trace sessions started before `beforeMs`. Removes both the index
   * row and the JSONL files. Returns the number of sessions purged.
   */
  purgeOlderThan(beforeMs: number): number {
    const rows = this.db
      .prepare('SELECT session_id FROM traces WHERE started_at < ?')
      .all(beforeMs) as { session_id: string }[];
    let purged = 0;
    for (const { session_id } of rows) {
      const dir = path.join(this.rootDir, session_id);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: keep going even if one session's files are locked.
        continue;
      }
      this.db.prepare('DELETE FROM traces WHERE session_id = ?').run(session_id);
      purged += 1;
    }
    return purged;
  }

  /** Close the underlying SQLite handle. Safe to call multiple times. */
  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed — ignore.
    }
  }
}
