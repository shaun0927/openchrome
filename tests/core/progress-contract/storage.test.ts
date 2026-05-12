import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BulkProgressStore } from '../../../src/core/progress-contract';
import { TaskRunStore } from '../../../src/core/task-run';

describe('BulkProgressStore', () => {
  let dir: string;
  let now = 1_700_000_000_000;
  let taskRuns: TaskRunStore;
  let store: BulkProgressStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-bulk-progress-'));
    now = 1_700_000_000_000;
    taskRuns = new TaskRunStore({ rootDir: path.join(dir, 'task-runs'), now: () => now++ });
    store = new BulkProgressStore({
      rootDir: path.join(dir, 'progress-contracts'),
      taskRunStore: taskRuns,
      now: () => now++,
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('blocks completion until expected total is observed', async () => {
    const contract = await store.start({
      expected_total: 3,
      stop_condition: 'processed all input urls',
      item_key: 'url',
      completed: ['https://example.com'],
    });

    const blocked = store.checkCompletionGuard(contract);
    expect(blocked.allowed).toBe(false);
    expect(blocked.missing_count).toBe(2);

    const updated = await store.update(contract.contract_id, {
      completed: ['https://news.ycombinator.com'],
      failed: [{ item: 'https://www.iana.org/domains/reserved', reason: 'timeout', retryable: true }],
    });
    const allowed = store.checkCompletionGuard(updated);
    expect(allowed.allowed).toBe(true);
    expect(allowed.failed_count).toBe(1);
  });

  it('blocks completion when min_completed is unmet', async () => {
    const contract = await store.start({
      expected_total: 3,
      min_completed: 2,
      stop_condition: 'processed all input urls',
      item_key: 'url',
      completed: ['a'],
      failed: [{ item: 'b', reason: 'not found' }, { item: 'c', reason: 'not found' }],
    });

    const guard = store.checkCompletionGuard(contract);
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toContain('min_completed');
    expect(guard.missing_count).toBe(1);
  });

  it('requires unknown-total stop condition satisfaction', async () => {
    const contract = await store.start({
      stop_condition: 'no next page',
      item_key: 'page',
      completed: ['page-1'],
      cursor: 'page-2',
    });

    expect(store.checkCompletionGuard(contract).allowed).toBe(false);

    const stopped = await store.update(contract.contract_id, { stop_satisfied: true });
    expect(store.checkCompletionGuard(stopped).allowed).toBe(true);
  });

  it('links to TaskRun and bounds large item arrays', async () => {
    const run = await taskRuns.start({ goal: 'Process many rows' });
    const contract = await store.start({
      run_id: run.run_id,
      expected_total: 505,
      stop_condition: 'processed all rows',
      item_key: 'row',
      completed: Array.from({ length: 505 }, (_, i) => `row-${i}`),
      failed: Array.from({ length: 503 }, (_, i) => ({ item: `bad-${i}`, reason: 'failed' })),
    });

    expect(contract.completed).toHaveLength(500);
    expect(contract.failed).toHaveLength(500);
    expect(contract.completed_truncated).toBe(5);
    expect(contract.failed_truncated).toBe(3);

    const runAfterLink = await taskRuns.get(run.run_id);
    expect(runAfterLink.bulk_contract_id).toBe(contract.contract_id);
    expect(runAfterLink.completed_items).toHaveLength(500);
    expect(runAfterLink.failed_items).toHaveLength(500);
  });
});
