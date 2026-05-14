import { scoreRecoveryOutcome } from '../../src/recovery';

describe('scoreRecoveryOutcome', () => {
  it('treats contract pass as strongest positive evidence', () => {
    const score = scoreRecoveryOutcome({
      toolName: 'oc_assert',
      contractPassed: true,
      isError: true,
      errorText: 'element not found',
    });

    expect(score.classification).toBe('contract_pass');
    expect(score.score).toBe(1);
    expect(score.confidence).toBe(1);
  });

  it('scores DOM, URL, and extracted data as progress', () => {
    const score = scoreRecoveryOutcome({
      toolName: 'click',
      urlChanged: true,
      domChanged: true,
      dataItemsExtracted: 2,
    });

    expect(score.classification).toBe('progress');
    expect(score.score).toBeGreaterThan(0.5);
    expect(score.reasons).toContain('url changed');
    expect(score.reasons).toContain('dom changed');
  });

  it('penalizes repeated no-progress observations', () => {
    const first = scoreRecoveryOutcome({ toolName: 'read_page', resultText: 'same page', observationOnly: true });
    const repeated = scoreRecoveryOutcome({
      toolName: 'read_page',
      resultText: 'same page',
      observationOnly: true,
      repeatedNoProgressCount: 4,
    });

    expect(first.classification).toBe('observation');
    expect(repeated.classification).toBe('no_progress');
    expect(repeated.score).toBeLessThan(first.score);
  });

  it('classifies stale refs, timeouts, and blocking pages as negative outcomes', () => {
    expect(scoreRecoveryOutcome({ toolName: 'click', isError: true, errorText: 'ref is stale' }).classification).toBe('failure');
    expect(scoreRecoveryOutcome({ toolName: 'navigate', errorText: 'Navigation timeout' }).classification).toBe('failure');
    expect(scoreRecoveryOutcome({ toolName: 'click', resultText: 'CAPTCHA Access Denied' }).classification).toBe('blocked');
  });

  it('blocks ungated destructive actions with a hard negative score', () => {
    const score = scoreRecoveryOutcome({ toolName: 'click', destructiveUngated: true });

    expect(score.classification).toBe('destructive_blocked');
    expect(score.score).toBe(-1);
  });



  it('scores recovery via fresh read above repeating the same failed action', () => {
    const repeatedFailure = scoreRecoveryOutcome({
      toolName: 'interact',
      isError: true,
      errorText: 'STALE_REF: element not found',
      repeatedFailureCount: 1,
    });
    const freshReadRecovery = scoreRecoveryOutcome({
      toolName: 'read_page',
      resultText: '[ref_1] Submit button',
      observationOnly: true,
      freshRefsDiscovered: true,
    });

    expect(repeatedFailure.classification).toBe('failure');
    expect(freshReadRecovery.classification).toBe('progress');
    expect(freshReadRecovery.score).toBeGreaterThan(repeatedFailure.score);
    expect(freshReadRecovery.reasons).toContain('fresh actionable refs discovered');
  });

  it('handles missing evidence deterministically', () => {
    const a = scoreRecoveryOutcome({ toolName: 'unknown_tool' });
    const b = scoreRecoveryOutcome({ toolName: 'unknown_tool' });

    expect(a).toEqual(b);
    expect(a.classification).toBe('no_progress');
  });
});
