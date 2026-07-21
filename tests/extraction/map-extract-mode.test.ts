/**
 * Map / Extract mode contract tests.
 */

import {
  CRAWL_MODES,
  SimpleUrlMapper,
  compileUrlPattern,
  extractLinksFromHtml,
  filterUrls,
  finaliseExtractResult,
  validateExtractSchema,
  validateMapOptions,
  type ExtractSchema,
} from '../../src/extraction/map-extract-mode';

describe('CRAWL_MODES', () => {
  it('exposes the three-mode split', () => {
    expect(CRAWL_MODES).toEqual(['scrape', 'map', 'extract']);
  });
});

describe('compileUrlPattern', () => {
  it('matches literals', () => {
    expect(compileUrlPattern('https://example.com/').test('https://example.com/')).toBe(true);
    expect(compileUrlPattern('https://example.com/').test('https://other.com/')).toBe(false);
  });

  it('supports * wildcard', () => {
    const re = compileUrlPattern('https://example.com/blog/*');
    expect(re.test('https://example.com/blog/hello')).toBe(true);
    expect(re.test('https://example.com/docs/hello')).toBe(false);
  });

  it('escapes regex metachars', () => {
    const re = compileUrlPattern('https://example.com/a.b');
    expect(re.test('https://example.com/a.b')).toBe(true);
    expect(re.test('https://example.com/aXb')).toBe(false);
  });
});

describe('extractLinksFromHtml', () => {
  const html = `
    <a href="/foo">foo</a>
    <a href='https://example.com/bar'>bar</a>
    <a href=/baz>baz</a>
    <a href="#top">anchor</a>
    <a href="javascript:void(0)">js</a>
    <a href="mailto:x@y.z">mail</a>
    <a>no href</a>
  `;

  it('resolves relative links against the base', () => {
    const links = extractLinksFromHtml(html, 'https://example.com/');
    expect(links).toContain('https://example.com/foo');
    expect(links).toContain('https://example.com/bar');
    expect(links).toContain('https://example.com/baz');
  });

  it('skips anchors, javascript:, mailto:, and href-less links', () => {
    const links = extractLinksFromHtml(html, 'https://example.com/');
    expect(links.some((l) => l.startsWith('javascript:'))).toBe(false);
    expect(links.some((l) => l.startsWith('mailto:'))).toBe(false);
    expect(links.some((l) => l.endsWith('#top'))).toBe(false);
  });

  it('dedupes', () => {
    const links = extractLinksFromHtml('<a href="/x">1</a><a href="/x">2</a>', 'https://e.com');
    expect(links).toEqual(['https://e.com/x']);
  });
});

describe('filterUrls', () => {
  const seed = 'https://example.com/docs/';
  const urls = [
    'https://example.com/docs/a',
    'https://example.com/docs/b',
    'https://example.com/blog/c',
    'https://other.com/x',
    'https://example.com/docs/private/y',
  ];

  it('honours sameDomainOnly', () => {
    const out = filterUrls(urls, seed, { sameDomainOnly: true });
    expect(out).not.toContain('https://other.com/x');
    expect(out).toContain('https://example.com/blog/c');
  });

  it('honours subpathsOnly', () => {
    const out = filterUrls(urls, seed, { subpathsOnly: true });
    expect(out).toContain('https://example.com/docs/a');
    expect(out).not.toContain('https://example.com/blog/c');
  });

  it('applies includePatterns then excludePatterns', () => {
    const out = filterUrls(urls, seed, {
      includePatterns: ['https://example.com/docs/*'],
      excludePatterns: ['*/private/*'],
    });
    expect(out).toContain('https://example.com/docs/a');
    expect(out).not.toContain('https://example.com/docs/private/y');
  });
});

describe('validateMapOptions', () => {
  it('accepts undefined', () => {
    expect(validateMapOptions(undefined).ok).toBe(true);
  });

  it('rejects non-positive limits', () => {
    expect(validateMapOptions({ limit: 0 }).ok).toBe(false);
    expect(validateMapOptions({ limit: -5 }).ok).toBe(false);
  });

  it('rejects limits above the hard cap', () => {
    expect(validateMapOptions({ limit: 50001 }).ok).toBe(false);
  });

  it('rejects empty include-pattern entries', () => {
    expect(validateMapOptions({ includePatterns: [''] }).ok).toBe(false);
  });
});

describe('validateExtractSchema', () => {
  it('accepts a well-formed schema', () => {
    const schema: ExtractSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    expect(validateExtractSchema(schema).ok).toBe(true);
  });

  it('rejects non-object schema.type', () => {
    // deliberately mistyped
    const schema = { type: 'string', properties: {} } as unknown as ExtractSchema;
    expect(validateExtractSchema(schema).ok).toBe(false);
  });

  it('rejects required fields not present in properties', () => {
    const schema: ExtractSchema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['b'],
    };
    expect(validateExtractSchema(schema).ok).toBe(false);
  });

  it('rejects empty properties', () => {
    const schema: ExtractSchema = { type: 'object', properties: {} };
    expect(validateExtractSchema(schema).ok).toBe(false);
  });
});

describe('finaliseExtractResult', () => {
  const schema: ExtractSchema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      price: { type: 'number' },
    },
    required: ['title', 'price'],
  };

  it('marks complete when every required field is present', () => {
    const result = finaliseExtractResult('u', { title: 'x', price: 9 }, schema);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('reports missing required fields', () => {
    const result = finaliseExtractResult('u', { title: 'x' }, schema);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['price']);
  });

  it('treats null and empty string as missing', () => {
    const result = finaliseExtractResult('u', { title: '', price: null as unknown as number }, schema);
    expect(result.missing.sort()).toEqual(['price', 'title']);
  });
});

describe('SimpleUrlMapper', () => {
  it('maps DOM anchors into a MapModeResult', async () => {
    const html = '<a href="/a">a</a><a href="/b">b</a>';
    const mapper = new SimpleUrlMapper(async () => html);
    const result = await mapper.map('https://example.com/');
    expect(result.urls.sort()).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(result.sources['https://example.com/a']).toBe('dom');
    expect(result.truncated).toBe(false);
  });

  it('truncates at the configured limit', async () => {
    const html = Array.from({ length: 20 }, (_, i) => `<a href="/${i}">${i}</a>`).join('');
    const mapper = new SimpleUrlMapper(async () => html);
    const result = await mapper.map('https://e.com/', { limit: 5 });
    expect(result.urls.length).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('throws when options fail validation', async () => {
    const mapper = new SimpleUrlMapper(async () => '');
    await expect(mapper.map('https://e.com/', { limit: -1 })).rejects.toThrow(
      /Invalid map options/,
    );
  });
});
