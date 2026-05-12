/**
 * Trace storage backend (JSONL-only).
 *
 * Per portability-harness contract P5 (Native dependency discipline —
 * argon2 only), this storage layer uses plain filesystem primitives. The
 * previous design (closed PR #735) carried a `better-sqlite3` index DB
 * alongside the JSONL event files; this revision drops SQLite entirely
 * and keeps the per-session metadata in a sibling `meta.json` file.
 *
 * Layout under `rootDir`:
 *
 *   <rootDir>/
 *     <sessionId>/
 *       meta.json                 -- TraceSessionMeta, atomic writes
 *       <ts>-<seq>.jsonl          -- append-only event batch(es)
 *
 * `list(filter)` scans `meta.json` files under rootDir and filters in
 * memory. For trace counts in the hundreds-to-low-thousands this is fast
 * enough; the original PR's iteration log captured the same expectation.
 *
 * Write coordination uses `proper-lockfile` via `acquireLock` from
 * `src/utils/atomic-file.ts` so two `TraceStorage` instances against the
 * same `rootDir` can interleave `recordSessionStart` / `appendEvents`
 * safely. JSONL appends are O_APPEND atomic for sub-PIPE_BUF writes and
 * meta.json writes go through `writeFileAtomicSafe` (temp+rename).
 *
 * The recorder (PR-2, separate from this PR) is responsible for batching
 * events and calling `appendEvents` periodically. This module only
 * handles persistence.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { acquireLock, writeFileAtomicSafe } from '../../utils/atomic-file';
import type {
  TraceEvent,
  TraceListFilter,
  TraceSessionMeta,
  TraceStatus,
} from './types';

export interface TraceStorageOptions {
  /** Root directory for per-session JSONL files and meta.json. */
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
 * Windows reserved device names. Even on POSIX we prefix these so a
 * trace recorded on Linux is round-trippable on Windows without
 * collision. `CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9` (with or
 * without an extension) are unusable as directory basenames on Windows.
 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * Reject session IDs that would let a caller escape the trace root via
 * `path.join(rootDir, sessionId)`. We constrain to a conservative
 * basename: no path separators, no `..` segments, no NUL, no leading
 * dot, must be ASCII-printable, length-bounded. Tightening this is
 * strictly easier than loosening it later; if a real legitimate ID
 * needs more, plumb a sanitiser at the call site.
 */
function assertSafeSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('TraceStorage: session_id must be a non-empty string');
  }
  if (sessionId.length > 200) {
    throw new Error(`TraceStorage: session_id too long (${sessionId.length} chars; max 200)`);
  }
  if (sessionId === '.' || sessionId === '..' || sessionId.startsWith('.')) {
    throw new Error(`TraceStorage: session_id "${sessionId}" begins with a dot (reserved)`);
  }
  // Disallow path separators (POSIX + Windows) and NUL.
  if (/[\\/\0]/.test(sessionId)) {
    throw new Error(`TraceStorage: session_id "${sessionId}" contains a path separator or NUL`);
  }
  // Disallow control chars and the segment forms that fs would treat as
  // navigation (`..` anywhere is already covered by the separator
  // check, but block standalone `..` defensively too).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(sessionId)) {
    throw new Error(`TraceStorage: session_id "${sessionId}" contains a control character`);
  }
}

/**
 * Map a session ID to a directory basename that is safe on all
 * platforms. Most IDs pass through unchanged; Windows-reserved device
 * names like `CON` or `CON.jsonl` get a leading `_` so they can exist
 * as directory entries.
 */
function sessionDirName(sessionId: string): string {
  return WINDOWS_RESERVED.test(sessionId) ? `_${sessionId}` : sessionId;
}

interface MetaFileShape {
  session_id: string;
  started_at: number;
  ended_at: number | null;
  domain: string | null;
  status: TraceStatus;
  byte_size: number;
  parent_op: string | null;
}

function metaToShape(meta: TraceSessionMeta): MetaFileShape {
  return {
    session_id: meta.sessionId,
    started_at: meta.startedAt,
    ended_at: meta.endedAt ?? null,
    domain: meta.domain ?? null,
    status: meta.status,
    byte_size: meta.byteSize,
    parent_op: meta.parentOp ?? null,
  };
}

function shapeToMeta(row: MetaFileShape): TraceSessionMeta {
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

/**
 * JSONL-backed trace store. Multiple instances against the same
 * `rootDir` are safe — meta.json writes are atomic (temp + rename) and
 * cross-process contention is serialised by `proper-lockfile` on a
 * per-session lock file. JSONL appends rely on O_APPEND atomicity for
 * the small batches the recorder emits.
 */
export class TraceStorage {
  private readonly rootDir: string;
  /** Last-flush sequence per session, used to derive the JSONL filename. */
  private readonly seqCounters = new Map<string, number>();
  /** Lazy-init flag — we do not touch the filesystem in the constructor. */
  private rootEnsured = false;

  constructor(opts: TraceStorageOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultTraceRootDir();
  }

  /** Ensure rootDir exists exactly once per instance. */
  private ensureRoot(): void {
    if (this.rootEnsured) return;
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.rootEnsured = true;
  }

  /** Resolve the directory holding the JSONL + meta.json for a session. */
  private sessionDir(sessionId: string): string {
    return path.join(this.rootDir, sessionDirName(sessionId));
  }

  /** Path to the per-session lock file used by `proper-lockfile`. */
  private lockFile(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), '.lock');
  }

  /** Path to the per-session metadata file. */
  private metaPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'meta.json');
  }

  /** Read meta.json synchronously (best-effort; returns undefined on miss). */
  private readMetaSync(sessionId: string): TraceSessionMeta | undefined {
    const file = this.metaPath(sessionId);
    if (!fs.existsSync(file)) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const row = JSON.parse(raw) as MetaFileShape;
      if (!row || typeof row !== 'object' || typeof row.session_id !== 'string') {
        return undefined;
      }
      return shapeToMeta(row);
    } catch {
      return undefined;
    }
  }

  private async writeMeta(meta: TraceSessionMeta): Promise<void> {
    const file = this.metaPath(meta.sessionId);
    await writeFileAtomicSafe(file, JSON.stringify(metaToShape(meta), null, 2));
  }

  /**
   * Insert / overwrite the meta.json marking the start of a new trace
   * session. When the same `session_id` is reused (restart/retry flow),
   * any prior JSONL files in the session directory are removed so the
   * row reflects the new session, not stale state from the previous run.
   */
  async recordSessionStart(
    meta: Omit<TraceSessionMeta, 'byteSize'> & { byteSize?: number },
  ): Promise<void> {
    assertSafeSessionId(meta.sessionId);
    this.ensureRoot();
    const dir = this.sessionDir(meta.sessionId);
    // Wipe any prior content (JSONL + stale meta.json) so a reused
    // session ID does not carry over byte_size or partial flushes.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const release = await acquireLock(this.lockFile(meta.sessionId));
    try {
      await this.writeMeta({
        sessionId: meta.sessionId,
        startedAt: meta.startedAt,
        endedAt: meta.endedAt,
        domain: meta.domain,
        status: meta.status,
        byteSize: meta.byteSize ?? 0,
        parentOp: meta.parentOp,
      });
    } finally {
      await release();
    }
    // Reset the in-process per-session sequence counter so a reused
    // session ID starts JSONL filenames at 1 again.
    this.seqCounters.delete(meta.sessionId);
  }

  /** Update terminal fields when a session ends. */
  async recordSessionEnd(
    sessionId: string,
    args: { endedAt: number; status: TraceStatus; byteSize?: number },
  ): Promise<void> {
    assertSafeSessionId(sessionId);
    this.ensureRoot();
    // Same pre-flight pattern as appendEvents: avoid creating a `.lock`
    // file (and its parent dir) for a session that doesn't exist.
    if (!fs.existsSync(this.metaPath(sessionId))) {
      throw new Error(
        `TraceStorage.recordSessionEnd: unknown session_id=${sessionId} (call recordSessionStart first)`,
      );
    }
    const release = await acquireLock(this.lockFile(sessionId));
    try {
      const existing = this.readMetaSync(sessionId);
      if (!existing) {
        throw new Error(
          `TraceStorage.recordSessionEnd: unknown session_id=${sessionId} (call recordSessionStart first)`,
        );
      }
      const next: TraceSessionMeta = {
        ...existing,
        endedAt: args.endedAt,
        status: args.status,
        byteSize: args.byteSize ?? existing.byteSize,
      };
      await this.writeMeta(next);
    } finally {
      await release();
    }
  }

  /** Look up a single session row. */
  getMeta(sessionId: string): TraceSessionMeta | undefined {
    // Path safety also matters on read: an attacker-controlled ID must
    // not be allowed to traverse out of rootDir even for reads.
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    return this.readMetaSync(sessionId);
  }

  /** Filter sessions; defaults: limit=100, ordered by started_at DESC. */
  list(filter: TraceListFilter = {}): TraceSessionMeta[] {
    if (!fs.existsSync(this.rootDir)) {
      return [];
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(this.rootDir);
    } catch {
      return [];
    }
    const statusFilter = filter.status
      ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
      : undefined;
    const all: TraceSessionMeta[] = [];
    for (const entry of entries) {
      // Skip dotfiles and anything that isn't a directory we own.
      if (entry.startsWith('.')) continue;
      const metaFile = path.join(this.rootDir, entry, 'meta.json');
      if (!fs.existsSync(metaFile)) continue;
      let row: TraceSessionMeta | undefined;
      try {
        const raw = fs.readFileSync(metaFile, 'utf8');
        const parsed = JSON.parse(raw) as MetaFileShape;
        if (!parsed || typeof parsed.session_id !== 'string') continue;
        row = shapeToMeta(parsed);
      } catch {
        // Skip corrupted / partially-written meta.json files rather than
        // failing the entire list query.
        continue;
      }
      if (!row) continue;
      if (filter.since !== undefined && row.startedAt < filter.since) continue;
      if (filter.domain !== undefined && row.domain !== filter.domain) continue;
      if (statusFilter && !statusFilter.has(row.status)) continue;
      all.push(row);
    }
    all.sort((a, b) => b.startedAt - a.startedAt);
    const limit = filter.limit ?? 100;
    return all.slice(0, limit);
  }

  /**
   * Append a batch of events to the session's current JSONL file. Returns
   * the bytes written and the file path. Each event is serialised one-per-line.
   */
  async appendEvents(sessionId: string, events: TraceEvent[]): Promise<AppendResult> {
    assertSafeSessionId(sessionId);
    if (events.length === 0) {
      return { bytes: 0, filePath: '' };
    }
    this.ensureRoot();
    // Pre-flight existence check WITHOUT acquiring the lock: a real
    // session always has its session directory + meta.json on disk
    // after recordSessionStart. Skipping acquireLock here keeps the
    // unknown-session path from creating a `.lock` file (and therefore
    // the parent session directory) as a side effect, which would
    // leave an orphan directory the caller's "no ghost dir" check
    // would observe.
    if (!fs.existsSync(this.metaPath(sessionId))) {
      throw new Error(
        `TraceStorage.appendEvents: unknown session_id=${sessionId} (call recordSessionStart first)`,
      );
    }
    const release = await acquireLock(this.lockFile(sessionId));
    try {
      // Re-verify under the lock — the session could have been purged
      // between the pre-flight check and acquiring the lock.
      const meta = this.readMetaSync(sessionId);
      if (!meta) {
        throw new Error(
          `TraceStorage.appendEvents: unknown session_id=${sessionId} (call recordSessionStart first)`,
        );
      }
      const dir = this.sessionDir(sessionId);
      fs.mkdirSync(dir, { recursive: true });
      // Compute seq locally and ONLY commit it to seqCounters after both
      // sides (file + meta.json) succeed. Otherwise a partial failure
      // would either skip a seq number (file leaks) or be retried with
      // the same id (file duplicates).
      const seq = (this.seqCounters.get(sessionId) ?? 0) + 1;
      const ts = events[0].ts;
      const filePath = path.join(dir, `${ts}-${seq}.jsonl`);
      const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      const bytes = Buffer.byteLength(lines, 'utf8');
      fs.appendFileSync(filePath, lines, 'utf8');
      try {
        await this.writeMeta({ ...meta, byteSize: meta.byteSize + bytes });
      } catch (err) {
        // meta.json write failed AFTER the JSONL was committed to disk.
        // Roll back the file so the recorder's flush() can retry the
        // same batch without producing duplicate trace records on disk.
        try {
          fs.unlinkSync(filePath);
        } catch {
          // best-effort
        }
        throw err;
      }
      // TOCTOU: between readMetaSync and writeMeta a concurrent purge
      // could have removed the session directory. Re-check that the
      // meta.json still resolves to the same session_id we expected. If
      // it doesn't, roll back the JSONL and surface the conflict.
      const after = this.readMetaSync(sessionId);
      if (!after || after.sessionId !== sessionId) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // best-effort
        }
        throw new Error(
          `TraceStorage.appendEvents: session_id=${sessionId} disappeared between existence check and meta update (concurrent purge?)`,
        );
      }
      this.seqCounters.set(sessionId, seq);
      return { bytes, filePath };
    } finally {
      await release();
    }
  }

  /**
   * Delete trace sessions started before `beforeMs`. Removes both the
   * meta.json row and the JSONL files. Returns the number of sessions
   * purged.
   *
   * Only sessions in a terminal state (`completed`, `failed`, `aborted`)
   * are eligible. A long-lived `running` session that crosses the TTL
   * cutoff is intentionally NOT purged — deleting its JSONL directory
   * mid-recording would lose data and break the next `appendEvents`
   * call. Operators who really want to evict an active session should
   * call `recordSessionEnd` first.
   */
  purgeOlderThan(beforeMs: number): number {
    if (!fs.existsSync(this.rootDir)) return 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(this.rootDir);
    } catch {
      return 0;
    }
    let purged = 0;
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const dir = path.join(this.rootDir, entry);
      const metaFile = path.join(dir, 'meta.json');
      if (!fs.existsSync(metaFile)) continue;
      let row: TraceSessionMeta | undefined;
      try {
        const raw = fs.readFileSync(metaFile, 'utf8');
        const parsed = JSON.parse(raw) as MetaFileShape;
        if (!parsed || typeof parsed.session_id !== 'string') continue;
        row = shapeToMeta(parsed);
      } catch {
        continue;
      }
      if (!row) continue;
      if (row.startedAt >= beforeMs) continue;
      if (
        row.status !== 'completed' &&
        row.status !== 'failed' &&
        row.status !== 'aborted'
      ) {
        continue;
      }
      // Defence-in-depth: even though `assertSafeSessionId` runs at all
      // ingest entry points, a sessionId could have been written by an
      // older build before that check existed. Skip any row that fails
      // the safety check rather than rmSync-ing an unintended path.
      try {
        assertSafeSessionId(row.sessionId);
      } catch {
        continue;
      }
      const expectedDir = this.sessionDir(row.sessionId);
      if (path.resolve(dir) !== path.resolve(expectedDir)) {
        // The on-disk directory basename does not match what
        // sessionDirName would produce for this session_id. Refuse to
        // delete a path we did not author.
        continue;
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: keep going even if one session's files are locked.
        continue;
      }
      this.seqCounters.delete(row.sessionId);
      purged += 1;
    }
    return purged;
  }

  /**
   * Release any per-instance resources. Currently a no-op (no open file
   * handles or DB connections in the JSONL backend) but kept on the
   * surface so the storage lifecycle stays symmetric with the recorder
   * and callers can treat `end()` uniformly. Safe to call multiple times.
   */
  end(): void {
    this.seqCounters.clear();
  }
}
