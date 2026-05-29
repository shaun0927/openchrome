import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyLaneTarget, createBrowserLane, closeBrowserLane, getBrowserLane, reconcileBrowserLaneTargets, recordLaneToolCall } from '../../src/core/browser-lanes';
import { TaskStore } from '../../src/core/task-ledger/store';
import type { TaskMeta } from '../../src/core/task-ledger/types';
import { setTaskStoreForTests } from '../../src/tools/oc-task-start';

// ---------------------------------------------------------------------------
// Stub SessionManager — createBrowserLane calls getSessionManager()
// ---------------------------------------------------------------------------
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));
import { getSessionManager } from '../../src/session-manager';

function makeStubSessionManager() {
  return {
    getOrCreateWorker: jest.fn().mockResolvedValue({ id: 'worker-stub' }),
    createTarget: jest.fn().mockResolvedValue({ targetId: 'tab-new', workerId: 'worker-stub' }),
    closeTarget: jest.fn().mockResolvedValue(undefined),
  };
}

describe('browser lanes (#1037)', () => {
  let dir: string;
  let store: TaskStore;
  const taskId = '0123456789abcdef';

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-lanes-'));
    store = new TaskStore({ rootDir: dir });
    setTaskStoreForTests(store);
    const stubSM = makeStubSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(stubSM);
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
    jest.clearAllMocks();
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


  test('reconcileBrowserLaneTargets marks missing restored targets as recoverable failures', async () => {
    const lanes = await reconcileBrowserLaneTargets(taskId, new Set<string>());

    expect(lanes[0]).toMatchObject({
      status: 'failed',
      recovery: 'target_missing',
      targetStatuses: [{ targetId: 'tab-a', status: 'target_missing' }],
    });
    expect(getBrowserLane(taskId, 'lane_alpha')).toMatchObject({ status: 'failed', recovery: 'target_missing' });
  });

  test('reconcileBrowserLaneTargets keeps lane open when every restored target is live', async () => {
    const lanes = await reconcileBrowserLaneTargets(taskId, new Set(['tab-a']));

    expect(lanes[0]).toMatchObject({
      status: 'open',
      targetStatuses: [{ targetId: 'tab-a', status: 'open' }],
    });
    expect(lanes[0].recovery).toBeUndefined();
  });

  test('reconcileBrowserLaneTargets reports per-target status when some targets are missing', async () => {
    await recordLaneToolCall({ taskId, laneId: 'lane_alpha' }, true, 'tab-b');

    const lanes = await reconcileBrowserLaneTargets(taskId, new Set(['tab-a']));

    expect(lanes[0]).toMatchObject({
      status: 'failed',
      recovery: 'target_missing',
      targetStatuses: [
        { targetId: 'tab-a', status: 'open' },
        { targetId: 'tab-b', status: 'target_missing' },
      ],
    });
  });

  test('recordLaneToolCall increments lane counters and appends new target', async () => {
    await recordLaneToolCall({ taskId, laneId: 'lane_alpha' }, false, 'tab-b');
    const lane = getBrowserLane(taskId, 'lane_alpha');
    expect(lane.targetIds).toEqual(['tab-a', 'tab-b']);
    expect(lane.counters).toEqual({ toolCalls: 1, failures: 1 });
  });
});

describe('browser lanes — scratch profile (#1431 Part 1)', () => {
  let dir: string;
  let store: TaskStore;
  const taskId = 'abcdef0123456789';

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-lanes-scratch-'));
    store = new TaskStore({ rootDir: dir });
    setTaskStoreForTests(store);
    const stubSM = makeStubSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(stubSM);
    const meta: TaskMeta = {
      task_id: taskId,
      kind: 'browser_task',
      status: 'RUNNING',
      pid: process.pid,
      created_at: Date.now(),
      args_summary: {},
      owner: { session_id: 'session-b' },
    };
    await store.create(meta);
  });

  afterEach(() => {
    setTaskStoreForTests(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test('scratch lane: scratchDir exists on disk after creation', async () => {
    const lane = await createBrowserLane({ sessionId: 'session-b', taskId, profile: 'scratch' });
    expect(lane.profile).toBe('scratch');
    expect(lane.scratchDir).toBeDefined();
    expect(fs.existsSync(lane.scratchDir!)).toBe(true);
    // cleanup
    fs.rmSync(lane.scratchDir!, { recursive: true, force: true });
  });

  test('scratch lane: scratchDir removed after closeBrowserLane', async () => {
    const lane = await createBrowserLane({ sessionId: 'session-b', taskId, profile: 'scratch' });
    const scratchDir = lane.scratchDir!;
    expect(fs.existsSync(scratchDir)).toBe(true);

    await closeBrowserLane(taskId, lane.lane_id, 'session-b');
    expect(fs.existsSync(scratchDir)).toBe(false);
  });

  test('scratch lane: no orphan dir when worker creation fails', async () => {
    const stubSM = makeStubSessionManager();
    stubSM.getOrCreateWorker.mockRejectedValue(new Error('worker creation failed'));
    (getSessionManager as jest.Mock).mockReturnValue(stubSM);

    let capturedDir: string | undefined;
    // Intercept mkdir to capture path before failure
    const originalMkdir = fsPromises.mkdir;
    const mkdirSpy = jest.spyOn(fsPromises, 'mkdir').mockImplementation(async (...args) => {
      const result = await originalMkdir(...args as Parameters<typeof originalMkdir>);
      capturedDir = String(args[0]);
      return result;
    });

    await expect(
      createBrowserLane({ sessionId: 'session-b', taskId, profile: 'scratch' })
    ).rejects.toThrow('worker creation failed');

    mkdirSpy.mockRestore();
    if (capturedDir) {
      expect(fs.existsSync(capturedDir)).toBe(false);
    }
  });

  test('inherit lane: no scratchDir created', async () => {
    const lane = await createBrowserLane({ sessionId: 'session-b', taskId, profile: 'inherit' });
    expect(lane.profile).toBe('inherit');
    expect(lane.scratchDir).toBeUndefined();
  });

  test('default lane (no profile): behaves as inherit', async () => {
    const lane = await createBrowserLane({ sessionId: 'session-b', taskId });
    expect(lane.scratchDir).toBeUndefined();
  });
});
