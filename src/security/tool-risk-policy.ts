import { TOOL_ANNOTATIONS } from '../types/tool-annotations';

export type ActionRisk = 'read_only' | 'browser_mutation' | 'external_side_effect' | 'destructive' | 'irreversible';
export type PolicyDecision = 'allow' | 'preview_required' | 'elicitation_required' | 'checkpoint_required' | 'blocked';

export interface ToolRiskPolicy {
  tool: string;
  risk: ActionRisk;
  trigger?: string;
  requiresDryRun?: boolean;
  requiresElicitation?: boolean;
  requiresCheckpoint?: boolean;
  requiresContractPrecheck?: boolean;
}

export interface PolicyEvaluationInput {
  tool: string;
  args?: Record<string, unknown>;
  dryRun?: boolean;
  elicitationSupported?: boolean;
  checkpoint?: {
    taskId?: string;
    createdAt: number;
    now?: number;
  };
  allowedDomains?: string[];
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  policy: ToolRiskPolicy;
  reason: string;
  missing?: Array<'dryRun' | 'elicitation' | 'checkpoint' | 'allowedDomain'>;
  checkpointMaxAgeMs?: number;
  suggested_next_action?: string;
}

const CHECKPOINT_MAX_AGE_MS = 5 * 60 * 1000;

export const DEFAULT_TOOL_RISK_POLICIES: ToolRiskPolicy[] = [
  { tool: 'read_page', risk: 'read_only' },
  { tool: 'tabs_context', risk: 'read_only' },
  { tool: 'query_dom', risk: 'read_only' },
  { tool: 'cookies', risk: 'destructive', trigger: 'action in delete/delete-all/clear', requiresDryRun: true, requiresElicitation: true },
  { tool: 'storage', risk: 'destructive', trigger: 'action in clear/delete/remove', requiresDryRun: true, requiresElicitation: true },
  { tool: 'oc_stop', risk: 'destructive', trigger: 'always', requiresElicitation: true, requiresCheckpoint: true },
  { tool: 'oc_reap_orphans', risk: 'destructive', trigger: 'always', requiresDryRun: true, requiresElicitation: true },
  { tool: 'request_intercept', risk: 'external_side_effect', trigger: 'broad block/abort rules', requiresDryRun: true },
  { tool: 'file_upload', risk: 'external_side_effect', trigger: 'always', requiresElicitation: true, requiresCheckpoint: true },
  { tool: 'act', risk: 'irreversible', trigger: 'submit/payment/delete form action text', requiresElicitation: true, requiresCheckpoint: true, requiresContractPrecheck: true },
  { tool: 'interact', risk: 'irreversible', trigger: 'submit/payment/delete form action text', requiresElicitation: true, requiresCheckpoint: true, requiresContractPrecheck: true },
  { tool: 'navigate', risk: 'external_side_effect', trigger: 'url host outside allowedDomains', requiresElicitation: true },
];

export function getEffectiveToolRiskPolicy(tool: string, args: Record<string, unknown> = {}, allowedDomains?: string[]): ToolRiskPolicy {
  if (tool === 'navigate' && allowedDomains && !isAllowedDomain(String(args.url || ''), allowedDomains)) {
    return DEFAULT_TOOL_RISK_POLICIES.find(p => p.tool === 'navigate')!;
  }
  if (tool === 'cookies' && /^(delete|delete-all|clear|remove)$/i.test(String(args.action || args.operation || ''))) {
    return DEFAULT_TOOL_RISK_POLICIES.find(p => p.tool === 'cookies')!;
  }
  if (tool === 'storage' && /^(clear|delete|remove)$/i.test(String(args.action || args.operation || ''))) {
    return DEFAULT_TOOL_RISK_POLICIES.find(p => p.tool === 'storage')!;
  }
  if (tool === 'request_intercept' && hasBroadBlockRule(args)) {
    return DEFAULT_TOOL_RISK_POLICIES.find(p => p.tool === 'request_intercept')!;
  }
  if ((tool === 'act' || tool === 'interact') && hasIrreversibleText(args)) {
    return DEFAULT_TOOL_RISK_POLICIES.find(p => p.tool === tool)!;
  }
  const explicit = DEFAULT_TOOL_RISK_POLICIES.find(p => p.tool === tool && p.trigger === 'always');
  if (explicit) return explicit;
  const annotations = (TOOL_ANNOTATIONS as Record<string, { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } | undefined>)[tool];
  if (annotations?.readOnlyHint) return { tool, risk: 'read_only' };
  if (annotations?.destructiveHint) return { tool, risk: 'destructive', requiresElicitation: true };
  if (annotations?.openWorldHint) return { tool, risk: 'external_side_effect' };
  return { tool, risk: 'browser_mutation' };
}

export function evaluateToolRiskPolicy(input: PolicyEvaluationInput): PolicyEvaluationResult {
  const args = input.args ?? {};
  const policy = getEffectiveToolRiskPolicy(input.tool, args, input.allowedDomains);
  if (policy.risk === 'read_only') {
    return { decision: 'allow', policy, reason: 'read-only policy does not require a gate' };
  }

  const missing: PolicyEvaluationResult['missing'] = [];
  if (policy.requiresDryRun && input.dryRun !== true) missing.push('dryRun');
  if (policy.requiresElicitation && input.elicitationSupported !== true) missing.push('elicitation');
  if (policy.requiresCheckpoint && !hasFreshCheckpoint(input.checkpoint)) missing.push('checkpoint');
  if (input.tool === 'navigate' && input.allowedDomains && !isAllowedDomain(String(args.url || ''), input.allowedDomains)) missing.push('allowedDomain');

  if (missing.includes('allowedDomain')) {
    return {
      decision: 'blocked',
      policy,
      reason: 'navigation target is outside allowedDomains',
      missing,
      suggested_next_action: 'Use an allowed localhost/domain URL or update the task allowedDomains policy.',
    };
  }
  if (missing.includes('dryRun')) {
    return {
      decision: 'preview_required',
      policy,
      reason: 'policy requires a dry-run preview before this high-risk action can commit',
      missing,
      suggested_next_action: `Call ${input.tool} with dryRun:true or use the documented preview path first.`,
    };
  }
  if (missing.includes('checkpoint')) {
    return {
      decision: 'checkpoint_required',
      policy,
      reason: 'policy requires a fresh task checkpoint before this irreversible action',
      missing,
      checkpointMaxAgeMs: CHECKPOINT_MAX_AGE_MS,
      suggested_next_action: 'Create or refresh a task/session checkpoint, then retry with the same policy context.',
    };
  }
  if (missing.includes('elicitation')) {
    return {
      decision: 'elicitation_required',
      policy,
      reason: 'policy requires client elicitation/confirmation support before this action',
      missing,
      suggested_next_action: 'Ask the host to confirm or enable the elicitation/irreversible-action hook.',
    };
  }
  return { decision: 'allow', policy, reason: 'all policy prerequisites are satisfied' };
}

function hasFreshCheckpoint(checkpoint: PolicyEvaluationInput['checkpoint']): boolean {
  if (!checkpoint) return false;
  const now = checkpoint.now ?? Date.now();
  return now - checkpoint.createdAt <= CHECKPOINT_MAX_AGE_MS;
}

function isAllowedDomain(url: string, allowedDomains: string[]): boolean {
  if (!url || allowedDomains.length === 0) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedDomains.some(domain => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`));
  } catch {
    return false;
  }
}

function hasBroadBlockRule(args: Record<string, unknown>): boolean {
  const text = JSON.stringify(args).toLowerCase();
  return /block|abort|deny/.test(text) && (/\*|all|resource|image|script|stylesheet/.test(text));
}

function hasIrreversibleText(args: Record<string, unknown>): boolean {
  const text = JSON.stringify(args).toLowerCase();
  return /submit|payment|pay|purchase|checkout|delete|remove|transfer|send money|place order/.test(text);
}
