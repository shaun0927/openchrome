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
