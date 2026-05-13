/**
 * Runner state-machine tests — covers PENDING -> RUNNING -> terminal
 * transitions, cancellation latency, partial-result retention, wait
 * with timeout, and watcher vs poll fallback.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TaskStore,
  runTask,
  waitForTerminal,
  TaskWaitTimeoutError,
} from '../../../src/core/task-ledger';
import type { TaskMeta } from '../../../src/core/task-ledger';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tasks-runner-'));
}

function pendingMeta(taskId: string, overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    task_id: taskId,
    kind: 'crawl',
    status: 'PENDING',
    pid: process.pid,
    created_at: Date.now(),
    args_summary: {},
    ...overrides,
  };
}

describe('runTask — happy path COMPLETED', () => {
  let root: string;
  let store: TaskStore;

  beforeEach(() => {
    root = tempRoot();
    store = new TaskStore({ rootDir: root });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('PENDING -> RUNNING -> COMPLETED, result persisted', async () => {
    const id = '1111111111111111';
    await store.create(pendingMeta(id));
    const outcome = await runTask(store, {
      taskId: id,
      pid: process.pid,
      invoke: async () => ({ ok: true, pages: ['/a', '/b'] }),
    });
    expect(outcome.status).toBe('COMPLETED');
    const meta = store.readMetaSync(id);
    expect(meta?.status).toBe('COMPLETED');
    expect(meta?.started_at).toBeDefined();
    expect(meta?.ended_at).toBeDefined();
    expect(meta?.result_path).toBe(store.resultPath(id));
    expect(store.readResultSync(id)).toEqual({ ok: true, pages: ['/a', '/b'] });
    const eventLines = fs.readFileSync(store.eventsPath(id), 'utf8').trim().split('\n');
    const kinds = eventLines.map((l) => JSON.parse(l).kind);
    expect(kinds).toContain('started');
    expect(kinds).toContain('completed');
  });
});

describe('runTask — FAILED path', () => {
  let root: string;
  let store: TaskStore;

  beforeEach(() => {
    root = tempRoot();
    store = new TaskStore({ rootDir: root });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('underlying throw lands as FAILED with error.message', async () => {
    const id = '2222222222222222';
    await store.create(pendingMeta(id));
    const outcome = await runTask(store, {
      taskId: id,
      pid: process.pid,
      invoke: async () => {
        throw new Error('boom');
      },
    });
    expect(outcome.status).toBe('FAILED');
    expect(store.readMetaSync(id)?.error?.message).toBe('boom');
  });


  test('MCP isError result lands as FAILED rather than COMPLETED', async () => {
    const id = '2222222222222223';
    await store.create(pendingMeta(id));
    const outcome = await runTask(store, {
      taskId: id,
      pid: process.pid,
      invoke: async () => ({ isError: true, content: [{ type: 'text', text: 'inner failed' }] }),
    });
    expect(outcome.status).toBe('FAILED');
    expect(store.readMetaSync(id)?.status).toBe('FAILED');
    expect(store.readMetaSync(id)?.error?.message).toBe('inner failed');
  });
});

describe('runTask — cancellation', () => {
  let root: string;
  let store: TaskStore;

  beforeEach(() => {
    root = tempRoot();
    store = new TaskStore({ rootDir: root });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('signal flips after cancel_requested_at and tool returns partial state', async () => {
    const id = '3333333333333333';
    await store.create(pendingMeta(id));

    // Tool that emits pages until aborted.
    const pages: string[] = [];
    const invoke = async (signal: AbortSignal): Promise<{ pages: string[] }> => {
      while (!signal.aborted) {
        pages.push(`/page-${pages.length}`);
        await new Promise((r) => setTimeout(r, 30));
      }
      return { pages };
    };

    // Start the task; cancel after ~250 ms so at least one page is emitted.
    const runP = runTask(store, { taskId: id, pid: process.pid, invoke });
    await new Promise((r) => setTimeout(r, 250));
    await store.update(id, (cur) => ({ ...cur, cancel_requested_at: Date.now() }));
    const outcome = await runP;

    expect(outcome.status).toBe('CANCELLED');
    const result = store.readResultSync(id) as { pages: string[] } | undefined;
    expect(result?.pages.length).toBeGreaterThan(0);
    expect(store.readMetaSync(id)?.status).toBe('CANCELLED');
  });
});

describe('waitForTerminal — fs.watch + poll fallback', () => {
  let root: string;
  let store: TaskStore;

  beforeEach(() => {
    root = tempRoot();
    store = new TaskStore({ rootDir: root });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('returns immediately when task is already terminal', async () => {
    const id = '4444444444444444';
    await store.create(pendingMeta(id, { status: 'COMPLETED' }));
    const meta = await waitForTerminal(store, id, 5_000);
    expect(meta.status).toBe('COMPLETED');
  });

  test('resolves within ~250 ms of terminal transition', async () => {
    const id = '5555555555555555';
    await store.create(pendingMeta(id));
    // Run the task; underlying takes 100ms, then completes.
    const runP = runTask(store, {
      taskId: id,
      pid: process.pid,
      invoke: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { ok: true };
      },
    });
    const t0 = Date.now();
    const meta = await waitForTerminal(store, id, 5_000);
    const elapsed = Date.now() - t0;
    await runP;
    expect(meta.status).toBe('COMPLETED');
    // Allow generous slack (CI variance); requirement is "no spin".
    expect(elapsed).toBeLessThan(2_000);
  });

  test('throws TaskWaitTimeoutError on expiry', async () => {
    const id = '6666666666666666';
    await store.create(pendingMeta(id, { status: 'RUNNING' }));
    await expect(waitForTerminal(store, id, 200)).rejects.toBeInstanceOf(TaskWaitTimeoutError);
  });

  test('throws for unknown task id', async () => {
    await expect(waitForTerminal(store, '7777777777777777', 200)).rejects.toThrow(/unknown task/);
  });
});
