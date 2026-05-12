/// <reference types="jest" />

import {
  MAX_REGEX_PATTERN_LENGTH,
  compileSafeRegex,
  isSafeRegexPattern,
  validateRegexPattern,
} from '../../src/contracts/safe-regex';

describe('safe-regex', () => {
  test('accepts ordinary patterns', () => {
    expect(isSafeRegexPattern('^https://example\\.com/?$')).toBe(true);
    expect(isSafeRegexPattern('/orders/[A-Z0-9]{8}/confirmation')).toBe(true);
    expect(isSafeRegexPattern('cart')).toBe(true);
  });

  test('rejects patterns with nested quantifiers (ReDoS shapes)', () => {
    expect(isSafeRegexPattern('(a+)+$')).toBe(false);
    expect(isSafeRegexPattern('(a*)*')).toBe(false);
    expect(isSafeRegexPattern('a++')).toBe(false);
    expect(isSafeRegexPattern('a**')).toBe(false);
    expect(isSafeRegexPattern('(a+b)+')).toBe(false);
  });

  test('rejects patterns longer than the cap', () => {
    const long = 'a'.repeat(MAX_REGEX_PATTERN_LENGTH + 1);
    const r = validateRegexPattern(long);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/exceeds/);
  });

  test('rejects unparseable regex with descriptive reason', () => {
    const r = validateRegexPattern('(');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invalid regex/);
  });

  test('compileSafeRegex throws on rejected patterns', () => {
    expect(() => compileSafeRegex('(a+)+')).toThrow(/unsafe regex/);
    expect(() => compileSafeRegex('a'.repeat(MAX_REGEX_PATTERN_LENGTH + 1))).toThrow(/unsafe regex/);
  });

  test('compileSafeRegex returns a working RegExp on safe input', () => {
    const re = compileSafeRegex('^foo$');
    expect(re.test('foo')).toBe(true);
    expect(re.test('foobar')).toBe(false);
  });
});
