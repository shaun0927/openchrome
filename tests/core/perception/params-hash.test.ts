/**
 * Unit tests for the canonical params hash (#879 / PR #929).
 *
 * The hash powers cache-key identity in `SnapshotCache`. It must satisfy:
 *   - Stability across calls (deterministic).
 *   - Reorder invariance (object key order does not change the hash).
 *   - Volatile-field stripping via the allow-list API
 *     (`paramsHashFromArgs(args, allowList)`).
 *   - Defensive handling of `undefined`, `null`, NaN, nested objects, and
 *     arrays.
 *   - 64-character lowercase hex output.
 */

import {
  paramsHash,
  paramsHashFromArgs,
  READ_PAGE_PARAMS,
  FIND_PARAMS,
  QUERY_DOM_PARAMS,
} from '../../../src/core/perception/params-hash';

describe('paramsHash — output shape', () => {
  test('returns 64-character lowercase hex', () => {
    const h = paramsHash({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('empty object hashes to a stable value', () => {
    expect(paramsHash({})).toBe(paramsHash({}));
  });
});

describe('paramsHash — invariant: stability', () => {
  test('identical inputs produce identical hashes', () => {
    const a = paramsHash({ mode: 'ax', limit: 10 });
    const b = paramsHash({ mode: 'ax', limit: 10 });
    expect(a).toBe(b);
  });

  test('different inputs produce different hashes', () => {
    expect(paramsHash({ mode: 'ax' })).not.toBe(paramsHash({ mode: 'dom' }));
    expect(paramsHash({ limit: 10 })).not.toBe(paramsHash({ limit: 11 }));
  });
});

describe('paramsHash — invariant: reorder invariance', () => {
  test('object key order does not change the hash', () => {
    const ab = paramsHash({ a: 1, b: 2 });
    const ba = paramsHash({ b: 2, a: 1 });
    expect(ab).toBe(ba);
  });

  test('nested object key order does not change the hash', () => {
    const left = paramsHash({ outer: { x: 1, y: 2 }, list: [{ p: 1, q: 2 }] });
    const right = paramsHash({ list: [{ q: 2, p: 1 }], outer: { y: 2, x: 1 } });
    expect(left).toBe(right);
  });

  test('array order DOES matter (lists are positional)', () => {
    expect(paramsHash([1, 2, 3])).not.toBe(paramsHash([3, 2, 1]));
  });
});

describe('paramsHash — defensive coercions', () => {
  test('undefined fields are dropped (must not affect identity)', () => {
    const without = paramsHash({ a: 1 });
    const withU = paramsHash({ a: 1, b: undefined });
    expect(without).toBe(withU);
  });

  test('null is preserved (distinct from undefined)', () => {
    expect(paramsHash({ a: null })).not.toBe(paramsHash({}));
  });

  test('NaN coerces to null (canonical JSON disallows NaN)', () => {
    expect(paramsHash({ a: NaN })).toBe(paramsHash({ a: null }));
  });

  test('Infinity coerces to null', () => {
    expect(paramsHash({ a: Infinity })).toBe(paramsHash({ a: null }));
    expect(paramsHash({ a: -Infinity })).toBe(paramsHash({ a: null }));
  });

  test('boolean and string round-trip', () => {
    expect(paramsHash({ a: true })).not.toBe(paramsHash({ a: false }));
    expect(paramsHash({ a: 'x' })).not.toBe(paramsHash({ a: 'y' }));
  });
});

describe('paramsHashFromArgs — allow-list filtering', () => {
  test('only the allow-listed fields participate', () => {
    const allow = ['mode', 'limit'] as const;
    const a = paramsHashFromArgs({ mode: 'ax', limit: 10, trace_id: 'one' }, allow);
    const b = paramsHashFromArgs({ mode: 'ax', limit: 10, trace_id: 'TWO' }, allow);
    // trace_id is NOT in the allow-list, so the two hashes must match.
    expect(a).toBe(b);
  });

  test('missing optional fields do not appear in the canonical form', () => {
    const allow = ['mode', 'limit'] as const;
    const a = paramsHashFromArgs({ mode: 'ax' }, allow);
    const b = paramsHashFromArgs({ mode: 'ax', limit: undefined }, allow);
    expect(a).toBe(b);
  });

  test('adding a non-allow-listed field never changes the hash', () => {
    const allow = ['mode'] as const;
    const a = paramsHashFromArgs({ mode: 'ax' }, allow);
    const b = paramsHashFromArgs({ mode: 'ax', _seq: 123 }, allow);
    const c = paramsHashFromArgs({ mode: 'ax', caller_trace_id: 't' }, allow);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test('allow-list ordering does not affect the hash', () => {
    const aFirst = paramsHashFromArgs({ a: 1, b: 2 }, ['a', 'b']);
    const bFirst = paramsHashFromArgs({ a: 1, b: 2 }, ['b', 'a']);
    expect(aFirst).toBe(bFirst);
  });
});

describe('per-tool allow-list constants', () => {
  test('READ_PAGE_PARAMS / FIND_PARAMS / QUERY_DOM_PARAMS are frozen arrays', () => {
    expect(Array.isArray(READ_PAGE_PARAMS)).toBe(true);
    expect(Array.isArray(FIND_PARAMS)).toBe(true);
    expect(Array.isArray(QUERY_DOM_PARAMS)).toBe(true);
    expect(Object.isFrozen(READ_PAGE_PARAMS)).toBe(true);
    expect(Object.isFrozen(FIND_PARAMS)).toBe(true);
    expect(Object.isFrozen(QUERY_DOM_PARAMS)).toBe(true);
  });

  test('per-tool allow-lists are non-empty', () => {
    expect(READ_PAGE_PARAMS.length).toBeGreaterThan(0);
    expect(FIND_PARAMS.length).toBeGreaterThan(0);
    expect(QUERY_DOM_PARAMS.length).toBeGreaterThan(0);
  });

  test('allow-lists scope the hash to documented fields only', () => {
    // Adding an undocumented field must NOT change the read_page hash.
    const args = Object.fromEntries(READ_PAGE_PARAMS.map((k, i) => [k, `v-${i}`]));
    const base = paramsHashFromArgs(args, READ_PAGE_PARAMS);
    const polluted = paramsHashFromArgs({ ...args, undocumented: 'noise' }, READ_PAGE_PARAMS);
    expect(base).toBe(polluted);
  });
});
