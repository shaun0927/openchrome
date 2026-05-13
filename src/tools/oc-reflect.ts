/**
 * oc_reflect — structured task-failure reflection artifacts (#1007).
 *
 * Core-tier persistence surface only. It stores bounded recovery guidance but
 * never executes the stored nextPlan.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { ReflectionStore, ReflectionCreateInput } from '../reflection';

const definition: MCPToolDefinition = {
  name: 'oc_reflect',
  description:
    'Create, get, or list structured task-failure reflection artifacts. ' +
    'Reflections are passive recovery guidance only; OpenChrome never executes nextPlan automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'get', 'list', 'validate'], description: 'REQUIRED Reflection action: create, get, list, or validate.' },
      id: { type: 'string', description: '(get) Reflection id' },
      scope: { type: 'object', description: '(create/list) domain, taskFingerprint, optional contractId/urlPattern' },
      trigger: { type: 'string', description: '(create) stuck, plan_failed, contract_failed, workflow_partial, or timeout' },
      evidence: { type: 'object', description: '(create) journalEntryIds, hintRules, failedAssertions, and lastTools' },
      diagnosis: { type: 'string', description: '(create) bounded diagnosis text' },
      nextPlan: { type: 'array', items: { type: 'string' }, description: '(create) passive next-trial plan items' },
      avoid: { type: 'array', items: { type: 'string' }, description: '(create) actions/strategies to avoid repeating' },
      confidence: { type: 'number', description: '(create) confidence 0..1' },
      expiresAt: { type: 'number', description: '(create) optional unix ms expiry' },
      limit: { type: 'number', description: '(list) max records, default 3, max 100' },
      includeExpired: { type: 'boolean', description: '(list) include expired reflections for debugging' },
      success: { type: 'boolean', description: '(validate) whether using this reflection succeeded' },
    },
    required: ['action'],
  },
};

const handler: ToolHandler = async (_sessionId: string, args: Record<string, unknown>): Promise<MCPResult> => {
  const store = new ReflectionStore();
  const action = args.action as string;

  try {
    if (action === 'create') {
      const artifact = await store.create({
        scope: args.scope as ReflectionCreateInput['scope'],
        trigger: args.trigger as ReflectionCreateInput['trigger'],
        evidence: args.evidence as ReflectionCreateInput['evidence'],
        diagnosis: args.diagnosis as string | undefined,
        nextPlan: args.nextPlan as string[] | undefined,
        avoid: args.avoid as string[] | undefined,
        confidence: args.confidence as number | undefined,
        expiresAt: args.expiresAt as number | undefined,
      });
      return jsonResult({ status: 'created', artifact });
    }

    if (action === 'get') {
      const id = args.id as string | undefined;
      if (!id) return jsonResult({ status: 'error', error: 'id is required for get' }, true);
      const artifact = await store.get(id);
      return artifact ? jsonResult({ status: 'found', artifact }) : jsonResult({ status: 'not_found', artifact: null });
    }

    if (action === 'validate') {
      const id = args.id as string | undefined;
      if (!id) return jsonResult({ status: 'error', error: 'id is required for validate' }, true);
      if (typeof args.success !== 'boolean') return jsonResult({ status: 'error', error: 'success boolean is required for validate' }, true);
      const artifact = await store.validate(id, args.success);
      return artifact ? jsonResult({ status: 'validated', artifact }) : jsonResult({ status: 'pruned_or_not_found', artifact: null });
    }

    if (action === 'list') {
      const scope = (args.scope ?? {}) as { domain?: string; taskFingerprint?: string; contractId?: string };
      const artifacts = store.list({
        domain: scope.domain,
        taskFingerprint: scope.taskFingerprint,
        contractId: scope.contractId,
        limit: args.limit as number | undefined,
        includeExpired: args.includeExpired as boolean | undefined,
      });
      return jsonResult({ status: 'listed', artifacts });
    }

    return jsonResult({ status: 'error', error: `Unknown action: ${action}. Use create, get, list, or validate.` }, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ status: 'error', error: message }, true);
  }
};

function jsonResult(payload: Record<string, unknown>, isError = false): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
    ...payload,
  };
}

export function registerOcReflectTool(server: MCPServer): void {
  server.registerTool('oc_reflect', handler, definition);
}
