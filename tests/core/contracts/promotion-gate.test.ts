/// <reference types="jest" />

/**
 * Tests for the schema_diff-based promotion gate (B1-PR3 of #1359).
 */

import {
  shouldPromoteFromSchemaDiff,
} from '../../../src/core/contracts/promotion-gate';
import type { SchemaDiff } from '../../../src/core/contracts/schema-diff';

function diff(over: Partial<SchemaDiff> = {}): SchemaDiff {
  return {
    matched: [],
    missing: [],
    extra: [],
    typeMismatch: [],
    coverage: 1,
    ...over,
  };
}

describe('shouldPromoteFromSchemaDiff — defaults', () => {
  test('full coverage and no mismatches → eligible with "pass" reason', () => {
    const d = shouldPromoteFromSchemaDiff(diff({ coverage: 1 }));
    expect(d.eligible).toBe(true);
    expect(d.reasons).toEqual([{ kind: 'pass' }]);
    expect(d.coverage).toBe(1);
    expect(d.threshold.minCoverage).toBe(0.8);
  });

  test('coverage exactly at default bar (0.8) passes', () => {
    const d = shouldPromoteFromSchemaDiff(diff({ coverage: 0.8 }));
    expect(d.eligible).toBe(true);
  });

  test('coverage below default bar (0.79) blocks with coverage_below_bar', () => {
    const d = shouldPromoteFromSchemaDiff(diff({ coverage: 0.79 }));
    expect(d.eligible).toBe(false);
    expect(d.reasons).toContainEqual({
      kind: 'coverage_below_bar',
      coverage: 0.79,
      required: 0.8,
    });
  });

  test('any type mismatch blocks under defaults', () => {
    const d = shouldPromoteFromSchemaDiff(
      diff({
        coverage: 1,
        typeMismatch: [{ field: 'statusCode', expected: 'number', got: 'string' }],
      }),
    );
    expect(d.eligible).toBe(false);
    expect(d.reasons).toContainEqual({
      kind: 'type_mismatch_present',
      count: 1,
      max: 0,
      fields: ['statusCode'],
    });
  });

  test('default does not block on missing fields when coverage clears the bar', () => {
    // Missing one optional field doesn't reduce coverage; but missing one
    // required field does. Here we simulate "coverage stays at 0.9 with
    // missing[]" — defaults allow it through.
    const d = shouldPromoteFromSchemaDiff(diff({ coverage: 0.9, missing: ['preview'] }));
    expect(d.eligible).toBe(true);
  });
});

describe('shouldPromoteFromSchemaDiff — strict options', () => {
  test('requireZeroMissing blocks when missing is non-empty', () => {
    const d = shouldPromoteFromSchemaDiff(
      diff({ coverage: 1, missing: ['description'] }),
      { requireZeroMissing: true },
    );
    expect(d.eligible).toBe(false);
    expect(d.reasons).toContainEqual({
      kind: 'missing_required_fields',
      fields: ['description'],
    });
  });

  test('minCoverage = 1 requires perfect match', () => {
    expect(
      shouldPromoteFromSchemaDiff(diff({ coverage: 0.95 }), { minCoverage: 1 }).eligible,
    ).toBe(false);
    expect(
      shouldPromoteFromSchemaDiff(diff({ coverage: 1 }), { minCoverage: 1 }).eligible,
    ).toBe(true);
  });

  test('maxTypeMismatch = 2 allows up to 2 mismatches', () => {
    const twoMismatches = diff({
      coverage: 1,
      typeMismatch: [
        { field: 'a', expected: 'number', got: 'string' },
        { field: 'b', expected: 'boolean', got: 'number' },
      ],
    });
    expect(
      shouldPromoteFromSchemaDiff(twoMismatches, { maxTypeMismatch: 2 }).eligible,
    ).toBe(true);
  });
});

describe('shouldPromoteFromSchemaDiff — option clamping', () => {
  test('minCoverage clamps to [0, 1]', () => {
    expect(shouldPromoteFromSchemaDiff(diff({ coverage: 0 }), { minCoverage: -5 }).threshold.minCoverage).toBe(0);
    expect(shouldPromoteFromSchemaDiff(diff({ coverage: 1 }), { minCoverage: 5 }).threshold.minCoverage).toBe(1);
  });

  test('maxTypeMismatch clamps to >= 0 and floors', () => {
    expect(
      shouldPromoteFromSchemaDiff(diff(), { maxTypeMismatch: -3 }).threshold.maxTypeMismatch,
    ).toBe(0);
    expect(
      shouldPromoteFromSchemaDiff(diff(), { maxTypeMismatch: 2.7 }).threshold.maxTypeMismatch,
    ).toBe(2);
  });

  test('NaN / non-finite options fall back to defaults', () => {
    const d = shouldPromoteFromSchemaDiff(diff(), {
      minCoverage: Number.NaN,
      maxTypeMismatch: Number.POSITIVE_INFINITY as unknown as number,
    });
    expect(d.threshold.minCoverage).toBe(0.8);
    expect(d.threshold.maxTypeMismatch).toBe(0);
  });
});

describe('shouldPromoteFromSchemaDiff — determinism', () => {
  test('repeated evaluations on the same diff produce structurally identical output', () => {
    const d1 = shouldPromoteFromSchemaDiff(
      diff({ coverage: 0.75, missing: ['x', 'y'] }),
    );
    const d2 = shouldPromoteFromSchemaDiff(
      diff({ coverage: 0.75, missing: ['x', 'y'] }),
    );
    expect(JSON.stringify(d1)).toBe(JSON.stringify(d2));
  });
});

describe('shouldPromoteFromSchemaDiff — multiple reasons', () => {
  test('blocking reasons accumulate (no short-circuit) — caller sees full diagnosis', () => {
    const d = shouldPromoteFromSchemaDiff(
      diff({
        coverage: 0.5,
        missing: ['statusCode'],
        typeMismatch: [{ field: 'title', expected: 'string', got: 'number' }],
      }),
      { requireZeroMissing: true },
    );
    expect(d.eligible).toBe(false);
    const kinds = d.reasons.map((r) => r.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'coverage_below_bar',
        'type_mismatch_present',
        'missing_required_fields',
      ]),
    );
  });
});
