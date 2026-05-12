/** Advisory recovery candidate ranking for stuck/stalling hints. */
import { policyRankBoost, type RecoveryPolicyRecord } from './policy-learner';
import { scoreRecoveryOutcome } from './reward-scorer';

export type RecoveryCandidateRisk = 'read_only' | 'reversible' | 'side_effect_possible';

export interface RecentToolCallLike {
  toolName: string;
  result: 'pending' | 'success' | 'error' | 'aborted';
  error?: string;
  args?: Record<string, unknown>;
}

export interface RecoveryCandidate {
  tool: string;
  reason: string;
  score: number;
  risk: RecoveryCandidateRisk;
  argsTemplate?: Record<string, unknown>;
  blockedReason?: string;
}

export interface RecoveryCandidateRankInput {
  toolName: string;
  resultText: string;
  isError: boolean;
  recentCalls: RecentToolCallLike[];
  maxCandidates?: number;
  policies?: RecoveryPolicyRecord[];
}

const BLIND_INTERACTION_TOOLS = new Set(['click', 'interact', 'computer', 'form_input', 'fill_form', 'javascript_tool']);
const READ_TOOLS = new Set(['read_page', 'tabs_context', 'find', 'query_dom']);

export function rankRecoveryCandidates(input: RecoveryCandidateRankInput): RecoveryCandidate[] {
  const text = `${input.resultText}\n${input.recentCalls.map((c) => c.error ?? '').join('\n')}`.toLowerCase();
  const candidates: RecoveryCandidate[] = [];

  const add = (candidate: Omit<RecoveryCandidate, 'score'> & { baseScore: number }) => {
    if (candidate.blockedReason) {
      candidates.push({ ...candidate, score: -1 });
      return;
    }
    const repeatedPenalty = repeatedToolCount(input.recentCalls, candidate.tool) * 0.08;
    const sameFailedPenalty = candidate.tool === input.toolName && input.isError ? 0.25 : 0;
    const riskPenalty = candidate.risk === 'read_only' ? 0 : candidate.risk === 'reversible' ? 0.08 : 0.25;
    const evidence = scoreRecoveryOutcome({
      toolName: candidate.tool,
      errorText: input.isError ? input.resultText : undefined,
      resultText: input.resultText,
      freshRefsDiscovered: candidate.tool === 'read_page' && isStaleOrElementFailure(text),
      observationOnly: READ_TOOLS.has(candidate.tool),
      repeatedFailureCount: repeatedToolCount(input.recentCalls, input.toolName),
    });
    const learnedBoost = policyRankBoost(input.policies, candidate.tool, candidate.risk);
    const score = clamp(candidate.baseScore + evidence.score * 0.25 + learnedBoost - repeatedPenalty - sameFailedPenalty - riskPenalty);
    candidates.push({ ...candidate, score });
  };

  if (isBlockingOrAuth(text)) {
    add({
      tool: 'read_page',
      reason: 'Classify the blocking/auth state before any more interactions.',
      risk: 'read_only',
      baseScore: 0.78,
    });
    add({
      tool: 'tabs_context',
      reason: 'Verify the active tab and URL after the blocking redirect.',
      risk: 'read_only',
      baseScore: 0.62,
    });
    add({
      tool: input.toolName,
      reason: 'Blind retry is unsafe on auth, CAPTCHA, or blocking pages.',
      risk: 'side_effect_possible',
      baseScore: -0.2,
      blockedReason: 'blocking/auth signal present',
    });
    return topCandidates(candidates, input.maxCandidates);
  }

  if (isStaleOrElementFailure(text)) {
    add({
      tool: 'read_page',
      reason: 'Refresh actionable refs after stale/missing element evidence.',
      risk: 'read_only',
      baseScore: 0.9,
    });
    add({
      tool: 'find',
      reason: 'Re-resolve the target by accessible text or role instead of reusing an old ref.',
      risk: 'read_only',
      baseScore: 0.74,
    });
  }

  if (isTimeoutOrNetwork(text)) {
    add({
      tool: 'tabs_context',
      reason: 'Check whether the tab survived the timeout before retrying.',
      risk: 'read_only',
      baseScore: 0.72,
    });
    add({
      tool: 'read_page',
      reason: 'Inspect partial page state; the navigation may have produced usable content.',
      risk: 'read_only',
      baseScore: 0.68,
    });
  }

  if (input.isError && BLIND_INTERACTION_TOOLS.has(input.toolName)) {
    add({
      tool: 'read_page',
      reason: 'Observe the current page before another interaction attempt.',
      risk: 'read_only',
      baseScore: 0.7,
    });
  }

  if (candidates.length === 0) {
    add({
      tool: 'tabs_context',
      reason: 'Step back and verify tab, URL, and page state before continuing.',
      risk: 'read_only',
      baseScore: 0.55,
    });
    add({
      tool: 'read_page',
      reason: 'Collect fresh page evidence instead of repeating the same call.',
      risk: 'read_only',
      baseScore: 0.5,
    });
  }

  return topCandidates(candidates, input.maxCandidates);
}

export function formatCandidateHint(candidates: RecoveryCandidate[]): string {
  if (candidates.length === 0) return '';
  const actionable = candidates.filter((c) => !c.blockedReason).slice(0, 3);
  if (actionable.length === 0) return '';
  return ' Suggested recovery order: ' + actionable
    .map((c, i) => `${i + 1}) ${c.tool} — ${c.reason}`)
    .join(' ');
}

function topCandidates(candidates: RecoveryCandidate[], max = 3): RecoveryCandidate[] {
  const deduped = new Map<string, RecoveryCandidate>();
  for (const candidate of candidates) {
    const current = deduped.get(candidate.tool);
    if (!current || candidate.score > current.score) deduped.set(candidate.tool, candidate);
  }
  return Array.from(deduped.values())
    .sort((a, b) => {
      if (a.blockedReason && !b.blockedReason) return 1;
      if (!a.blockedReason && b.blockedReason) return -1;
      return b.score - a.score;
    })
    .slice(0, max);
}

function repeatedToolCount(calls: RecentToolCallLike[], tool: string): number {
  return calls.filter((call) => call.toolName === tool).length;
}

function isStaleOrElementFailure(text: string): boolean {
  return /stale|element not found|ref .*not found|ref .*expired|no longer available|not interactive/.test(text);
}

function isBlockingOrAuth(text: string): boolean {
  return /captcha|access denied|forbidden|authredirect|login page detected|blocking page detected|bot-check|blocked by|network security/.test(text);
}

function isTimeoutOrNetwork(text: string): boolean {
  return /timed out|timeout|net::err_|protocol error|target closed/.test(text);
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, Number(value.toFixed(3))));
}
