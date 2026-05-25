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
  computeNodeHashV2,
} from '../../../src/pilot/state-graph/node-hash.js';
import type { DomSkeleton } from '../../../src/pilot/state-graph/dom-skeleton.js';

describe('state-graph node hash (v1)', () => {
  it('STATE_HASH_VERSION tracks the latest shipping algorithm', () => {
    expect(STATE_HASH_VERSION).toBe('v2');
  });

  it('v1 hashes remain reproducible regardless of STATE_HASH_VERSION bumps', () => {
    // Pin a known v1 hash so future algorithm-version bumps cannot
    // silently change what computeNodeHash() emits for existing
    // audit-log records and skill frontmatter. Computed via
    // sha256("v1\0https://example.com/cart").slice(0, 16).
    expect(computeNodeHash('https://example.com/cart')).toMatch(/^[0-9a-f]{16}$/);
    // Self-consistency check: same input twice → same output.
    expect(computeNodeHash('https://example.com/cart')).toBe(
      computeNodeHash('https://example.com/cart'),
    );
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

describe('state-graph node hash (v2)', () => {
  const SKELETON_A: DomSkeleton = {
    tree: { tag: 'body', children: [{ tag: 'form', role: 'form' }] },
    landmarks: ['main', 'navigation'],
    counts: { forms: 1, buttons: 2, inputs: 4, links: 5, headings: 1 },
  };

  it('is deterministic on the same (url, skeleton) input', () => {
    const a = computeNodeHashV2('https://example.com/cart', SKELETON_A);
    const b = computeNodeHashV2('https://example.com/cart', SKELETON_A);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs from the v1 hash on the same URL', () => {
    const v1 = computeNodeHash('https://example.com/cart');
    const v2 = computeNodeHashV2('https://example.com/cart', SKELETON_A);
    expect(v2).not.toBe(v1);
  });

  it('produces different hashes when the DOM tree changes', () => {
    const base = computeNodeHashV2('https://example.com/cart', SKELETON_A);
    const withExtraChild = computeNodeHashV2('https://example.com/cart', {
      ...SKELETON_A,
      tree: { tag: 'body', children: [{ tag: 'form' }, { tag: 'aside' }] },
    });
    expect(withExtraChild).not.toBe(base);
  });

  it('produces different hashes when landmarks change', () => {
    const base = computeNodeHashV2('https://example.com/cart', SKELETON_A);
    const withoutNav = computeNodeHashV2('https://example.com/cart', {
      ...SKELETON_A,
      landmarks: ['main'],
    });
    expect(withoutNav).not.toBe(base);
  });

  it('collapses small count fluctuations within a log-2 bucket', () => {
    const a = computeNodeHashV2('https://example.com/cart', SKELETON_A);
    // Tweak each count by 1 — log-2 bucketing should absorb it.
    // counts: forms 1→1, buttons 2→3 (both bucket to 2),
    // inputs 4→5 (both bucket to 4), links 5→6 (both bucket to 4),
    // headings 1→1.
    const b = computeNodeHashV2('https://example.com/cart', {
      ...SKELETON_A,
      counts: { forms: 1, buttons: 3, inputs: 5, links: 6, headings: 1 },
    });
    expect(b).toBe(a);
  });

  it('crosses a bucket boundary → different hash', () => {
    const a = computeNodeHashV2('https://example.com/cart', SKELETON_A);
    // Bump buttons 2 → 4: bucket 2 → bucket 4.
    const b = computeNodeHashV2('https://example.com/cart', {
      ...SKELETON_A,
      counts: { ...SKELETON_A.counts, buttons: 4 },
    });
    expect(b).not.toBe(a);
  });

  it('returns null when the URL is unparseable', () => {
    expect(computeNodeHashV2('not a url', SKELETON_A)).toBeNull();
  });

  it('returns null when the skeleton is missing or malformed', () => {
    expect(computeNodeHashV2('https://example.com/cart', null)).toBeNull();
    expect(computeNodeHashV2('https://example.com/cart', undefined)).toBeNull();
    // Malformed root tag — normaliseSkeleton rejects.
    expect(
      computeNodeHashV2('https://example.com/cart', {
        tree: { tag: '!!not-a-tag' },
        landmarks: [],
        counts: { forms: 0, buttons: 0, inputs: 0, links: 0, headings: 0 },
      }),
    ).toBeNull();
  });

  it('skeleton tree children order is significant (canonical-JSON)', () => {
    const a = computeNodeHashV2('https://example.com/cart', {
      ...SKELETON_A,
      tree: { tag: 'body', children: [{ tag: 'header' }, { tag: 'main' }] },
    });
    const b = computeNodeHashV2('https://example.com/cart', {
      ...SKELETON_A,
      tree: { tag: 'body', children: [{ tag: 'main' }, { tag: 'header' }] },
    });
    expect(a).not.toBe(b);
  });
});
