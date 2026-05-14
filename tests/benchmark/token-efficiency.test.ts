/// <reference types="jest" />

import {
  normalizeValue,
  computeRetention,
  scorePayload,
  compressionRatio,
  efficiencyPoint,
  GroundTruthSpec,
  MIN_GROUND_TRUTH_FIELDS,
} from './token-efficiency';

/** A valid >= 12-field ground truth for a synthetic product-page fixture. */
function productGroundTruth(): GroundTruthSpec {
  const fields = [
    { key: 'title', expected: 'Wireless Headphones' },
    { key: 'price', expected: '$199.00' },
    { key: 'brand', expected: 'Acme Audio' },
    { key: 'sku', expected: 'AA-WH-001' },
    { key: 'rating', expected: '4.6' },
    { key: 'reviewCount', expected: '1283' },
    { key: 'availability', expected: 'In stock' },
    { key: 'primaryCta', expected: 'Add to cart' },
    { key: 'shippingNote', expected: 'Free shipping over $50' },
    { key: 'category', expected: 'Audio' },
    { key: 'color', expected: 'Midnight Black' },
    { key: 'warranty', expected: '2 year limited' },
  ];
  return { fixture: 'product-01', fields };
}

describe('normalizeValue', () => {
  test('strips markup, collapses whitespace, trims, lowercases', () => {
    expect(normalizeValue('  <b>Hello</b>   World  ')).toBe('hello world');
    expect(normalizeValue('PRICE:\n  $9.99')).toBe('price: $9.99');
  });

  test('two values that differ only in markup/whitespace/case normalize equal', () => {
    expect(normalizeValue('<span>Add to Cart</span>')).toBe(normalizeValue('ADD TO   CART'));
  });
});

describe('computeRetention', () => {
  test('full structured extraction retains every field', () => {
    const gt = productGroundTruth();
    const extracted = Object.fromEntries(gt.fields.map((f) => [f.key, f.expected]));
    const result = computeRetention(extracted, gt);
    expect(result.fieldsTotal).toBe(12);
    expect(result.fieldsRetained).toBe(12);
    expect(result.retention).toBe(1);
    expect(result.missingKeys).toEqual([]);
  });

  test('missing, null, and mismatched fields all count as not retained', () => {
    const gt = productGroundTruth();
    const extracted: Record<string, string | null> = Object.fromEntries(
      gt.fields.map((f) => [f.key, f.expected]),
    );
    extracted.price = null; // null
    extracted.brand = 'Wrong Brand'; // mismatch
    delete extracted.sku; // missing
    const result = computeRetention(extracted, gt);
    expect(result.fieldsRetained).toBe(9);
    expect(result.retention).toBeCloseTo(9 / 12);
    expect(result.missingKeys.sort()).toEqual(['brand', 'price', 'sku']);
  });

  test('matches values that differ only in markup/whitespace/case', () => {
    const gt = productGroundTruth();
    const extracted = Object.fromEntries(gt.fields.map((f) => [f.key, f.expected]));
    extracted.primaryCta = '  <button>ADD TO CART</button> ';
    const result = computeRetention(extracted, gt);
    expect(result.fieldsRetained).toBe(12);
  });

  test('a raw-blob dump cannot game retention — only structured keys count', () => {
    const gt = productGroundTruth();
    // Every expected value exists as a substring of this blob, but it is not
    // a structured, field-keyed extraction, so it retains nothing.
    const blob = gt.fields.map((f) => f.expected).join(' | ');
    const result = computeRetention({ rawHtml: blob }, gt);
    expect(result.fieldsRetained).toBe(0);
    expect(result.retention).toBe(0);
  });

  test('throws when ground truth has fewer than the minimum fields', () => {
    const tooFew: GroundTruthSpec = {
      fixture: 'thin',
      fields: [
        { key: 'title', expected: 'a' },
        { key: 'price', expected: 'b' },
        { key: 'image', expected: 'c' },
      ],
    };
    expect(() => computeRetention({}, tooFew)).toThrow(
      new RegExp(`>= ${MIN_GROUND_TRUTH_FIELDS} required`),
    );
  });
});

describe('scorePayload', () => {
  test('reports exact token count and char length', () => {
    const score = scorePayload('hello world');
    expect(score.chars).toBe(11);
    expect(score.tokens).toBeGreaterThan(0);
  });

  test('empty payload scores zero', () => {
    expect(scorePayload('')).toEqual({ tokens: 0, chars: 0 });
  });
});

describe('compressionRatio', () => {
  test('a smaller payload than raw HTML yields a ratio > 1', () => {
    const rawHtml = '<html><body>' + '<div class="x">content</div>'.repeat(200) + '</body></html>';
    const compact = 'content '.repeat(20);
    expect(compressionRatio(rawHtml, compact)).toBeGreaterThan(1);
  });

  test('handles an empty payload without dividing by zero', () => {
    expect(compressionRatio('something', '')).toBe(Infinity);
    expect(compressionRatio('', '')).toBe(1);
  });
});

describe('efficiencyPoint', () => {
  test('assembles tokens + retention for one (library, fixture) cell', () => {
    const gt = productGroundTruth();
    const extracted = Object.fromEntries(gt.fields.map((f) => [f.key, f.expected]));
    const point = efficiencyPoint('OpenChrome', gt, extracted, '{"title":"Wireless Headphones"}');
    expect(point.library).toBe('OpenChrome');
    expect(point.fixture).toBe('product-01');
    expect(point.retention).toBe(1);
    expect(point.tokens).toBeGreaterThan(0);
  });
});
