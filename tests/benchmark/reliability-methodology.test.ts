/// <reference types="jest" />

import {
  MIN_REAL_WORLD_TASK_REPETITIONS,
  REAL_WORLD_RELIABILITY_PLAN,
  assertNoMockRowsPublishable,
  isPublishableReliabilityMeasurement,
} from './reliability-methodology';
import { MIN_FLAKY_SAMPLE_SIZE } from './reliability';

describe('REAL_WORLD_RELIABILITY_PLAN', () => {
  test('makes real-world task success the primary reliability metric', () => {
    expect(REAL_WORLD_RELIABILITY_PLAN.primaryMetric.id).toBe('real_world_task_success_rate');
    expect(REAL_WORLD_RELIABILITY_PLAN.primaryMetric.priority).toBe('primary');
    expect(REAL_WORLD_RELIABILITY_PLAN.primaryMetric.minimumSamples).toBe(MIN_REAL_WORLD_TASK_REPETITIONS);
    expect(REAL_WORLD_RELIABILITY_PLAN.secondaryMetrics.map((m) => m.id)).toContain('fault_recovery_stress_rate');
  });

  test('keeps isolated flaky rate as a guardrail with N >= 50', () => {
    const flaky = REAL_WORLD_RELIABILITY_PLAN.secondaryMetrics.find((m) => m.id === 'isolated_flaky_rate');
    expect(flaky?.priority).toBe('guardrail');
    expect(flaky?.minimumSamples).toBe(MIN_FLAKY_SAMPLE_SIZE);
  });

  test('records the follow-up GitHub issues created for #1259', () => {
    expect(REAL_WORLD_RELIABILITY_PLAN.followUpIssues.map((i) => i.issue).sort()).toEqual([1303, 1304]);
  });
});

describe('isPublishableReliabilityMeasurement', () => {
  test('rejects mock and live-unwired scaffold rows', () => {
    expect(
      isPublishableReliabilityMeasurement({
        measurementKind: 'mock_scaffold',
        liveDriver: false,
        samples: 50,
        flakyRate: 0,
        recoveryRate: 0.9,
      }),
    ).toBe(false);
    expect(
      isPublishableReliabilityMeasurement({
        measurementKind: 'live_unwired_skip',
        liveDriver: true,
        samples: 0,
        flakyRate: null,
        recoveryRate: null,
        skipReason: 'live cells not wired',
      }),
    ).toBe(false);
  });

  test('accepts only finite live measured rows with enough samples', () => {
    expect(
      isPublishableReliabilityMeasurement({
        measurementKind: 'fault_recovery_stress',
        liveDriver: true,
        samples: 10,
        flakyRate: 0.1,
        recoveryRate: 0.8,
      }),
    ).toBe(true);
    expect(
      isPublishableReliabilityMeasurement({
        measurementKind: 'fault_recovery_stress',
        liveDriver: true,
        samples: 9,
        flakyRate: 0.1,
        recoveryRate: 0.8,
      }),
    ).toBe(false);
  });

  test('assertNoMockRowsPublishable is a defensive no-op for current scaffold rows', () => {
    expect(() =>
      assertNoMockRowsPublishable([
        { measurementKind: 'mock_scaffold', liveDriver: false, samples: 50, flakyRate: 0, recoveryRate: 0.5 },
        { measurementKind: 'live_unwired_skip', liveDriver: true, samples: 0, flakyRate: null, recoveryRate: null },
      ]),
    ).not.toThrow();
  });

  test('assertNoMockRowsPublishable rejects any scaffold row flagged publishable', () => {
    expect(() =>
      assertNoMockRowsPublishable([
        { measurementKind: 'mock_scaffold', liveDriver: false, samples: 50, flakyRate: 0, recoveryRate: 0.5, publishable: true },
      ]),
    ).toThrow(/cannot be publishable/);
  });
});
