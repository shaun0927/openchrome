/**
 * Task-scoped browser lanes (#1037).
 *
 * A lane is deliberately a thin task-ledger overlay over existing
 * SessionManager worker/target ownership. It does not create agent workers or
 * new Chrome processes by itself; it allocates a deterministic worker id and
 * records the targets that belong to that lane so hosts can keep parallel
 * browser branches isolated.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getSessionManager } from '../session-manager';
import { getTaskStore } from '../tools/oc-task-start';
import type { BrowserLane, TaskMeta } from './task-ledger/types';

const LANE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function assertLaneId(laneId: string): void {
  if (!LANE_ID_RE.test(laneId)) {
    throw new Error(`laneId ${JSON.stringify(laneId)} must match ${LANE_ID_RE}`);
  }
}

export function makeLaneId(seed = crypto.randomUUID()): string {
  return `lane_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10)}`;
}

export function laneWorkerId(taskId: string, laneId: string): string {
  assertLaneId(laneId);
  return `task:${taskId}:lane:${laneId}`;
}

function cloneLane(lane: BrowserLane): BrowserLane {
  return {
    ...lane,
    targetIds: [...lane.targetIds],
    ...(lane.targetStatuses ? { targetStatuses: lane.targetStatuses.map((target) => ({ ...target })) } : {}),
    counters: { ...lane.counters },
  };
}

function laneWithStatuses(lane: BrowserLane, liveTargetIds?: Set<string>): BrowserLane {
  const statuses = lane.targetIds.map((targetId) => ({
    targetId,
    status: liveTargetIds && !liveTargetIds.has(targetId) ? 'target_missing' as const : 'open' as const,
  }));
  const missing = statuses.some((target) => target.status === 'target_missing');
  // A reconciled lane with zero targets is treated as recoverable failure too:
  // hosts need to see "lane has no live targets" rather than a silent open status.
  const emptyAfterReconcile = liveTargetIds !== undefined && statuses.length === 0;
  const degraded = missing || emptyAfterReconcile;
  return {
    ...lane,
    targetStatuses: statuses,
    ...(degraded ? { status: 'failed' as const, recovery: 'target_missing' as const } : {}),
  };
}

export function getTaskLanes(meta: TaskMeta): BrowserLane[] {
  return Array.isArray(meta.lanes) ? meta.lanes.map(cloneLane) : [];
}

export function findTaskLane(meta: TaskMeta, laneId: string): BrowserLane | undefined {
  return getTaskLanes(meta).find((lane) => lane.lane_id === laneId);
}

/**
 * Create a task-scoped browser lane.
 *
 * @param input.profile - Profile isolation mode for the lane.
 *   - `'inherit'` (default) — shares the server's existing Chrome
 *     user-data-dir. No extra resource management required.
 *   - `'scratch'` — provisions a fresh temporary Chrome user-data-dir
 *     (under `os.tmpdir()`) when the lane opens and removes it with
 *     `fs.rm({ recursive: true, force: true })` when the lane closes via
 *     `closeBrowserLane`. This is the foundation for the fresh-lane
 *     re-verification gate (Part 3 of #1431). If scratch-dir creation fails
 *     the lane creation fails cleanly with no orphan directory left behind.
 */
export async function createBrowserLane(input: {
  sessionId: string;
  taskId: string;
  name?: string;
  purpose?: string;
  initialUrl?: string;
  budget?: unknown;
  profile?: 'scratch' | 'inherit';
}): Promise<BrowserLane> {
  const { sessionId, taskId } = input;
  const store = getTaskStore();
  const meta = store.readMetaSync(taskId);
  if (!meta) throw new Error(`unknown task ${taskId}`);
  if (meta.owner?.session_id && meta.owner.session_id !== sessionId) {
    throw new Error(`task ${taskId} is not visible in this session`);
  }

  const profile = input.profile ?? 'inherit';
  const laneId = makeLaneId(crypto.randomUUID());
  const now = Date.now();
  const workerId = laneWorkerId(taskId, laneId);

  // Provision scratch dir before touching the session manager so that a
  // creation failure leaves no partial state on the store.
  let scratchDir: string | undefined;
  if (profile === 'scratch') {
    const scratchBase = path.join(os.tmpdir(), `oc-scratch-${crypto.randomUUID()}`);
    try {
      await fs.mkdir(scratchBase, { recursive: true });
      scratchDir = scratchBase;
    } catch (err) {
      throw new Error(`scratch lane: failed to create temp dir ${scratchBase}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const lane: BrowserLane = {
    lane_id: laneId,
    task_id: taskId,
    ...(input.name ? { name: input.name } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    status: 'open',
    profile,
    ...(scratchDir ? { scratchDir } : {}),
    sessionId,
    workerId,
    targetIds: [],
    created_at: now,
    last_activity_at: now,
    counters: { toolCalls: 0, failures: 0 },
  };

  try {
    if (input.initialUrl) {
      const result = await getSessionManager().createTarget(sessionId, input.initialUrl, workerId);
      lane.targetIds.push(result.targetId);
      lane.workerId = result.workerId;
    } else {
      await getSessionManager().getOrCreateWorker(sessionId, workerId);
    }
  } catch (err) {
    // Clean up scratch dir if worker/target acquisition fails so no orphan dirs are left.
    if (scratchDir) {
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }

  await store.update(taskId, (cur) => ({
    ...cur,
    lanes: [...getTaskLanes(cur).filter((existing) => existing.lane_id !== laneId), lane],
    last_activity_at: now,
  }));
  store.appendEvent(taskId, { ts: now, kind: 'log', data: { event: 'lane_created', laneId, workerId, targetIds: lane.targetIds, profile } });
  return cloneLane(lane);
}

export function listBrowserLanes(taskId: string): BrowserLane[] {
  const meta = getTaskStore().readMetaSync(taskId);
  if (!meta) throw new Error(`unknown task ${taskId}`);
  return getTaskLanes(meta);
}

export function getBrowserLane(taskId: string, laneId: string): BrowserLane {
  assertLaneId(laneId);
  const meta = getTaskStore().readMetaSync(taskId);
  if (!meta) throw new Error(`unknown task ${taskId}`);
  const lane = findTaskLane(meta, laneId);
  if (!lane) throw new Error(`unknown lane ${laneId} for task ${taskId}`);
  return lane;
}

export async function closeBrowserLane(taskId: string, laneId: string, sessionId: string): Promise<BrowserLane> {
  const lane = getBrowserLane(taskId, laneId);
  if (lane.sessionId !== sessionId) throw new Error(`lane ${laneId} is not visible in this session`);
  const sm = getSessionManager();
  for (const targetId of lane.targetIds) {
    await sm.closeTarget(sessionId, targetId).catch(() => false);
  }
  const now = Date.now();
  const closed: BrowserLane = { ...lane, status: 'closed', last_activity_at: now, targetIds: [] };
  await getTaskStore().update(taskId, (cur) => ({
    ...cur,
    lanes: getTaskLanes(cur).map((existing) => existing.lane_id === laneId ? closed : existing),
    last_activity_at: now,
  }));
  getTaskStore().appendEvent(taskId, { ts: now, kind: 'log', data: { event: 'lane_closed', laneId } });

  // Remove the scratch user-data-dir after the lane record is committed so
  // callers observing the closed lane can still see scratchDir if needed.
  if (lane.scratchDir) {
    await fs.rm(lane.scratchDir, { recursive: true, force: true }).catch((err) => {
      console.error(`[closeBrowserLane] failed to remove scratch dir ${lane.scratchDir}:`, err);
    });
  }

  return cloneLane(closed);
}


/**
 * Reconcile persisted lane target ids against the live CDP target set.
 * Intended to be called by the task-restore / session-resume path after a
 * host restart (#1037) so hosts can see which lanes lost their targets and
 * recover them explicitly instead of silently dropping the isolation facts.
 */
export async function reconcileBrowserLaneTargets(taskId: string, liveTargetIds: Set<string>): Promise<BrowserLane[]> {
  const store = getTaskStore();
  const now = Date.now();
  let reconciled: BrowserLane[] = [];
  await store.update(taskId, (cur) => {
    reconciled = getTaskLanes(cur).map((lane) => laneWithStatuses(lane, liveTargetIds));
    return { ...cur, lanes: reconciled, last_activity_at: now };
  });
  return reconciled.map(cloneLane);
}

export function resolveLaneForTool(args: Record<string, unknown>): { taskId?: string; laneId?: string } {
  const taskId = typeof args.taskId === 'string' ? args.taskId : typeof args.task_id === 'string' ? args.task_id : undefined;
  const laneId = typeof args.laneId === 'string' ? args.laneId : typeof args.lane_id === 'string' ? args.lane_id : undefined;
  return { taskId, laneId };
}

export function applyLaneTarget(args: Record<string, unknown>): Record<string, unknown> {
  const { taskId, laneId } = resolveLaneForTool(args);
  if (!taskId && !laneId) return args;
  if (!taskId || !laneId) throw new Error('taskId and laneId must be supplied together');
  const lane = getBrowserLane(taskId, laneId);
  const tabId = typeof args.tabId === 'string' && args.tabId ? args.tabId : lane.targetIds[lane.targetIds.length - 1];
  if (!tabId) throw new Error(`lane ${laneId} has no target; call oc_lane_create with initialUrl or navigate with taskId/laneId first`);
  if (!lane.targetIds.includes(tabId)) throw new Error(`tabId ${tabId} does not belong to lane ${laneId}`);
  return { ...args, tabId, workerId: lane.workerId };
}

export async function recordLaneToolCall(args: Record<string, unknown>, ok: boolean, targetId?: string): Promise<void> {
  const { taskId, laneId } = resolveLaneForTool(args);
  if (!taskId || !laneId) return;
  const now = Date.now();
  await getTaskStore().update(taskId, (cur) => ({
    ...cur,
    lanes: getTaskLanes(cur).map((lane) => {
      if (lane.lane_id !== laneId) return lane;
      const targetIds = targetId && !lane.targetIds.includes(targetId) ? [...lane.targetIds, targetId] : lane.targetIds;
      return {
        ...lane,
        targetIds,
        last_activity_at: now,
        counters: { toolCalls: lane.counters.toolCalls + 1, failures: lane.counters.failures + (ok ? 0 : 1) },
      };
    }),
    last_activity_at: now,
  }));
}
