/// <reference types="jest" />

import { mapToAirenaRound } from './map-to-airena';

describe('mapToAirenaRound — input validation', () => {
  test('throws when input is missing or not an object', () => {
    expect(() => mapToAirenaRound(null as never)).toThrow();
    expect(() => mapToAirenaRound(undefined as never)).toThrow();
    expect(() => mapToAirenaRound('nope' as never)).toThrow();
  });

  test('throws when targetUrl is missing or empty', () => {
    expect(() => mapToAirenaRound({} as never)).toThrow(/targetUrl/);
    expect(() => mapToAirenaRound({ targetUrl: '' })).toThrow(/targetUrl/);
  });
});

describe('mapToAirenaRound — status rules', () => {
  test("status='gated' wins over coverage when a gate is detected", () => {
    const r = mapToAirenaRound({
      targetUrl: 'https://example.com',
      schemaDiff: { matched: ['a'], missing: [], extra: [], typeMismatch: [], coverage: 1 },
      gateFact: { detected: true, kind: 'captcha', gateType: 'hcaptcha' },
    });
    expect(r.status).toBe('gated');
    // Coverage is still echoed verbatim — score is host-derived.
    expect(r.coverage).toBe(1);
  });

  test("status='ok' when coverage is 1 and no gate", () => {
    const r = mapToAirenaRound({
      targetUrl: 'https://example.com',
      schemaDiff: { matched: ['a', 'b'], missing: [], extra: [], typeMismatch: [], coverage: 1 },
    });
    expect(r.status).toBe('ok');
  });

  test("status='partial' when 0 < coverage < 1", () => {
    const r = mapToAirenaRound({
      targetUrl: 'https://example.com',
      schemaDiff: { matched: ['a'], missing: ['b'], extra: [], typeMismatch: [], coverage: 0.5 },
    });
    expect(r.status).toBe('partial');
  });

  test("status='failed' when coverage is 0", () => {
    const r = mapToAirenaRound({
      targetUrl: 'https://example.com',
      schemaDiff: { matched: [], missing: ['a', 'b'], extra: [], typeMismatch: [], coverage: 0 },
    });
    expect(r.status).toBe('failed');
  });

  test("status='failed' when schemaDiff is missing entirely", () => {
    const r = mapToAirenaRound({ targetUrl: 'https://example.com' });
    expect(r.status).toBe('failed');
    expect(r.coverage).toBe(0);
  });
});

describe('mapToAirenaRound — facts composition', () => {
  test('attaches all four optional facts when present', () => {
    const r = mapToAirenaRound({
      targetUrl: 'https://example.com',
      schemaDiff: { matched: ['a'], missing: [], extra: [], typeMismatch: [], coverage: 1 },
      gateFact: null,
      profileFingerprint: { hash: 'deadbeef'.repeat(8), breakdown: { cookies: 3 } },
      pathTaken: 'lp-served',
    });
    expect(r.facts.path_taken).toBe('lp-served');
    expect(r.facts.profile_fingerprint).toMatch(/^deadbeef/);
    expect(r.facts.schema_diff).toBeDefined();
    expect(r.facts.gate).toBeUndefined();
  });

  test('omits facts that are absent or null', () => {
    const r = mapToAirenaRound({
      targetUrl: 'https://example.com',
      schemaDiff: { matched: [], missing: [], extra: [], typeMismatch: [], coverage: 0 },
    });
    expect(r.facts).toEqual({ schema_diff: r.facts.schema_diff });
  });
});

describe('mapToAirenaRound — determinism', () => {
  test('repeated calls on the same input produce structurally identical output', () => {
    const input = {
      targetUrl: 'https://example.com',
      schemaDiff: { matched: ['a'], missing: [], extra: [], typeMismatch: [], coverage: 1 },
      pathTaken: 'lp-served',
    };
    const a = mapToAirenaRound(input);
    const b = mapToAirenaRound(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
