/// <reference types="jest" />

import { buildReport, assertReportPasses } from './run-certification';
import { REQUIRED_SCENARIOS } from './scenarios';
import type { HarnessCertificationThresholds } from './types';

const thresholds: HarnessCertificationThresholds = {
  globalTimeoutMs: 60000,
  scenarioTimeoutMs: 10000,
  maxNonProgressCalls: 3,
  maxStuckEvents: 1,
  maxP99ToolLatencyMs: 5000,
  maxToolCalls: 12,
};

describe('harness certification report', () => {
  test('contains every required scenario and metric field', () => {
    const report = buildReport(thresholds, new Date('2026-05-13T00:00:00.000Z'));
    expect(report.version).toBe(1);
    expect(report.scenarios.map((scenario) => scenario.scenario).sort()).toEqual([...REQUIRED_SCENARIOS].sort());
    for (const scenario of report.scenarios) {
      expect(typeof scenario.success).toBe('boolean');
      expect(typeof scenario.toolCalls).toBe('number');
      expect(typeof scenario.nonProgressCalls).toBe('number');
      expect(typeof scenario.durationMs).toBe('number');
      expect(scenario.thresholds.scenarioTimeoutMs).toBe(thresholds.scenarioTimeoutMs);
      expect(Array.isArray(scenario.hints)).toBe(true);
      expect(Array.isArray(scenario.toolTrace)).toBe(true);
    }
  });

  test('stale-ref scenario records bounded recovery success', () => {
    const report = buildReport(thresholds, new Date('2026-05-13T00:00:00.000Z'));
    const stale = report.scenarios.find((scenario) => scenario.scenario === 'stale-ref-recovery');
    expect(stale?.recoveryAttempts).toBeGreaterThanOrEqual(1);
    expect(stale?.recoverySucceeded).toBe(true);
    expect(stale?.nonProgressCalls).toBeLessThanOrEqual(thresholds.maxNonProgressCalls);
  });

  test('blocked page emits warning or critical hint', () => {
    const report = buildReport(thresholds, new Date('2026-05-13T00:00:00.000Z'));
    const blocked = report.scenarios.find((scenario) => scenario.scenario === 'blocked-page-detection');
    expect(blocked?.hints.some((hint) => hint.severity === 'warning' || hint.severity === 'critical')).toBe(true);
  });

  test('strict thresholds fail certification', () => {
    const report = buildReport({ ...thresholds, maxNonProgressCalls: 0 }, new Date('2026-05-13T00:00:00.000Z'));
    expect(() => assertReportPasses(report)).toThrow(/certification failed/);
  });

  test('scenarioTimeoutMs participates in scenario verdicts', () => {
    const report = buildReport({ ...thresholds, scenarioTimeoutMs: 1 }, new Date('2026-05-13T00:00:00.000Z'));
    expect(report.scenarios.some((scenario) => scenario.failureReason?.includes('durationMs'))).toBe(true);
    expect(() => assertReportPasses(report)).toThrow(/durationMs/);
  });
});
