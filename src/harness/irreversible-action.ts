import type { MCPResult } from '../types/mcp';
import { isContractRuntimeEnabled } from './flags';

export interface BrowserActionRiskInput {
  toolName: string;
  action: string;
  labelText?: string;
  pageUrl?: string;
}

export interface BrowserActionRisk {
  critical: boolean;
  actionLabel: string;
  reason: string;
  evidence: string[];
}

const CRITICAL_ACTION_WORDS = [
  'delete', 'remove', 'destroy', 'erase', 'reset account', 'close account',
  'submit payment', 'pay', 'purchase', 'checkout', 'buy now', 'place order',
  'transfer', 'withdraw', 'send money', 'wire',
  'publish', 'post now', 'send message', 'send email',
  'disable security', 'change password', 'change email', 'revoke',
];

const SAFE_NEGATIONS = [
  'cancel', 'back', 'dismiss', 'close dialog', 'not now', 'learn more', 'preview', 'view', 'read',
];

function normalize(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(?:^|\\s)${escapeRegex(phrase)}(?:\\s|$)`).test(text);
}

export function classifyBrowserActionRisk(input: BrowserActionRiskInput): BrowserActionRisk {
  const text = normalize(`${input.action} ${input.labelText ?? ''}`);
  const evidence = CRITICAL_ACTION_WORDS.filter((word) => containsPhrase(text, word));
  const negated = SAFE_NEGATIONS.some((word) => containsPhrase(text, word));
  const mutatingClick = ['click', 'double click'].includes(normalize(input.action));

  if (!mutatingClick || evidence.length === 0 || negated) {
    return {
      critical: false,
      actionLabel: `${input.toolName}:${input.action}`,
      reason: negated ? 'matched safe/negating action text' : 'no critical side-effect keyword matched',
      evidence,
    };
  }

  return {
    critical: true,
    actionLabel: `${input.toolName}:${evidence[0].replace(/\s+/g, '-')}`,
    reason: `Matched irreversible-action keyword "${evidence[0]}" in browser action text.`,
    evidence,
  };
}

export async function guardIrreversibleBrowserAction<T>(
  input: BrowserActionRiskInput,
  skill: () => Promise<T>,
): Promise<{ value?: T; blocked?: MCPResult; risk: BrowserActionRisk }> {
  const risk = classifyBrowserActionRisk(input);
  if (!risk.critical || !isContractRuntimeEnabled()) {
    return { value: await skill(), risk };
  }

  const { runWithContract } = await import('../pilot/runtime/runtime');
  const record = await runWithContract({
    contract: {
      id: `browser-action:${risk.actionLabel}`,
      domain: input.pageUrl ? safeHost(input.pageUrl) : undefined,
      critical: true,
      action: risk.actionLabel,
      pre: { kind: 'no_dialog' },
      post: { kind: 'no_dialog' },
      on_fail: { escalate: 'abort' },
    },
    args: {
      toolName: input.toolName,
      action: input.action,
      labelText: input.labelText,
      pageUrl: input.pageUrl,
      riskEvidence: risk.evidence,
    },
    snapshot: async () => ({
      async url() { return input.pageUrl ?? ''; },
      async domText() { return input.labelText ?? ''; },
      async domCount() { return 0; },
      async networkSince() { return []; },
      async screenshotPng() { return null; },
      async hasOpenDialog() { return false; },
    }),
    skill,
  });

  if (record.verdict === 'success') {
    return { value: record.skill_result as T, risk };
  }

  const text = JSON.stringify({
    status: record.verdict,
    action: risk.actionLabel,
    reason: record.error_message ?? record.hook_decision?.reason ?? risk.reason,
    externalToken: record.hook_decision?.external_token,
    evidence: risk.evidence,
  }, null, 2);

  return {
    risk,
    blocked: {
      content: [{ type: 'text', text }],
      isError: true,
      _irreversibleAction: {
        status: record.verdict,
        action: risk.actionLabel,
        evidence: risk.evidence,
        hookDecision: record.hook_decision,
      },
    },
  };
}

function safeHost(url: string): string | undefined {
  try { return new URL(url).hostname; } catch { return undefined; }
}
