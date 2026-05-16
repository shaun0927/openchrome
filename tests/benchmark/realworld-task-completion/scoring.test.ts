/// <reference types="jest" />

import { deterministicOpenChromeFixtureRuns } from './fixtures';
import { aggregateRealWorldMetrics, assertHonestMeasurement } from './scoring';
import type { RealWorldTaskRun } from './types';

describe('real-world task completion scoring', () => {
  test('aggregates success, first-attempt, recovery, and cost metrics', () => {
    const runs = deterministicOpenChromeFixtureRuns();
    const [metrics] = aggregateRealWorldMetrics(runs);
    expect(metrics.library).toBe('openchrome');
    expect(metrics.mode).toBe('deterministic-fixture');
    expect(metrics.totalRuns).toBe(5);
    expect(metrics.successRate).toBe(1);
    expect(metrics.firstAttemptSuccessRate).toBe(4 / 5);
    expect(metrics.recoverySuccessRate).toBe(1);
    expect(metrics.meanTokens).toBeNull();
    expect(metrics.costPerSuccessUsd).toBeNull();
  });

  test('honesty guard rejects deterministic rows with token/cost claims', () => {
    const bad: RealWorldTaskRun = { ...deterministicOpenChromeFixtureRuns()[0], tokens: 100 };
    expect(() => assertHonestMeasurement([bad])).toThrow(/must not claim token or cost/);
  });

  test('honesty guard requires deterministic notes to say deterministic', () => {
    const bad: RealWorldTaskRun = { ...deterministicOpenChromeFixtureRuns()[0], notes: 'local row' };
    expect(() => assertHonestMeasurement([bad])).toThrow(/identify itself/);
  });
});
