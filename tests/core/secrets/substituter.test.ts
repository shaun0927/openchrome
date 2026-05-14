/// <reference types="jest" />
/**
 * Secret substituter tests (#834).
 */

import {
  makeSecretStore,
  EMPTY_SECRET_STORE,
} from '../../../src/core/secrets/loader';
import {
  substituteString,
  substituteSecrets,
  hasSecretToken,
  MissingSecretError,
} from '../../../src/core/secrets/substituter';

const STORE = makeSecretStore(new Map([
  ['PW', 'hunter2_xyz_unique_string_a8f3'],
  ['TOTP', '987654'],
]));

describe('hasSecretToken', () => {
  test.each([
    ['${SECRET:PW}', true],
    ['hello ${SECRET:X} world', true],
    ['no token', false],
    ['', false],
    ['${SECRET:incomplete', false],
    ['${SECRET:}', false], // empty name not valid
    ['${SECRET:1ABC}', false], // leading digit not valid
  ])('hasSecretToken(%j) === %s', (input, expected) => {
    expect(hasSecretToken(input)).toBe(expected);
  });
});

describe('substituteString', () => {
  test('substitutes a single token', () => {
    expect(substituteString('${SECRET:PW}', STORE))
      .toBe('hunter2_xyz_unique_string_a8f3');
  });

  test('substitutes multiple tokens in one string', () => {
    expect(substituteString('${SECRET:PW}|${SECRET:TOTP}', STORE))
      .toBe('hunter2_xyz_unique_string_a8f3|987654');
  });

  test('preserves surrounding text', () => {
    expect(substituteString('pre ${SECRET:TOTP} post', STORE))
      .toBe('pre 987654 post');
  });

  test('throws MissingSecretError on unknown name', () => {
    expect(() => substituteString('${SECRET:UNKNOWN}', STORE)).toThrow(MissingSecretError);
    try {
      substituteString('${SECRET:UNKNOWN}', STORE);
    } catch (e) {
      expect((e as MissingSecretError).code).toBe('MISSING_SECRET');
      expect((e as MissingSecretError).secretName).toBe('UNKNOWN');
    }
  });

  test('partial token (no closing brace) passes through unchanged', () => {
    expect(substituteString('${SECRET:PW', STORE)).toBe('${SECRET:PW');
  });

  test('empty string is a no-op', () => {
    expect(substituteString('', STORE)).toBe('');
  });
});

describe('substituteSecrets (walker)', () => {
  test('walks nested objects and arrays', () => {
    const input = {
      a: '${SECRET:PW}',
      b: ['plain', '${SECRET:TOTP}'],
      c: { d: 'pre-${SECRET:PW}-post' },
    };
    const out = substituteSecrets(input, STORE);
    expect((out as any).a).toBe('hunter2_xyz_unique_string_a8f3');
    expect((out as any).b[1]).toBe('987654');
    expect((out as any).c.d).toBe('pre-hunter2_xyz_unique_string_a8f3-post');
    // Token strings must not survive
    expect(JSON.stringify(out)).not.toMatch(/\$\{SECRET:/);
  });

  test('throws MISSING_SECRET when store is empty but token present', () => {
    expect(() => substituteSecrets('${SECRET:X}', EMPTY_SECRET_STORE))
      .toThrow(MissingSecretError);
  });

  test('no-op when no tokens present and store is empty', () => {
    const out = substituteSecrets({ a: 'plain' }, EMPTY_SECRET_STORE);
    expect(out).toEqual({ a: 'plain' });
  });

  test('throws on first missing secret in a nested tree', () => {
    const input = { a: '${SECRET:PW}', b: '${SECRET:NOPE}' };
    try {
      substituteSecrets(input, STORE);
      fail('expected MISSING_SECRET');
    } catch (e) {
      expect((e as MissingSecretError).secretName).toBe('NOPE');
    }
  });
});
