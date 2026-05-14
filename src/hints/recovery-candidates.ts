import type { ToolCallEvent } from '../dashboard/types';
import { scoreRecoveryOutcome } from '../recovery';

export type RecoveryCandidateRisk = 'read_only' | 'reversible' | 'side_effect_possible';

export interface RecoveryCandidate {
  tool: string;
  description: string;
  reason: string;
  score: number;
  risk: RecoveryCandidateRisk;
  blockedReason?: string;
}

const RISK_ORDER: Record<RecoveryCandidateRisk, number> = {
  read_only: 0,
  reversible: 1,
  side_effect_possible: 2,
};

const BLOCKING_TEXT = /captcha|access denied|forbidden|login page detected|blocking page detected|authredirect|bot-check/i;
const STALE_TEXT = /stale[_ -]?ref|stale|element not found|no elements found|no longer available/i;
const TIMEOUT_TEXT = /timeout|timed out|deadline|not ready|loading|detached/i;
const SECRET_KEY = /password|passcode|token|secret|credential|api[_-]?key|authorization|cookie/i;

export function rankRecoveryCandidates(args: {
  toolName: string;
  resultText: string;
  isError: boolean;
  recentCalls: ToolCallEvent[];
  maxCandidates?: number;
}): RecoveryCandidate[] {
  const maxCandidates = Math.max(1, Math.min(args.maxCandidates ?? 3, 5));
  const candidates: RecoveryCandidate[] = [];
  const text = args.resultText || '';
  const repeatedSameTool = countLeadingSameTool(args.recentCalls, args.toolName);

  if (BLOCKING_TEXT.test(text)) {
    candidates.push(candidate('read_page', 'Classify the current page state before retrying.', 'Blocking/auth/CAPTCHA signals detected; observe and classify instead of blind retries.', 'read_only', 0.82));
    candidates.push(candidate('tabs_context', 'Confirm the live tab and URL.', 'Blocked flows often redirect or replace tabs; verify location before mutating.', 'read_only', 0.72));
    return sortAndBound(candidates, maxCandidates);
  }

  if (STALE_TEXT.test(text)) {
    candidates.push(candidate('read_page', 'Refresh page state and refs.', 'Stale/missing element evidence means old refs are unsafe; get fresh refs first.', 'read_only', 0.9));
    candidates.push(candidate('find', 'Re-resolve the target by visible text or role.', 'A fresh query can locate the replacement element after DOM mutation.', 'read_only', 0.72));
    candidates.push(candidate(args.toolName, 'Retry only after refreshing refs.', 'Repeating the same failed tool/ref is down-ranked until new state is observed.', 'reversible', 0.2, repeatedSameTool > 0 ? 'same tool recently failed' : undefined));
    return sortAndBound(candidates, maxCandidates);
  }

  if (TIMEOUT_TEXT.test(text)) {
    candidates.push(candidate('wait_for', 'Wait for page readiness with a bounded timeout.', 'Timeout/loading evidence suggests waiting once before retrying.', 'read_only', 0.78));
    candidates.push(candidate('read_page', 'Observe current DOM after the wait.', 'Verify whether the page changed before another mutation.', 'read_only', 0.7));
  } else {
    candidates.push(candidate('tabs_context', 'Confirm the active tab and URL.', 'Stuck state may be caused by acting on the wrong tab.', 'read_only', 0.64));
    candidates.push(candidate('read_page', 'Refresh observable page state.', 'Observation can reveal new refs or blocking state before changing strategy.', 'read_only', 0.62));
  }

  if (args.isError && repeatedSameTool > 0) {
    candidates.push(candidate(args.toolName, 'Avoid immediate identical retry.', 'Same failed tool appears in recent calls; choose a different strategy first.', 'reversible', -0.2, 'repeated failed strategy'));
  }

  return sortAndBound(candidates, maxCandidates);
}

export function formatRecoveryCandidates(candidates: RecoveryCandidate[]): string {
  if (candidates.length === 0) return '';
  const rendered = candidates.map((c, index) => {
    const blocked = c.blockedReason ? `; blocked: ${c.blockedReason}` : '';
    return `${index + 1}. ${c.tool} (${c.risk}, score=${c.score.toFixed(2)}): ${sanitize(c.reason)}${blocked}`;
  });
  return ` Ranked recovery candidates: ${rendered.join(' | ')}`;
}

function candidate(
  tool: string,
  description: string,
  reason: string,
  risk: RecoveryCandidateRisk,
  baseScore: number,
  blockedReason?: string,
): RecoveryCandidate {
  const reward = scoreRecoveryOutcome({
    toolName: tool,
    observationOnly: risk === 'read_only',
    freshRefsDiscovered: tool === 'read_page' && /ref|state/i.test(reason),
    repeatedFailureCount: blockedReason ? 1 : 0,
  });
  return {
    tool,
    description: sanitize(description),
    reason: sanitize(reason),
    risk,
    score: Math.max(-1, Math.min(1, Number(((baseScore + reward.score * 0.2) / (blockedReason ? 1.5 : 1)).toFixed(3)))),
    ...(blockedReason ? { blockedReason: sanitize(blockedReason) } : {}),
  };
}

function sortAndBound(candidates: RecoveryCandidate[], max: number): RecoveryCandidate[] {
  return candidates
    .sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || b.score - a.score || a.tool.localeCompare(b.tool))
    .slice(0, max);
}

function countLeadingSameTool(calls: ToolCallEvent[], toolName: string): number {
  let count = 0;
  for (const call of calls) {
    if (call.toolName !== toolName) break;
    count += 1;
  }
  return count;
}

function sanitize(value: string): string {
  return value
    .replace(new RegExp(`(${SECRET_KEY.source})\\s*[:=]\\s*[^\\s,;]+`, 'gi'), '$1=[REDACTED]')
    .slice(0, 240);
}
