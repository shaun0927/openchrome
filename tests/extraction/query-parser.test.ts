/// <reference types="jest" />

import {
  buildExtractionQueryPlan,
  ExtractionQueryParseError,
  parseExtractionQuery,
} from '../../src/extraction/query-parser';

describe('extraction query parser', () => {
  test('parses flat object fields with type hints', () => {
    const plan = buildExtractionQueryPlan('{ title price(number) available(boolean) }');

    expect(plan.multiple).toBe(false);
    expect(plan.schema).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        price: { type: 'number' },
        available: { type: 'boolean' },
      },
      required: ['title', 'price', 'available'],
    });
  });

  test('parses list object and infers multiple extraction', () => {
    const plan = buildExtractionQueryPlan('{ products[] { product_name product_price(number) product_url(url) } }');

    expect(plan.multiple).toBe(true);
    expect(plan.rootListField).toBe('products');
    expect(plan.schema.type).toBe('array');
    expect(plan.schema.items?.properties?.product_price).toEqual({ type: 'number' });
    expect(plan.schema.items?.properties?.product_url).toEqual({
      type: 'string',
      description: 'type hint: url',
    });
  });

  test('preserves field descriptions', () => {
    const plan = buildExtractionQueryPlan('{ price(number, "current sale price, not MSRP") }');

    expect(plan.schema.properties?.price).toEqual({
      type: 'number',
      description: 'current sale price, not MSRP',
    });
  });

  test('rejects unmatched braces with position', () => {
    expect(() => parseExtractionQuery('{ title price(number)')).toThrow(ExtractionQueryParseError);
    expect(() => parseExtractionQuery('{ title price(number)')).toThrow(/position/);
  });

  test('rejects unsupported types', () => {
    expect(() => parseExtractionQuery('{ price(currency) }')).toThrow(/Unsupported type "currency"/);
  });

  test('rejects empty list blocks', () => {
    expect(() => parseExtractionQuery('{ products[] { } }')).toThrow(/must contain at least one child field/);
  });

  test('rejects unsafe field names', () => {
    expect(() => parseExtractionQuery('{ _private }')).toThrow(/Unsafe field name/);
    expect(() => parseExtractionQuery('{ product$name }')).toThrow(/Unexpected token/);
  });

  test('query plan rejects nested object shapes outside executable v1 subset', () => {
    expect(() => buildExtractionQueryPlan('{ product { name price(number) } }')).toThrow(/Nested field/);
    expect(() => buildExtractionQueryPlan('{ products[] { variants[] { name } } }')).toThrow(/Nested field/);
  });
});
