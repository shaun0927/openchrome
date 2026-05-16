import { evaluateEpisodeClaimEligibility, requiredSamplesForScope } from './claim-eligibility';

describe('episode claim eligibility', () => {
  it('rejects mock smoke runs as diagnostic-only even when they pass', () => {
    const result = evaluateEpisodeClaimEligibility({
      mode: 'mock',
      scope: 'aggregate',
      sampleCount: 50,
      finalPostconditionEvaluated: true,
      competitorVersionsPinned: true,
      sameTaskContracts: true,
      llmSettingsPinned: true,
    });

    expect(result.eligible).toBe(false);
    expect(result.tier).toBe('diagnostic-only');
    expect(result.reasons.join('\n')).toMatch(/mock/);
  });

  it('requires aggregate and per-task sample thresholds', () => {
    expect(requiredSamplesForScope('aggregate')).toBe(10);
    expect(requiredSamplesForScope('per-task')).toBe(20);

    const aggregate = evaluateEpisodeClaimEligibility({
      mode: 'live',
      scope: 'aggregate',
      sampleCount: 9,
      finalPostconditionEvaluated: true,
      competitorVersionsPinned: true,
      sameTaskContracts: true,
      llmSettingsPinned: true,
    });
    const perTask = evaluateEpisodeClaimEligibility({
      mode: 'live',
      scope: 'per-task',
      sampleCount: 19,
      finalPostconditionEvaluated: true,
      competitorVersionsPinned: true,
      sameTaskContracts: true,
      llmSettingsPinned: true,
    });

    expect(aggregate.eligible).toBe(false);
    expect(perTask.eligible).toBe(false);
    expect(aggregate.reasons[0]).toMatch(/N >= 10/);
    expect(perTask.reasons[0]).toMatch(/N >= 20/);
  });

  it('approves a pinned live aggregate with enough final-contract samples', () => {
    const result = evaluateEpisodeClaimEligibility({
      mode: 'live',
      scope: 'aggregate',
      sampleCount: 10,
      finalPostconditionEvaluated: true,
      competitorVersionsPinned: true,
      sameTaskContracts: true,
      llmSettingsPinned: true,
    });

    expect(result).toEqual({
      eligible: true,
      tier: 'primary-realworld',
      reasons: [],
      requiredSamples: 10,
    });
  });
});
