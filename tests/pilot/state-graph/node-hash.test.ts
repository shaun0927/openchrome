/**
 * Unit tests for the v1 state-graph node hash.
 *
 * v1 algorithm spec:
 *   canonical = origin + pathname (lower-cased host, trailing slash stripped)
 *   hash      = sha256("v1\0" + canonical).hex.slice(0, 16)
 *
 * Coverage:
 *   - Determinism (same URL → same 16-char hex)
 *   - Query / fragment / trailing slash collapses
 *   - Host case-insensitivity, path case-sensitivity
 *   - Different paths → different hashes
 *   - Garbage input → null
 */

import {
  STATE_HASH_VERSION,
  canonicalizeUrl,
  computeNodeHash,
} from '../../../src/pilot/state-graph/node-hash.js';

describe('state-graph node hash (v1)', () => {
  it('exports STATE_HASH_VERSION = "v1"', () => {
    expect(STATE_HASH_VERSION).toBe('v1');
  });

  it('is deterministic on the same URL', () => {
    const a = computeNodeHash('https://example.com/cart');
    const b = computeNodeHash('https://example.com/cart');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores query string and fragment', () => {
    const base = computeNodeHash('https://example.com/products');
    expect(computeNodeHash('https://example.com/products?utm_source=x')).toBe(base);
    expect(computeNodeHash('https://example.com/products?ref=42&utm=y')).toBe(base);
    expect(computeNodeHash('https://example.com/products#section-a')).toBe(base);
    expect(computeNodeHash('https://example.com/products?x=1#anchor')).toBe(base);
  });

  it('collapses a trailing slash on a non-root pathname', () => {
    expect(computeNodeHash('https://example.com/cart/')).toBe(
      computeNodeHash('https://example.com/cart'),
    );
  });

  it('preserves the root slash so it does not collide with malformed URLs', () => {
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com/');
    expect(canonicalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it('lowercases the host', () => {
    expect(computeNodeHash('https://Example.COM/cart')).toBe(
      computeNodeHash('https://example.com/cart'),
    );
  });

  it('treats path case as significant', () => {
    expect(computeNodeHash('https://example.com/User')).not.toBe(
      computeNodeHash('https://example.com/user'),
    );
  });

  it('produces different hashes for different paths', () => {
    expect(computeNodeHash('https://example.com/cart')).not.toBe(
      computeNodeHash('https://example.com/checkout'),
    );
  });

  it('produces different hashes for different origins on the same path', () => {
    expect(computeNodeHash('https://a.example.com/cart')).not.toBe(
      computeNodeHash('https://b.example.com/cart'),
    );
    expect(computeNodeHash('http://example.com/cart')).not.toBe(
      computeNodeHash('https://example.com/cart'),
    );
  });

  it('returns null for unparseable or empty input', () => {
    expect(computeNodeHash('')).toBeNull();
    expect(computeNodeHash(null)).toBeNull();
    expect(computeNodeHash(undefined)).toBeNull();
    expect(computeNodeHash('not a url')).toBeNull();
    // Two different unparseable inputs do not collide on a default hash:
    expect(computeNodeHash('garbage-1')).toBeNull();
    expect(computeNodeHash('garbage-2')).toBeNull();
  });

  it('canonicalize round-trip — query/fragment dropped, host lower-cased', () => {
    expect(canonicalizeUrl('https://Example.com/Foo?a=1#x')).toBe('https://example.com/Foo');
  });
});
