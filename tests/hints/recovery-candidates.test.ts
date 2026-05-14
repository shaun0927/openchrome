import { rankRecoveryCandidates } from '../../src/hints/recovery-candidates';

describe('rankRecoveryCandidates', () => {
  it('ranks fresh read_page first for stale refs and down-ranks the repeated tool', () => {
    const candidates = rankRecoveryCandidates({
      toolName: 'interact',
      resultText: 'STALE_REF: element not found for ref_1',
      isError: true,
      recentCalls: [{ toolName: 'interact', args: { ref: 'ref_1' }, result: 'error' } as any],
    });

    expect(candidates[0]).toMatchObject({ tool: 'read_page', risk: 'read_only' });
    expect(candidates.find(c => c.tool === 'interact')?.score).toBeLessThan(candidates[0].score);
  });

  it('filters blocking pages to read-only classification candidates', () => {
    const candidates = rankRecoveryCandidates({
      toolName: 'click',
      resultText: 'CAPTCHA Access Denied',
      isError: true,
      recentCalls: [],
    });

    expect(candidates.map(c => c.tool)).toEqual(['read_page', 'tabs_context']);
    expect(candidates.every(c => c.risk === 'read_only')).toBe(true);
  });

  it('orders read-only candidates before side-effect possible candidates', () => {
    const candidates = rankRecoveryCandidates({
      toolName: 'interact',
      resultText: 'timeout waiting for page ready',
      isError: true,
      recentCalls: [{ toolName: 'interact', result: 'error' } as any],
    });

    expect(candidates[0].risk).toBe('read_only');
  });
});
