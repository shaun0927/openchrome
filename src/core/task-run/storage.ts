import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireLock, writeFileAtomicSafe, readFileSafe } from '../../utils/atomic-file';
import { redactValue } from '../trace/redactor';
import {
  EvidencePointer,
  FailedItem,
  NeedsHelpState,
  TaskRunAutoSessionSnapshotPolicy,
  TaskRunCheckpoint,
  TaskRunEvent,
  TaskRunListFilter,
  TaskRunMeta,
  TaskRunStatus,
  TERMINAL_TASK_RUN_STATUSES,
} from './types';

const MAX_GOAL_CHARS = 4096;
const MAX_SUMMARY_CHARS = 8192;
const MAX_HELP_CHARS = 2048;
const MAX_CRITERIA = 50;
const MAX_CRITERION_CHARS = 1024;
const MAX_ITEMS = 500;
const RUN_ID_BYTES = 8; // 16 hex chars

export interface TaskRunStoreOptions {
  rootDir?: string;
  now?: () => number;
}

export interface StartTaskRunInput {
  goal: string;
  success_criteria?: string[];
  session_id?: string;
  workflow_id?: string;
  ledger_task_ids?: string[];
  auto_session_snapshot?: {
    enabled?: boolean;
    mode?: 'best-effort' | 'strict';
    max_snapshots?: number;
  };
}

export interface UpdateTaskRunInput {
  status?: TaskRunStatus;
  resume_reason?: string;
  progress_summary?: string;
  completed_items?: string[];
  failed_items?: FailedItem[];
  current_cursor?: string;
  last_evidence?: EvidencePointer[];
  ledger_task_ids?: string[];
  workflow_id?: string;
}

export interface NeedsHelpInput {
  reason: string;
  resume_hint?: string;
  current_cursor?: string;
  last_evidence?: EvidencePointer[];
}

export interface CompleteInput {
  status?: Extract<TaskRunStatus, 'COMPLETED' | 'FAILED' | 'CANCELLED'>;
  progress_summary?: string;
  failed_items?: FailedItem[];
  completed_items?: string[];
  last_evidence?: EvidencePointer[];
}

export class TaskRunTransitionError extends Error {
  code = 'invalid_task_run_transition';
}

export class TaskRunNotFoundError extends Error {
  code = 'task_run_not_found';
}

export class TaskRunStore {
  readonly rootDir: string;
  private readonly now: () => number;

  constructor(opts: TaskRunStoreOptions = {}) {
    const openchromeHome = process.env.OPENCHROME_HOME || path.join(os.homedir(), '.openchrome');
    this.rootDir = opts.rootDir || path.join(openchromeHome, 'task-runs');
    this.now = opts.now || (() => Date.now());
  }

  async start(input: StartTaskRunInput): Promise<TaskRunMeta> {
    const ts = this.now();
    const meta: TaskRunMeta = {
      run_id: this.createRunId(input.goal, ts),
      status: 'RUNNING',
      goal: limit(scrub(String(input.goal || '')), MAX_GOAL_CHARS),
      success_criteria: sanitizeStringArray(input.success_criteria, MAX_CRITERIA, MAX_CRITERION_CHARS),
      session_id: optionalString(input.session_id),
      workflow_id: optionalString(input.workflow_id),
      ledger_task_ids: uniqueStrings(input.ledger_task_ids),
      auto_session_snapshot_policy: sanitizeAutoSessionSnapshotPolicy(input.auto_session_snapshot),
      auto_session_snapshot_state: sanitizeAutoSessionSnapshotPolicy(input.auto_session_snapshot) ? { snapshot_ids: [] } : undefined,
      created_at: ts,
      updated_at: ts,
    };
    await this.writeMeta(meta);
    await this.appendEvent(meta.run_id, { ts, kind: 'started', data: { status: meta.status } });
    return meta;
  }

  async get(runId: string): Promise<TaskRunMeta> {
    const result = await readFileSafe<TaskRunMeta>(this.metaPath(runId));
    if (!result.success || !result.data) {
      throw new TaskRunNotFoundError(`TaskRun ${runId} not found`);
    }
    return result.data;
  }

  async list(filter: TaskRunListFilter = {}): Promise<TaskRunMeta[]> {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    const entries = await fs.promises.readdir(this.rootDir, { withFileTypes: true });
    const metas: TaskRunMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = await this.get(entry.name);
        if (filter.status && meta.status !== filter.status) continue;
        if (filter.since && meta.created_at < filter.since) continue;
        metas.push(meta);
      } catch {
        // Ignore partial/corrupt directories; read path should not throw list.
      }
    }
    metas.sort((a, b) => b.created_at - a.created_at);
    return metas.slice(0, clampLimit(filter.limit));
  }

  async update(runId: string, input: UpdateTaskRunInput): Promise<TaskRunMeta> {
    return this.withRunLock(runId, async () => {
      const current = await this.get(runId);
      this.assertMutable(current);
      const ts = this.now();

      const nextStatus = input.status || current.status;
      if (!isTaskRunStatus(nextStatus)) {
        throw new TaskRunTransitionError(`Unknown TaskRun status: ${String(nextStatus)}`);
      }
      if (current.status === 'NEEDS_HELP' && nextStatus === 'RUNNING' && !optionalString(input.resume_reason)) {
        throw new TaskRunTransitionError('Resuming a NEEDS_HELP TaskRun requires resume_reason');
      }
      if (TERMINAL_TASK_RUN_STATUSES.has(nextStatus)) {
        throw new TaskRunTransitionError('Use oc_task_run_complete to enter a terminal state');
      }
      if (nextStatus === 'PENDING') {
        throw new TaskRunTransitionError('TaskRun cannot transition back to PENDING');
      }
      // NEEDS_HELP requires a reason + requested_at payload; route callers
      // through oc_task_run_needs_help instead of an unguarded update().
      if (nextStatus === 'NEEDS_HELP' && current.status !== 'NEEDS_HELP') {
        throw new TaskRunTransitionError('Use oc_task_run_needs_help to enter NEEDS_HELP');
      }

      const merged = mergeItems(current, input.completed_items, input.failed_items);
      const meta: TaskRunMeta = pruneUndefined({
        ...current,
        status: nextStatus,
        workflow_id: optionalString(input.workflow_id) || current.workflow_id,
        ledger_task_ids: uniqueStrings([...(current.ledger_task_ids || []), ...(input.ledger_task_ids || [])]),
        progress_summary: input.progress_summary !== undefined
          ? limit(scrub(input.progress_summary), MAX_SUMMARY_CHARS)
          : current.progress_summary,
        completed_items: merged.completed,
        failed_items: merged.failed,
        completed_items_truncated: merged.completedTruncated || undefined,
        failed_items_truncated: merged.failedTruncated || undefined,
        current_cursor: input.current_cursor !== undefined ? scrub(input.current_cursor) : current.current_cursor,
        last_evidence: sanitizeEvidence(input.last_evidence) || current.last_evidence,
        needs_help: nextStatus === 'RUNNING' ? undefined : current.needs_help,
        updated_at: ts,
      });
      await this.writeMeta(meta);
      await this.appendEvent(runId, { ts, kind: 'updated', data: redactValue({ status: meta.status, resume_reason: input.resume_reason }) as Record<string, unknown> });
      return meta;
    });
  }

  async checkpoint(runId: string, summary: string, opts: { current_cursor?: string; evidence?: EvidencePointer[] } = {}): Promise<TaskRunCheckpoint> {
    return this.withRunLock(runId, async () => {
      const meta = await this.get(runId);
      this.assertMutable(meta);
      const ts = this.now();
      const checkpoint: TaskRunCheckpoint = pruneUndefined({
        checkpoint_id: this.createRunId(`${runId}\0checkpoint\0${ts}`, ts),
        run_id: runId,
        summary: limit(scrub(summary), MAX_SUMMARY_CHARS),
        current_cursor: opts.current_cursor ? scrub(opts.current_cursor) : undefined,
        evidence: sanitizeEvidence(opts.evidence),
        created_at: ts,
      });
      const checkpointPath = path.join(this.runDir(runId), 'checkpoints', `${checkpoint.checkpoint_id}.json`);
      await writeFileAtomicSafe(checkpointPath, checkpoint);
      const updated = pruneUndefined({
        ...meta,
        progress_summary: checkpoint.summary,
        current_cursor: checkpoint.current_cursor ?? meta.current_cursor,
        last_evidence: checkpoint.evidence ?? meta.last_evidence,
        updated_at: ts,
      });
      await this.writeMeta(updated);
      await this.appendEvent(runId, { ts, kind: 'checkpointed', data: { checkpoint_id: checkpoint.checkpoint_id } });
      return checkpoint;
    });
  }

  async needsHelp(runId: string, input: NeedsHelpInput): Promise<TaskRunMeta> {
    return this.withRunLock(runId, async () => {
      const current = await this.get(runId);
      this.assertMutable(current);
      const ts = this.now();
      const needs_help: NeedsHelpState = pruneUndefined({
        reason: limit(scrub(input.reason), MAX_HELP_CHARS),
        requested_at: ts,
        resume_hint: input.resume_hint ? limit(scrub(input.resume_hint), MAX_HELP_CHARS) : undefined,
      });
      const meta = pruneUndefined({
        ...current,
        status: 'NEEDS_HELP' as const,
        needs_help,
        current_cursor: input.current_cursor !== undefined ? scrub(input.current_cursor) : current.current_cursor,
        last_evidence: sanitizeEvidence(input.last_evidence) || current.last_evidence,
        updated_at: ts,
      });
      await this.writeMeta(meta);
      await this.appendEvent(runId, { ts, kind: 'needs_help', data: redactValue(needs_help) as Record<string, unknown> });
      return meta;
    });
  }

  async complete(runId: string, input: CompleteInput = {}): Promise<TaskRunMeta> {
    return this.withRunLock(runId, async () => {
      const current = await this.get(runId);
      this.assertMutable(current);
      const ts = this.now();
      const status = input.status || 'COMPLETED';
      if (!isTaskRunStatus(status) || !TERMINAL_TASK_RUN_STATUSES.has(status)) {
        throw new TaskRunTransitionError('Completion status must be COMPLETED, FAILED, or CANCELLED');
      }
      const merged = mergeItems(current, input.completed_items, input.failed_items);
      const meta: TaskRunMeta = pruneUndefined({
        ...current,
        status,
        progress_summary: input.progress_summary !== undefined ? limit(scrub(input.progress_summary), MAX_SUMMARY_CHARS) : current.progress_summary,
        completed_items: merged.completed,
        failed_items: merged.failed,
        completed_items_truncated: merged.completedTruncated || undefined,
        failed_items_truncated: merged.failedTruncated || undefined,
        last_evidence: sanitizeEvidence(input.last_evidence) || current.last_evidence,
        needs_help: undefined,
        updated_at: ts,
        completed_at: ts,
      });
      await this.writeMeta(meta);
      const kind = status === 'COMPLETED' ? 'completed' : status === 'FAILED' ? 'failed' : 'cancelled';
      await this.appendEvent(runId, { ts, kind, data: { status } });
      return meta;
    });
  }

  async recordAutoSessionSnapshot(runId: string, snapshotId: string): Promise<TaskRunMeta> {
    return this.withRunLock(runId, async () => {
      const current = await this.get(runId);
      const ts = this.now();
      const maxSnapshots = current.auto_session_snapshot_policy?.max_snapshots || 10;
      const ids = [...(current.auto_session_snapshot_state?.snapshot_ids || []), scrub(snapshotId)].slice(-maxSnapshots);
      const meta: TaskRunMeta = pruneUndefined({
        ...current,
        auto_session_snapshot_state: {
          snapshot_ids: ids,
          last_snapshot_at: ts,
        },
        updated_at: ts,
      });
      await this.writeMeta(meta);
      await this.appendEvent(runId, { ts, kind: 'auto_session_snapshot', data: { snapshot_id: snapshotId } });
      return meta;
    });
  }

  async recordAutoSessionSnapshotFailure(runId: string, error: unknown): Promise<TaskRunMeta> {
    return this.withRunLock(runId, async () => {
      const current = await this.get(runId);
      const ts = this.now();
      const meta: TaskRunMeta = pruneUndefined({
        ...current,
        auto_session_snapshot_state: {
          snapshot_ids: current.auto_session_snapshot_state?.snapshot_ids || [],
          last_snapshot_at: current.auto_session_snapshot_state?.last_snapshot_at,
          last_error: limit(error instanceof Error ? error.message : String(error), 1024),
        },
        updated_at: ts,
      });
      await this.writeMeta(meta);
      await this.appendEvent(runId, { ts, kind: 'auto_session_snapshot', data: { error: meta.auto_session_snapshot_state?.last_error } });
      return meta;
    });
  }

  async readEvents(runId: string): Promise<TaskRunEvent[]> {
    const eventsPath = this.eventsPath(runId);
    if (!fs.existsSync(eventsPath)) return [];
    const text = await fs.promises.readFile(eventsPath, 'utf8');
    const events: TaskRunEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as TaskRunEvent);
      } catch (err) {
        // Skip malformed JSONL lines so a single corrupt entry does not
        // fail the whole read. Surface diagnostics via stderr; stdout is
        // reserved for MCP JSON-RPC.
        console.error(`[TaskRunStore] Skipping malformed event line in ${eventsPath}: ${(err as Error).message}`);
      }
    }
    return events;
  }

  private createRunId(seed: string, ts: number): string {
    return crypto.createHash('sha256')
      .update(seed)
      .update('\0')
      .update(String(ts))
      .update('\0')
      .update(crypto.randomBytes(RUN_ID_BYTES))
      .digest('hex')
      .slice(0, 16);
  }

  private assertMutable(meta: TaskRunMeta): void {
    if (TERMINAL_TASK_RUN_STATUSES.has(meta.status)) {
      throw new TaskRunTransitionError(`TaskRun ${meta.run_id} is terminal (${meta.status}) and cannot be modified`);
    }
  }

  private async writeMeta(meta: TaskRunMeta): Promise<void> {
    await writeFileAtomicSafe(this.metaPath(meta.run_id), meta);
  }

  private async appendEvent(runId: string, event: TaskRunEvent): Promise<void> {
    const dir = this.runDir(runId);
    await fs.promises.mkdir(dir, { recursive: true });
    const safeEvent = redactValue(event) as TaskRunEvent;
    await fs.promises.appendFile(this.eventsPath(runId), `${JSON.stringify(safeEvent)}\n`, 'utf8');
  }

  /**
   * Per-run advisory file lock. Serializes mutating operations against the
   * same `run_id` so concurrent update / checkpoint / needs_help / complete
   * calls cannot read-modify-write past each other.
   */
  private async withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    assertSafeId(runId);
    await fs.promises.mkdir(this.runDir(runId), { recursive: true });
    const release = await acquireLock(this.lockPath(runId));
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private lockPath(runId: string): string {
    return path.join(this.runDir(runId), 'meta.lock');
  }

  private runDir(runId: string): string {
    assertSafeId(runId);
    return path.join(this.rootDir, runId);
  }

  private metaPath(runId: string): string {
    return path.join(this.runDir(runId), 'meta.json');
  }

  private eventsPath(runId: string): string {
    return path.join(this.runDir(runId), 'events.jsonl');
  }
}

function isTaskRunStatus(value: unknown): value is TaskRunStatus {
  return value === 'PENDING' || value === 'RUNNING' || value === 'NEEDS_HELP' ||
    value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED';
}

function assertSafeId(id: string): void {
  if (!/^[a-f0-9]{16}$/i.test(id)) {
    throw new Error(`Invalid TaskRun id: ${id}`);
  }
}

function scrub(value: string): string {
  return String(redactValue(value));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? scrub(value.trim()) : undefined;
}

function limit(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function sanitizeStringArray(values: unknown, maxItems: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return values.slice(0, maxItems).map(v => limit(scrub(String(v)), maxChars)).filter(Boolean);
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => scrub(v.trim()))));
}

function sanitizeAutoSessionSnapshotPolicy(value: unknown): TaskRunAutoSessionSnapshotPolicy | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as { enabled?: unknown; mode?: unknown; max_snapshots?: unknown };
  if (input.enabled !== true) return undefined;
  const max = typeof input.max_snapshots === 'number' && Number.isFinite(input.max_snapshots)
    ? Math.max(1, Math.min(100, Math.floor(input.max_snapshots)))
    : 10;
  return {
    enabled: true,
    mode: input.mode === 'strict' ? 'strict' : 'best-effort',
    max_snapshots: max,
  };
}

function sanitizeEvidence(values: unknown): EvidencePointer[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return values
    .filter((v): v is EvidencePointer => Boolean(v) && typeof v === 'object' && typeof (v as EvidencePointer).kind === 'string' && typeof (v as EvidencePointer).ref === 'string')
    .slice(0, 50)
    .map(v => pruneUndefined({ kind: v.kind, ref: scrub(v.ref), summary: v.summary ? limit(scrub(v.summary), 1024) : undefined }));
}

function sanitizeFailed(values: unknown): FailedItem[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((v): v is FailedItem => Boolean(v) && typeof v === 'object' && typeof (v as FailedItem).item === 'string')
    .map(v => ({ item: scrub(v.item), reason: limit(scrub(String(v.reason || '')), 1024) }));
}

function mergeItems(current: TaskRunMeta, completedInput?: string[], failedInput?: FailedItem[]): {
  completed: string[];
  failed: FailedItem[];
  completedTruncated: number;
  failedTruncated: number;
} {
  const completed = Array.from(new Set([...(current.completed_items || []), ...uniqueStrings(completedInput)]));
  const failedByItem = new Map<string, FailedItem>();
  for (const item of [...(current.failed_items || []), ...sanitizeFailed(failedInput)]) {
    failedByItem.set(item.item, item);
  }
  const failed = Array.from(failedByItem.values());
  // Accumulate truncation counts. The merged arrays already include the
  // previously-retained tail (post-truncation), so this overflow count
  // reflects only new spillover; we add it to whatever the caller has
  // already shed historically.
  const completedOverflow = Math.max(0, completed.length - MAX_ITEMS);
  const failedOverflow = Math.max(0, failed.length - MAX_ITEMS);
  const completedTruncated = (current.completed_items_truncated || 0) + completedOverflow;
  const failedTruncated = (current.failed_items_truncated || 0) + failedOverflow;
  return {
    completed: completed.slice(-MAX_ITEMS),
    failed: failed.slice(-MAX_ITEMS),
    completedTruncated,
    failedTruncated,
  };
}

function clampLimit(limit: unknown): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 50;
  return Math.max(1, Math.min(200, n));
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}
