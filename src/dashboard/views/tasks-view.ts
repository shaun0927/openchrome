/**
 * Tasks View — read-only ANSI rendering of the task ledger (#865).
 *
 * Surfaces the ledger backing `oc_task_*` (#855) inside the terminal
 * dashboard. The view is strictly read-only: it never mutates the
 * ledger files. Refresh cadence matches the rest of the dashboard's
 * 1–2s tick.
 */

import { ANSI, BOX, horizontalLine, pad, truncate } from '../ansi.js';
import type { ScreenSize } from '../types.js';
import { Renderer } from '../renderer.js';
import { TaskStore, defaultTaskRootDir } from '../../core/task-ledger/index.js';
import type { TaskMeta, TaskStatus } from '../../core/task-ledger/index.js';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TasksViewData {
  tasks: TaskMeta[];
  version: string;
  recovery?: RecoveryViewData;
  /** Last error encountered while reading the ledger, if any. */
  errorMessage?: string;
}

export interface RecoveryViewData {
  taskRuns: TaskRunRecovery[];
  handoffs: HandoffRecovery[];
  errorMessage?: string;
}

export interface TaskRunRecovery {
  run_id: string;
  status: string;
  reason?: string;
  requested_at?: number;
  resume_hint?: string;
  current_cursor?: string;
  last_checkpoint?: string;
  evidence?: Array<{ kind: string; ref: string; summary?: string }>;
}

export interface HandoffRecovery {
  handoff_id: string;
  status: string;
  reason?: string;
  run_id?: string;
  expires_at?: number;
  before_url?: string;
  before_title?: string;
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  PENDING: ANSI.dim,
  RUNNING: ANSI.cyan,
  COMPLETED: ANSI.green,
  FAILED: ANSI.red,
  CANCELLED: ANSI.yellow,
};

const RECOVERY_STATUS_COLORS: Record<string, string> = {
  NEEDS_HELP: ANSI.brightYellow,
  ACTIVE: ANSI.brightMagenta,
};

function colorize(text: string, code: string | undefined): string {
  if (!code) return text;
  return code + text + ANSI.reset;
}

export class TasksView {
  private renderer: Renderer;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  render(data: TasksViewData, size: ScreenSize): string[] {
    const lines: string[] = [];
    const width = size.columns;

    lines.push(this.renderer.header('Task Ledger', width));
    lines.push(this.renderColumnHeaders(width));
    lines.push(BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft);

    if (data.errorMessage) {
      lines.push(this.renderer.contentLine(colorize(`error: ${data.errorMessage}`, ANSI.red), width));
    } else if (data.tasks.length === 0) {
      lines.push(
        this.renderer.contentLine(
          colorize('(no tasks recorded — kick one off via oc_task_start)', ANSI.dim),
          width,
        ),
      );
    } else {
      const recoveryLines = this.renderRecovery(data.recovery, width);
      const visibleRows = Math.max(0, size.rows - 7 - recoveryLines.length);
      for (const t of data.tasks.slice(0, visibleRows)) {
        lines.push(this.renderTaskRow(t, width));
      }
      lines.push(...recoveryLines);
    }

    while (lines.length < size.rows - 3) {
      lines.push(this.renderer.emptyLine(width));
    }

    lines.push(BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft);
    lines.push(
      this.renderer.contentLine(colorize('esc: back  q: quit  (read-only view)', ANSI.dim), width),
    );
    lines.push(this.renderer.footer(width));
    return lines;
  }

  private renderRecovery(recovery: RecoveryViewData | undefined, width: number): string[] {
    if (!recovery) return [];
    const lines: string[] = [];
    if (recovery.errorMessage) {
      lines.push(BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft);
      lines.push(this.renderer.contentLine(colorize(`recovery metadata unavailable: ${recovery.errorMessage}`, ANSI.dim), width));
      return lines;
    }
    const needsHelp = recovery.taskRuns.filter(run => run.status === 'NEEDS_HELP');
    const activeHandoffs = recovery.handoffs.filter(handoff => handoff.status === 'ACTIVE');
    if (needsHelp.length === 0 && activeHandoffs.length === 0) return [];

    lines.push(BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft);
    lines.push(this.renderer.contentLine(colorize('Recovery / Human Help', ANSI.bold), width));
    for (const run of needsHelp.slice(0, 3)) {
      const status = colorize('NEEDS_HELP', RECOVERY_STATUS_COLORS.NEEDS_HELP);
      lines.push(this.renderer.contentLine(
        truncate(`${status} run=${run.run_id.slice(0, 8)} reason=${run.reason || '—'}`, width - 4),
        width,
      ));
      lines.push(this.renderer.contentLine(
        truncate(`  cursor=${run.current_cursor || '—'} resume=${run.resume_hint || '—'}`, width - 4),
        width,
      ));
      const evidence = (run.evidence || []).slice(0, 3).map(item => `${item.kind}:${item.ref}`).join(', ') || '—';
      lines.push(this.renderer.contentLine(
        truncate(`  checkpoint=${run.last_checkpoint || '—'} evidence=${evidence}`, width - 4),
        width,
      ));
    }
    for (const handoff of activeHandoffs.slice(0, 3)) {
      const remaining = handoff.expires_at ? formatAge(Math.max(0, handoff.expires_at - Date.now())) : '—';
      const status = colorize('ACTIVE', RECOVERY_STATUS_COLORS.ACTIVE);
      lines.push(this.renderer.contentLine(
        truncate(`${status} handoff=${handoff.handoff_id.slice(0, 8)} run=${handoff.run_id?.slice(0, 8) || '—'} timeout=${remaining}`, width - 4),
        width,
      ));
      lines.push(this.renderer.contentLine(
        truncate(`  reason=${handoff.reason || '—'} before=${handoff.before_url || handoff.before_title || '—'}`, width - 4),
        width,
      ));
    }
    return lines;
  }

  private renderColumnHeaders(width: number): string {
    const header = colorize(
      pad('task_id', 10) +
        ' ' +
        pad('kind', 22) +
        ' ' +
        pad('status', 10) +
        ' ' +
        pad('age', 10) +
        ' ' +
        'duration_ms',
      ANSI.bold,
    );
    return this.renderer.contentLine(header, width);
  }

  private renderTaskRow(t: TaskMeta, width: number): string {
    const shortId = t.task_id.slice(0, 8);
    const startedAt = t.started_at ?? 0;
    const endedAt = t.ended_at ?? null;
    const ageMs = startedAt > 0 ? Date.now() - startedAt : -1;
    const ageStr = formatAge(ageMs);
    const durStr =
      endedAt !== null && startedAt > 0 ? String(Math.max(0, endedAt - startedAt)) : '—';
    const row =
      pad(shortId, 10) +
      ' ' +
      pad(truncate(t.kind, 22), 22) +
      ' ' +
      colorize(pad(t.status, 10), STATUS_COLORS[t.status]) +
      ' ' +
      pad(ageStr, 10) +
      ' ' +
      durStr;
    return this.renderer.contentLine(row, width);
  }
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

/**
 * Snapshot reader for the dashboard tick. Reads the default task root
 * (`~/.openchrome/tasks/` or `OPENCHROME_TASK_ROOT`) and returns up to
 * `limit` most-recently-started tasks. Read-only; any IO error is
 * captured in `errorMessage` rather than thrown.
 */
export async function readTasksSnapshot(limit = 200): Promise<TasksViewData> {
  try {
    const store = new TaskStore({ rootDir: defaultTaskRootDir() });
    const tasks = await store.list({ limit });
    tasks.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
    const recovery = await readRecoverySnapshot();
    return { tasks, version: '1', recovery };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tasks: [], version: '1', errorMessage: msg };
  }
}

export async function readRecoverySnapshot(limit = 50): Promise<RecoveryViewData> {
  try {
    const home = process.env.OPENCHROME_HOME || join(homedir(), '.openchrome');
    const taskRuns = await readTaskRuns(join(home, 'task-runs'), limit);
    const handoffs = await readHandoffs(join(home, 'handoffs'), limit);
    return { taskRuns, handoffs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { taskRuns: [], handoffs: [], errorMessage: msg };
  }
}

async function readTaskRuns(root: string, limit: number): Promise<TaskRunRecovery[]> {
  const entries = await readdirSafe(root);
  const rows: TaskRunRecovery[] = [];
  for (const entry of entries.slice(0, limit)) {
    const meta = await readJsonSafe<Record<string, unknown>>(join(root, entry, 'meta.json'));
    if (!meta) continue;
    const needsHelp = meta.needs_help as Record<string, unknown> | undefined;
    rows.push({
      run_id: String(meta.run_id || entry),
      status: String(meta.status || 'UNKNOWN'),
      reason: typeof needsHelp?.reason === 'string' ? needsHelp.reason : undefined,
      requested_at: typeof needsHelp?.requested_at === 'number' ? needsHelp.requested_at : undefined,
      resume_hint: typeof needsHelp?.resume_hint === 'string' ? needsHelp.resume_hint : undefined,
      current_cursor: typeof meta.current_cursor === 'string' ? meta.current_cursor : undefined,
      last_checkpoint: await readLatestCheckpointId(join(root, entry, 'checkpoints')),
      evidence: Array.isArray(meta.last_evidence) ? meta.last_evidence as TaskRunRecovery['evidence'] : undefined,
    });
  }
  return rows.sort((a, b) => (b.requested_at || 0) - (a.requested_at || 0));
}

async function readHandoffs(root: string, limit: number): Promise<HandoffRecovery[]> {
  const entries = await readdirSafe(root);
  const rows: HandoffRecovery[] = [];
  for (const entry of entries.slice(0, limit)) {
    const meta = await readJsonSafe<Record<string, unknown>>(join(root, entry, 'meta.json'));
    if (!meta) continue;
    const before = meta.before as Record<string, unknown> | undefined;
    rows.push({
      handoff_id: String(meta.handoff_id || entry),
      status: String(meta.status || 'UNKNOWN'),
      reason: typeof meta.reason === 'string' ? meta.reason : undefined,
      run_id: typeof meta.run_id === 'string' ? meta.run_id : undefined,
      expires_at: typeof meta.expires_at === 'number' ? meta.expires_at : undefined,
      before_url: typeof before?.url === 'string' ? before.url : undefined,
      before_title: typeof before?.title === 'string' ? before.title : undefined,
    });
  }
  return rows.sort((a, b) => (b.expires_at || 0) - (a.expires_at || 0));
}

async function readLatestCheckpointId(root: string): Promise<string | undefined> {
  const entries = await readdirSafe(root);
  const checkpoints: Array<{ id: string; created_at: number }> = [];
  for (const entry of entries.filter(name => name.endsWith('.json'))) {
    const json = await readJsonSafe<Record<string, unknown>>(join(root, entry));
    if (!json) continue;
    checkpoints.push({
      id: String(json.checkpoint_id || entry.replace(/\.json$/, '')),
      created_at: typeof json.created_at === 'number' ? json.created_at : 0,
    });
  }
  checkpoints.sort((a, b) => b.created_at - a.created_at);
  return checkpoints[0]?.id;
}

async function readdirSafe(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() || entry.isFile()).map(entry => entry.name);
  } catch {
    return [];
  }
}

async function readJsonSafe<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
