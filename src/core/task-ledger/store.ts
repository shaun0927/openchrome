/**
 * Task ledger storage backend (JSONL + meta.json + proper-lockfile).
 *
 * Mirrors `src/core/trace/storage.ts` line-for-line on disk semantics
 * so we inherit the same crash-safety properties without introducing
 * new native deps. Per the portability-harness contract:
 *
 *   P1: host-pluggable — only `fs` / `path` / `os`, no MCP client knowledge.
 *   P2: OS-portable — `os.homedir()`, `path.join()`, no shell-isms.
 *   P5: no native deps — `proper-lockfile` + `write-file-atomic` only.
 *
 * Layout under `rootDir`:
 *
 *   <rootDir>/
 *     <task_id>/
 *       meta.json                 -- TaskMeta, atomic writes
 *       events.jsonl              -- append-only event log
 *       result.json               -- present iff status === COMPLETED
 *       .lock                     -- per-task proper-lockfile target
 *
 * The lock is held only during meta.json mutation, never for the long
 * body of work. JSONL appends rely on O_APPEND atomicity for the small
 * events the runner emits (`started`, `cancel_requested`, `completed`,
 * etc. — all well under PIPE_BUF).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { acquireLock, writeFileAtomicSafe } from '../../utils/atomic-file';
import type {
  TaskEvent,
  TaskKind,
  TaskListFilter,
  TaskMeta,
  TaskStatus,
} from './types';

export interface TaskStoreOptions {
  /** Root directory; defaults to defaultTaskRootDir(). */
  rootDir?: string;
}

/** Default rootDir resolves to `${HOME}/.openchrome/tasks`. */
export function defaultTaskRootDir(): string {
  // Allow operators to override the ledger location (test fixtures,
  // CI sandboxes). Falls back to ~/.openchrome/tasks so a stock
  // install lands under the same parent as ~/.openchrome/traces.
  const override = process.env.OPENCHROME_TASK_ROOT;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), '.openchrome', 'tasks');
}

/** Cap on args_summary serialised size, per the issue contract (≤2 KiB). */
const MAX_ARGS_SUMMARY_BYTES = 2048;

/**
 * Compute the deterministic task id from (kind, args, created_at). The
 * issue specifies SHA-256 truncated to 16 hex chars. We include
 * created_at so that two calls with identical args at different times
 * produce distinct ids.
 */
export function computeTaskId(
  kind: TaskKind,
  args: Record<string, unknown>,
  createdAt: number,
): string {
  const hasher = crypto.createHash('sha256');
  hasher.update(String(kind));
  hasher.update('\x00');
  hasher.update(JSON.stringify(args ?? {}));
  hasher.update('\x00');
  hasher.update(String(createdAt));
  return hasher.digest('hex').slice(0, 16);
}

/**
 * Reject task ids that would let a caller escape rootDir. The runner
 * always synthesises ids via `computeTaskId` (16-hex), so any deviation
 * from that shape is a bug or an attack and we reject it.
 */
const TASK_ID_RE = /^[0-9a-f]{16}$/;
export function assertSafeTaskId(taskId: string): void {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new Error(
      `TaskStore: task_id ${JSON.stringify(taskId)} is not a 16-hex string`,
    );
  }
}

/**
 * Best-effort liveness check. `process.kill(pid, 0)` throws ESRCH when
 * the pid no longer exists, EPERM when the pid exists but is owned by
 * another user (treat as alive — we can't reap something we don't own).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/** Redact and clamp a launch args object for storage in meta.args_summary. */
export function summariseArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const redactKey = (key: string): boolean => {
    const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (
      normalised.includes('password') ||
      normalised.includes('passwd') ||
      normalised.includes('secret') ||
      normalised.includes('token') ||
      normalised.includes('apikey') ||
      normalised.includes('authorization') ||
      normalised === 'cookie' ||
      normalised.endsWith('cookie')
    );
  };

  const redactDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redactDeep);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = redactKey(key) ? '[redacted]' : redactDeep(child);
      }
      return out;
    }
    return value;
  };

  const redacted = redactDeep(args ?? {}) as Record<string, unknown>;
  const serialised = JSON.stringify(redacted);
  const bytes = Buffer.byteLength(serialised, 'utf8');
  if (bytes > MAX_ARGS_SUMMARY_BYTES) {
    return { _truncated: true, _bytes: bytes };
  }
  return redacted;
}

/**
 * Persistent task ledger. Multiple instances against the same rootDir
 * are safe — meta.json writes go through `writeFileAtomicSafe` and
 * cross-process contention is serialised by `proper-lockfile`.
 */
export class TaskStore {
  private readonly rootDir: string;
  private rootEnsured = false;

  constructor(opts: TaskStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultTaskRootDir();
  }

  getRootDir(): string {
    return this.rootDir;
  }

  private ensureRoot(): void {
    if (this.rootEnsured) return;
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.rootEnsured = true;
  }

  taskDir(taskId: string): string {
    return path.join(this.rootDir, taskId);
  }

  private lockFile(taskId: string): string {
    return path.join(this.taskDir(taskId), '.lock');
  }

  metaPath(taskId: string): string {
    return path.join(this.taskDir(taskId), 'meta.json');
  }

  eventsPath(taskId: string): string {
    return path.join(this.taskDir(taskId), 'events.jsonl');
  }

  resultPath(taskId: string): string {
    return path.join(this.taskDir(taskId), 'result.json');
  }

  /** Synchronous best-effort meta.json read. Returns undefined on miss/corruption. */
  readMetaSync(taskId: string): TaskMeta | undefined {
    try {
      assertSafeTaskId(taskId);
    } catch {
      return undefined;
    }
    const file = this.metaPath(taskId);
    if (!fs.existsSync(file)) return undefined;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as TaskMeta;
      if (!parsed || typeof parsed.task_id !== 'string') return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async writeMetaUnderLock(meta: TaskMeta): Promise<void> {
    await writeFileAtomicSafe(this.metaPath(meta.task_id), JSON.stringify(meta, null, 2));
  }


  /** Async best-effort meta.json read. Returns undefined on miss/corruption. */
  async readMeta(taskId: string): Promise<TaskMeta | undefined> {
    try {
      assertSafeTaskId(taskId);
    } catch {
      return undefined;
    }
    try {
      const raw = await fs.promises.readFile(this.metaPath(taskId), 'utf8');
      const parsed = JSON.parse(raw) as TaskMeta;
      if (!parsed || typeof parsed.task_id !== 'string') return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  /**
   * Create a new task row in PENDING. Fails if a row with the same id
   * already exists (collisions are vanishingly unlikely given the
   * created_at component, but we treat them as a programmer error
   * rather than silently overwriting prior state).
   */
  async create(meta: TaskMeta): Promise<void> {
    assertSafeTaskId(meta.task_id);
    this.ensureRoot();
    const dir = this.taskDir(meta.task_id);
    fs.mkdirSync(dir, { recursive: true });
    const release = await acquireLock(this.lockFile(meta.task_id));
    try {
      if (fs.existsSync(this.metaPath(meta.task_id))) {
        throw new Error(`TaskStore.create: task ${meta.task_id} already exists`);
      }
      await this.writeMetaUnderLock(meta);
    } finally {
      await release();
    }
  }

  /**
   * Update meta.json under the per-task lock. The mutator receives the
   * current meta and must return the next meta (or undefined to abort).
   * Returns the value actually written, or undefined if the mutator
   * aborted.
   *
   * The mutator MUST preserve terminal-state immutability: callers are
   * expected to check `current.status` and abort if it is already
   * COMPLETED / FAILED / CANCELLED.
   */
  async update(
    taskId: string,
    mutator: (current: TaskMeta) => TaskMeta | undefined,
  ): Promise<TaskMeta | undefined> {
    assertSafeTaskId(taskId);
    this.ensureRoot();
    if (!fs.existsSync(this.metaPath(taskId))) {
      throw new Error(`TaskStore.update: unknown task ${taskId}`);
    }
    const release = await acquireLock(this.lockFile(taskId));
    try {
      const current = this.readMetaSync(taskId);
      if (!current) {
        throw new Error(`TaskStore.update: meta.json for ${taskId} disappeared`);
      }
      const next = mutator(current);
      if (!next) return undefined;
      await this.writeMetaUnderLock(next);
      return next;
    } finally {
      await release();
    }
  }

  /**
   * Append a single event to the task's events.jsonl. The runner uses
   * this for visibility / debugging only; meta.json remains the source
   * of truth for status.
   */
  appendEvent(taskId: string, event: TaskEvent): void {
    assertSafeTaskId(taskId);
    this.ensureRoot();
    fs.mkdirSync(this.taskDir(taskId), { recursive: true });
    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(this.eventsPath(taskId), line, 'utf8');
  }

  /** Persist the tool's terminal result blob. Idempotent. */
  async writeResult(taskId: string, result: unknown): Promise<void> {
    assertSafeTaskId(taskId);
    this.ensureRoot();
    fs.mkdirSync(this.taskDir(taskId), { recursive: true });
    await writeFileAtomicSafe(this.resultPath(taskId), JSON.stringify(result, null, 2));
  }

  readResultSync(taskId: string): unknown | undefined {
    try {
      assertSafeTaskId(taskId);
    } catch {
      return undefined;
    }
    const file = this.resultPath(taskId);
    if (!fs.existsSync(file)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return undefined;
    }
  }

  /**
   * Enumerate task rows, applying filter + default ordering (created_at
   * descending, default limit 50). Corrupt meta.json files are skipped
   * rather than failing the entire listing.
   */
  async list(filter: TaskListFilter = {}): Promise<TaskMeta[]> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.rootDir);
    } catch {
      return [];
    }
    const statusFilter = filter.status
      ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
      : undefined;
    const kindFilter = filter.kind
      ? new Set(Array.isArray(filter.kind) ? filter.kind : [filter.kind])
      : undefined;
    const all: TaskMeta[] = [];
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      if (!TASK_ID_RE.test(entry)) continue;
      const meta = await this.readMeta(entry);
      if (!meta) continue;
      if (filter.since !== undefined && meta.created_at < filter.since) continue;
      if (statusFilter && !statusFilter.has(meta.status)) continue;
      if (kindFilter && !kindFilter.has(meta.kind)) continue;
      all.push(meta);
    }
    all.sort((a, b) => b.created_at - a.created_at);
    const limit = filter.limit ?? 50;
    return all.slice(0, limit);
  }

  /**
   * Reap any RUNNING/PENDING task whose owner pid is no longer alive. Returns
   * the list of task ids that were transitioned to FAILED. Must be
   * called once at server startup before accepting any new tasks
   * (issue invariant #2). Safe to call concurrently — meta.json
   * mutations go through `update()` and the per-task lock.
   */
  async reapOrphans(now: number = Date.now()): Promise<string[]> {
    const reaped: string[] = [];
    const candidates = await this.list({ status: ['PENDING', 'RUNNING'], limit: Number.MAX_SAFE_INTEGER });
    for (const meta of candidates) {
      if (isPidAlive(meta.pid)) continue;
      try {
        const next = await this.update(meta.task_id, (cur) => {
          // Re-check under the lock — another process may have just
          // reaped this row or transitioned it terminal.
          if (cur.status !== 'RUNNING' && cur.status !== 'PENDING') return undefined;
          if (isPidAlive(cur.pid)) return undefined;
          return {
            ...cur,
            status: 'FAILED' as TaskStatus,
            ended_at: now,
            error: { message: `orphaned: pid ${cur.pid} no longer alive`, code: 'orphaned' },
          };
        });
        if (next) {
          this.appendEvent(meta.task_id, {
            ts: now,
            kind: 'failed',
            data: { code: 'orphaned', pid: meta.pid },
          });
          reaped.push(meta.task_id);
        }
      } catch {
        // Best-effort: keep scanning.
      }
    }
    return reaped;
  }
}
