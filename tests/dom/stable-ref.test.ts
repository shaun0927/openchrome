import {
  canonicalSignature,
  computeStableRef,
  mintPageRefs,
  refKey,
  StableRefInput,
} from '../../src/dom/stable-ref';

describe('deterministic a11y-ref (P14) — util', () => {
  test('canonicalSignature is whitespace/case tolerant', () => {
    const a = canonicalSignature({ tag: 'BUTTON', role: 'button', name: '  Submit  ' });
    const b = canonicalSignature({ tag: 'button', role: 'button', name: 'submit' });
    expect(a).toBe(b);
  });

  test('stableAttr dominates the signature', () => {
    const sig = canonicalSignature({ tag: 'a', role: 'link', name: 'X', stableAttr: 'checkout-btn' });
    expect(sig.startsWith('stable|checkout-btn|')).toBe(true);
  });

  test('reserved roles (generic/none/presentation/empty) collapse', () => {
    const a = canonicalSignature({ tag: 'div', role: 'generic', name: 'x' });
    const b = canonicalSignature({ tag: 'div', role: 'none', name: 'x' });
    const c = canonicalSignature({ tag: 'div', role: '', name: 'x' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('ancestor tags and siblingIndex participate', () => {
    expect(canonicalSignature({ tag: 'button', name: 'ok', ancestorTags: ['html', 'body', 'form'] }))
      .not.toBe(canonicalSignature({ tag: 'button', name: 'ok', ancestorTags: ['html', 'body', 'dialog'] }));
    expect(canonicalSignature({ tag: 'li', name: 'i', siblingIndex: 0 }))
      .not.toBe(canonicalSignature({ tag: 'li', name: 'i', siblingIndex: 1 }));
  });

  test('computeStableRef is deterministic, default 6-hex, hexLen bounded', () => {
    const input: StableRefInput = { tag: 'button', role: 'button', name: 'OK' };
    expect(computeStableRef(input)).toBe(computeStableRef(input));
    expect(computeStableRef({ tag: 'a' })).toMatch(/^[0-9a-f]{6}$/);
    expect(computeStableRef({ tag: 'a' }, 12)).toHaveLength(12);
    expect(() => computeStableRef({ tag: 'a' }, 0)).toThrow(RangeError);
    expect(() => computeStableRef({ tag: 'a' }, 65)).toThrow(RangeError);
  });

  test('reload-equivalent input → same ref', () => {
    const snap1: StableRefInput = {
      tag: 'BUTTON', role: 'button', name: '  Submit Form  ',
      ancestorTags: ['HTML', 'BODY', 'FORM'], siblingIndex: 2,
    };
    const snap2: StableRefInput = {
      tag: 'button', role: 'button', name: 'submit form',
      ancestorTags: ['html', 'body', 'form'], siblingIndex: 2,
    };
    expect(computeStableRef(snap1)).toBe(computeStableRef(snap2));
  });

  test('refKey strips query/hash, preserves origin, tolerates garbage', () => {
    const a = refKey({ url: 'https://x.com/checkout?ref=1', ref: 'abc' });
    const b = refKey({ url: 'https://x.com/checkout#foo', ref: 'abc' });
    expect(a).toBe(b);
    expect(refKey({ url: 'https://x.com/p', ref: 'abc' }))
      .not.toBe(refKey({ url: 'https://y.com/p', ref: 'abc' }));
    expect(refKey({ url: 'garbage', ref: 'z' })).toBe('garbage#z');
  });

  test('mintPageRefs disambiguates collisions deterministically', () => {
    const dup: StableRefInput = { tag: 'button', name: 'Delete' };
    const out = mintPageRefs([dup, dup, dup, dup]);
    expect(out[0].collision).toBe(false);
    expect(out[1].display.endsWith('b')).toBe(true);
    expect(out[2].display.endsWith('c')).toBe(true);
    expect(out[3].display.endsWith('d')).toBe(true);
    expect(new Set(out.map((r) => r.hash)).size).toBe(1);
    expect(new Set(out.map((r) => r.display)).size).toBe(4);
    // Determinism across calls
    expect(mintPageRefs([dup, dup])).toEqual(mintPageRefs([dup, dup]));
    // Wraps to two-letter after 25
    const many = mintPageRefs(Array.from({ length: 27 }, () => ({ tag: 'li', name: 'row' })));
    expect(new Set(many.map((r) => r.display)).size).toBe(27);
  });
});
