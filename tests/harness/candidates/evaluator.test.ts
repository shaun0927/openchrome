/// <reference types="jest" />

import { buildReport } from './evaluator';

describe('harness candidate evaluator', () => {
  test('scores at least two candidates across at least three scenarios', () => {
    const report = buildReport();
    expect(report.version).toBe(1);
    expect(report.candidates.length).toBeGreaterThanOrEqual(2);
    expect(report.scenarios.length).toBeGreaterThanOrEqual(3);
    expect(report.scores.length).toBe(report.candidates.length * report.scenarios.length);
  });

  test('rejects unsafe destructive candidates', () => {
    const report = buildReport();
    expect(report.rejected.some((entry) => entry.candidateId === 'force-click-delete' && /destructive|safety/i.test(entry.reason))).toBe(true);
    expect(report.recommended.some((entry) => entry.candidateId === 'force-click-delete')).toBe(false);
  });

  test('selection is deterministic for the same inputs', () => {
    const a = buildReport();
    const b = buildReport();
    expect({ recommended: a.recommended, rejected: a.rejected, best: a.bestPerFailureFamily }).toEqual({ recommended: b.recommended, rejected: b.rejected, best: b.bestPerFailureFamily });
  });
});
