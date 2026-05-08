/**
 * Per-domain skill graph storage.
 *
 * One SQLite database per domain at `<rootDir>/<domain>.db`. This keeps
 * concurrent activity on different domains fully independent — only writes
 * to the same domain serialise via SQLite's WAL + `BEGIN IMMEDIATE`.
 *
 * Schema (v1):
 *   nodes(state_hash PK, evidence_blob, thumbnail_path, last_seen_at,
 *         visit_count)
 *   edges(from_state, action_kind, action_args_norm,
 *         to_state_distribution JSON, success_count, fail_count,
 *         last_failed_at, PRIMARY KEY(from_state, action_kind, action_args_norm))
 *
 * `to_state_distribution` is included from day one (per #702 v2) so
 * #703's executor can match against a multi-state distribution without
 * a follow-up migration.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

CREATE TABLE IF NOT EXISTS nodes (
  state_hash     TEXT PRIMARY KEY,
  evidence_blob  TEXT,            -- JSON
  thumbnail_path TEXT,
  last_seen_at   INTEGER NOT NULL,
  visit_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS edges (
  from_state            TEXT NOT NULL,
  action_kind           TEXT NOT NULL,
  action_args_norm      TEXT NOT NULL,
  to_state_distribution TEXT NOT NULL DEFAULT '[]',  -- JSON: Array<{to_state, count}>
  success_count         INTEGER NOT NULL DEFAULT 0,
  fail_count            INTEGER NOT NULL DEFAULT 0,
  last_failed_at        INTEGER,
  PRIMARY KEY (from_state, action_kind, action_args_norm),
  FOREIGN KEY (from_state) REFERENCES nodes(state_hash)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_state);
`;

/** A row from `nodes`. */
export interface SkillNode {
  stateHash: string;
  evidence?: unknown;
  thumbnailPath?: string;
  lastSeenAt: number;
  visitCount: number;
}

/** A row from `edges`. */
export interface SkillEdge {
  fromState: string;
  actionKind: string;
  actionArgsNorm: string;
  /** Sorted (by count DESC) distribution of observed `to_state` outcomes. */
  toStateDistribution: ToStateDistribution;
  successCount: number;
  failCount: number;
  lastFailedAt?: number;
}

export type ToStateDistribution = Array<{ to_state: string; count: number }>;

/** Stats inspect summary returned by `inspect()`. */
export interface SkillGraphInspectSummary {
  domain: string;
  nodeCount: number;
  edgeCount: number;
  topEdgesByVisit: Array<{
    from: string;
    actionKind: string;
    successCount: number;
    failCount: number;
  }>;
  recentFailures: Array<{
    from: string;
    actionKind: string;
    failCount: number;
    lastFailedAt: number;
  }>;
}

export interface SkillGraphStorageOptions {
  rootDir?: string;
}

/** Default rootDir resolves to `${HOME}/.openchrome/skills`. */
export function defaultSkillGraphRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'skills');
}

/**
 * Single-domain handle. Multiple instances against the same `domain` are
 * safe; writes serialise on the WAL.
 */
export class SkillGraphStorage {
  private readonly rootDir: string;
  private readonly db: Database;
  readonly domain: string;

  constructor(domain: string, opts: SkillGraphStorageOptions = {}) {
    if (!domain || /[\\/]/.test(domain)) {
      throw new Error(`SkillGraphStorage: invalid domain "${domain}"`);
    }
    this.domain = domain;
    this.rootDir = opts.rootDir ?? defaultSkillGraphRootDir();
    fs.mkdirSync(this.rootDir, { recursive: true });
    const Sqlite = loadSqlite();
    this.db = new Sqlite(path.join(this.rootDir, `${domain}.db`));
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

  getSchemaVersion(): number {
    return CURRENT_SCHEMA_VERSION;
  }

  /** Insert or refresh a node. Increments visit_count on every call. */
  upsertNode(args: {
    stateHash: string;
    evidence?: unknown;
    thumbnailPath?: string;
    seenAt?: number;
  }): void {
    const seenAt = args.seenAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO nodes (state_hash, evidence_blob, thumbnail_path, last_seen_at, visit_count)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(state_hash) DO UPDATE SET
           evidence_blob  = COALESCE(excluded.evidence_blob,  evidence_blob),
           thumbnail_path = COALESCE(excluded.thumbnail_path, thumbnail_path),
           last_seen_at   = excluded.last_seen_at,
           visit_count    = visit_count + 1`,
      )
      .run(
        args.stateHash,
        args.evidence !== undefined ? JSON.stringify(args.evidence) : null,
        args.thumbnailPath ?? null,
        seenAt,
      );
  }

  /** Look up a node row. Returns undefined if not found. */
  getNode(stateHash: string): SkillNode | undefined {
    const row = this.db
      .prepare(
        'SELECT state_hash, evidence_blob, thumbnail_path, last_seen_at, visit_count FROM nodes WHERE state_hash = ?',
      )
      .get(stateHash) as
      | {
          state_hash: string;
          evidence_blob: string | null;
          thumbnail_path: string | null;
          last_seen_at: number;
          visit_count: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      stateHash: row.state_hash,
      evidence: row.evidence_blob ? JSON.parse(row.evidence_blob) : undefined,
      thumbnailPath: row.thumbnail_path ?? undefined,
      lastSeenAt: row.last_seen_at,
      visitCount: row.visit_count,
    };
  }

  /** Returns all nodes ordered by visit_count DESC. */
  listNodes(limit = 100): SkillNode[] {
    const rows = this.db
      .prepare(
        'SELECT state_hash, evidence_blob, thumbnail_path, last_seen_at, visit_count FROM nodes ORDER BY visit_count DESC LIMIT ?',
      )
      .all(limit) as Array<{
      state_hash: string;
      evidence_blob: string | null;
      thumbnail_path: string | null;
      last_seen_at: number;
      visit_count: number;
    }>;
    return rows.map((row) => ({
      stateHash: row.state_hash,
      evidence: row.evidence_blob ? JSON.parse(row.evidence_blob) : undefined,
      thumbnailPath: row.thumbnail_path ?? undefined,
      lastSeenAt: row.last_seen_at,
      visitCount: row.visit_count,
    }));
  }

  /**
   * Record the outcome of executing an edge: increments success or fail
   * counters, appends to the to_state distribution, and creates the edge
   * row if it didn't exist. Atomic via SQLite transaction.
   *
   * The transaction runs in IMMEDIATE mode so the writer lock is acquired
   * before the leading SELECT. Without this, two same-domain writers on
   * separate connections can both observe the same snapshot and one will
   * fail with `SQLITE_BUSY_SNAPSHOT` (or hit a unique-key collision on
   * first insert) when upgrading to a write — silently dropping an
   * outcome event under concurrent agent activity. With IMMEDIATE the
   * second writer simply waits, matching the per-domain serialisation
   * contract documented in #702 v2.
   *
   * `observedToState` may be undefined when execution fails before the
   * page settles (e.g., navigation error). In that case the distribution
   * is not updated.
   */
  recordOutcome(args: {
    fromState: string;
    actionKind: string;
    actionArgsNorm: string;
    observedToState?: string;
    success: boolean;
    at?: number;
  }): void {
    const at = args.at ?? Date.now();
    const tx = this.db.transaction((a: typeof args) => {
      const existing = this.db
        .prepare(
          'SELECT to_state_distribution, success_count, fail_count FROM edges WHERE from_state = ? AND action_kind = ? AND action_args_norm = ?',
        )
        .get(a.fromState, a.actionKind, a.actionArgsNorm) as
        | {
            to_state_distribution: string;
            success_count: number;
            fail_count: number;
          }
        | undefined;

      let dist: ToStateDistribution = existing
        ? (JSON.parse(existing.to_state_distribution) as ToStateDistribution)
        : [];
      if (a.observedToState) {
        const idx = dist.findIndex((entry) => entry.to_state === a.observedToState);
        if (idx >= 0) {
          dist[idx].count += 1;
        } else {
          dist.push({ to_state: a.observedToState, count: 1 });
        }
        // Keep distribution sorted by count DESC for cheap inspection.
        dist = dist.sort((p, q) => q.count - p.count);
      }

      if (existing) {
        this.db
          .prepare(
            `UPDATE edges
               SET to_state_distribution = ?,
                   success_count = success_count + ?,
                   fail_count    = fail_count + ?,
                   last_failed_at = CASE WHEN ? = 0 THEN ? ELSE last_failed_at END
             WHERE from_state = ? AND action_kind = ? AND action_args_norm = ?`,
          )
          .run(
            JSON.stringify(dist),
            a.success ? 1 : 0,
            a.success ? 0 : 1,
            a.success ? 1 : 0,
            at,
            a.fromState,
            a.actionKind,
            a.actionArgsNorm,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO edges
               (from_state, action_kind, action_args_norm, to_state_distribution,
                success_count, fail_count, last_failed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            a.fromState,
            a.actionKind,
            a.actionArgsNorm,
            JSON.stringify(dist),
            a.success ? 1 : 0,
            a.success ? 0 : 1,
            a.success ? null : at,
          );
      }
    });
    // Use IMMEDIATE so we take the writer lock before the leading SELECT.
    tx.immediate(args);
  }

  /** Look up a single edge row. */
  getEdge(args: {
    fromState: string;
    actionKind: string;
    actionArgsNorm: string;
  }): SkillEdge | undefined {
    const row = this.db
      .prepare(
        'SELECT from_state, action_kind, action_args_norm, to_state_distribution, success_count, fail_count, last_failed_at FROM edges WHERE from_state = ? AND action_kind = ? AND action_args_norm = ?',
      )
      .get(args.fromState, args.actionKind, args.actionArgsNorm) as
      | {
          from_state: string;
          action_kind: string;
          action_args_norm: string;
          to_state_distribution: string;
          success_count: number;
          fail_count: number;
          last_failed_at: number | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      fromState: row.from_state,
      actionKind: row.action_kind,
      actionArgsNorm: row.action_args_norm,
      toStateDistribution: JSON.parse(row.to_state_distribution) as ToStateDistribution,
      successCount: row.success_count,
      failCount: row.fail_count,
      lastFailedAt: row.last_failed_at ?? undefined,
    };
  }

  /**
   * All edges leaving the given state, ordered by historical success rate
   * (success / (success+fail)) DESC, with raw success_count as tiebreaker.
   * Used by the executor (#703) to pick the best next action.
   */
  edgesFrom(stateHash: string): SkillEdge[] {
    const rows = this.db
      .prepare(
        'SELECT from_state, action_kind, action_args_norm, to_state_distribution, success_count, fail_count, last_failed_at FROM edges WHERE from_state = ?',
      )
      .all(stateHash) as Array<{
      from_state: string;
      action_kind: string;
      action_args_norm: string;
      to_state_distribution: string;
      success_count: number;
      fail_count: number;
      last_failed_at: number | null;
    }>;
    const edges: SkillEdge[] = rows.map((row) => ({
      fromState: row.from_state,
      actionKind: row.action_kind,
      actionArgsNorm: row.action_args_norm,
      toStateDistribution: JSON.parse(row.to_state_distribution) as ToStateDistribution,
      successCount: row.success_count,
      failCount: row.fail_count,
      lastFailedAt: row.last_failed_at ?? undefined,
    }));
    edges.sort((a, b) => {
      const ar = successRate(a);
      const br = successRate(b);
      if (ar !== br) return br - ar;
      return b.successCount - a.successCount;
    });
    return edges;
  }

  /**
   * Diagnostic snapshot consumed by `oc skill inspect` (PR-3) or any
   * programmatic UI. Cheap to compute — single aggregate queries.
   */
  inspect(): SkillGraphInspectSummary {
    const nodeCount = (this.db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n;
    const edgeCount = (this.db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n;
    const topRows = this.db
      .prepare(
        'SELECT from_state, action_kind, success_count, fail_count FROM edges ORDER BY success_count + fail_count DESC LIMIT 10',
      )
      .all() as Array<{
      from_state: string;
      action_kind: string;
      success_count: number;
      fail_count: number;
    }>;
    const failingRows = this.db
      .prepare(
        'SELECT from_state, action_kind, fail_count, last_failed_at FROM edges WHERE last_failed_at IS NOT NULL ORDER BY last_failed_at DESC LIMIT 10',
      )
      .all() as Array<{
      from_state: string;
      action_kind: string;
      fail_count: number;
      last_failed_at: number;
    }>;
    return {
      domain: this.domain,
      nodeCount,
      edgeCount,
      topEdgesByVisit: topRows.map((r) => ({
        from: r.from_state,
        actionKind: r.action_kind,
        successCount: r.success_count,
        failCount: r.fail_count,
      })),
      recentFailures: failingRows.map((r) => ({
        from: r.from_state,
        actionKind: r.action_kind,
        failCount: r.fail_count,
        lastFailedAt: r.last_failed_at,
      })),
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

function successRate(e: SkillEdge): number {
  const total = e.successCount + e.failCount;
  if (total === 0) return 0;
  return e.successCount / total;
}
