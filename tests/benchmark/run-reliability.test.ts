/// <reference types="jest" />

import { FAULT_TYPES } from './reliability';
import { RELIABILITY_LIBRARIES, runReliabilityMatrix } from './run-reliability';

describe('runReliabilityMatrix methodology guards', () => {
  test('mock matrix is explicitly scaffold-only and not publishable', () => {
    const rows = runReliabilityMatrix({ live: false, samplesPerCell: 3 });
    expect(rows).toHaveLength(RELIABILITY_LIBRARIES.length * FAULT_TYPES.length);
    expect(rows.every((r) => r.measurementKind === 'mock_scaffold')).toBe(true);
    expect(rows.every((r) => r.publishable === false)).toBe(true);
    expect(rows.every((r) => r.samples === 3)).toBe(true);
  });

  test('live-unwired matrix emits explicit skip rows with null numeric metrics', () => {
    const rows = runReliabilityMatrix({ live: true, samplesPerCell: 50 });
    expect(rows).toHaveLength(RELIABILITY_LIBRARIES.length * FAULT_TYPES.length);
    expect(rows.every((r) => r.measurementKind === 'live_unwired_skip')).toBe(true);
    expect(rows.every((r) => r.publishable === false)).toBe(true);
    expect(rows.every((r) => r.skipReason && r.skipReason.length > 0)).toBe(true);
    expect(rows.every((r) => r.samples === 0 && r.flakyRate === null && r.recoveryRate === null)).toBe(true);
  });
});
