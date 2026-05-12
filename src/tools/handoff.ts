import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolHandler } from '../types/mcp';
import {
  FinishHandoffInput,
  HandoffNotFoundError,
  HandoffStore,
  HandoffTransitionError,
  StartHandoffInput,
} from '../core/handoff';

const store = new HandoffStore();

type Json = Record<string, unknown>;

function jsonResult(value: Json): MCPResult {
  return {
    structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown): MCPResult {
  const code = error instanceof HandoffTransitionError || error instanceof HandoffNotFoundError
    ? error.code
    : 'handoff_error';
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    structuredContent: { error: { code, message } },
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }, null, 2) }],
  };
}

const snapshotSchema = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    title: { type: 'string' },
    origin: { type: 'string' },
    cookie_count: { type: 'number' },
    local_storage_keys: { type: 'array', items: { type: 'string' } },
    session_storage_keys: { type: 'array', items: { type: 'string' } },
    dom_fingerprint: { type: 'string' },
    screenshot_ref: { type: 'string' },
  },
};

const startDefinition: MCPToolDefinition = {
  name: 'oc_handoff_start',
  description: 'Start a secret-safe human takeover checkpoint. Stores only caller-supplied safe page state deltas and optional TaskRun linkage.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string' },
      run_id: { type: 'string', description: 'Optional TaskRun id from oc_task_run_start.' },
      session_id: { type: 'string' },
      tab_id: { type: 'string' },
      resume_hint: { type: 'string' },
      before: snapshotSchema,
      ttl_ms: { type: 'number', description: 'Timeout in milliseconds. Default 15 minutes, max 4 hours.' },
    },
    required: ['reason'],
  },
};

const statusDefinition: MCPToolDefinition = {
  name: 'oc_handoff_status',
  description: 'Read a handoff checkpoint and transition it to TIMED_OUT when its TTL has elapsed.',
  inputSchema: {
    type: 'object',
    properties: {
      handoff_id: { type: 'string' },
      include_events: { type: 'boolean' },
    },
    required: ['handoff_id'],
  },
};

const finishDefinition: MCPToolDefinition = {
  name: 'oc_handoff_finish',
  description: 'Finish a human takeover checkpoint, compute a secret-safe state delta, and append one handoff evidence pointer to the linked TaskRun when run_id was supplied.',
  inputSchema: {
    type: 'object',
    properties: {
      handoff_id: { type: 'string' },
      after: snapshotSchema,
      human_summary: { type: 'string' },
    },
    required: ['handoff_id'],
  },
};

const cancelDefinition: MCPToolDefinition = {
  name: 'oc_handoff_cancel',
  description: 'Cancel an active handoff checkpoint without changing browser state.',
  inputSchema: {
    type: 'object',
    properties: {
      handoff_id: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['handoff_id'],
  },
};

const startHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const handoff = await store.start(args as unknown as StartHandoffInput);
    return jsonResult({ handoff });
  } catch (error) {
    return errorResult(error);
  }
};

const statusHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const handoffId = String(args.handoff_id || '');
    const handoff = await store.status(handoffId);
    const result: Json = { handoff };
    if (args.include_events === true) {
      result.events = await store.readEvents(handoffId);
    }
    return jsonResult(result);
  } catch (error) {
    return errorResult(error);
  }
};

const finishHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const handoffId = String(args.handoff_id || '');
    const handoff = await store.finish(handoffId, args as FinishHandoffInput);
    return jsonResult({ handoff });
  } catch (error) {
    return errorResult(error);
  }
};

const cancelHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const handoffId = String(args.handoff_id || '');
    const handoff = await store.cancel(handoffId, args.reason as string | undefined);
    return jsonResult({ handoff });
  } catch (error) {
    return errorResult(error);
  }
};

export function registerHandoffTools(server: MCPServer): void {
  server.registerTool('oc_handoff_start', startHandler, startDefinition);
  server.registerTool('oc_handoff_status', statusHandler, statusDefinition);
  server.registerTool('oc_handoff_finish', finishHandler, finishDefinition);
  server.registerTool('oc_handoff_cancel', cancelHandler, cancelDefinition);
}

export const handoffToolHandlers = {
  startHandler,
  statusHandler,
  finishHandler,
  cancelHandler,
};
