import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolHandler } from '../types/mcp';
import {
  BulkProgressInputError,
  BulkProgressNotFoundError,
  BulkProgressStore,
  StartBulkProgressInput,
  UpdateBulkProgressInput,
} from '../core/progress-contract';

export const bulkProgressStore = new BulkProgressStore();

type Json = Record<string, unknown>;

function jsonResult(value: Json): MCPResult {
  return {
    structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown): MCPResult {
  const code = error instanceof BulkProgressNotFoundError || error instanceof BulkProgressInputError
    ? error.code
    : 'bulk_progress_error';
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    structuredContent: { error: { code, message } },
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }, null, 2) }],
  };
}

const failedSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      item: { type: 'string' },
      reason: { type: 'string' },
      retryable: { type: 'boolean' },
    },
    required: ['item', 'reason'],
  },
};

const startDefinition: MCPToolDefinition = {
  name: 'oc_bulk_progress_start',
  description: 'Create an opt-in bulk progress contract for repetitive TaskRun/workflow/batch/crawl work. Use it before long item lists to prevent premature completion.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string' },
      scope: { type: 'string', enum: ['task_run', 'workflow', 'batch', 'crawl'] },
      expected_total: { type: 'number' },
      min_completed: { type: 'number' },
      stop_condition: { type: 'string' },
      stop_satisfied: { type: 'boolean' },
      item_key: { type: 'string' },
      cursor: { type: 'string' },
      completed: { type: 'array', items: { type: 'string' } },
      failed: failedSchema,
    },
    required: ['stop_condition', 'item_key'],
  },
};

const updateDefinition: MCPToolDefinition = {
  name: 'oc_bulk_progress_update',
  description: 'Record completed/failed item ids, cursor movement, stop satisfaction, or threshold changes on a bulk progress contract.',
  inputSchema: {
    type: 'object',
    properties: {
      contract_id: { type: 'string' },
      cursor: { type: 'string' },
      completed: { type: 'array', items: { type: 'string' } },
      failed: failedSchema,
      stop_satisfied: { type: 'boolean' },
      expected_total: { type: 'number' },
      min_completed: { type: 'number' },
    },
    required: ['contract_id'],
  },
};

const checkDefinition: MCPToolDefinition = {
  name: 'oc_bulk_progress_check',
  description: 'Evaluate whether a bulk progress contract currently allows task completion and return machine-readable recovery guidance.',
  inputSchema: {
    type: 'object',
    properties: {
      contract_id: { type: 'string' },
    },
    required: ['contract_id'],
  },
};

const startHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const contract = await bulkProgressStore.start(args as unknown as StartBulkProgressInput);
    return jsonResult({ bulk_progress_contract: contract, completion_guard: bulkProgressStore.checkCompletionGuard(contract) });
  } catch (error) {
    return errorResult(error);
  }
};

const updateHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const contractId = String(args.contract_id || '');
    const contract = await bulkProgressStore.update(contractId, args as UpdateBulkProgressInput);
    return jsonResult({ bulk_progress_contract: contract, completion_guard: bulkProgressStore.checkCompletionGuard(contract) });
  } catch (error) {
    return errorResult(error);
  }
};

const checkHandler: ToolHandler = async (_sessionId, args) => {
  try {
    const contractId = String(args.contract_id || '');
    const contract = await bulkProgressStore.get(contractId);
    return jsonResult({ bulk_progress_contract: contract, completion_guard: bulkProgressStore.checkCompletionGuard(contract) });
  } catch (error) {
    return errorResult(error);
  }
};

export function registerBulkProgressTools(server: MCPServer): void {
  server.registerTool('oc_bulk_progress_start', startHandler, startDefinition);
  server.registerTool('oc_bulk_progress_update', updateHandler, updateDefinition);
  server.registerTool('oc_bulk_progress_check', checkHandler, checkDefinition);
}

export const bulkProgressToolHandlers = {
  startHandler,
  updateHandler,
  checkHandler,
};
