import { buildExtractionPlan } from '../../src/extraction/plan';
import { buildCssHeuristicExtractor, buildJsonLdExtractor, buildOpenGraphExtractor } from '../../src/extraction/strategies';

function runExtractor<T>(script: string, documentMock: unknown): T {
  const previous = (global as any).document;
  (global as any).document = documentMock;
  try {
    // Strategy builders intentionally return an IIFE string for page.evaluate.
    return eval(script) as T;
  } finally {
    (global as any).document = previous;
  }
}

describe('schema-aware extraction strategies', () => {
  test('JSON-LD resolves headline from name alias', () => {
    const plan = buildExtractionPlan({ headline: { type: 'string' } });
    const script = buildJsonLdExtractor(plan.fields);
    const documentMock = {
      querySelectorAll: (selector: string) => selector === 'script[type="application/ld+json"]'
        ? [{ textContent: JSON.stringify({ '@type': 'Article', name: 'Alias headline' }) }]
        : [],
    };

    expect(runExtractor<Record<string, unknown>>(script, documentMock)).toEqual({ headline: 'Alias headline' });
  });

  test('CSS heuristic resolves salePrice from .price alias and coerces later', () => {
    const schemaProps = {
      salePrice: { type: 'number', description: 'discounted current product price' },
    };
    const plan = buildExtractionPlan(schemaProps);
    const priceElement = {
      tagName: 'SPAN',
      textContent: '$19.99',
      hasAttribute: () => false,
      getAttribute: () => null,
    };
    const root = {
      querySelector: (selector: string) => selector.includes('price') ? priceElement : null,
    };
    const documentMock = {
      body: root,
      querySelector: () => root,
    };

    const result = runExtractor<Record<string, unknown>>(
      buildCssHeuristicExtractor(plan.fields, schemaProps),
      documentMock,
    );

    expect(result).toEqual({ salePrice: '$19.99' });
  });

  test('OpenGraph resolves site_name after alias normalization', () => {
    const plan = buildExtractionPlan({ site_name: { type: 'string' } });
    const script = buildOpenGraphExtractor(plan.fields);
    const documentMock = {
      querySelector: (selector: string) => selector === 'meta[property="og:site_name"]'
        ? { getAttribute: (name: string) => name === 'content' ? 'OpenChrome' : null }
        : null,
    };

    expect(runExtractor<Record<string, unknown>>(script, documentMock)).toEqual({ site_name: 'OpenChrome' });
  });
});

test('JSON-LD ignores inherited enumerable properties when matching aliases', () => {
  const plan = buildExtractionPlan({ headline: { type: 'string' } });
  const script = buildJsonLdExtractor(plan.fields);
  const documentMock = {
    querySelectorAll: (selector: string) => selector === 'script[type="application/ld+json"]'
      ? [{ textContent: JSON.stringify({ description: 'own description' }) }]
      : [],
  };

  Object.defineProperty(Object.prototype, 'headline', {
    configurable: true,
    enumerable: true,
    value: 'inherited headline',
  });
  try {
    expect(runExtractor<Record<string, unknown>>(script, documentMock)).toEqual({});
  } finally {
    delete (Object.prototype as { headline?: string }).headline;
  }
});


test('JSON-LD own alias is not suppressed by inherited result fields', () => {
  const plan = buildExtractionPlan({ headline: { type: 'string' } });
  const script = buildJsonLdExtractor(plan.fields);
  const documentMock = {
    querySelectorAll: (selector: string) => selector === 'script[type="application/ld+json"]'
      ? [{ textContent: JSON.stringify({ name: 'Own headline' }) }]
      : [],
  };

  Object.defineProperty(Object.prototype, 'headline', {
    configurable: true,
    enumerable: true,
    value: 'inherited headline',
  });
  try {
    expect(runExtractor<Record<string, unknown>>(script, documentMock)).toEqual({ headline: 'Own headline' });
  } finally {
    delete (Object.prototype as { headline?: string }).headline;
  }
});

test('JSON-LD scalar projection: string field extracts ratingValue from object', () => {
  // When schema declares type: "string", val() should project ratingValue from the nested object
  const plan = buildExtractionPlan({ rating: { type: 'string' } });
  const script = buildJsonLdExtractor(plan.fields);
  const documentMock = {
    querySelectorAll: (selector: string) => selector === 'script[type="application/ld+json"]'
      ? [{ textContent: JSON.stringify({ '@type': 'Product', aggregateRating: { ratingValue: '4.7', reviewCount: 120 } }) }]
      : [],
  };

  const result = runExtractor<Record<string, unknown>>(script, documentMock);
  // rating alias matches aggregateRating; ratingValue projected from the nested object
  expect(result.rating).toBe('4.7');
});

test('JSON-LD object-typed field preserves nested object as-is', () => {
  // When schema declares type: "object", val() should return the raw nested value
  const plan = buildExtractionPlan({ aggregateRating: { type: 'object', properties: { ratingValue: { type: 'string' } } } });
  const script = buildJsonLdExtractor(plan.fields);
  const nestedRating = { ratingValue: '4.7', reviewCount: 120 };
  const documentMock = {
    querySelectorAll: (selector: string) => selector === 'script[type="application/ld+json"]'
      ? [{ textContent: JSON.stringify({ '@type': 'Product', aggregateRating: nestedRating }) }]
      : [],
  };

  const result = runExtractor<Record<string, unknown>>(script, documentMock);
  expect(result.aggregateRating).toEqual(nestedRating);
});

test('JSON-LD scalar projection: number field extracts @value from typed value object', () => {
  // When schema declares type: "number", val() should project @value from { "@value": "4.7" }
  const plan = buildExtractionPlan({ price: { type: 'number' } });
  const script = buildJsonLdExtractor(plan.fields);
  const documentMock = {
    querySelectorAll: (selector: string) => selector === 'script[type="application/ld+json"]'
      ? [{ textContent: JSON.stringify({ '@type': 'Offer', price: { '@value': '29.99' } }) }]
      : [],
  };

  const result = runExtractor<Record<string, unknown>>(script, documentMock);
  expect(result.price).toBe('29.99');
});

test('JSON-LD untyped field preserves raw object value', () => {
  // When no type declared, val() should preserve the value as-is (no projection)
  const plan = buildExtractionPlan({ brand: {} });
  const script = buildJsonLdExtractor(plan.fields);
  const brandObj = { '@type': 'Brand', name: 'Acme' };
  const documentMock = {
    querySelectorAll: (selector: string) => selector === 'script[type="application/ld+json"]'
      ? [{ textContent: JSON.stringify({ '@type': 'Product', brand: brandObj }) }]
      : [],
  };

  const result = runExtractor<Record<string, unknown>>(script, documentMock);
  expect(result.brand).toEqual(brandObj);
});
