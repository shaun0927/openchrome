import {
  buildAutomationInsight,
  classifyAutomationOutcome,
  formatAutomationFallback,
  shouldInjectAutomationFallback,
} from '../../src/hints/result-guidance';
import type { HintResult } from '../../src/hints/hint-engine';

function result(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: isError ? `Error: ${text}` : text }], ...(isError && { isError: true }) };
}

describe('result guidance automation classifications', () => {
  it('classifies auth and CAPTCHA states as needs_user_input', () => {
    const insight = buildAutomationInsight('navigate', result('{"authRedirect":true,"url":"https://accounts.example/login"}'), false);

    expect(insight?.classification).toBe('needs_user_input');
    expect(insight?.guidance?.status).toBe('needs_user_input');
    expect(insight?.guidance?.avoid?.[0].action).toContain('navigate');
    expect(shouldInjectAutomationFallback(insight!)).toBe(true);
  });

  it('classifies WAF and access denied states as blocked', () => {
    const insight = buildAutomationInsight('navigate', result('Blocking page detected: Access Denied by WAF'), false);

    expect(insight?.classification).toBe('blocked');
    expect(insight?.guidance?.status).toBe('blocked');
    expect(formatAutomationFallback(insight!)).toContain('Automation status: blocked');
  });

  it('classifies progress-tracker stuck hints as retry_with_different_strategy', () => {
    const hint: HintResult = {
      severity: 'critical',
      rule: 'progress-tracker-stuck',
      fireCount: 2,
      rawHint: 'STOP — you are stuck. Step back and try a completely different approach.',
      hint: '🛑 CRITICAL (2x — you MUST change approach): STOP — you are stuck.',
    };

    const insight = buildAutomationInsight('interact', result('No significant visual change'), false, hint);

    expect(insight?.classification).toBe('retry_with_different_strategy');
    expect(insight?.guidance?.nextAction?.reason).toContain('different tool');
    expect(shouldInjectAutomationFallback(insight!, hint)).toBe(true);
  });

  it('uses hint suggestions as next action for retryable stale ref failures', () => {
    const hint: HintResult = {
      severity: 'warning',
      rule: 'stale-ref',
      fireCount: 3,
      rawHint: 'Refs expire; call read_page again.',
      hint: 'Refs expire; call read_page again.',
      suggestion: { tool: 'read_page', reason: 'Refresh refs before retrying.' },
    };

    const insight = buildAutomationInsight('interact', result('ref not found: abc123', true), true, hint);

    expect(insight?.classification).toBe('retry_with_different_strategy');
    expect(insight?.guidance?.status).toBe('retryable_error');
    expect(insight?.guidance?.nextAction?.tool).toBe('read_page');
  });

  it('surfaces passing explicit assertions as done candidates without claiming global completion', () => {
    expect(classifyAutomationOutcome('oc_assert', result('{"verdict":"pass"}'), false)).toBe('done_candidate');
    const insight = buildAutomationInsight('oc_assert', result('{"verdict":"pass"}'), false);
    expect(insight?.guidance?.nextAction?.reason).toContain('completion candidate');
  });

  it('omits metadata for ordinary successful progress', () => {
    expect(buildAutomationInsight('navigate', result('{"url":"https://example.com","title":"Example"}'), false)).toBeNull();
  });
});
