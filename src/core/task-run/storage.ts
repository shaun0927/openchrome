import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomicSafe, readFileSafe } from '../../utils/atomic-file';
import { redactValue } from '../trace/redactor';
import {
  EvidencePointer,
  FailedItem,
  NeedsHelpState,
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
      completed_items_truncated: merged.completedTruncated || current.completed_items_truncated,
      failed_items_truncated: merged.failedTruncated || current.failed_items_truncated,
      current_cursor: input.current_cursor !== undefined ? scrub(input.current_cursor) : current.current_cursor,
      last_evidence: sanitizeEvidence(input.last_evidence) || current.last_evidence,
      needs_help: nextStatus === 'RUNNING' ? undefined : current.needs_help,
      updated_at: ts,
    });
    await this.writeMeta(meta);
    await this.appendEvent(runId, {
      ts,
      kind: 'updated',
      data: redactValue({
        status: meta.status,
        resume_reason: input.resume_reason,
        current_cursor: meta.current_cursor,
        completed_count: meta.completed_items?.length || 0,
        failed_count: meta.failed_items?.length || 0,
        evidence: meta.last_evidence,
      }) as Record<string, unknown>,
    });
    return meta;
  }

  async checkpoint(runId: string, summary = '', opts: { current_cursor?: string; evidence?: EvidencePointer[] } = {}): Promise<TaskRunCheckpoint> {
    const meta = await this.get(runId);
    this.assertMutable(meta);
    const ts = this.now();
    const events = await this.readEvents(runId);
    const currentCursor = opts.current_cursor ? scrub(opts.current_cursor) : meta.current_cursor;
    const evidence = sanitizeEvidence(opts.evidence) || meta.last_evidence;
    const deterministicSummary = buildCheckpointSummary(meta, events, {
      current_cursor: currentCursor,
      evidence,
      summary,
    });
    const checkpoint: TaskRunCheckpoint = pruneUndefined({
      checkpoint_id: this.createRunId(`${runId}\0checkpoint\0${ts}`, ts),
      run_id: runId,
      source_event_range: sourceEventRange(events),
      summary: deterministicSummary.summary,
      current_cursor: currentCursor,
      completed_count: meta.completed_items?.length,
      failed_count: meta.failed_items?.length,
      last_url: lastUrl(meta, currentCursor),
      event_count: events.length,
      redaction_applied: deterministicSummary.redaction_applied,
      evidence,
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
  }

  async latestCheckpoint(runId: string): Promise<TaskRunCheckpoint | undefined> {
    const dir = path.join(this.runDir(runId), 'checkpoints');
    if (!fs.existsSync(dir)) return undefined;
    const entries = await fs.promises.readdir(dir);
    const checkpoints: TaskRunCheckpoint[] = [];
    for (const entry of entries.filter(name => name.endsWith('.json'))) {
      const result = await readFileSafe<TaskRunCheckpoint>(path.join(dir, entry));
      if (result.success && result.data) checkpoints.push(result.data);
    }
    checkpoints.sort((a, b) => b.created_at - a.created_at || b.checkpoint_id.localeCompare(a.checkpoint_id));
    return checkpoints[0];
  }

  async needsHelp(runId: string, input: NeedsHelpInput): Promise<TaskRunMeta> {
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
  }

  async complete(runId: string, input: CompleteInput = {}): Promise<TaskRunMeta> {
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
      completed_items_truncated: merged.completedTruncated || current.completed_items_truncated,
      failed_items_truncated: merged.failedTruncated || current.failed_items_truncated,
      last_evidence: sanitizeEvidence(input.last_evidence) || current.last_evidence,
      needs_help: undefined,
      updated_at: ts,
      completed_at: ts,
    });
    await this.writeMeta(meta);
    const kind = status === 'COMPLETED' ? 'completed' : status === 'FAILED' ? 'failed' : 'cancelled';
    await this.appendEvent(runId, { ts, kind, data: { status } });
    return meta;
  }

  async readEvents(runId: string): Promise<TaskRunEvent[]> {
    const eventsPath = this.eventsPath(runId);
    if (!fs.existsSync(eventsPath)) return [];
    const text = await fs.promises.readFile(eventsPath, 'utf8');
    return text.split('\n').filter(Boolean).map((line, index) => {
      const event = JSON.parse(line) as TaskRunEvent;
      return event.seq === undefined ? { ...event, seq: index + 1 } : event;
    });
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
    const safeEvent = redactValue({ ...event, seq: await this.nextEventSeq(runId) }) as TaskRunEvent;
    await fs.promises.appendFile(this.eventsPath(runId), `${JSON.stringify(safeEvent)}\n`, 'utf8');
  }

  private async nextEventSeq(runId: string): Promise<number> {
    const eventsPath = this.eventsPath(runId);
    if (!fs.existsSync(eventsPath)) return 1;
    const text = await fs.promises.readFile(eventsPath, 'utf8');
    return text.split('\n').filter(Boolean).length + 1;
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
  const completedTruncated = Math.max(0, completed.length - MAX_ITEMS);
  const failedTruncated = Math.max(0, failed.length - MAX_ITEMS);
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

function sourceEventRange(events: TaskRunEvent[]): { from: number; to: number } {
  if (events.length === 0) return { from: 0, to: 0 };
  return {
    from: events[0].seq || 1,
    to: events[events.length - 1].seq || events.length,
  };
}

function buildCheckpointSummary(
  meta: TaskRunMeta,
  events: TaskRunEvent[],
  opts: { current_cursor?: string; evidence?: EvidencePointer[]; summary?: string },
): { summary: string; redaction_applied: boolean } {
  const range = sourceEventRange(events);
  const lines = [
    'TaskRun checkpoint',
    `status=${meta.status}`,
    `events=${events.length} range=${range.from}-${range.to}`,
    `completed=${meta.completed_items?.length || 0}`,
    `failed=${meta.failed_items?.length || 0}`,
  ];
  if (opts.current_cursor) lines.push(`cursor=${opts.current_cursor}`);
  const url = lastUrl(meta, opts.current_cursor);
  if (url) lines.push(`last_url=${url}`);
  if (meta.needs_help) lines.push(`needs_help=${meta.needs_help.reason}`);
  if (opts.evidence?.length) {
    lines.push(`evidence=${opts.evidence.map(item => `${item.kind}:${item.ref}`).join(',')}`);
  }
  if (opts.summary) lines.push(`caller_note=${opts.summary}`);
  const raw = lines.join('\n');
  const summary = limit(scrub(raw), MAX_SUMMARY_CHARS);
  return { summary, redaction_applied: summary !== raw };
}

function lastUrl(meta: TaskRunMeta, cursor?: string): string | undefined {
  const candidate = cursor || meta.last_evidence?.find(item => item.kind === 'url')?.ref;
  if (!candidate) return undefined;
  return /^https?:\/\//i.test(candidate) ? scrub(candidate) : undefined;
}
