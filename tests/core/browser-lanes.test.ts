import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyLaneTarget, getBrowserLane, recordLaneToolCall } from '../../src/core/browser-lanes';
import { TaskStore } from '../../src/core/task-ledger/store';
import type { TaskMeta } from '../../src/core/task-ledger/types';
import { setTaskStoreForTests } from '../../src/tools/oc-task-start';

describe('browser lanes (#1037)', () => {
  let dir: string;
  let store: TaskStore;
  const taskId = '0123456789abcdef';

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-lanes-'));
    store = new TaskStore({ rootDir: dir });
    setTaskStoreForTests(store);
    const meta: TaskMeta = {
      task_id: taskId,
      kind: 'browser_task',
      status: 'RUNNING',
      pid: process.pid,
      created_at: Date.now(),
      args_summary: {},
      owner: { session_id: 'session-a' },
      lanes: [{
        lane_id: 'lane_alpha',
        task_id: taskId,
        status: 'open',
        sessionId: 'session-a',
        workerId: 'task:0123456789abcdef:lane:lane_alpha',
        targetIds: ['tab-a'],
        created_at: Date.now(),
        last_activity_at: Date.now(),
        counters: { toolCalls: 0, failures: 0 },
      }],
    };
    await store.create(meta);
  });

  afterEach(() => {
    setTaskStoreForTests(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('applyLaneTarget defaults tabId and workerId from lane', () => {
    expect(applyLaneTarget({ taskId, laneId: 'lane_alpha' })).toEqual(expect.objectContaining({
      tabId: 'tab-a',
      workerId: 'task:0123456789abcdef:lane:lane_alpha',
    }));
  });

  test('applyLaneTarget rejects cross-lane tabId', () => {
    expect(() => applyLaneTarget({ taskId, laneId: 'lane_alpha', tabId: 'tab-b' })).toThrow(/does not belong/);
  });

  test('recordLaneToolCall increments lane counters and appends new target', async () => {
    await recordLaneToolCall({ taskId, laneId: 'lane_alpha' }, false, 'tab-b');
    const lane = getBrowserLane(taskId, 'lane_alpha');
    expect(lane.targetIds).toEqual(['tab-a', 'tab-b']);
    expect(lane.counters).toEqual({ toolCalls: 1, failures: 1 });
  });
});
