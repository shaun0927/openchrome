/**
 * TaskStore unit tests — disk layout, state machine, and orphan reaper.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TaskStore,
  computeTaskId,
  summariseArgs,
  isPidAlive,
  assertSafeTaskId,
} from '../../../src/core/task-ledger';
import type { TaskMeta } from '../../../src/core/task-ledger';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tasks-'));
}

function pendingMeta(taskId: string, overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    task_id: taskId,
    kind: 'crawl',
    status: 'PENDING',
    pid: process.pid,
    created_at: Date.now(),
    args_summary: { foo: 'bar' },
    ...overrides,
  };
}

describe('TaskStore — id helpers', () => {
  test('computeTaskId is deterministic and 16-hex', () => {
    const id1 = computeTaskId('crawl', { url: 'https://example.com' }, 1000);
    const id2 = computeTaskId('crawl', { url: 'https://example.com' }, 1000);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{16}$/);
  });

  test('computeTaskId differs across created_at', () => {
    const a = computeTaskId('crawl', { url: 'https://example.com' }, 1000);
    const b = computeTaskId('crawl', { url: 'https://example.com' }, 1001);
    expect(a).not.toBe(b);
  });

  test('assertSafeTaskId rejects path-escaping inputs', () => {
    expect(() => assertSafeTaskId('../../etc/passwd')).toThrow();
    expect(() => assertSafeTaskId('not-hex')).toThrow();
    expect(() => assertSafeTaskId('')).toThrow();
    expect(() => assertSafeTaskId('abcdef0123456789')).not.toThrow();
  });
});

describe('TaskStore — create / readMeta / list', () => {
  let root: string;
  let store: TaskStore;

  beforeEach(() => {
    root = tempRoot();
    store = new TaskStore({ rootDir: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('create writes meta.json and is readable', async () => {
    const meta = pendingMeta('aaaaaaaaaaaaaaaa');
    await store.create(meta);
    const back = store.readMetaSync(meta.task_id);
    expect(back?.task_id).toBe(meta.task_id);
    expect(back?.status).toBe('PENDING');
  });

  test('create twice on the same id throws', async () => {
    const meta = pendingMeta('bbbbbbbbbbbbbbbb');
    await store.create(meta);
    await expect(store.create(meta)).rejects.toThrow(/already exists/);
  });

  test('list applies status / kind / since / limit filters', async () => {
    const t0 = Date.now();
    await store.create(pendingMeta('1111111111111111', { created_at: t0, kind: 'crawl' }));
    await store.create(pendingMeta('2222222222222222', { created_at: t0 + 1, kind: 'recording', status: 'COMPLETED' }));
    await store.create(pendingMeta('3333333333333333', { created_at: t0 + 2, kind: 'crawl', status: 'FAILED' }));

    expect((await store.list({ status: 'PENDING' })).map((r) => r.task_id)).toEqual([
      '1111111111111111',
    ]);
    expect((await store.list({ kind: 'crawl' })).map((r) => r.task_id)).toEqual([
      '3333333333333333',
      '1111111111111111',
    ]);
    expect((await store.list({ since: t0 + 2 })).map((r) => r.task_id)).toEqual([
      '3333333333333333',
    ]);
    expect((await store.list({ limit: 1 })).map((r) => r.task_id)).toEqual([
      '3333333333333333',
    ]);
  });
});

describe('TaskStore — update is atomic and lock-serialised', () => {
  let root: string;
  let store: TaskStore;

  beforeEach(() => {
    root = tempRoot();
    store = new TaskStore({ rootDir: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('update preserves terminal immutability when mutator declines', async () => {
    const meta = pendingMeta('aaaaaaaaaaaaaaa1', { status: 'COMPLETED' });
    await store.create(meta);
    const result = await store.update(meta.task_id, (cur) => {
      if (cur.status === 'COMPLETED') return undefined; // honour invariant
      return { ...cur, status: 'FAILED' };
    });
    expect(result).toBeUndefined();
    expect(store.readMetaSync(meta.task_id)?.status).toBe('COMPLETED');
  });

  test('two concurrent writers do not corrupt meta.json (lock contention)', async () => {
    const meta = pendingMeta('cccccccccccccccc');
    await store.create(meta);
    // Run 20 concurrent updates that each bump a counter; final value
    // must equal 20 if the lock serialised them properly.
    const ops = Array.from({ length: 20 }, () =>
      store.update(meta.task_id, (cur) => {
        const n = ((cur.args_summary.counter as number) ?? 0) + 1;
        return { ...cur, args_summary: { ...cur.args_summary, counter: n } };
      }),
    );
    await Promise.all(ops);
    const final = store.readMetaSync(meta.task_id);
    expect(final?.args_summary.counter).toBe(20);
  });
});

describe('TaskStore — events.jsonl append', () => {
  let root: string;
  let store: TaskStore;

  beforeEach(() => {
    root = tempRoot();
    store = new TaskStore({ rootDir: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('appendEvent writes one JSON line per call', async () => {
    const meta = pendingMeta('dddddddddddddddd');
    await store.create(meta);
    store.appendEvent(meta.task_id, { ts: 1, kind: 'started' });
    store.appendEvent(meta.task_id, { ts: 2, kind: 'completed' });
    const raw = fs.readFileSync(store.eventsPath(meta.task_id), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].kind).toBe('started');
    expect(parsed[1].kind).toBe('completed');
  });
});

describe('TaskStore — reapOrphans', () => {
  let root: string;
  let store: TaskStore;

  beforeEach(() => {
    root = tempRoot();
    store = new TaskStore({ rootDir: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('RUNNING task whose pid is dead transitions to FAILED with code "orphaned"', async () => {
    // Use a pid we are confident is dead. pid=1 on POSIX is init/launchd
    // and is always alive; pid=2_000_000_000 is essentially never alive.
    // We use the latter to avoid platform variance.
    const deadPid = 2_000_000_000;
    const meta = pendingMeta('eeeeeeeeeeeeeeee', { status: 'RUNNING', pid: deadPid });
    await store.create(meta);
    const reaped = await store.reapOrphans();
    expect(reaped).toContain(meta.task_id);
    const back = store.readMetaSync(meta.task_id);
    expect(back?.status).toBe('FAILED');
    expect(back?.error?.code).toBe('orphaned');
  });


  test('PENDING task whose pid is dead transitions to FAILED with code "orphaned"', async () => {
    const deadPid = 2_000_000_000;
    const meta = pendingMeta('eeeeeeeeeeeeeeef', { status: 'PENDING', pid: deadPid });
    await store.create(meta);
    const reaped = await store.reapOrphans();
    expect(reaped).toContain(meta.task_id);
    const back = store.readMetaSync(meta.task_id);
    expect(back?.status).toBe('FAILED');
    expect(back?.error?.code).toBe('orphaned');
  });

  test('RUNNING task whose pid is alive is left untouched', async () => {
    const meta = pendingMeta('ffffffffffffffff', { status: 'RUNNING', pid: process.pid });
    await store.create(meta);
    const reaped = await store.reapOrphans();
    expect(reaped).not.toContain(meta.task_id);
    expect(store.readMetaSync(meta.task_id)?.status).toBe('RUNNING');
  });

  test('Terminal states are never touched', async () => {
    const completed = pendingMeta('aaaaaaaaaaaaaaa2', { status: 'COMPLETED' });
    await store.create(completed);
    const reaped = await store.reapOrphans();
    expect(reaped).not.toContain(completed.task_id);
    expect(store.readMetaSync(completed.task_id)?.status).toBe('COMPLETED');
  });
});

describe('TaskStore — helpers', () => {
  test('isPidAlive returns true for current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test('isPidAlive returns false for absurdly large pid', () => {
    expect(isPidAlive(2_000_000_000)).toBe(false);
  });

  test('summariseArgs redacts credential-shaped keys', () => {
    const out = summariseArgs({ url: 'https://example.com', password: 'secret', token: 'xyz' });
    expect(out.url).toBe('https://example.com');
    expect(out.password).toBe('[redacted]');
    expect(out.token).toBe('[redacted]');
  });

  test('summariseArgs redacts nested and case-variant credential keys', () => {
    const out = summariseArgs({
      headers: { Authorization: 'Bearer secret', 'X-API-Key': 'abc' },
      auth: { TOKEN: 'xyz' },
      safe: { value: 'kept' },
    });

    expect((out.headers as Record<string, unknown>).Authorization).toBe('[redacted]');
    expect((out.headers as Record<string, unknown>)['X-API-Key']).toBe('[redacted]');
    expect((out.auth as Record<string, unknown>).TOKEN).toBe('[redacted]');
    expect((out.safe as Record<string, unknown>).value).toBe('kept');
  });


  test('summariseArgs clamps payloads larger than ~2 KiB', () => {
    const big = 'x'.repeat(8192);
    const out = summariseArgs({ blob: big });
    const size = Buffer.byteLength(JSON.stringify(out), 'utf8');
    expect(size).toBeLessThanOrEqual(2048 + 64); // small overshoot tolerance for stub fallback
  });
});
