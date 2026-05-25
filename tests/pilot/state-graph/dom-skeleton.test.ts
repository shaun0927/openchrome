/**
 * Tests for the DOM skeleton normaliser + canonicaliser.
 *
 * `normaliseSkeleton` is the entry point used by v2 node hashing —
 * its job is to coerce a raw probe payload into a deterministic
 * shape so two functionally identical inputs always hash the same.
 *
 * `canonicalizeSkeleton` produces the byte string fed into sha256;
 * it must be insertion-order-independent inside `counts`.
 */

import {
  bucketCount,
  canonicalizeSkeleton,
  DOM_SKELETON_MAX_DEPTH,
  DOM_SKELETON_MAX_NODES,
  normaliseSkeleton,
  type DomSkeleton,
  type DomSkeletonNode,
} from '../../../src/pilot/state-graph/dom-skeleton.js';

describe('bucketCount', () => {
  it('maps 0 and negatives to 0', () => {
    expect(bucketCount(0)).toBe(0);
    expect(bucketCount(-1)).toBe(0);
    expect(bucketCount(NaN)).toBe(0);
    expect(bucketCount(Infinity)).toBe(0);
  });
  it('maps 1 to 1', () => {
    expect(bucketCount(1)).toBe(1);
  });
  it('floors to powers of two', () => {
    expect(bucketCount(2)).toBe(2);
    expect(bucketCount(3)).toBe(2);
    expect(bucketCount(4)).toBe(4);
    expect(bucketCount(5)).toBe(4);
    expect(bucketCount(7)).toBe(4);
    expect(bucketCount(8)).toBe(8);
    expect(bucketCount(15)).toBe(8);
    expect(bucketCount(16)).toBe(16);
  });
});

describe('normaliseSkeleton', () => {
  const VALID: DomSkeleton = {
    tree: { tag: 'body' },
    landmarks: ['main'],
    counts: { forms: 1, buttons: 1, inputs: 1, links: 1, headings: 1 },
  };

  it('returns null for null/undefined/garbage', () => {
    expect(normaliseSkeleton(null)).toBeNull();
    expect(normaliseSkeleton(undefined)).toBeNull();
    expect(normaliseSkeleton({} as unknown as DomSkeleton)).toBeNull();
  });

  it('rejects skeletons whose root tag is malformed', () => {
    expect(
      normaliseSkeleton({
        ...VALID,
        tree: { tag: '<script>' },
      }),
    ).toBeNull();
    expect(
      normaliseSkeleton({
        ...VALID,
        tree: { tag: '' },
      }),
    ).toBeNull();
  });

  it('drops invalid child nodes silently', () => {
    const out = normaliseSkeleton({
      tree: {
        tag: 'body',
        children: [
          { tag: 'header' },
          { tag: '<bad>' },
          { tag: 'main' },
        ],
      },
      landmarks: [],
      counts: { forms: 0, buttons: 0, inputs: 0, links: 0, headings: 0 },
    });
    expect(out?.tree.children?.map((c) => c.tag)).toEqual(['header', 'main']);
  });

  it('lower-cases tags and roles', () => {
    const out = normaliseSkeleton({
      tree: { tag: 'BODY', role: 'BANNER' },
      landmarks: ['MAIN', 'navigation'],
      counts: { forms: 0, buttons: 0, inputs: 0, links: 0, headings: 0 },
    });
    expect(out?.tree.tag).toBe('body');
    expect(out?.tree.role).toBe('banner');
    expect(out?.landmarks).toEqual(['main', 'navigation']);
  });

  it('de-duplicates and sorts landmarks', () => {
    const out = normaliseSkeleton({
      ...VALID,
      landmarks: ['navigation', 'main', 'navigation', 'banner'],
    });
    expect(out?.landmarks).toEqual(['banner', 'main', 'navigation']);
  });

  it('drops invalid landmark strings', () => {
    const out = normaliseSkeleton({
      ...VALID,
      landmarks: ['main', '<bad>', '', 'navigation', 'a'.repeat(64)],
    });
    expect(out?.landmarks).toEqual(['main', 'navigation']);
  });

  it('buckets counts to log-2', () => {
    const out = normaliseSkeleton({
      ...VALID,
      counts: { forms: 3, buttons: 5, inputs: 7, links: 9, headings: 17 },
    });
    expect(out?.counts).toEqual({
      forms: 2,
      buttons: 4,
      inputs: 4,
      links: 8,
      headings: 16,
    });
  });

  it('strips empty children arrays from the canonical shape', () => {
    const out = normaliseSkeleton({
      tree: { tag: 'body', children: [] },
      landmarks: [],
      counts: { forms: 0, buttons: 0, inputs: 0, links: 0, headings: 0 },
    });
    expect((out?.tree as { children?: unknown }).children).toBeUndefined();
  });

  it('caps retained tree depth to three levels including the root', () => {
    const out = normaliseSkeleton({
      tree: {
        tag: 'body',
        children: [{
          tag: 'main',
          children: [{
            tag: 'section',
            children: [{ tag: 'button' }],
          }],
        }],
      },
      landmarks: [],
      counts: { forms: 0, buttons: 0, inputs: 0, links: 0, headings: 0 },
    });

    expect(DOM_SKELETON_MAX_DEPTH).toBe(3);
    expect(out?.tree).toEqual({
      tag: 'body',
      children: [{
        tag: 'main',
        children: [{ tag: 'section' }],
      }],
    });
  });

  it('caps retained nodes to 64 in document order without charging invalid nodes', () => {
    const children: DomSkeletonNode[] = [];
    for (let i = 0; i < DOM_SKELETON_MAX_NODES + 2; i += 1) {
      children.push({ tag: i === 1 ? '<bad>' : `x-${i}` });
    }

    const out = normaliseSkeleton({
      tree: { tag: 'body', children },
      landmarks: [],
      counts: { forms: 0, buttons: 0, inputs: 0, links: 0, headings: 0 },
    });

    const retained = out?.tree.children ?? [];
    expect(retained).toHaveLength(DOM_SKELETON_MAX_NODES - 1);
    expect(retained.map((c) => c.tag)).toEqual([
      'x-0',
      ...Array.from({ length: DOM_SKELETON_MAX_NODES - 2 }, (_, i) => `x-${i + 2}`),
    ]);
  });
});

describe('canonicalizeSkeleton', () => {
  it('produces stable JSON regardless of counts insertion order', () => {
    const a = canonicalizeSkeleton({
      tree: { tag: 'body' },
      landmarks: [],
      // Insert in alpha order
      counts: { buttons: 1, forms: 2, headings: 3, inputs: 4, links: 5 },
    });
    const b = canonicalizeSkeleton({
      tree: { tag: 'body' },
      landmarks: [],
      // Insert in reverse order
      counts: { links: 5, inputs: 4, headings: 3, forms: 2, buttons: 1 },
    });
    expect(a).toBe(b);
  });

  it('emits children in tree order (significant)', () => {
    const a = canonicalizeSkeleton({
      tree: { tag: 'body', children: [{ tag: 'header' }, { tag: 'main' }] },
      landmarks: [],
      counts: { forms: 0, buttons: 0, inputs: 0, links: 0, headings: 0 },
    });
    const b = canonicalizeSkeleton({
      tree: { tag: 'body', children: [{ tag: 'main' }, { tag: 'header' }] },
      landmarks: [],
      counts: { forms: 0, buttons: 0, inputs: 0, links: 0, headings: 0 },
    });
    expect(a).not.toBe(b);
  });
});
