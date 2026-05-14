/// <reference types="jest" />

import {
  computeFlakyRate,
  aggregateRecoveryRate,
  summarizeStability,
  MIN_FLAKY_SAMPLE_SIZE,
  RecoveryRecord,
  StabilitySample,
} from './reliability';

describe('computeFlakyRate', () => {
  test('a perfectly deterministic run has flaky rate 0', () => {
    const allPass = computeFlakyRate(Array(60).fill(true));
    expect(allPass.flakyRate).toBe(0);
    expect(allPass.successRate).toBe(1);

    const allFail = computeFlakyRate(Array(60).fill(false));
    expect(allFail.flakyRate).toBe(0);
    expect(allFail.successRate).toBe(0);
  });

  test('a 50/50 split is maximally flaky', () => {
    const outcomes = [...Array(30).fill(true), ...Array(30).fill(false)];
    const result = computeFlakyRate(outcomes);
    expect(result.flakyRate).toBeCloseTo(0.5);
    expect(result.modeOutcomeCount).toBe(30);
  });

  test('mostly-passing run has a small flaky rate', () => {
    const outcomes = [...Array(57).fill(true), ...Array(3).fill(false)];
    const result = computeFlakyRate(outcomes);
    expect(result.n).toBe(60);
    expect(result.successCount).toBe(57);
    expect(result.flakyRate).toBeCloseTo(3 / 60);
  });

  test('enforces the >= 50 sample minimum by default', () => {
    expect(() => computeFlakyRate(Array(20).fill(true))).toThrow(
      new RegExp(`>= ${MIN_FLAKY_SAMPLE_SIZE} samples`),
    );
  });

  test('minSamples override allows direct arithmetic tests', () => {
    const result = computeFlakyRate([true, false, true], { minSamples: 1 });
    expect(result.n).toBe(3);
    expect(result.flakyRate).toBeCloseTo(1 / 3);
  });
});

describe('aggregateRecoveryRate', () => {
  test('computes per-fault-type recovery rate', () => {
    const records: RecoveryRecord[] = [
      { faultType: 'stale-selector', recovered: true, stepsToRecover: 2, timeToRecoverMs: 100 },
      { faultType: 'stale-selector', recovered: true, stepsToRecover: 4, timeToRecoverMs: 300 },
      { faultType: 'stale-selector', recovered: false },
      { faultType: 'tab-crash', recovered: false },
      { faultType: 'tab-crash', recovered: false },
    ];
    const agg = aggregateRecoveryRate(records);
    const stale = agg.find((a) => a.faultType === 'stale-selector')!;
    expect(stale.injected).toBe(3);
    expect(stale.recovered).toBe(2);
    expect(stale.recoveryRate).toBeCloseTo(2 / 3);
    expect(stale.meanStepsToRecover).toBe(3);
    expect(stale.meanTimeToRecoverMs).toBe(200);

    const crash = agg.find((a) => a.faultType === 'tab-crash')!;
    expect(crash.recoveryRate).toBe(0);
    expect(crash.meanStepsToRecover).toBeNull();
  });

  test('a competitor that always throws yields recoveryRate 0, not an error', () => {
    const records: RecoveryRecord[] = [
      { faultType: 'network-drop', recovered: false },
      { faultType: 'network-drop', recovered: false },
    ];
    const agg = aggregateRecoveryRate(records);
    expect(agg).toHaveLength(1);
    expect(agg[0].recoveryRate).toBe(0);
  });

  test('only fault types present in the input are returned', () => {
    const agg = aggregateRecoveryRate([{ faultType: 'cdp-drop', recovered: true }]);
    expect(agg.map((a) => a.faultType)).toEqual(['cdp-drop']);
  });

  test('empty input yields no rows', () => {
    expect(aggregateRecoveryRate([])).toEqual([]);
  });
});

describe('summarizeStability', () => {
  test('a flat RSS series shows no leak', () => {
    const samples: StabilitySample[] = [
      { tMs: 0, rssBytes: 100_000_000 },
      { tMs: 30_000, rssBytes: 101_000_000 },
      { tMs: 60_000, rssBytes: 100_500_000 },
    ];
    const summary = summarizeStability(samples);
    expect(summary.suspectedLeak).toBe(false);
    expect(Math.abs(summary.rssGrowthRatio)).toBeLessThan(0.5);
  });

  test('a steadily growing RSS series is flagged as a suspected leak', () => {
    const samples: StabilitySample[] = Array.from({ length: 10 }, (_, i) => ({
      tMs: i * 60_000,
      rssBytes: 100_000_000 + i * 20_000_000, // +20MB every minute
    }));
    const summary = summarizeStability(samples);
    expect(summary.suspectedLeak).toBe(true);
    expect(summary.rssSlopeBytesPerSec).toBeGreaterThan(0);
    expect(summary.rssGrowthRatio).toBeCloseTo(1.8);
  });

  test('sorts unordered samples before computing duration', () => {
    const summary = summarizeStability([
      { tMs: 60_000, rssBytes: 100_000_000 },
      { tMs: 0, rssBytes: 100_000_000 },
    ]);
    expect(summary.durationMs).toBe(60_000);
  });

  test('requires at least two samples', () => {
    expect(() => summarizeStability([{ tMs: 0, rssBytes: 1 }])).toThrow(/at least 2 samples/);
  });
});
