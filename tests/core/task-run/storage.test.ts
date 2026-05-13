import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskRunStore, TaskRunTransitionError } from '../../../src/core/task-run';

describe('TaskRunStore', () => {
  let dir: string;
  let now = 1_700_000_000_000;
  let store: TaskRunStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-task-run-'));
    now = 1_700_000_000_000;
    store = new TaskRunStore({ rootDir: dir, now: () => now++ });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('starts, updates, checkpoints, lists, and completes a TaskRun', async () => {
    const started = await store.start({
      goal: 'Visit pages and collect titles',
      success_criteria: ['example.com visited'],
      session_id: 'default',
    });

    expect(started.run_id).toMatch(/^[a-f0-9]{16}$/);
    expect(started.status).toBe('RUNNING');

    const updated = await store.update(started.run_id, {
      progress_summary: 'Visited first page',
      completed_items: ['https://example.com'],
      current_cursor: 'https://example.com',
      last_evidence: [{ kind: 'url', ref: 'https://example.com', summary: 'Loaded page' }],
    });
    expect(updated.completed_items).toEqual(['https://example.com']);
    expect(updated.progress_summary).toBe('Visited first page');

    const checkpoint = await store.checkpoint(started.run_id, 'Checkpoint summary', {
      current_cursor: 'cursor-1',
      evidence: [{ kind: 'journal', ref: 'journal-1' }],
    });
    expect(checkpoint.checkpoint_id).toMatch(/^[a-f0-9]{16}$/);

    const listed = await store.list({ status: 'RUNNING' });
    expect(listed.map(r => r.run_id)).toContain(started.run_id);

    const completed = await store.complete(started.run_id, {
      progress_summary: 'Done',
      last_evidence: [{ kind: 'contract', ref: 'contract-1' }],
    });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.completed_at).toBeDefined();

    await expect(store.update(started.run_id, { progress_summary: 'late' }))
      .rejects.toBeInstanceOf(TaskRunTransitionError);
  });

  it('rejects invalid status transitions', async () => {
    const run = await store.start({ goal: 'Invalid status' });

    await expect(store.update(run.run_id, { status: 'PENDING' })).rejects.toThrow('PENDING');
    await expect(store.update(run.run_id, { status: 'BOGUS' as any })).rejects.toThrow('Unknown TaskRun status');
  });

  it('requires explicit resume reason when leaving NEEDS_HELP', async () => {
    const run = await store.start({ goal: 'Manual login' });
    await store.needsHelp(run.run_id, { reason: 'Login required', resume_hint: 'Continue after login' });

    await expect(store.update(run.run_id, { status: 'RUNNING' })).rejects.toThrow('resume_reason');

    const resumed = await store.update(run.run_id, {
      status: 'RUNNING',
      resume_reason: 'User completed login',
    });
    expect(resumed.status).toBe('RUNNING');
    expect(resumed.needs_help).toBeUndefined();
  });

  it('redacts secret-like strings from metadata and event logs', async () => {
    const run = await store.start({
      goal: 'Open https://example.com/?token=supersecretvalue1234567890',
      success_criteria: ['password=hunter2 must never persist'],
    });
    await store.needsHelp(run.run_id, {
      reason: 'Need token=abcdefabcdefabcdefabcdefabcdef12 to proceed',
      resume_hint: 'password=hunter2',
    });

    const raw = fs.readFileSync(path.join(dir, run.run_id, 'meta.json'), 'utf8') +
      fs.readFileSync(path.join(dir, run.run_id, 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('supersecretvalue1234567890');
    expect(raw).not.toContain('abcdefabcdefabcdefabcdefabcdef12');
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain('[REDACTED]');
  });

  it('bounds completed and failed item arrays with truncation metadata', async () => {
    const run = await store.start({ goal: 'Bulk task' });
    await store.update(run.run_id, {
      completed_items: Array.from({ length: 505 }, (_, i) => `item-${i}`),
      failed_items: Array.from({ length: 503 }, (_, i) => ({ item: `bad-${i}`, reason: 'failed' })),
    });

    const meta = await store.get(run.run_id);
    expect(meta.completed_items).toHaveLength(500);
    expect(meta.failed_items).toHaveLength(500);
    expect(meta.completed_items_truncated).toBe(5);
    expect(meta.failed_items_truncated).toBe(3);
    expect(meta.completed_items?.[0]).toBe('item-5');
  });

  it('persists records across store instances', async () => {
    const run = await store.start({ goal: 'Restart-safe run' });
    await store.update(run.run_id, { completed_items: ['one'] });

    const reopened = new TaskRunStore({ rootDir: dir });
    const loaded = await reopened.get(run.run_id);
    expect(loaded.goal).toBe('Restart-safe run');
    expect(loaded.completed_items).toEqual(['one']);
  });

  it('rejects transitioning to NEEDS_HELP via update (must use oc_task_run_needs_help)', async () => {
    const run = await store.start({ goal: 'Cannot transition via update' });
    await expect(store.update(run.run_id, { status: 'NEEDS_HELP' as any }))
      .rejects.toThrow(/oc_task_run_needs_help/);
    const reloaded = await store.get(run.run_id);
    expect(reloaded.status).toBe('RUNNING');
    expect(reloaded.needs_help).toBeUndefined();
  });

  it('serializes concurrent update calls on the same run_id', async () => {
    const run = await store.start({ goal: 'Concurrent updates' });
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.update(run.run_id, { completed_items: [`item-${i}`] }),
      ),
    );
    const meta = await store.get(run.run_id);
    // Each concurrent caller must observe its predecessor's writes; union
    // must equal the full input set rather than the last-writer-wins value.
    expect(meta.completed_items).toBeDefined();
    expect(meta.completed_items!.length).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(meta.completed_items).toContain(`item-${i}`);
    }
  }, 30000);

  it('accumulates truncation counts across multiple overflows', async () => {
    const run = await store.start({ goal: 'Repeated overflow' });
    await store.update(run.run_id, {
      completed_items: Array.from({ length: 505 }, (_, i) => `first-${i}`),
    });
    let meta = await store.get(run.run_id);
    expect(meta.completed_items_truncated).toBe(5);

    await store.update(run.run_id, {
      completed_items: Array.from({ length: 10 }, (_, i) => `second-${i}`),
    });
    meta = await store.get(run.run_id);
    // Existing 500 retained + 10 new = 510 → 10 additional overflow → 5 + 10 = 15
    expect(meta.completed_items_truncated).toBe(15);
  });

  it('tolerates malformed JSONL lines in the event log', async () => {
    const run = await store.start({ goal: 'Resilient event reader' });
    await store.update(run.run_id, { progress_summary: 'one' });
    const eventsFile = path.join(dir, run.run_id, 'events.jsonl');
    fs.appendFileSync(eventsFile, 'this is not json\n', 'utf8');
    await store.update(run.run_id, { progress_summary: 'two' });

    const events = await store.readEvents(run.run_id);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every(e => typeof e.ts === 'number')).toBe(true);
  });
});
