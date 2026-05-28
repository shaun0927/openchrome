/**
 * Tests for the early-stop policy (#1428 Part 2).
 */
import {
  DEFAULT_PLATEAU_STEPS,
  DEFAULT_MIN_P_FOR_STOP,
  recommendEarlyStop,
} from '../../../src/core/task-ledger/early-stop';
import type { MarginalUtilitySummary } from '../../../src/core/task-ledger/marginal-utility';

function summary(overrides: Partial<MarginalUtilitySummary>): MarginalUtilitySummary {
  return {
    last_p: 0.5,
    mean_delta_per_step: 0,
    consecutive_low_delta: 0,
    ...overrides,
  };
}

describe('recommendEarlyStop', () => {
  it('does not recommend stop while last_p is below the minimum', () => {
    const r = recommendEarlyStop(summary({ last_p: 0.4, consecutive_low_delta: 99 }));
    expect(r.should_stop).toBe(false);
    expect(r.reason).toMatch(/last_p=0.400 below/);
  });

  it('does not recommend stop while the plateau has not been reached', () => {
    const r = recommendEarlyStop(
      summary({ last_p: 0.9, consecutive_low_delta: DEFAULT_PLATEAU_STEPS - 1 }),
    );
    expect(r.should_stop).toBe(false);
    expect(r.reason).toMatch(/consecutive_low_delta=/);
  });

  it('recommends stop when both conditions hold', () => {
    const r = recommendEarlyStop(
      summary({ last_p: 0.95, consecutive_low_delta: DEFAULT_PLATEAU_STEPS }),
    );
    expect(r.should_stop).toBe(true);
    expect(r.reason).toMatch(/plateau reached/);
  });

  it('uses explicit policy values when provided', () => {
    const r = recommendEarlyStop(
      summary({ last_p: 0.6, consecutive_low_delta: 3 }),
      { min_p_for_stop: 0.5, plateau_steps: 3 },
    );
    expect(r.should_stop).toBe(true);
    expect(r.policy.min_p_for_stop).toBe(0.5);
    expect(r.policy.plateau_steps).toBe(3);
  });

  it('falls back to defaults on invalid policy fields', () => {
    const r = recommendEarlyStop(
      summary({ last_p: 1, consecutive_low_delta: DEFAULT_PLATEAU_STEPS }),
      { min_p_for_stop: -1, plateau_steps: 0 },
    );
    expect(r.policy.min_p_for_stop).toBe(DEFAULT_MIN_P_FOR_STOP);
    expect(r.policy.plateau_steps).toBe(DEFAULT_PLATEAU_STEPS);
  });

  it('refuses to recommend stop on a non-finite last_p', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = recommendEarlyStop(
        summary({ last_p: bad, consecutive_low_delta: 999 }),
      );
      expect(r.should_stop).toBe(false);
      expect(r.reason).toMatch(/not finite/);
    }
  });

  it('is pure — same input yields the same output', () => {
    const input = summary({ last_p: 0.9, consecutive_low_delta: 11 });
    const a = recommendEarlyStop(input);
    const b = recommendEarlyStop(input);
    expect(a).toEqual(b);
  });
});
