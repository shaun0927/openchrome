/**
 * Tests for oc_lane_create profile option (#1431 Part 1).
 *
 * Covers:
 *   1. profile:'scratch' threads through to createBrowserLane
 *   2. profile:'inherit' threads through to createBrowserLane
 *   3. missing profile defaults gracefully (no error)
 *   4. invalid profile value is ignored (treated as undefined / inherit)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TaskStore } from '../../src/core/task-ledger/store';
import type { BrowserLane, TaskMeta } from '../../src/core/task-ledger/types';
import { setTaskStoreForTests } from '../../src/tools/oc-task-start';

// ---------------------------------------------------------------------------
// Mock session-manager so no real CDP is needed
// ---------------------------------------------------------------------------
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));
import { getSessionManager } from '../../src/session-manager';

function makeStubSM() {
  return {
    getOrCreateWorker: jest.fn().mockResolvedValue({ id: 'worker-stub' }),
    createTarget: jest.fn().mockResolvedValue({ targetId: 'tab-stub', workerId: 'worker-stub' }),
    closeTarget: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// We test the oc_lane_create handler directly via __test__ export
// ---------------------------------------------------------------------------
type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: unknown };
type Handler = (sessionId: string, args: Record<string, unknown>) => Promise<ToolResult>;

let createHandler: Handler;

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ createHandler } = (require('../../src/tools/oc-lane') as { __test__: { createHandler: Handler } }).__test__);
});

const SESSION_ID = 'session-test';
const TASK_ID = 'fedcba9876543210';

describe('oc_lane_create — profile option (#1431 Part 1)', () => {
  let storeDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-lane-tool-'));
    store = new TaskStore({ rootDir: storeDir });
    setTaskStoreForTests(store);
    (getSessionManager as jest.Mock).mockReturnValue(makeStubSM());

    const meta: TaskMeta = {
      task_id: TASK_ID,
      kind: 'browser_task',
      status: 'RUNNING',
      pid: process.pid,
      created_at: Date.now(),
      args_summary: {},
      owner: { session_id: SESSION_ID },
    };
    await store.create(meta);
  });

  afterEach(() => {
    setTaskStoreForTests(undefined);
    fs.rmSync(storeDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  function parseLane(result: ToolResult): BrowserLane {
    const text = result.content[0]?.text ?? '{}';
    return (JSON.parse(text) as { lane: BrowserLane }).lane;
  }

  test('profile:scratch is threaded through and scratchDir is created', async () => {
    const result = await createHandler(SESSION_ID, { taskId: TASK_ID, profile: 'scratch' });
    expect(result.isError).toBeFalsy();
    const lane = parseLane(result);
    expect(lane.profile).toBe('scratch');
    expect(typeof lane.scratchDir).toBe('string');
    expect(fs.existsSync(lane.scratchDir!)).toBe(true);
    // cleanup
    if (lane.scratchDir) fs.rmSync(lane.scratchDir, { recursive: true, force: true });
  });

  test('profile:inherit is threaded through with no scratchDir', async () => {
    const result = await createHandler(SESSION_ID, { taskId: TASK_ID, profile: 'inherit' });
    expect(result.isError).toBeFalsy();
    const lane = parseLane(result);
    expect(lane.profile).toBe('inherit');
    expect(lane.scratchDir).toBeUndefined();
  });

  test('omitted profile creates lane without scratchDir (backward compat)', async () => {
    const result = await createHandler(SESSION_ID, { taskId: TASK_ID });
    expect(result.isError).toBeFalsy();
    const lane = parseLane(result);
    expect(lane.scratchDir).toBeUndefined();
  });

  test('invalid profile value is ignored gracefully', async () => {
    const result = await createHandler(SESSION_ID, { taskId: TASK_ID, profile: 'bogus' });
    expect(result.isError).toBeFalsy();
    const lane = parseLane(result);
    // bogus profile → treated as inherit (undefined profile field or 'inherit')
    expect(lane.scratchDir).toBeUndefined();
  });

  test('missing taskId returns error', async () => {
    const result = await createHandler(SESSION_ID, { profile: 'scratch' });
    expect(result.isError).toBe(true);
  });
});
