/// <reference types="jest" />
/**
 * Secret redactor tests (#834).
 */

import {
  makeSecretStore,
  EMPTY_SECRET_STORE,
} from '../../../src/core/secrets/loader';
import {
  redactSecrets,
  redactSecretString,
  findLiteralSecret,
} from '../../../src/core/secrets/redactor';

const STORE = makeSecretStore(new Map([
  ['PW', 'hunter2_xyz_unique_string_a8f3'],
  ['TOKEN', 'tok_short'],
]));

describe('redactSecretString', () => {
  test('replaces literal secret with ${SECRET:NAME}', () => {
    const out = redactSecretString('login with hunter2_xyz_unique_string_a8f3', STORE);
    expect(out).toBe('login with ${SECRET:PW}');
    expect(out).not.toMatch(/hunter2/);
  });

  test('multiple occurrences are all replaced', () => {
    const out = redactSecretString('tok_short here and tok_short there', STORE);
    expect(out.match(/\$\{SECRET:TOKEN\}/g)).toHaveLength(2);
    expect(out).not.toMatch(/tok_short/);
  });

  test('passes through when no secret matches', () => {
    expect(redactSecretString('nothing to see', STORE)).toBe('nothing to see');
  });

  test('no-op on empty store', () => {
    expect(redactSecretString('hunter2_xyz_unique_string_a8f3', EMPTY_SECRET_STORE))
      .toBe('hunter2_xyz_unique_string_a8f3');
  });
});

describe('redactSecrets (walker)', () => {
  test('redacts inside nested objects and arrays', () => {
    const input = {
      a: 'plain',
      b: 'use hunter2_xyz_unique_string_a8f3 here',
      c: ['tok_short', { d: 'hunter2_xyz_unique_string_a8f3' }],
    };
    const out = redactSecrets(input, STORE);
    expect(JSON.stringify(out)).not.toMatch(/hunter2_xyz/);
    expect(JSON.stringify(out)).not.toMatch(/tok_short/);
    expect((out as any).a).toBe('plain');
    expect((out as any).b).toBe('use ${SECRET:PW} here');
    expect((out as any).c[0]).toBe('${SECRET:TOKEN}');
    expect((out as any).c[1].d).toBe('${SECRET:PW}');
  });

  test('does not mutate input', () => {
    const input = { x: 'hunter2_xyz_unique_string_a8f3' };
    const out = redactSecrets(input, STORE);
    expect(input.x).toBe('hunter2_xyz_unique_string_a8f3');
    expect((out as any).x).toBe('${SECRET:PW}');
    expect(out).not.toBe(input);
  });

  test('longest-first ordering prevents substring shadowing', () => {
    const store = makeSecretStore(new Map([
      ['SHORT', 'abc'],
      ['LONG', 'abcdef'], // superstring
    ]));
    const out = redactSecretString('abcdef', store);
    expect(out).toBe('${SECRET:LONG}');
    expect(out).not.toMatch(/SHORT/);
  });

  test('handles non-string primitives gracefully', () => {
    expect(redactSecrets(null, STORE)).toBe(null);
    expect(redactSecrets(42, STORE)).toBe(42);
    expect(redactSecrets(true, STORE)).toBe(true);
    expect(redactSecrets(undefined, STORE)).toBeUndefined();
  });

  test('empty store is a strict no-op (same reference returned)', () => {
    const input = { x: 'whatever' };
    expect(redactSecrets(input, EMPTY_SECRET_STORE)).toBe(input);
  });
});

describe('findLiteralSecret', () => {
  test('returns the matching secret name when value appears as substring', () => {
    expect(findLiteralSecret('the value tok_short appears', STORE)).toBe('TOKEN');
  });

  test('returns undefined when nothing matches', () => {
    expect(findLiteralSecret('no secrets here', STORE)).toBeUndefined();
  });

  test('returns undefined on empty store', () => {
    expect(findLiteralSecret('hunter2_xyz_unique_string_a8f3', EMPTY_SECRET_STORE))
      .toBeUndefined();
  });
});
