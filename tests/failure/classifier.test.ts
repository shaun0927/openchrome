import { classifyFailure, primaryFailureCategory } from '../../src/failure';

function categories(message: string, extra: Parameters<typeof classifyFailure>[0] = {}) {
  return classifyFailure({ message, ...extra }).map((r) => r.category);
}

describe('failure classifier', () => {
  it('classifies stale refs', () => {
    expect(primaryFailureCategory({ message: 'Error: stale ref abc is no longer available' }).category).toBe('STALE_REF');
  });

  it('classifies missing elements', () => {
    expect(categories('selector failed: no matching element found')).toContain('ELEMENT_NOT_FOUND');
  });

  it('classifies navigation timeouts', () => {
    expect(primaryFailureCategory({ toolName: 'navigate', message: 'Navigation timeout of 30000 ms exceeded' }).category).toBe('NAVIGATION_TIMEOUT');
  });

  it('classifies tab and target failures', () => {
    expect(categories('invalid tab: no such tab')).toContain('TAB_UNHEALTHY');
    expect(categories('CDPSession connection closed')).toContain('CONNECTION_LOST');
  });

  it('classifies browser crashes', () => {
    const error = new Error('Target closed because the browser crash closed the renderer');
    error.name = 'TargetClosedError';
    expect(categories('', { error })).toContain('BROWSER_CRASH');
  });

  it('classifies auth-required access denied separately from WAF access denied', () => {
    expect(primaryFailureCategory({ message: 'Access denied: login session expired, please sign in' }).category).toBe('AUTH_REQUIRED');
    expect(primaryFailureCategory({ message: 'Access Denied reference from Akamai bot block' }).category).toBe('CAPTCHA_OR_WAF');
  });

  it('does not treat bare forbidden responses as auth-required', () => {
    expect(categories('403 Forbidden')).not.toContain('AUTH_REQUIRED');
    expect(primaryFailureCategory({ message: '403 Forbidden', fallbackToUnknown: false })).toBeUndefined();
    expect(categories('Forbidden: login session expired')).toContain('AUTH_REQUIRED');
  });

  it('classifies CAPTCHA and WAF blockers', () => {
    expect(categories('Cloudflare says verify you are human captcha detected')).toContain('CAPTCHA_OR_WAF');
  });

  it('maps progress tracker stuck hints to no progress and wandering', () => {
    const result = classifyFailure({ hintRule: 'progress-tracker-stuck', message: 'STOP — no meaningful progress, screenshot-verification-loop' });
    expect(result.map((r) => r.category)).toEqual(expect.arrayContaining(['NO_PROGRESS', 'LLM_WANDERING']));
  });

  it('classifies step budget and postcondition failures', () => {
    expect(categories('Reached the max number of 10 steps')).toContain('MAX_STEPS_EXCEEDED');
    expect(categories('postcondition_violation: oc_assert failed')).toContain('POSTCONDITION_FAILED');
  });

  it('falls back to UNKNOWN by default and can suppress fallback', () => {
    expect(classifyFailure({ message: 'some unrecognized failure' })).toEqual([
      { category: 'UNKNOWN', confidence: 0.5, reason: 'No failure classifier rule matched' },
    ]);
    expect(classifyFailure({ message: 'some unrecognized failure', fallbackToUnknown: false })).toEqual([]);
  });

  it('classifies protocol errors for missing DOM nodes as stale references, not connection loss', () => {
    const result = primaryFailureCategory({
      error: new Error('Protocol error (DOM.resolveNode): No node with given id found'),
      toolName: 'click',
    });

    expect(result.category).toBe('STALE_REF');
  });

  it('does not classify navigation context churn as connection loss', () => {
    expect(categories('Execution context was destroyed, most likely because of a navigation')).not.toContain('CONNECTION_LOST');
    expect(categories('Cannot find context with specified id')).not.toContain('CONNECTION_LOST');
    expect(categories('Inspected target navigated or closed')).not.toContain('CONNECTION_LOST');
  });

  it('keeps generic could-not-find runtime failures out of element-not-found', () => {
    expect(categories('Could not find expected browser (chrome) locally')).not.toContain('ELEMENT_NOT_FOUND');
    expect(categories('Could not find element for selector .submit')).toContain('ELEMENT_NOT_FOUND');
  });

});
