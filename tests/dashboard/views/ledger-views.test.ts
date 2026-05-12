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
import { TasksView, readRecoverySnapshot, type TasksViewData } from '../../../src/dashboard/views/tasks-view.js';
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

  test('renders NEEDS_HELP and active handoff recovery details read-only', () => {
    const renderer = new Renderer();
    const view = new TasksView(renderer);
    const data: TasksViewData = {
      version: '1',
      tasks: [mkTaskMeta({ task_id: 'r'.repeat(16), status: 'RUNNING' })],
      recovery: {
        taskRuns: [{
          run_id: '1'.repeat(16),
          status: 'NEEDS_HELP',
          reason: 'Manual login required before continuing',
          requested_at: Date.now(),
          resume_hint: 'Continue after login',
          current_cursor: 'https://the-internet.herokuapp.com/login',
          last_checkpoint: 'c'.repeat(16),
          evidence: [{ kind: 'url', ref: 'https://the-internet.herokuapp.com/login' }],
        }],
        handoffs: [{
          handoff_id: 'h'.repeat(16),
          status: 'ACTIVE',
          reason: 'Manual login required before continuing',
          run_id: '1'.repeat(16),
          expires_at: Date.now() + 10_000,
          before_url: 'https://the-internet.herokuapp.com/login',
          before_title: 'Login Page',
        }],
      },
    };
    const joined = view.render(data, SIZE).join('\n');
    expect(joined).toMatch(/Recovery \/ Human Help/);
    expect(joined).toMatch(/NEEDS_HELP/);
    expect(joined).toMatch(/Manual login required/);
    expect(joined).toMatch(/Continue after login/);
    expect(joined).toMatch(/ACTIVE/);
    expect(joined).toMatch(/handoff=hhhhhhhh/);
  });

  test.each([
    { rows: 24, columns: 80 },
    { rows: 40, columns: 120 },
    { rows: 60, columns: 200 },
  ])('recovery pane renders within terminal size %o', (size) => {
    const renderer = new Renderer();
    const view = new TasksView(renderer);
    const lines = view.render({
      version: '1',
      tasks: [mkTaskMeta({ task_id: 'r'.repeat(16), status: 'RUNNING' })],
      recovery: {
        taskRuns: [{
          run_id: '1'.repeat(16),
          status: 'NEEDS_HELP',
          reason: 'Manual login required before continuing',
          current_cursor: 'https://example.com/login',
          resume_hint: 'resume',
        }],
        handoffs: [],
      },
    }, size);
    expect(lines.length).toBe(size.rows);
    expect(lines.join('\n')).toMatch(/NEEDS_HELP/);
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

  test('readRecoverySnapshot reads TaskRun and handoff metadata without mutating files', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'oc-recovery-home-'));
    const prev = process.env.OPENCHROME_HOME;
    process.env.OPENCHROME_HOME = fakeHome;
    try {
      const runDir = join(fakeHome, 'task-runs', '1'.repeat(16));
      const handoffDir = join(fakeHome, 'handoffs', 'h'.repeat(16));
      const checkpointDir = join(runDir, 'checkpoints');
      await fs.mkdir(checkpointDir, { recursive: true });
      await fs.mkdir(handoffDir, { recursive: true });
      await fs.writeFile(join(runDir, 'meta.json'), JSON.stringify({
        run_id: '1'.repeat(16),
        status: 'NEEDS_HELP',
        current_cursor: 'https://example.com/login',
        needs_help: {
          reason: 'Manual login required',
          requested_at: 1_700_000_000_000,
          resume_hint: 'Continue after login',
        },
        last_evidence: [{ kind: 'url', ref: 'https://example.com/login' }],
      }));
      await fs.writeFile(join(checkpointDir, 'c.json'), JSON.stringify({
        checkpoint_id: 'c'.repeat(16),
        created_at: 1_700_000_000_001,
      }));
      await fs.writeFile(join(handoffDir, 'meta.json'), JSON.stringify({
        handoff_id: 'h'.repeat(16),
        status: 'ACTIVE',
        reason: 'Manual login required',
        run_id: '1'.repeat(16),
        expires_at: 1_700_000_010_000,
        before: { url: 'https://example.com/login', title: 'Login' },
      }));
      const before = JSON.stringify(await tree(fakeHome));
      for (let i = 0; i < 3; i++) {
        const snapshot = await readRecoverySnapshot();
        expect(snapshot.taskRuns[0].status).toBe('NEEDS_HELP');
        expect(snapshot.taskRuns[0].last_checkpoint).toBe('c'.repeat(16));
        expect(snapshot.handoffs[0].status).toBe('ACTIVE');
      }
      expect(JSON.stringify(await tree(fakeHome))).toBe(before);
    } finally {
      process.env.OPENCHROME_HOME = prev;
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });
});

async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      out.push(full.replace(root, ''));
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return out.sort();
}

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

  test('entry refresh and timer refresh share one in-flight guard', async () => {
    let resolveRefresh!: () => void;
    const dashboard = new Dashboard({ enabled: false }) as unknown as {
      currentView: string;
      handleMainViewKey: (key: string) => void;
      refreshTick: () => void;
      refreshLedgers: jest.Mock<Promise<void>, []>;
    };
    dashboard.currentView = 'activity';
    dashboard.refreshLedgers = jest.fn(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));

    dashboard.handleMainViewKey('j');
    dashboard.refreshTick();
    expect(dashboard.refreshLedgers).toHaveBeenCalledTimes(1);

    resolveRefresh();
    await dashboard.refreshLedgers.mock.results[0].value;
    await Promise.resolve();

    dashboard.refreshTick();
    expect(dashboard.refreshLedgers).toHaveBeenCalledTimes(2);
  });
});
