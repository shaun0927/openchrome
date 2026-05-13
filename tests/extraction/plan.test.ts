import { buildFieldPlan, buildExtractionPlan, isSafeSelectorToken } from '../../src/extraction/plan';

describe('schema-aware extraction plan', () => {
  test('expands semantic aliases for salePrice', () => {
    const plan = buildFieldPlan('salePrice', {
      type: 'number',
      description: 'discounted current product price',
    });

    expect(plan.aliases).toEqual(expect.arrayContaining(['salePrice', 'sale-price', 'sale_price', 'price', 'amount']));
    expect(plan.descriptionTokens).toContain('discounted');
    expect(plan.selectorTokens).toContain('price');
  });

  test('expands headline aliases to title and name', () => {
    const plan = buildFieldPlan('headline', { type: 'string' });
    expect(plan.aliases).toEqual(expect.arrayContaining(['headline', 'title', 'name']));
  });

  test('filters unsafe selector tokens without dropping schema field', () => {
    const plan = buildFieldPlan('가격(원)', {
      type: 'string',
      description: 'safe-token <script> onclick=bad very-long-token'.repeat(20),
    });

    expect(plan.field).toBe('가격(원)');
    expect(plan.aliases).toEqual([]);
    expect(plan.selectorTokens.every(isSafeSelectorToken)).toBe(true);
    expect(plan.selectorTokens.length).toBeLessThanOrEqual(14);
  });

  test('keeps legacy structured-data aliases', () => {
    expect(buildFieldPlan('currency', { type: 'string' }).aliases).toContain('priceCurrency');
    expect(buildFieldPlan('rating', { type: 'number' }).aliases).toContain('aggregateRating');
    expect(buildFieldPlan('availability', { type: 'string' }).aliases).toContain('stock');
  });

  test('builds a plan for every schema property', () => {
    const plan = buildExtractionPlan({
      headline: { type: 'string' },
      salePrice: { type: 'number' },
    });

    expect(plan.fields.map(f => f.field)).toEqual(['headline', 'salePrice']);
    expect(plan.strategyOrder).toEqual(['json-ld', 'microdata', 'opengraph', 'css-heuristic']);
  });
});
