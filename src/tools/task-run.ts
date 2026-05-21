import type { MCPServer } from '../mcp-server';
import type { MCPResult, MCPToolDefinition, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { isAutoRecallEnabled, isPilotEnabled, isSkillCuratorEnabled } from '../harness/flags';
import {
  CompleteInput,
  NeedsHelpInput,
  StartTaskRunInput,
  TaskRunListFilter,
  TaskRunNotFoundError,
  TaskRunStore,
  TaskRunTransitionError,
  UpdateTaskRunInput,
} from '../core/task-run';
import { buildAutoSnapshotArgs, SnapshotTrigger } from '../session-snapshot-policy';
import { collectTabs, generateSnapshotId, saveSnapshot, SessionSnapshot } from './session-snapshot';

const store = new TaskRunStore();

type Json = Record<string, unknown>;

function jsonResult(value: Json): MCPResult {
  return {
    structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown): MCPResult {
  const code = error instanceof TaskRunTransitionError || error instanceof TaskRunNotFoundError
    ? error.code
    : 'task_run_error';
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    structuredContent: { error: { code, message } },
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }, null, 2) }],
  };
}

const evidenceSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['journal', 'screenshot', 'contract', 'ledger_task', 'workflow', 'url'] },
      ref: { type: 'string' },
      summary: { type: 'string' },
    },
    required: ['kind', 'ref'],
  },
};

const failedItemsSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      item: { type: 'string' },
      reason: { type: 'string', description: 'REQUIRED Secret-safe reason this TaskRun needs user help.' },
    },
    required: ['item', 'reason'],
  },
};

const startDefinition: MCPToolDefinition = {
  name: 'oc_task_run_start',
  description: 'Start an opt-in goal-level TaskRun. Tracks user goal, success criteria, progress summary, item progress, and evidence across multiple OpenChrome tool calls without changing existing browser tools.',
  annotations: TOOL_ANNOTATIONS.oc_task_run_start,
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'REQUIRED User-level goal to track, redacted and capped at 4 KiB.' },
      success_criteria: { type: 'array', items: { type: 'string' }, description: 'Optional concrete success criteria.' },
      session_id: { type: 'string', description: 'Optional OpenChrome session id to associate.' },
      workflow_id: { type: 'string', description: 'Optional workflow id to associate.' },
      ledger_task_ids: { type: 'array', items: { type: 'string' }, description: 'Optional #855 async ledger task ids to link when available.' },
      auto_session_snapshot: {
        type: 'object',
        description: 'Optional #1013 policy. When enabled, TaskRun lifecycle tools write compact oc_session_snapshot artifacts without changing ordinary browser tools.',
        properties: {
          enabled: { type: 'boolean' },
          mode: { type: 'string', enum: ['best-effort', 'strict'] },
          max_snapshots: { type: 'number', description: 'Maximum snapshot ids to retain on the TaskRun metadata; default 10, max 100.' },
        },
      },
      page_url: {
        type: 'string',
        description:
          'Optional current page URL. When pilot + skill-curator + OPENCHROME_AUTO_RECALL=1 are all enabled, the start response includes a `recalled_skills` field with up to 5 promoted curator skills for this URL\'s host — the host LLM uses them as priors for the goal.',
      },
    },
    required: ['goal'],
  },
};

const updateDefinition: MCPToolDefinition = {
  name: 'oc_task_run_update',
  description: 'Update a non-terminal TaskRun with progress, item results, cursor, evidence, or explicit NEEDS_HELP resume back to RUNNING. Existing browser tools are unaffected.',
  annotations: TOOL_ANNOTATIONS.oc_task_run_update,
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'REQUIRED TaskRun id returned by oc_task_run_start.' },
      status: { type: 'string', enum: ['RUNNING'], description: 'Only RUNNING is accepted. Use oc_task_run_needs_help / oc_task_run_complete for other transitions.' },
      resume_reason: { type: 'string', description: 'Required when resuming from NEEDS_HELP to RUNNING.' },
      progress_summary: { type: 'string' },
      completed_items: { type: 'array', items: { type: 'string' } },
      failed_items: failedItemsSchema,
      current_cursor: { type: 'string' },
      last_evidence: evidenceSchema,
      ledger_task_ids: { type: 'array', items: { type: 'string' } },
      workflow_id: { type: 'string' },
    },
    required: ['run_id'],
  },
};

const checkpointDefinition: MCPToolDefinition = {
  name: 'oc_task_run_checkpoint',
  description: 'Write a compact caller-provided checkpoint summary for a non-terminal TaskRun and return the checkpoint metadata.',
  annotations: TOOL_ANNOTATIONS.oc_task_run_checkpoint,
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'REQUIRED TaskRun id returned by oc_task_run_start.' },
      summary: { type: 'string', description: 'REQUIRED Caller-provided summary, redacted and capped at 8 KiB.' },
      current_cursor: { type: 'string' },
      evidence: evidenceSchema,
    },
    required: ['run_id', 'summary'],
  },
};

const needsHelpDefinition: MCPToolDefinition = {
  name: 'oc_task_run_needs_help',
  description: 'Move a non-terminal TaskRun to NEEDS_HELP with a secret-safe reason, optional resume hint, cursor, and evidence pointer.',
  annotations: TOOL_ANNOTATIONS.oc_task_run_needs_help,
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'REQUIRED TaskRun id returned by oc_task_run_start.' },
      reason: { type: 'string', description: 'REQUIRED Secret-safe reason this TaskRun needs user help.' },
      resume_hint: { type: 'string' },
      current_cursor: { type: 'string' },
      last_evidence: evidenceSchema,
    },
    required: ['run_id', 'reason'],
  },
};

const completeDefinition: MCPToolDefinition = {
  name: 'oc_task_run_complete',
  description: 'Enter a terminal TaskRun state (COMPLETED, FAILED, or CANCELLED). Terminal TaskRuns are immutable.',
  annotations: TOOL_ANNOTATIONS.oc_task_run_complete,
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'REQUIRED TaskRun id returned by oc_task_run_start.' },
      status: { type: 'string', enum: ['COMPLETED', 'FAILED', 'CANCELLED'], description: 'Defaults to COMPLETED.' },
      progress_summary: { type: 'string' },
      completed_items: { type: 'array', items: { type: 'string' } },
      failed_items: failedItemsSchema,
      last_evidence: evidenceSchema,
    },
    required: ['run_id'],
  },
};

const getDefinition: MCPToolDefinition = {
  name: 'oc_task_run_get',
  description: 'Read a TaskRun meta record and optionally its event log.',
  annotations: TOOL_ANNOTATIONS.oc_task_run_get,
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'REQUIRED TaskRun id returned by oc_task_run_start.' },
      include_events: { type: 'boolean', description: 'When true, include events.jsonl entries.' },
    },
    required: ['run_id'],
  },
};

const listDefinition: MCPToolDefinition = {
  name: 'oc_task_run_list',
  description: 'List recent TaskRuns sorted by created_at descending. Read-only.',
  annotations: TOOL_ANNOTATIONS.oc_task_run_list,
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['PENDING', 'RUNNING', 'NEEDS_HELP', 'COMPLETED', 'FAILED', 'CANCELLED'] },
      limit: { type: 'number', description: 'Default 50, max 200.' },
      since: { type: 'number', description: 'Unix ms lower bound for created_at.' },
    },
    required: [],
  },
};

const startHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const meta = await store.start(args as unknown as StartTaskRunInput);
    const snapshot = await takeTaskRunAutoSessionSnapshot(meta, 'start');
    const recalled = await maybeRecallCuratorSkills(args.page_url);
    return jsonResult({
      task_run: snapshot?.task_run || meta,
      ...(snapshot ? { auto_session_snapshot: snapshot.auto_session_snapshot } : {}),
      ...(recalled ? { recalled_skills: recalled } : {}),
    });
  } catch (error) {
    return errorResult(error);
  }
};

/**
 * Best-effort curator recall lookup for `oc_task_run_start`. Returns
 * `undefined` when any of the activation gates is closed, when no
 * URL was supplied, or when the curator has no promoted skills for
 * the URL's host. All errors are swallowed — TaskRun creation must
 * not fail because an optional recall lookup blew up.
 *
 * Loaded dynamically so the core build never statically imports
 * `src/pilot/**`; matches the existing pattern in
 * `oc-skill-record.ts:240` for `dynamic-skills/events`.
 */
async function maybeRecallCuratorSkills(
  pageUrlArg: unknown,
): Promise<Json | undefined> {
  const pageUrl = typeof pageUrlArg === 'string' ? pageUrlArg : '';
  if (pageUrl.length === 0) return undefined;
  if (!isPilotEnabled()) return undefined;
  if (!isSkillCuratorEnabled()) return undefined;
  if (!isAutoRecallEnabled()) return undefined;
  try {
    const mod = await import('../pilot/curator/auto-recall.js');
    const domain = mod.hostnameForRecall(pageUrl);
    if (domain === null) return undefined;
    const payload = mod.recallCuratorSkills({ domain });
    if (payload === null) return undefined;
    return payload as unknown as Json;
  } catch {
    return undefined;
  }
}

const updateHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const runId = String(args.run_id || '');
    const meta = await store.update(runId, args as UpdateTaskRunInput);
    return jsonResult({ task_run: meta });
  } catch (error) {
    return errorResult(error);
  }
};

const checkpointHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const runId = String(args.run_id || '');
    const checkpoint = await store.checkpoint(runId, String(args.summary || ''), {
      current_cursor: args.current_cursor as string | undefined,
      evidence: args.evidence as never,
    });
    const meta = await store.get(runId);
    const snapshot = await takeTaskRunAutoSessionSnapshot(meta, 'retry', checkpoint.summary);
    return jsonResult({ checkpoint, ...(snapshot ? { task_run: snapshot.task_run, auto_session_snapshot: snapshot.auto_session_snapshot } : {}) });
  } catch (error) {
    return errorResult(error);
  }
};

const needsHelpHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const runId = String(args.run_id || '');
    const meta = await store.needsHelp(runId, args as unknown as NeedsHelpInput);
    const snapshot = await takeTaskRunAutoSessionSnapshot(meta, 'retry', meta.needs_help?.reason);
    return jsonResult({ task_run: snapshot?.task_run || meta, ...(snapshot ? { auto_session_snapshot: snapshot.auto_session_snapshot } : {}) });
  } catch (error) {
    return errorResult(error);
  }
};

const completeHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const runId = String(args.run_id || '');
    const meta = await store.complete(runId, args as CompleteInput);
    const snapshot = await takeTaskRunAutoSessionSnapshot(meta, 'final', meta.progress_summary);
    return jsonResult({ task_run: snapshot?.task_run || meta, ...(snapshot ? { auto_session_snapshot: snapshot.auto_session_snapshot } : {}) });
  } catch (error) {
    return errorResult(error);
  }
};

const getHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const runId = String(args.run_id || '');
    const meta = await store.get(runId);
    const result: Json = { task_run: meta };
    if (args.include_events === true) {
      result.events = await store.readEvents(runId);
    }
    return jsonResult(result);
  } catch (error) {
    return errorResult(error);
  }
};

const listHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const task_runs = await store.list(args as TaskRunListFilter);
    return jsonResult({ task_runs });
  } catch (error) {
    return errorResult(error);
  }
};


async function takeTaskRunAutoSessionSnapshot(
  meta: Awaited<ReturnType<TaskRunStore['get']>>,
  trigger: SnapshotTrigger,
  currentStep?: string,
): Promise<{ task_run: Awaited<ReturnType<TaskRunStore['get']>>; auto_session_snapshot: { snapshot_id?: string; trigger: SnapshotTrigger; error?: string } } | null> {
  const policy = meta.auto_session_snapshot_policy;
  if (!policy?.enabled) return null;

  try {
    const args = buildAutoSnapshotArgs({
      objective: meta.goal,
      currentStep: currentStep || meta.progress_summary || `TaskRun ${meta.status}`,
      completedSteps: meta.completed_items,
      nextActions: buildTaskRunNextActions(meta),
      notes: `TaskRun ${meta.run_id} status=${meta.status}`,
    }, trigger);
    const snapshotId = generateSnapshotId();
    const snapshot: SessionSnapshot = {
      version: 1,
      id: snapshotId,
      timestamp: Date.now(),
      tabs: await collectTabs(),
      memo: {
        objective: args.objective,
        currentStep: args.currentStep,
        nextActions: args.nextActions,
        completedSteps: args.completedSteps,
        notes: args.notes,
      },
      label: args.label,
    };
    await saveSnapshot(snapshot);
    const updated = await store.recordAutoSessionSnapshot(meta.run_id, snapshotId);
    return { task_run: updated, auto_session_snapshot: { snapshot_id: snapshotId, trigger } };
  } catch (error) {
    const updated = await store.recordAutoSessionSnapshotFailure(meta.run_id, error);
    const message = error instanceof Error ? error.message : String(error);
    if (policy.mode === 'strict') throw error;
    return { task_run: updated, auto_session_snapshot: { trigger, error: message } };
  }
}

function buildTaskRunNextActions(meta: Awaited<ReturnType<TaskRunStore['get']>>): string[] {
  if (meta.status === 'COMPLETED') return ['Review completion evidence or call oc_session_resume after compaction.'];
  if (meta.status === 'FAILED' || meta.status === 'CANCELLED') return ['Review failure evidence before restarting or retrying the task.'];
  if (meta.needs_help?.resume_hint) return [meta.needs_help.resume_hint];
  if (meta.success_criteria && meta.success_criteria.length > 0) return meta.success_criteria.slice(0, 5);
  return ['Continue the TaskRun and update progress with oc_task_run_update or oc_task_run_checkpoint.'];
}

export function registerTaskRunTools(server: MCPServer): void {
  server.registerTool('oc_task_run_start', startHandler, startDefinition);
  server.registerTool('oc_task_run_update', updateHandler, updateDefinition);
  server.registerTool('oc_task_run_checkpoint', checkpointHandler, checkpointDefinition);
  server.registerTool('oc_task_run_needs_help', needsHelpHandler, needsHelpDefinition);
  server.registerTool('oc_task_run_complete', completeHandler, completeDefinition);
  server.registerTool('oc_task_run_get', getHandler, getDefinition);
  server.registerTool('oc_task_run_list', listHandler, listDefinition);
}

export const taskRunToolHandlers = {
  startHandler,
  updateHandler,
  checkpointHandler,
  needsHelpHandler,
  completeHandler,
  getHandler,
  listHandler,
};
