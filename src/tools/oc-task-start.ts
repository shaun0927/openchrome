/**
 * oc_task_start — launch a registered MCP tool as a background task.
 *
 * Returns `{ task_id, status }` immediately; the underlying tool runs
 * via `runTask` in the background and writes its result to the ledger.
 * Callers poll with `oc_task_get` or block on `oc_task_wait`.
 *
 * Defaults are conservative — direct invocation of the wrapped tool
 * still behaves identically (issue #855 invariant #6). This tool only
 * exists to add an opt-in async lane.
 */

import { MCPServer } from '../mcp-server';
import {
  MCPResult,
  MCPToolDefinition,
  ToolContext,
  ToolHandler,
} from '../types/mcp';
import {
  computeTaskId,
  summariseArgs,
  runTask,
  getTaskStore,
  setTaskStoreForTests,
  normalizeTaskPolicy,
  normalizeTaskPhase,
  initialCounters,
} from '../core/task-ledger';
import type { TaskMeta, TaskKind, TaskOwner } from '../core/task-ledger';
import type { Principal } from '../auth/api-key-types';

export { getTaskStore, setTaskStoreForTests };

const definition: MCPToolDefinition = {
  name: 'oc_task_start',
  description:
    'Create a task-level browser harness envelope, or launch a long-running tool as a background task. Returns a task_id ' +
    'that can be polled with oc_task_get / oc_task_list / oc_task_wait, ' +
    'or aborted with oc_task_cancel. The result is persisted to disk and ' +
    'survives MCP-session loss.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description:
          'Optional name of the underlying MCP tool to run in the background. ' +
          'Omit kind to create a task envelope for host-driven browser tool calls.',
      },
      args: {
        type: 'object',
        description: 'Arguments forwarded to the underlying tool when kind is set.',
      },
      objective: {
        type: 'string',
        description: 'Host-declared objective for task-level browser harness tracking.',
      },
      phase: {
        type: 'string',
        enum: ['explore', 'act', 'verify', 'recover', 'done'],
        description: 'Initial host-declared task phase. Default: explore.',
      },
      policy: {
        type: 'object',
        description: 'Deterministic budget policy: maxToolCalls, maxObservationStreak, maxConsecutiveSameTool, maxFailureStreak, maxSameUrlNavigations, maxWallMs, allowedDomains, checkpointEveryCalls.',
      },
    },
    required: [],
  },
};

interface StartHandlerOpts {
  /** Resolver injected at registration time so tests can stub the registry. */
  resolveTool: (toolName: string) => ToolHandler | null;
  /**
   * Invoke the selected tool through the normal MCP tool-call pipeline.
   * Production uses MCPServer.invokeRegisteredToolForTask so background tasks
   * keep the same wrappers as direct calls (notably secret substitution).
   */
  invokeTool?: (
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    principal?: Principal,
  ) => Promise<MCPResult>;
}


let taskNonceSeq = 0;
let startupReapPromise: Promise<unknown> = Promise.resolve();

export function setTaskStartupReapPromise(promise: Promise<unknown>): void {
  startupReapPromise = promise.catch((err) => {
    console.error('[task-ledger] startup reapOrphans failed:', err);
  });
}

export async function waitForTaskStartupReap(): Promise<void> {
  await startupReapPromise;
}

export function taskOwnerFor(sessionId: string, principal?: Principal): TaskOwner {
  return {
    session_id: sessionId,
    ...(principal?.tenantId ? { tenant_id: principal.tenantId } : {}),
    ...(principal?.keyId ? { key_id: principal.keyId } : {}),
    ...(principal?.mode ? { mode: principal.mode } : {}),
  };
}

export function canAccessTask(meta: TaskMeta, sessionId: string, principal?: Principal): boolean {
  if (!meta.owner) return true;
  if (meta.owner.session_id !== sessionId) return false;
  if ((principal?.mode === 'api-key' || principal?.mode === 'jwt') && meta.owner.tenant_id !== principal.tenantId) {
    return false;
  }
  return true;
}

export function taskAccessDeniedResult(taskId: string): MCPResult {
  return { isError: true, content: [{ type: 'text', text: `task ${taskId} is not visible in this session` }] };
}

const TASK_LEDGER_TOOLS = new Set([
  'oc_task_start',
  'oc_task_get',
  'oc_task_list',
  'oc_task_wait',
  'oc_task_cancel',
]);

function makeHandler(opts: StartHandlerOpts): ToolHandler {
  return async (
    sessionId: string,
    params: Record<string, unknown>,
    _ctx?: ToolContext,
  ): Promise<MCPResult> => {
    const rawKind = params.kind;
    const kind = typeof rawKind === 'string' && rawKind.length > 0 ? rawKind : 'browser_task';
    const args = (params.args ?? {}) as Record<string, unknown>;
    const objective = typeof params.objective === 'string' ? params.objective : undefined;
    const phase = normalizeTaskPhase(params.phase);
    const policy = normalizeTaskPolicy(params.policy);
    if (TASK_LEDGER_TOOLS.has(kind)) {
      return errorResult(`oc_task_start: refusing to schedule task-ledger tool ${JSON.stringify(kind)}`);
    }
    const inner = kind === 'browser_task' ? null : opts.resolveTool(kind);
    if (kind !== 'browser_task' && !inner) {
      return errorResult(`oc_task_start: tool ${JSON.stringify(kind)} is not registered`);
    }

    await waitForTaskStartupReap();

    const store = getTaskStore();
    // Orphan reaping is wired once during tool registration/startup. Keep
    // oc_task_start on the latency-sensitive path and avoid rescanning the
    // whole ledger for every new background job.
    const createdAt = Date.now();
    const taskNonce = `${process.pid}:${createdAt}:${taskNonceSeq++}`;
    const idSeed = kind === 'browser_task'
      ? { objective: objective ?? '', phase, policy, __task_nonce: taskNonce }
      : { ...args, __task_nonce: taskNonce };
    const taskId = computeTaskId(kind as TaskKind, idSeed, createdAt);
    const meta: TaskMeta = {
      task_id: taskId,
      kind,
      status: kind === 'browser_task' ? 'RUNNING' : 'PENDING',
      pid: process.pid,
      created_at: createdAt,
      started_at: kind === 'browser_task' ? createdAt : undefined,
      args_summary: summariseArgs(kind === 'browser_task' ? idSeed : args),
      owner: taskOwnerFor(sessionId, _ctx?.principal),
      task_nonce: taskNonce,
      objective,
      phase,
      policy,
      counters: initialCounters(),
      budget_status: 'ok',
      recent_events: [],
      last_activity_at: createdAt,
    };
    await store.create(meta);

    if (kind === 'browser_task') {
      store.appendEvent(taskId, { ts: createdAt, kind: 'started', data: { objective, phase } });
      return {
        content: [{ type: 'text', text: `task_id=${taskId} status=RUNNING kind=browser_task phase=${phase}` }],
        task_id: taskId,
        status: 'RUNNING',
        kind,
        meta,
      };
    }

    // Spawn the runner in the background. We deliberately don't await
    // it — `oc_task_start` returns as soon as the PENDING row is on
    // disk so the MCP client doesn't have to hold its request open.
    void runTask(store, {
      taskId,
      pid: process.pid,
      invoke: async (signal) => {
        const merged: Record<string, unknown> = { ...args };
        if (opts.invokeTool) {
          return await opts.invokeTool(sessionId, kind, merged, signal, _ctx?.principal);
        }
        // Test seam fallback: direct handler invocation remains available for
        // focused unit tests, while production registration always supplies
        // invokeTool above so background tasks use the MCP pipeline.
        return await inner!(sessionId, merged, {
          startTime: Date.now(),
          deadlineMs: Number.MAX_SAFE_INTEGER,
          signal,
          principal: _ctx?.principal,
        });
      },
    }).catch((err) => {
      console.error(`[oc_task_start] runTask threw for ${taskId}:`, err);
    });

    return {
      content: [
        {
          type: 'text',
          text: `task_id=${taskId} status=PENDING kind=${kind}`,
        },
      ],
      task_id: taskId,
      status: 'PENDING',
      kind,
      meta,
    };
  };
}

function errorResult(message: string): MCPResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

export function registerOcTaskStartTool(server: MCPServer): void {
  const handler = makeHandler({
    resolveTool: (name) => server.getToolHandler(name),
    invokeTool: (sessionId, toolName, args, signal, principal) =>
      server.invokeRegisteredToolForTask(sessionId, toolName, args, signal, principal),
  });
  server.registerTool(definition.name, handler, definition);
}

// Test seam: expose the handler factory so tests can drive the start
// path without spinning up a full MCPServer.
export const __test__ = { makeHandler };
