import type { EpisodeResult } from './types';

export type EpisodeMeasurementMode = 'mock' | 'scaffold' | 'dry-run' | 'skip' | 'recorded-real' | 'live';
export type EpisodeClaimScope = 'aggregate' | 'per-task';

export interface EpisodeClaimEligibilityInput {
  mode: EpisodeMeasurementMode;
  scope: EpisodeClaimScope;
  sampleCount: number;
  finalPostconditionEvaluated: boolean;
  competitorVersionsPinned: boolean;
  sameTaskContracts: boolean;
  llmSettingsPinned?: boolean;
  results?: readonly EpisodeResult[];
}

export interface EpisodeClaimEligibility {
  eligible: boolean;
  tier: 'primary-realworld' | 'diagnostic-only';
  reasons: string[];
  requiredSamples: number;
}

const HEADLINE_MODES: readonly EpisodeMeasurementMode[] = ['recorded-real', 'live'];

export function requiredSamplesForScope(scope: EpisodeClaimScope): number {
  return scope === 'per-task' ? 20 : 10;
}

export function evaluateEpisodeClaimEligibility(input: EpisodeClaimEligibilityInput): EpisodeClaimEligibility {
  const reasons: string[] = [];
  const requiredSamples = requiredSamplesForScope(input.scope);

  if (!HEADLINE_MODES.includes(input.mode)) {
    reasons.push(`measurement mode ${input.mode} is not headline-eligible; use live or recorded-real`);
  }
  if (input.sampleCount < requiredSamples) {
    reasons.push(`sample count ${input.sampleCount} is below ${input.scope} threshold N >= ${requiredSamples}`);
  }
  if (!input.finalPostconditionEvaluated) {
    reasons.push('final task postcondition was not evaluated');
  }
  if (!input.competitorVersionsPinned) {
    reasons.push('competitor/library versions are not pinned');
  }
  if (!input.sameTaskContracts) {
    reasons.push('same task contracts were not used for every compared library');
  }
  if (input.llmSettingsPinned === false) {
    reasons.push('LLM model/settings/budgets are not pinned');
  }
  if (input.results && input.results.some(result => !result.success && result.status === 'passed')) {
    reasons.push('at least one passed row does not carry success=true');
  }

  return {
    eligible: reasons.length === 0,
    tier: reasons.length === 0 ? 'primary-realworld' : 'diagnostic-only',
    reasons,
    requiredSamples,
  };
}
