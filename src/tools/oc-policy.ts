import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import {
  DEFAULT_TOOL_RISK_POLICIES,
  evaluateToolRiskPolicy,
  getEffectiveToolRiskPolicy,
} from '../security/tool-risk-policy';

const definition: MCPToolDefinition = {
  name: 'oc_policy',
  description: 'Inspect deterministic OpenChrome safety policy. Use action="matrix" to list irreversible-action rules or action="evaluate" to preview a policy decision for a tool/args context.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['matrix', 'evaluate'], description: 'matrix lists policies; evaluate returns a decision for tool/args. Default: matrix.' },
      tool: { type: 'string', description: '(evaluate) Tool name to evaluate.' },
      args: { type: 'object', description: '(evaluate) Tool arguments to classify.', additionalProperties: true },
      dryRun: { type: 'boolean', description: '(evaluate) Whether the caller requested a dry-run/preview path.' },
      elicitationSupported: { type: 'boolean', description: '(evaluate) Whether client-side elicitation/confirmation is available.' },
      allowedDomains: { type: 'array', items: { type: 'string' }, description: '(evaluate) Optional task allowedDomains policy.' },
      checkpoint: {
        type: 'object',
        description: '(evaluate) Optional checkpoint evidence with createdAt, now, and taskId.',
        properties: {
          taskId: { type: 'string' },
          createdAt: { type: 'number' },
          now: { type: 'number' },
        },
      },
    },
    required: [],
  },
  annotations: TOOL_ANNOTATIONS.oc_policy,
};

const handler: ToolHandler = async (_sessionId: string, args: Record<string, unknown>): Promise<MCPResult> => {
  const action = (args.action as string | undefined) ?? 'matrix';
  if (action === 'matrix') {
    return jsonResult({ status: 'ok', policies: DEFAULT_TOOL_RISK_POLICIES });
  }
  if (action !== 'evaluate') {
    return jsonResult({ status: 'error', error: `Unknown action: ${action}` }, true);
  }
  const tool = args.tool as string | undefined;
  if (!tool) return jsonResult({ status: 'error', error: 'tool is required for action=evaluate' }, true);
  const toolArgs = (args.args ?? {}) as Record<string, unknown>;
  const checkpoint = args.checkpoint && typeof args.checkpoint === 'object'
    ? args.checkpoint as { taskId?: string; createdAt: number; now?: number }
    : undefined;
  const allowedDomains = Array.isArray(args.allowedDomains) ? args.allowedDomains.map(String) : undefined;
  const decision = evaluateToolRiskPolicy({
    tool,
    args: toolArgs,
    dryRun: args.dryRun === true,
    elicitationSupported: args.elicitationSupported === true,
    allowedDomains,
    checkpoint,
  });
  return jsonResult({
    status: 'ok',
    effectivePolicy: getEffectiveToolRiskPolicy(tool, toolArgs, allowedDomains),
    decision,
  });
};

function jsonResult(payload: Record<string, unknown>, isError = false): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError,
    ...payload,
  };
}

export function registerOcPolicyTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}

export const ocPolicyToolHandler = handler;
