import {
  canonicalSignature,
  computeStableRef,
  mintPageRefs,
  refKey,
  StableRefInput,
} from '../../src/dom/stable-ref';

describe('deterministic a11y-ref (P14)', () => {
  describe('canonicalSignature', () => {
    test('same input → same signature (whitespace tolerant)', () => {
      const a = canonicalSignature({ tag: 'BUTTON', role: 'button', name: '  Submit  ' });
      const b = canonicalSignature({ tag: 'button', role: 'button', name: 'submit' });
      expect(a).toBe(b);
    });
    test('stableAttr dominates', () => {
      const sig = canonicalSignature({
        tag: 'a', role: 'link', name: 'X', stableAttr: 'checkout-btn',
      });
      expect(sig.startsWith('stable|checkout-btn|')).toBe(true);
    });
    test('generic/none/presentation roles collapse to empty', () => {
      const a = canonicalSignature({ tag: 'div', role: 'generic', name: 'x' });
      const b = canonicalSignature({ tag: 'div', role: 'none', name: 'x' });
      const c = canonicalSignature({ tag: 'div', role: '', name: 'x' });
      expect(a).toBe(b);
      expect(b).toBe(c);
    });
    test('ancestor tags participate', () => {
      const a = canonicalSignature({ tag: 'button', name: 'ok', ancestorTags: ['html', 'body', 'form'] });
      const b = canonicalSignature({ tag: 'button', name: 'ok', ancestorTags: ['html', 'body', 'dialog'] });
      expect(a).not.toBe(b);
    });
    test('siblingIndex participates', () => {
      const a = canonicalSignature({ tag: 'li', name: 'item', siblingIndex: 0 });
      const b = canonicalSignature({ tag: 'li', name: 'item', siblingIndex: 1 });
      expect(a).not.toBe(b);
    });
    test('normalises unicode whitespace (nbsp, zero-width)', () => {
      const a = canonicalSignature({ tag: 'button', name: 'Sign In' });
      const b = canonicalSignature({ tag: 'button', name: 'Sign In' });
      expect(a).toBe(b);
    });
  });

  describe('computeStableRef', () => {
    test('deterministic', () => {
      const input: StableRefInput = { tag: 'button', role: 'button', name: 'OK' };
      expect(computeStableRef(input)).toBe(computeStableRef(input));
    });
    test('default length is 6 hex', () => {
      expect(computeStableRef({ tag: 'a' })).toHaveLength(6);
      expect(computeStableRef({ tag: 'a' })).toMatch(/^[0-9a-f]{6}$/);
    });
    test('respects hexLen', () => {
      expect(computeStableRef({ tag: 'a' }, 12)).toHaveLength(12);
    });
    test('rejects invalid hexLen', () => {
      expect(() => computeStableRef({ tag: 'a' }, 0)).toThrow(RangeError);
      expect(() => computeStableRef({ tag: 'a' }, 65)).toThrow(RangeError);
    });
    test('different inputs → different refs (high probability)', () => {
      const refs = new Set([
        computeStableRef({ tag: 'button', name: 'A' }),
        computeStableRef({ tag: 'button', name: 'B' }),
        computeStableRef({ tag: 'a', name: 'A' }),
        computeStableRef({ tag: 'a', name: 'B' }),
      ]);
      expect(refs.size).toBe(4);
    });
    test('reload-equivalent input → same ref', () => {
      // Simulate a reload where the browser normalises whitespace and casing.
      const snap1: StableRefInput = {
        tag: 'BUTTON', role: 'button', name: '  Submit Form  ',
        ancestorTags: ['HTML', 'BODY', 'FORM'], siblingIndex: 2,
      };
      const snap2: StableRefInput = {
        tag: 'button', role: 'button', name: 'submit form',
        ancestorTags: ['html', 'body', 'form'], siblingIndex: 2,
      };
      expect(computeStableRef(snap1)).toBe(computeStableRef(snap2));
    });
  });

  describe('refKey', () => {
    test('strips query and hash', () => {
      const a = refKey({ url: 'https://x.com/checkout?ref=1', ref: 'abc123' });
      const b = refKey({ url: 'https://x.com/checkout#foo', ref: 'abc123' });
      expect(a).toBe(b);
    });
    test('preserves origin', () => {
      const a = refKey({ url: 'https://x.com/p', ref: 'abc' });
      const b = refKey({ url: 'https://y.com/p', ref: 'abc' });
      expect(a).not.toBe(b);
    });
    test('malformed URL falls through untouched', () => {
      expect(refKey({ url: 'garbage', ref: 'z' })).toBe('garbage#z');
    });
  });

  describe('mintPageRefs', () => {
    test('unique inputs → unique refs, no collision flag', () => {
      const out = mintPageRefs([
        { tag: 'button', name: 'A' },
        { tag: 'button', name: 'B' },
        { tag: 'a', name: 'C' },
      ]);
      expect(out).toHaveLength(3);
      expect(out.every((r) => r.collision === false)).toBe(true);
      expect(new Set(out.map((r) => r.display)).size).toBe(3);
    });
    test('duplicate inputs → collision suffixes b, c, d…', () => {
      const dup: StableRefInput = { tag: 'button', name: 'Delete' };
      const out = mintPageRefs([dup, dup, dup, dup]);
      expect(out[0].collision).toBe(false);
      expect(out[1].collision).toBe(true);
      expect(out[1].display.endsWith('b')).toBe(true);
      expect(out[2].display.endsWith('c')).toBe(true);
      expect(out[3].display.endsWith('d')).toBe(true);
      // All share the same underlying hash
      expect(new Set(out.map((r) => r.hash)).size).toBe(1);
      // All display refs are unique
      expect(new Set(out.map((r) => r.display)).size).toBe(4);
    });
    test('mint is deterministic across calls', () => {
      const inputs: StableRefInput[] = [
        { tag: 'button', name: 'X' },
        { tag: 'button', name: 'X' },
        { tag: 'a', name: 'Y' },
      ];
      const a = mintPageRefs(inputs);
      const b = mintPageRefs(inputs);
      expect(a).toEqual(b);
    });
    test('wraps to two-letter suffixes after 25 collisions', () => {
      const inputs: StableRefInput[] = Array.from({ length: 27 }, () => ({ tag: 'li', name: 'row' }));
      const out = mintPageRefs(inputs);
      // 26th (index 25) collision index n=25 → suffix wraps
      expect(out[26].display.length).toBeGreaterThan(out[0].display.length + 1);
      expect(new Set(out.map((r) => r.display)).size).toBe(27);
    });
  });
});
