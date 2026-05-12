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

export interface TasksViewData {
  tasks: TaskMeta[];
  version: string;
  /** Last error encountered while reading the ledger, if any. */
  errorMessage?: string;
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  PENDING: ANSI.dim,
  RUNNING: ANSI.cyan,
  COMPLETED: ANSI.green,
  FAILED: ANSI.red,
  CANCELLED: ANSI.yellow,
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
      const visibleRows = Math.max(0, size.rows - 7);
      for (const t of data.tasks.slice(0, visibleRows)) {
        lines.push(this.renderTaskRow(t, width));
      }
    }

    while (lines.length < size.rows - 2) {
      lines.push(this.renderer.emptyLine(width));
    }

    lines.push(BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft);
    lines.push(
      this.renderer.contentLine(colorize('esc: back  q: quit  (read-only view)', ANSI.dim), width),
    );
    lines.push(this.renderer.footer(width));
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
    return { tasks, version: '1' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tasks: [], version: '1', errorMessage: msg };
  }
}
