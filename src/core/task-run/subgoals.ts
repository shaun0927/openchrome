export interface BrowserSubgoal {
  id: string;
  goal: string;
  success_criteria: string;
  allowed_tools: string[];
  stop_condition: string;
  allowed_domains?: string[];
}

export interface BrowserSubgoalPlan {
  objective: string;
  subgoals: BrowserSubgoal[];
  global_stop_conditions: string[];
}

export interface SubgoalExecutionState {
  subgoalId: string;
  status: 'pending' | 'passed' | 'failed' | 'stopped';
  reason?: string;
  next_safe_action?: string;
}

const REQUIRED_GLOBAL_STOPS = ['auth handoff required', 'captcha or bot check', 'destructive confirmation required'];
const DESTRUCTIVE_RE = /delete|remove|purchase|pay|checkout|transfer|send money|place order|confirm/i;

export function shouldDecomposeTask(input: { objective: string; optIn?: boolean; force?: boolean }): boolean {
  if (!input.optIn) return false;
  if (input.force) return true;
  const words = input.objective.trim().split(/\s+/).filter(Boolean);
  return words.length >= 8 || /\b(?:then|and|after|download|report|invoice|multi[- ]?step)\b/i.test(input.objective);
}

export function validateSubgoalPlan(plan: unknown, opts: { allowedDomains?: string[] } = {}): { ok: true; value: BrowserSubgoalPlan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan must be an object'] };
  const row = plan as Record<string, unknown>;
  if (typeof row.objective !== 'string' || row.objective.trim() === '') errors.push('objective is required');
  const subgoals = Array.isArray(row.subgoals) ? row.subgoals : undefined;
  const globalStopConditions = Array.isArray(row.global_stop_conditions) ? row.global_stop_conditions : undefined;
  if (!subgoals || subgoals.length === 0) errors.push('subgoals must be a non-empty array');
  if (!globalStopConditions) errors.push('global_stop_conditions must be an array');
  else if (!globalStopConditions.every((item) => typeof item === 'string' && item.length > 0)) {
    errors.push('global_stop_conditions must contain only strings');
  }

  const seen = new Set<string>();
  for (const stop of REQUIRED_GLOBAL_STOPS) {
    if (!globalStopConditions?.some(item => typeof item === 'string' && item.toLowerCase().includes(stop.split(' ')[0]))) {
      errors.push(`global_stop_conditions must include ${stop}`);
    }
  }

  for (const [index, subgoal] of (subgoals ?? []).entries()) {
    const prefix = `subgoals[${index}]`;
    if (!subgoal || typeof subgoal !== 'object') {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (typeof subgoal.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,80}$/i.test(subgoal.id)) errors.push(`${prefix}.id is invalid`);
    else if (seen.has(subgoal.id)) errors.push(`${prefix}.id is duplicated`);
    else seen.add(subgoal.id);
    if (typeof subgoal.goal !== 'string' || subgoal.goal.trim() === '') errors.push(`${prefix}.goal is required`);
    if (typeof subgoal.success_criteria !== 'string' || subgoal.success_criteria.trim() === '') errors.push(`${prefix}.success_criteria is required`);
    if (typeof subgoal.stop_condition !== 'string' || subgoal.stop_condition.trim() === '') errors.push(`${prefix}.stop_condition is required`);
    if (!Array.isArray(subgoal.allowed_tools) || subgoal.allowed_tools.length === 0) errors.push(`${prefix}.allowed_tools must be non-empty`);
    else if (!subgoal.allowed_tools.every((tool: unknown) => typeof tool === 'string' && tool.length > 0)) errors.push(`${prefix}.allowed_tools must contain only strings`);
    if (DESTRUCTIVE_RE.test(`${subgoal.goal} ${subgoal.stop_condition}`) && !/destructive|confirmation|policy/i.test(subgoal.stop_condition)) {
      errors.push(`${prefix} destructive-looking goal must stop on destructive confirmation/policy`);
    }
    if (subgoal.allowed_domains !== undefined && !Array.isArray(subgoal.allowed_domains)) {
      errors.push(`${prefix}.allowed_domains must be an array`);
    } else if (Array.isArray(subgoal.allowed_domains) && !subgoal.allowed_domains.every((domain: unknown) => typeof domain === 'string')) {
      errors.push(`${prefix}.allowed_domains must contain only strings`);
    }
    if (opts.allowedDomains && Array.isArray(subgoal.allowed_domains)) {
      const outside = subgoal.allowed_domains.filter((domain: unknown): domain is string => typeof domain === 'string' && !opts.allowedDomains!.includes(domain));
      if (outside.length > 0) errors.push(`${prefix}.allowed_domains outside allowed scope: ${outside.join(', ')}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: row as unknown as BrowserSubgoalPlan };
}

export function buildConservativeSubgoalPlan(input: {
  objective: string;
  allowedDomains?: string[];
  allowedTools?: string[];
}): BrowserSubgoalPlan {
  const callerAllowedTools = input.allowedTools?.filter((tool): tool is string => typeof tool === 'string' && tool.length > 0);
  const allowedTools = callerAllowedTools?.length ? callerAllowedTools : ['navigate', 'read_page', 'find', 'interact', 'oc_assert'];
  const allowed_domains = input.allowedDomains?.length ? input.allowedDomains : undefined;
  return {
    objective: input.objective,
    global_stop_conditions: [...REQUIRED_GLOBAL_STOPS],
    subgoals: [
      {
        id: 'scope-and-state',
        goal: 'Verify the task is on an allowed domain and the page is reachable',
        success_criteria: 'Current page URL is in scope and page state can be read',
        allowed_tools: pickStageTools(allowedTools, ['navigate', 'read_page', 'find']),
        stop_condition: 'out-of-domain, auth handoff required, captcha or bot check, or page reachable',
        allowed_domains,
      },
      {
        id: 'locate-target',
        goal: 'Locate the requested target or next required control without mutating external state',
        success_criteria: 'A specific visible target/control is identified with evidence',
        allowed_tools: pickStageTools(allowedTools, ['read_page', 'find', 'oc_assert']),
        stop_condition: 'target found, target absent, auth handoff required, captcha or bot check, or destructive confirmation required',
        allowed_domains,
      },
      {
        id: 'verify-outcome',
        goal: 'Verify the final requested outcome using explicit evidence before reporting completion',
        success_criteria: 'Outcome contract or success evidence is present and no global stop condition is active',
        allowed_tools: pickStageTools(allowedTools, ['read_page', 'find', 'oc_assert']),
        stop_condition: 'success evidence present, missing evidence, auth handoff required, captcha or bot check, or destructive confirmation required',
        allowed_domains,
      },
    ],
  };
}


function pickStageTools(allowedTools: string[], stageTools: string[]): string[] {
  const filtered = allowedTools.filter((tool) => stageTools.includes(tool));
  return filtered.length > 0 ? filtered : [...allowedTools];
}

export function evaluateSubgoalStop(input: { subgoal: BrowserSubgoal; evidenceText: string; passed?: boolean }): SubgoalExecutionState {
  const text = input.evidenceText.toLowerCase();
  if (/captcha|bot check/.test(text)) return stopped(input.subgoal.id, 'captcha or bot check detected', 'ask_user');
  if (/\b(?:login|unauthorized|forbidden|auth|authentication|authorization|sign[ -]?in)\b/.test(text)) return stopped(input.subgoal.id, 'auth handoff required', 'ask_user');
  if (/destructive|confirm|delete|payment|purchase|place order/.test(text)) return stopped(input.subgoal.id, 'destructive confirmation required', 'request_policy_confirmation');
  if (input.passed === true) return { subgoalId: input.subgoal.id, status: 'passed', reason: 'success criteria satisfied', next_safe_action: 'continue' };
  if (input.passed === false) return { subgoalId: input.subgoal.id, status: 'failed', reason: 'success criteria not satisfied', next_safe_action: 'stop_or_replan' };
  return { subgoalId: input.subgoal.id, status: 'pending', reason: 'no stop condition matched', next_safe_action: 'continue' };
}

function stopped(subgoalId: string, reason: string, next: string): SubgoalExecutionState {
  return { subgoalId, status: 'stopped', reason, next_safe_action: next };
}
