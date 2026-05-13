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
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import {
  TaskStore,
  computeTaskId,
  defaultTaskRootDir,
  summariseArgs,
  runTask,
} from '../core/task-ledger';
import type { TaskMeta, TaskOwner } from '../core/task-ledger';
import type { Principal } from '../auth/api-key-types';

let storeSingleton: TaskStore | undefined;

/**
 * Resolve the process-wide TaskStore. Tests can clobber this via
 * `setTaskStoreForTests` so each test runs against a fresh temp root.
 */
export function getTaskStore(): TaskStore {
  if (!storeSingleton) {
    storeSingleton = new TaskStore({ rootDir: defaultTaskRootDir() });
  }
  return storeSingleton;
}

/** Test seam — override the process-wide store with a custom instance. */
export function setTaskStoreForTests(store: TaskStore | undefined): void {
  storeSingleton = store;
}

const definition: MCPToolDefinition = {
  name: 'oc_task_start',
  description:
    'Launch a long-running tool as a background task. Returns a task_id ' +
    'that can be polled with oc_task_get / oc_task_list / oc_task_wait, ' +
    'or aborted with oc_task_cancel. The result is persisted to disk and ' +
    'survives MCP-session loss.',
  annotations: TOOL_ANNOTATIONS.oc_task_start,
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description:
          'REQUIRED Name of the underlying MCP tool to run. Canonical values: ' +
          'crawl, crawl_sitemap, recording, oc_evidence_bundle, oc_session_snapshot.',
      },
      args: {
        type: 'object',
        description: 'REQUIRED Arguments forwarded to the underlying tool.',
      },
    },
    required: ['kind', 'args'],
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
    const kind = String(params.kind ?? '');
    const args = (params.args ?? {}) as Record<string, unknown>;
    if (!kind) {
      return errorResult('oc_task_start: kind is required');
    }
    if (TASK_LEDGER_TOOLS.has(kind)) {
      return errorResult(`oc_task_start: refusing to schedule task-ledger tool ${JSON.stringify(kind)}`);
    }
    const inner = opts.resolveTool(kind);
    if (!inner) {
      return errorResult(`oc_task_start: tool ${JSON.stringify(kind)} is not registered`);
    }

    await waitForTaskStartupReap();

    const store = getTaskStore();
    // Orphan reaping is wired once during tool registration/startup. Keep
    // oc_task_start on the latency-sensitive path and avoid rescanning the
    // whole ledger for every new background job.
    const createdAt = Date.now();
    const taskNonce = `${process.pid}:${createdAt}:${taskNonceSeq++}`;
    const taskId = computeTaskId(kind, { ...args, __task_nonce: taskNonce }, createdAt);
    const meta: TaskMeta = {
      task_id: taskId,
      kind,
      status: 'PENDING',
      pid: process.pid,
      created_at: createdAt,
      args_summary: summariseArgs(args),
      owner: taskOwnerFor(sessionId, _ctx?.principal),
      task_nonce: taskNonce,
    };
    await store.create(meta);

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
        return await inner(sessionId, merged, {
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
