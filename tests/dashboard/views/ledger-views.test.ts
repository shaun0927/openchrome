/**
 * Smoke tests for the read-only ledger views (#865).
 *
 * Verify that:
 *   - TasksView and SkillsView render without throwing on representative
 *     fixture data,
 *   - their snapshot readers degrade gracefully when the backing
 *     directories are absent (no crash, error captured in viewdata),
 *   - readers do NOT mutate the on-disk state (no files added/removed).
 */

import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Renderer } from '../../../src/dashboard/renderer.js';
import { Dashboard } from '../../../src/dashboard/index.js';
import { TasksView, type TasksViewData } from '../../../src/dashboard/views/tasks-view.js';
import { SkillsView, type SkillsViewData } from '../../../src/dashboard/views/skills-view.js';
import type { TaskMeta } from '../../../src/core/task-ledger/index.js';
import type { SkillRecord } from '../../../src/core/skill-memory/index.js';

const SIZE = { rows: 30, columns: 100 };

function mkTaskMeta(over: Partial<TaskMeta>): TaskMeta {
  return {
    task_id: 'a'.repeat(16),
    kind: 'crawl',
    args_summary: '{}',
    status: 'RUNNING',
    started_at: Date.now() - 1500,
    ended_at: null,
    pid: process.pid,
    last_event_at: Date.now(),
    error_code: null,
    error_message: null,
    ...over,
  } as TaskMeta;
}

function mkSkill(over: Partial<SkillRecord>): SkillRecord {
  return {
    skillId: 'b'.repeat(16),
    domain: 'example.com',
    name: 'login',
    steps: [],
    contractId: 'noop',
    successCount: 3,
    lastUsedAt: Date.now() - 60_000,
    frozenSnapshotPath: null,
    ...over,
  } as SkillRecord;
}

describe('TasksView', () => {
  test('renders header + rows for a mixed-status ledger', () => {
    const renderer = new Renderer();
    const view = new TasksView(renderer);
    const data: TasksViewData = {
      version: '1',
      tasks: [
        mkTaskMeta({ task_id: 'r'.repeat(16), status: 'RUNNING' }),
        mkTaskMeta({
          task_id: 'c'.repeat(16),
          status: 'COMPLETED',
          ended_at: Date.now(),
        }),
        mkTaskMeta({ task_id: 'x'.repeat(16), status: 'CANCELLED' }),
      ],
    };
    const lines = view.render(data, SIZE);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(5);
    const joined = lines.join('\n');
    expect(joined).toMatch(/Task Ledger/);
    expect(joined).toMatch(/RUNNING/);
    expect(joined).toMatch(/COMPLETED/);
    expect(joined).toMatch(/CANCELLED/);
  });

  test('renders the empty-state hint when no tasks exist', () => {
    const renderer = new Renderer();
    const view = new TasksView(renderer);
    const lines = view.render({ version: '1', tasks: [] }, SIZE);
    expect(lines.join('\n')).toMatch(/no tasks recorded/);
  });

  test('renders the error message when the snapshot reader failed', () => {
    const renderer = new Renderer();
    const view = new TasksView(renderer);
    const lines = view.render(
      { version: '1', tasks: [], errorMessage: 'permission denied' },
      SIZE,
    );
    expect(lines.join('\n')).toMatch(/permission denied/);
  });
});

describe('SkillsView', () => {
  test('renders rows with replay badges', () => {
    const renderer = new Renderer();
    const view = new SkillsView(renderer);
    const data: SkillsViewData = {
      version: '1',
      rows: [
        {
          domain: 'app.example.com',
          skill: { ...mkSkill({ name: 'happy-login' }), lastReplayPassedAt: Date.now() } as SkillRecord,
        },
        {
          domain: 'app.example.com',
          skill: { ...mkSkill({ name: 'tampered' }), lastReplayFailedAt: Date.now() } as SkillRecord,
        },
        { domain: 'never-replayed.example.com', skill: mkSkill({ name: 'pristine' }) },
      ],
    };
    const lines = view.render(data, SIZE);
    const joined = lines.join('\n');
    expect(joined).toMatch(/Skill Ledger/);
    expect(joined).toMatch(/PASS/);
    expect(joined).toMatch(/FAIL/);
    expect(joined).toMatch(/happy-login/);
    expect(joined).toMatch(/tampered/);
  });

  test('empty-state when no rows', () => {
    const renderer = new Renderer();
    const view = new SkillsView(renderer);
    const lines = view.render({ version: '1', rows: [] }, SIZE);
    expect(lines.join('\n')).toMatch(/no skills recorded/);
  });
});

describe('snapshot readers — read-only behavior', () => {
  test('readSkillsSnapshot tolerates a missing skill-memory directory', async () => {
    // Point HOME at a clean tmp dir so the reader walks an empty tree.
    const fakeHome = await mkdtemp(join(tmpdir(), 'oc-views-home-'));
    const prev = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const { readSkillsSnapshot } = await import(
        '../../../src/dashboard/views/skills-view.js'
      );
      const out = await readSkillsSnapshot();
      expect(out.rows).toEqual([]);
      // No state file should have been created by the reader.
      const dirAfter = await fs.readdir(fakeHome);
      expect(dirAfter).toEqual([]);
    } finally {
      process.env.HOME = prev;
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('Dashboard ledger refresh ticks', () => {
  test('timer path refreshes ledgers while staying on tasks or skills view', async () => {
    const dashboard = new Dashboard({ enabled: false }) as unknown as {
      currentView: string;
      refreshTick: () => void;
      refreshLedgers: jest.Mock<Promise<void>, []>;
      refresh: jest.Mock<void, []>;
    };
    dashboard.refreshLedgers = jest.fn().mockResolvedValue(undefined);
    dashboard.refresh = jest.fn();

    dashboard.currentView = 'tasks';
    dashboard.refreshTick();
    await dashboard.refreshLedgers.mock.results[0].value;
    expect(dashboard.refreshLedgers).toHaveBeenCalledTimes(1);
    expect(dashboard.refresh).not.toHaveBeenCalled();

    dashboard.currentView = 'activity';
    dashboard.refreshTick();
    expect(dashboard.refresh).toHaveBeenCalledTimes(1);
  });

  test('timer path avoids overlapping ledger snapshot reads', async () => {
    let resolveRefresh!: () => void;
    const dashboard = new Dashboard({ enabled: false }) as unknown as {
      currentView: string;
      refreshTick: () => void;
      refreshLedgers: jest.Mock<Promise<void>, []>;
    };
    dashboard.currentView = 'skills';
    dashboard.refreshLedgers = jest.fn(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));

    dashboard.refreshTick();
    dashboard.refreshTick();
    expect(dashboard.refreshLedgers).toHaveBeenCalledTimes(1);

    resolveRefresh();
    await dashboard.refreshLedgers.mock.results[0].value;
    await Promise.resolve();

    dashboard.refreshTick();
    expect(dashboard.refreshLedgers).toHaveBeenCalledTimes(2);
  });
});
