import type { MCPServer } from '../mcp-server.js';
import type { MCPResult, MCPToolDefinition, ToolHandler } from '../types/mcp.js';
import { getRunStore } from './store.js';
import { RUN_STATUSES, TERMINAL_RUN_STATUSES, type RunRecord, type RunStatus } from './types.js';

const runIdProperty = {
  type: 'string',
  description: 'REQUIRED Run identifier returned by oc_run_start.',
};

const startDefinition: MCPToolDefinition = {
  name: 'oc_run_start',
  description: 'Start an opt-in OpenChrome run ledger. Returns {run_id,status,pathless metadata}.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'Optional caller-supplied safe run id.' },
      session_id: { type: 'string', description: 'Optional session id to associate with the run.' },
      tab_id: { type: 'string', description: 'Optional tab id to associate with the run.' },
      metadata: { type: 'object', description: 'Optional JSON metadata.' },
    },
    required: [],
  },
};

const statusDefinition: MCPToolDefinition = {
  name: 'oc_run_status',
  description: 'Return the current status and summary for an opt-in OpenChrome run ledger.',
  inputSchema: { type: 'object', properties: { run_id: runIdProperty }, required: ['run_id'] },
};

const eventsDefinition: MCPToolDefinition = {
  name: 'oc_run_events',
  description: 'Return recent events for an opt-in OpenChrome run ledger.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: runIdProperty,
      limit: { type: 'number', description: 'Maximum number of events to return. Default 100.' },
    },
    required: ['run_id'],
  },
};

const finishDefinition: MCPToolDefinition = {
  name: 'oc_run_finish',
  description: 'Finish an opt-in OpenChrome run ledger with a terminal or needs_user_input status.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: runIdProperty,
      status: { type: 'string', enum: RUN_STATUSES.filter((s) => s !== 'created' && s !== 'running') as unknown as string[], description: 'REQUIRED Terminal or needs_user_input run status.' },
      message: { type: 'string', description: 'Optional finish reason.' },
      metadata: { type: 'object', description: 'Optional finish metadata.' },
    },
    required: ['run_id', 'status'],
  },
};

const startHandler: ToolHandler = async (_sessionId, args): Promise<MCPResult> => {
  const record = getRunStore().startRun({
    run_id: stringArg(args.run_id),
    session_id: stringArg(args.session_id),
    tab_id: stringArg(args.tab_id),
    metadata: objectArg(args.metadata),
  });
  return json(recordSummary(record));
};

const statusHandler: ToolHandler = async (_sessionId, args): Promise<MCPResult> => {
  const run_id = requireString(args.run_id, 'run_id');
  const record = getRunStore().getRun(run_id);
  if (!record) return json({ run_id, found: false }, true);
  return json({ ...recordSummary(record), found: true });
};

const eventsHandler: ToolHandler = async (_sessionId, args): Promise<MCPResult> => {
  const run_id = requireString(args.run_id, 'run_id');
  const record = getRunStore().getRun(run_id);
  if (!record) return json({ run_id, found: false, events: [] }, true);
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.max(0, Math.floor(args.limit)) : 100;
  return json({ run_id, found: true, events: record.events.slice(-limit) });
};

const finishHandler: ToolHandler = async (_sessionId, args): Promise<MCPResult> => {
  const run_id = requireString(args.run_id, 'run_id');
  const status = requireRunFinishStatus(args.status);
  const record = getRunStore().finishRun(run_id, {
    status,
    message: stringArg(args.message),
    metadata: objectArg(args.metadata),
  });
  if (!record) return json({ run_id, found: false }, true);
  return json({ ...recordSummary(record), found: true });
};

export function registerRunHarnessTools(server: MCPServer): void {
  server.registerTool(startDefinition.name, startHandler, startDefinition);
  server.registerTool(statusDefinition.name, statusHandler, statusDefinition);
  server.registerTool(eventsDefinition.name, eventsHandler, eventsDefinition);
  server.registerTool(finishDefinition.name, finishHandler, finishDefinition);
}

function recordSummary(record: RunRecord): Record<string, unknown> {
  return {
    run_id: record.run_id,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    session_id: record.session_id,
    tab_id: record.tab_id,
    event_count: record.events.length,
    terminal: TERMINAL_RUN_STATUSES.has(record.status),
  };
}

function json(payload: Record<string, unknown>, isError = false): MCPResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError };
}

function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function requireString(value: unknown, name: string): string {
  const parsed = stringArg(value);
  if (!parsed) throw new Error(`${name} is required`);
  return parsed;
}

function objectArg(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requireRunFinishStatus(value: unknown): RunStatus {
  if (typeof value !== 'string' || !(RUN_STATUSES as readonly string[]).includes(value) || value === 'created' || value === 'running') {
    throw new Error('status must be one of completed, failed, timed_out, canceled, aborted, needs_user_input');
  }
  return value as RunStatus;
}
