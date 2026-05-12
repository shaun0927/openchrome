import { buildExtractionPlan } from '../../src/extraction/plan';
import { buildCssHeuristicExtractor, buildJsonLdExtractor } from '../../src/extraction/strategies';

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
});
