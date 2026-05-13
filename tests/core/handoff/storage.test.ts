import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HandoffStore, HandoffTransitionError } from '../../../src/core/handoff';
import { TaskRunStore } from '../../../src/core/task-run';

describe('HandoffStore', () => {
  let dir: string;
  let handoffDir: string;
  let taskRunDir: string;
  let now = 1_700_000_000_000;
  let taskRuns: TaskRunStore;
  let store: HandoffStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-handoff-'));
    handoffDir = path.join(dir, 'handoffs');
    taskRunDir = path.join(dir, 'task-runs');
    now = 1_700_000_000_000;
    taskRuns = new TaskRunStore({ rootDir: taskRunDir, now: () => now++ });
    store = new HandoffStore({ rootDir: handoffDir, taskRunStore: taskRuns, now: () => now++ });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finishes a handoff and appends one TaskRun handoff evidence pointer', async () => {
    const run = await taskRuns.start({ goal: 'Complete checkout after login' });
    const handoff = await store.start({
      run_id: run.run_id,
      reason: 'Manual login required',
      before: { url: 'https://example.com/login', title: 'Login', cookie_count: 1 },
    });

    const finished = await store.finish(handoff.handoff_id, {
      human_summary: 'User completed login',
      after: { url: 'https://example.com/account', title: 'Account', cookie_count: 3, local_storage_keys: ['logged_in'] },
    });

    expect(finished.status).toBe('COMPLETED');
    expect(finished.delta_summary).toContain('url: https://example.com/login -> https://example.com/account');
    expect(finished.task_run_evidence_appended).toBe(true);

    const updatedRun = await taskRuns.get(run.run_id);
    expect(updatedRun.last_evidence).toEqual([{
      kind: 'handoff',
      ref: handoff.handoff_id,
      summary: finished.delta_summary,
    }]);
  });

  it('redacts secrets from handoff metadata and events', async () => {
    const handoff = await store.start({
      reason: 'Need token=abcdefabcdefabcdefabcdefabcdef12',
      resume_hint: 'password=hunter2',
      before: { url: 'https://example.com/?token=supersecretvalue1234567890' },
    });
    await store.status(handoff.handoff_id);

    const raw = fs.readFileSync(path.join(handoffDir, handoff.handoff_id, 'meta.json'), 'utf8') +
      fs.readFileSync(path.join(handoffDir, handoff.handoff_id, 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('abcdefabcdefabcdefabcdefabcdef12');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('supersecretvalue1234567890');
    expect(raw).toContain('[REDACTED]');
  });

  it('times out expired handoffs and prevents finish afterwards', async () => {
    const handoff = await store.start({ reason: 'Waiting for user', ttl_ms: 1000 });
    now += 2000;

    const timedOut = await store.status(handoff.handoff_id);
    expect(timedOut.status).toBe('TIMED_OUT');

    await expect(store.finish(handoff.handoff_id, { human_summary: 'late' }))
      .rejects.toBeInstanceOf(HandoffTransitionError);
  });

  it('cancels active handoffs and prevents double cancellation', async () => {
    const handoff = await store.start({ reason: 'User confirmation needed' });
    const cancelled = await store.cancel(handoff.handoff_id, 'Not needed');
    expect(cancelled.status).toBe('CANCELLED');

    await expect(store.cancel(handoff.handoff_id, 'again'))
      .rejects.toBeInstanceOf(HandoffTransitionError);
  });
});
