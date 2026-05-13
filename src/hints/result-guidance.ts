import type { HintResult } from './hint-engine';

export type AutomationClassification =
  | 'continue'
  | 'done_candidate'
  | 'needs_user_input'
  | 'blocked'
  | 'retry_with_different_strategy'
  | 'impossible_or_out_of_scope';

export type ResultGuidanceStatus =
  | 'success'
  | 'partial'
  | 'blocked'
  | 'retryable_error'
  | 'fatal_error'
  | 'needs_user_input';

export interface ResultGuidance {
  status: ResultGuidanceStatus;
  nextAction?: {
    tool?: string;
    reason: string;
    argsHint?: Record<string, unknown>;
  };
  avoid?: Array<{ action: string; reason: string }>;
  evidence?: string[];
  resumeSuggestion?: string;
}

export interface AutomationInsight {
  classification: AutomationClassification;
  guidance?: ResultGuidance;
}

const NEEDS_USER_INPUT_PATTERNS = [
  /authredirect/i,
  /login page detected/i,
  /authentication required/i,
  /2fa|two[- ]factor|verification code|multi[- ]factor|mfa/i,
  /captcha detected|captcha|prove you(?:'| a)?re human|humanity/i,
  /consent required|manual input required|check your email/i,
];

const BLOCKED_PATTERNS = [
  /access denied|forbidden|\b403\b/i,
  /waf|bot[- ]?check|bot detection|blocking page detected/i,
  /blocked by|network security|been blocked/i,
  /aborted_by_hook|policy block|hook denied/i,
];

const RETRY_DIFFERENT_STRATEGY_PATTERNS = [
  /progress-tracker-stuck|progress-tracker-stalling/i,
  /stale ref|refs expire|ref not found|no longer available/i,
  /not interactive|non-interactive|no significant visual change/i,
  /no meaningful progress|must change approach|try a completely different approach/i,
  /element not found|selector not found|no clickable elements found/i,
];

const IMPOSSIBLE_PATTERNS = [
  /unsupported|disabled or not supported|out of scope|cannot proceed safely/i,
];

function extractText(result: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = result.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
        parts.push((item as { text: string }).text);
      }
    }
  }
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object') {
    try { parts.push(JSON.stringify(structured)); } catch { /* ignore */ }
  }
  for (const key of ['verdict', 'status', 'error', 'message']) {
    const value = result[key];
    if (typeof value === 'string') parts.push(value);
  }
  return parts.join('\n');
}

function evidenceFor(text: string, patterns: RegExp[]): string[] {
  const evidence: string[] = [];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) evidence.push(match[0]);
  }
  return [...new Set(evidence)].slice(0, 4);
}

export function classifyAutomationOutcome(
  toolName: string,
  result: Record<string, unknown>,
  isError: boolean,
  hint?: HintResult,
): AutomationClassification {
  const text = `${extractText(result)}\n${hint?.rule ?? ''}\n${hint?.rawHint ?? ''}\n${hint?.hint ?? ''}`;

  if (toolName === 'oc_assert' && /"?verdict"?\s*:?\s*"?pass"?/i.test(text)) {
    return 'done_candidate';
  }
  if (NEEDS_USER_INPUT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'needs_user_input';
  }
  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'blocked';
  }
  if (
    hint?.rule === 'progress-tracker-stuck' ||
    hint?.rule === 'progress-tracker-stalling' ||
    RETRY_DIFFERENT_STRATEGY_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return 'retry_with_different_strategy';
  }
  if (IMPOSSIBLE_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'impossible_or_out_of_scope';
  }
  return isError ? 'retry_with_different_strategy' : 'continue';
}

export function buildResultGuidance(
  classification: AutomationClassification,
  toolName: string,
  result: Record<string, unknown>,
  isError: boolean,
  hint?: HintResult,
): ResultGuidance | undefined {
  const text = `${extractText(result)}\n${hint?.rawHint ?? ''}\n${hint?.hint ?? ''}`;
  const suggestion = hint?.suggestion;

  switch (classification) {
    case 'needs_user_input':
      return {
        status: 'needs_user_input',
        evidence: evidenceFor(text, NEEDS_USER_INPUT_PATTERNS),
        nextAction: {
          reason: 'The browser state requires external user input or authentication before automation can safely continue.',
        },
        avoid: [{ action: `repeat ${toolName}`, reason: 'Repeating the same call will likely loop until the user completes the required step.' }],
        resumeSuggestion: 'Have the user complete login/2FA/CAPTCHA/consent in the active profile, then verify with read_page or navigate.',
      };
    case 'blocked':
      return {
        status: 'blocked',
        evidence: evidenceFor(text, BLOCKED_PATTERNS),
        nextAction: {
          reason: 'The page or policy blocked automated progress; switch to a supported handoff or different browser mode instead of retrying blindly.',
        },
        avoid: [{ action: `repeat ${toolName}`, reason: 'The current block signal is deterministic enough that immediate repetition is unlikely to help.' }],
      };
    case 'retry_with_different_strategy':
      return {
        status: isError ? 'retryable_error' : 'partial',
        evidence: evidenceFor(text, RETRY_DIFFERENT_STRATEGY_PATTERNS),
        nextAction: suggestion ?? { reason: 'Recent calls indicate no meaningful progress; choose a different tool or refresh page state before retrying.' },
        avoid: [{ action: `repeat ${toolName} with the same arguments`, reason: 'The previous result indicates this exact strategy is stalling.' }],
      };
    case 'done_candidate':
      return {
        status: 'success',
        evidence: ['explicit verifier returned pass'],
        nextAction: { reason: 'Treat this as a completion candidate and perform any task-level final verification before stopping.' },
      };
    case 'impossible_or_out_of_scope':
      return {
        status: 'fatal_error',
        evidence: evidenceFor(text, IMPOSSIBLE_PATTERNS),
        nextAction: { reason: 'Stop this strategy and report the unsupported or out-of-scope condition to the host/user.' },
      };
    case 'continue':
      return undefined;
  }
}

export function buildAutomationInsight(
  toolName: string,
  result: Record<string, unknown>,
  isError: boolean,
  hint?: HintResult,
): AutomationInsight | null {
  const classification = classifyAutomationOutcome(toolName, result, isError, hint);
  const guidance = buildResultGuidance(classification, toolName, result, isError, hint);
  if (classification === 'continue' && !guidance) return null;
  return { classification, ...(guidance && { guidance }) };
}

export function shouldInjectAutomationFallback(insight: AutomationInsight, hint?: HintResult): boolean {
  return (
    insight.classification === 'needs_user_input' ||
    insight.classification === 'blocked' ||
    insight.classification === 'impossible_or_out_of_scope' ||
    hint?.severity === 'critical'
  );
}

export function formatAutomationFallback(insight: AutomationInsight): string {
  const guidance = insight.guidance;
  const parts = [`Automation status: ${insight.classification}.`];
  if (guidance?.nextAction?.reason) parts.push(`Next: ${guidance.nextAction.reason}`);
  if (guidance?.avoid?.[0]) parts.push(`Avoid: ${guidance.avoid[0].action} — ${guidance.avoid[0].reason}`);
  if (guidance?.resumeSuggestion) parts.push(`Resume: ${guidance.resumeSuggestion}`);
  return parts.join(' ');
}
