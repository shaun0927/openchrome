import { TaskStore, computeTaskId } from '../../../src/core/task-ledger';
import { applyToolCallToTask, initialCounters, normalizeTaskPolicy } from '../../../src/core/task-ledger';
import { recordTaskToolCall } from '../../../src/core/task-ledger/envelope';
import type { TaskMeta, RecordedToolCall } from '../../../src/core/task-ledger';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeMeta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    task_id: 'aaaaaaaaaaaaaaaa',
    kind: 'browser_task',
    status: 'RUNNING',
    pid: process.pid,
    created_at: Date.now(),
    started_at: Date.now(),
    args_summary: {},
    objective: 'test objective',
    phase: 'explore',
    policy: normalizeTaskPolicy({ maxObservationStreak: 3, maxConsecutiveSameTool: 3, maxSameUrlNavigations: 2 }),
    counters: initialCounters(),
    budget_status: 'ok',
    recent_events: [],
    ...overrides,
  };
}

function call(tool: string, args: Record<string, unknown> = {}, ok = true): RecordedToolCall {
  return { ts: Date.now(), tool, sessionId: 'sess', args, durationMs: 5, ok };
}

describe('task envelope budget evaluation', () => {
  test('observation streak exceeds configured budget after repeated read_page calls', () => {
    let meta = makeMeta();
    meta = applyToolCallToTask(meta, call('read_page'));
    meta = applyToolCallToTask(meta, call('read_page'));
    meta = applyToolCallToTask(meta, call('read_page'));
    expect(meta.budget_status).toBe('warning');
    meta = applyToolCallToTask(meta, call('read_page'));
    expect(meta.budget_status).toBe('exceeded');
    expect(meta.budget_exceeded).toContain('maxObservationStreak');
    expect(meta.recommended_next).toBe('change_strategy_or_verify');
  });


  test('expanded read-only browser tools count as observations', () => {
    let meta = makeMeta();
    meta = applyToolCallToTask(meta, call('inspect'));
    meta = applyToolCallToTask(meta, call('tabs_list'));

    expect(meta.counters?.observationCalls).toBe(2);
    expect(meta.counters?.observationStreak).toBe(2);
    expect(meta.counters?.actionCalls).toBe(0);
  });

  test('action calls reset observation streak while incrementing action count', () => {
    let meta = makeMeta();
    meta = applyToolCallToTask(meta, call('read_page'));
    meta = applyToolCallToTask(meta, call('interact'));
    expect(meta.counters?.observationStreak).toBe(0);
    expect(meta.counters?.actionCalls).toBe(1);
  });

  test('same URL navigation budget is tracked per URL', () => {
    let meta = makeMeta();
    meta = applyToolCallToTask(meta, call('navigate', { url: 'http://localhost/a' }));
    meta = applyToolCallToTask(meta, call('navigate', { url: 'http://localhost/a' }));
    expect(meta.budget_status).toBe('warning');
    meta = applyToolCallToTask(meta, call('navigate', { url: 'http://localhost/a' }));
    expect(meta.budget_status).toBe('exceeded');
    expect(meta.budget_exceeded).toContain('maxSameUrlNavigations');
  });

  test('same URL navigation budget stays exceeded after later non-navigation calls', () => {
    let meta = makeMeta();
    meta = applyToolCallToTask(meta, call('navigate', { url: 'http://localhost/a' }));
    meta = applyToolCallToTask(meta, call('navigate', { url: 'http://localhost/a' }));
    meta = applyToolCallToTask(meta, call('navigate', { url: 'http://localhost/a' }));
    expect(meta.budget_status).toBe('exceeded');

    meta = applyToolCallToTask(meta, call('read_page'));

    expect(meta.budget_status).toBe('exceeded');
    expect(meta.budget_exceeded).toContain('maxSameUrlNavigations');
  });
});

describe('task envelope store integration', () => {
  let root: string;
  let store: TaskStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-task-envelope-'));
    store = new TaskStore({ rootDir: root });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('absent task id path is a no-op for normal tool calls', async () => {
    await expect(store.list()).resolves.toEqual([]);
  });

  test('task ids for browser_task envelopes are 16-hex and deterministic inputs vary by created_at', () => {
    const a = computeTaskId('browser_task', { objective: 'x' }, 1);
    const b = computeTaskId('browser_task', { objective: 'x' }, 2);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });


  test('recordTaskToolCall ignores non-browser_task rows', async () => {
    const meta = makeMeta({ kind: 'crawl', status: 'RUNNING' });
    await store.create(meta);

    await recordTaskToolCall(store, meta.task_id, {
      ts: Date.now(),
      tool: 'read_page',
      sessionId: 'sess',
      args: {},
      durationMs: 1,
      ok: true,
    });

    expect(store.readMetaSync(meta.task_id)?.counters?.toolCalls).toBe(0);
  });

  test('recordTaskToolCall ignores cross-owner task ids', async () => {
    const meta = makeMeta({
      owner: { session_id: 'sess-a', tenant_id: 'tenant-a', key_id: 'key-a', mode: 'api-key' },
    });
    await store.create(meta);

    await recordTaskToolCall(store, meta.task_id, {
      ts: Date.now(),
      tool: 'read_page',
      sessionId: 'sess-a',
      tenantId: 'tenant-b',
      principalMode: 'api-key',
      args: {},
      durationMs: 1,
      ok: true,
    });

    expect(store.readMetaSync(meta.task_id)?.counters?.toolCalls).toBe(0);
  });
});
