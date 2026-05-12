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
  TaskStore,
  computeTaskId,
  defaultTaskRootDir,
  summariseArgs,
  runTask,
} from '../core/task-ledger';
import type { TaskMeta } from '../core/task-ledger';

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
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description:
          'Name of the underlying MCP tool to run. Canonical values: ' +
          'crawl, crawl_sitemap, recording, oc_evidence_bundle, oc_session_snapshot.',
      },
      args: {
        type: 'object',
        description: 'Arguments forwarded to the underlying tool.',
      },
    },
    required: ['kind', 'args'],
  },
};

interface StartHandlerOpts {
  /** Resolver injected at registration time so tests can stub the registry. */
  resolveTool: (toolName: string) => ToolHandler | null;
}

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
    const inner = opts.resolveTool(kind);
    if (!inner) {
      return errorResult(`oc_task_start: tool ${JSON.stringify(kind)} is not registered`);
    }

    const store = getTaskStore();
    // Reap any orphaned RUNNING rows before accepting a new task — the
    // contract requires the reaper to run "before any new task is
    // accepted" (issue invariant #2).
    await store.reapOrphans().catch((err) => {
      console.error('[oc_task_start] reapOrphans failed:', err);
    });

    const createdAt = Date.now();
    const taskId = computeTaskId(kind, args, createdAt);
    const meta: TaskMeta = {
      task_id: taskId,
      kind,
      status: 'PENDING',
      pid: process.pid,
      created_at: createdAt,
      args_summary: summariseArgs(args),
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
        // Tools that participate in cooperative cancel can read the
        // signal off the ToolContext. The runner's poll already covers
        // tools that don't.
        return await inner(sessionId, merged, {
          startTime: Date.now(),
          deadlineMs: Number.MAX_SAFE_INTEGER,
          signal,
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
  });
  server.registerTool(definition.name, handler, definition);
}

// Test seam: expose the handler factory so tests can drive the start
// path without spinning up a full MCPServer.
export const __test__ = { makeHandler };
