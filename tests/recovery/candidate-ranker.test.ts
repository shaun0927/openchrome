import { rankRecoveryCandidates } from '../../src/recovery';

describe('rankRecoveryCandidates', () => {
  it('ranks fresh read_page first for stale refs', () => {
    const candidates = rankRecoveryCandidates({
      toolName: 'interact',
      resultText: 'Error: ref is stale and no longer available',
      isError: true,
      recentCalls: [
        { toolName: 'interact', result: 'error', error: 'ref is stale' },
        { toolName: 'interact', result: 'error', error: 'ref is stale' },
      ],
    });

    expect(candidates[0].tool).toBe('read_page');
    expect(candidates[0].risk).toBe('read_only');
    expect(candidates.find((c) => c.tool === 'interact')?.score ?? -1).toBeLessThan(candidates[0].score);
  });

  it('excludes blind retries on blocking/auth pages', () => {
    const candidates = rankRecoveryCandidates({
      toolName: 'click',
      resultText: 'CAPTCHA Access Denied Login page detected',
      isError: false,
      recentCalls: [{ toolName: 'click', result: 'success', error: 'Login page detected' }],
    });

    expect(candidates[0].tool).toBe('read_page');
    const blocked = candidates.find((c) => c.tool === 'click');
    expect(blocked?.blockedReason).toBe('blocking/auth signal present');
  });


  it('does not block read-only retries on blocking pages', () => {
    const candidates = rankRecoveryCandidates({
      toolName: 'find',
      resultText: 'Login page detected',
      isError: false,
      recentCalls: [{ toolName: 'find', result: 'success', error: 'Login page detected' }],
    });

    expect(candidates.find((c) => c.tool === 'find')).toBeUndefined();
    expect(candidates.every((c) => !c.blockedReason)).toBe(true);
    expect(candidates.map((c) => c.tool)).toEqual(expect.arrayContaining(['read_page', 'tabs_context']));
  });

  it('penalizes repeated failures without counting prior successes', () => {
    const mostlySuccessful = rankRecoveryCandidates({
      toolName: 'interact',
      resultText: 'Error: ref is stale',
      isError: true,
      recentCalls: [
        { toolName: 'interact', result: 'success' },
        { toolName: 'interact', result: 'success' },
        { toolName: 'interact', result: 'error', error: 'ref is stale' },
      ],
    });
    const repeatedlyFailing = rankRecoveryCandidates({
      toolName: 'interact',
      resultText: 'Error: ref is stale',
      isError: true,
      recentCalls: [
        { toolName: 'interact', result: 'error', error: 'ref is stale' },
        { toolName: 'interact', result: 'error', error: 'ref is stale' },
        { toolName: 'interact', result: 'error', error: 'ref is stale' },
      ],
    });

    expect(mostlySuccessful[0].score).toBeGreaterThan(repeatedlyFailing[0].score);
  });

  it('falls back to read-only state checks for ambiguous no-progress loops', () => {
    const candidates = rankRecoveryCandidates({
      toolName: 'wait_for',
      resultText: 'same state',
      isError: false,
      recentCalls: [
        { toolName: 'wait_for', result: 'success' },
        { toolName: 'read_page', result: 'success' },
      ],
    });

    expect(candidates.every((c) => c.risk === 'read_only')).toBe(true);
    expect(candidates.map((c) => c.tool)).toContain('tabs_context');
  });
});
