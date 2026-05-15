/// <reference types="jest" />

import {
  EXECUTION_MODES,
  AGGREGATE_MIN_N,
  PER_TASK_MIN_N,
  gateClaim,
  bootstrapPassRateCi95,
} from './execution-mode';

describe('execution-mode constants', () => {
  test('exposes native + passive in stable order; native is the headline', () => {
    expect(EXECUTION_MODES).toEqual(['native', 'passive']);
  });

  test('per-task threshold is the issue-mandated N>=20; aggregate is N>=10', () => {
    expect(PER_TASK_MIN_N).toBe(20);
    expect(AGGREGATE_MIN_N).toBe(10);
  });
});

describe('gateClaim', () => {
  test('aggregate claim with N>=10 is allowed', () => {
    const g = gateClaim('aggregate', 10);
    expect(g.allowed).toBe(true);
    expect(g.annotation).toBe('');
  });

  test('aggregate claim with N<10 is flagged underpowered', () => {
    const g = gateClaim('aggregate', 5);
    expect(g.allowed).toBe(false);
    expect(g.annotation).toContain('underpowered');
    expect(g.annotation).toContain('N=5');
    expect(g.annotation).toContain('10');
    expect(g.annotation).toContain('aggregate');
  });

  test('per-task claim demands N>=20, not 10', () => {
    expect(gateClaim('per-task', 19).allowed).toBe(false);
    expect(gateClaim('per-task', 20).allowed).toBe(true);
  });

  test('rejects fractional or negative sample counts', () => {
    expect(() => gateClaim('aggregate', 1.5)).toThrow(/sampleCount/);
    expect(() => gateClaim('aggregate', -1)).toThrow(/sampleCount/);
  });
});

describe('bootstrapPassRateCi95', () => {
  test('all-pass outcomes yield a [1, 1] CI', () => {
    const ci = bootstrapPassRateCi95(Array.from({ length: 20 }, () => true));
    expect(ci[0]).toBe(1);
    expect(ci[1]).toBe(1);
  });

  test('all-fail outcomes yield a [0, 0] CI', () => {
    const ci = bootstrapPassRateCi95(Array.from({ length: 20 }, () => false));
    expect(ci[0]).toBe(0);
    expect(ci[1]).toBe(0);
  });

  test('a 50/50 sample produces a CI that brackets 0.5', () => {
    const outcomes = Array.from({ length: 30 }, (_, i) => i % 2 === 0);
    const [lo, hi] = bootstrapPassRateCi95(outcomes);
    expect(lo).toBeLessThan(0.6);
    expect(hi).toBeGreaterThan(0.4);
  });

  test('is deterministic with a seeded RNG', () => {
    const outcomes = [true, false, true, true, false, true, false, true, true, true];
    const a = bootstrapPassRateCi95(outcomes, 500, 17);
    const b = bootstrapPassRateCi95(outcomes, 500, 17);
    expect(a).toEqual(b);
  });

  test('handles an empty sample without throwing', () => {
    expect(bootstrapPassRateCi95([])).toEqual([0, 0]);
  });
});
