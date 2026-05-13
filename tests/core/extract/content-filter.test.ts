import { applyContentFilter } from '../../../src/core/extract/content-filter';

describe('fit_markdown content filter', () => {
  const fixture = [
    '# Product Docs',
    '',
    'Home Login Subscribe Cookie settings Privacy Policy Terms',
    '',
    '## Enterprise Pricing',
    '',
    'Enterprise pricing includes annual discounts, support, and SSO.',
    '',
    '## API Example',
    '',
    '```ts\nconst price = "enterprise";\n```',
    '',
    '| Plan | Price |\n| --- | --- |\n| Enterprise | Contact us |',
    '',
    'Footer navigation and advertising links.',
  ].join('\n');

  it('prunes boilerplate while preserving headings, paragraphs, code, and tables', () => {
    const result = applyContentFilter(fixture, { type: 'prune', returnRaw: true, returnFit: true });

    expect(result.raw_markdown).toBe(fixture);
    expect(result.fit_markdown).toContain('# Product Docs');
    expect(result.fit_markdown).toContain('Enterprise pricing');
    expect(result.fit_markdown).toContain('```ts');
    expect(result.fit_markdown).toContain('| Enterprise | Contact us |');
    expect(result.fit_markdown).not.toContain('Cookie settings');
    expect(result.filter.type).toBe('prune');
    expect(result.filter.raw_chars).toBe(fixture.length);
    expect(result.filter.fit_chars).toBe(result.fit_markdown!.length);
    expect(result.filter.reduction_ratio).toBeGreaterThan(0);
  });

  it('bm25 keeps query-relevant sections and rejects missing query', () => {
    const result = applyContentFilter(fixture, { type: 'bm25', query: 'enterprise pricing support', maxSections: 3 });

    expect(result.content).toContain('Enterprise Pricing');
    expect(result.filter.query).toBe('enterprise pricing support');
    expect(() => applyContentFilter(fixture, { type: 'bm25' })).toThrow('requires a non-empty query');
  });

  it('content_filter none preserves raw content and omits fit markdown unless filtered', () => {
    const result = applyContentFilter(fixture, { type: 'none', returnRaw: true, returnFit: true });

    expect(result.content).toBe(fixture);
    expect(result.raw_markdown).toBe(fixture);
    expect(result.fit_markdown).toBeUndefined();
    expect(result.filter.type).toBe('none');
  });
});
