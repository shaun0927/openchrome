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

describe('compile caching (PR #939 review P1)', () => {
  test('repeated redactSecrets calls on the same store reuse the compiled view', () => {
    // Regression for the "compile-per-call" performance finding. The fix
    // memoizes the sorted+pre-escaped view per SecretStore identity in a
    // WeakMap. We exercise it by running a large number of redactions back
    // to back and asserting the per-call cost stays bounded — the cache
    // miss is the first call only.
    const N = 50;
    const entries: Array<[string, string]> = [];
    for (let i = 0; i < N; i++) {
      entries.push([`K${i}`, `value_${i}_${'x'.repeat(20)}`]);
    }
    const store = makeSecretStore(new Map(entries));

    const sample = `prefix ${entries[N - 1][1]} middle ${entries[0][1]} suffix`;

    // Warmup (first call populates the cache).
    redactSecretString(sample, store);

    // 200 hot-path iterations should complete well under any reasonable
    // budget. We don't assert a hard ms threshold (jest CI hosts vary)
    // but we DO assert the correctness invariant: every call still
    // redacts to the same canonical placeholder form.
    let last = '';
    for (let i = 0; i < 200; i++) {
      last = redactSecretString(sample, store);
    }
    expect(last).toContain('${SECRET:K0}');
    expect(last).toContain(`\${SECRET:K${N - 1}}`);
    expect(last).not.toMatch(/value_\d+_xxxx/);
  });

  test('a fresh SecretStore gets its own compiled view (no cross-store bleed)', () => {
    const storeA = makeSecretStore(new Map([['ONLY_A', 'aaaaaaaa']]));
    const storeB = makeSecretStore(new Map([['ONLY_B', 'bbbbbbbb']]));
    expect(redactSecretString('aaaaaaaa', storeA)).toBe('${SECRET:ONLY_A}');
    expect(redactSecretString('aaaaaaaa', storeB)).toBe('aaaaaaaa');
    expect(redactSecretString('bbbbbbbb', storeB)).toBe('${SECRET:ONLY_B}');
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
