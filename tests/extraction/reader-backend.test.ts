import {
  getReaderBackend,
  listReaderBackends,
  pickBackendFor,
  registerReaderBackend,
  resetReaderBackendsForTests,
  type ReaderBackend,
} from '../../src/extraction/reader-backend';

describe('reader-backend registry (P15)', () => {
  beforeEach(() => resetReaderBackendsForTests());

  const urlBackend: ReaderBackend = {
    name: 'jina-reader',
    capabilities: ['url'],
    async fromUrl(input) {
      return {
        markdown: `# from ${input.url}`,
        backend: 'jina-reader',
        resolvedUrl: input.url,
        inputBytes: 0,
        elapsedMs: 1,
      };
    },
  };

  const htmlBackend: ReaderBackend = {
    name: 'local-html',
    capabilities: ['html'],
    async fromHtml(input) {
      return {
        markdown: `raw:${input.html}`,
        backend: 'local-html',
        resolvedUrl: input.url,
        inputBytes: input.html.length,
        elapsedMs: 2,
      };
    },
  };

  test('registerReaderBackend + getReaderBackend round-trip', () => {
    registerReaderBackend(urlBackend);
    expect(getReaderBackend('jina-reader')).toBe(urlBackend);
  });

  test('listReaderBackends returns all registered', () => {
    registerReaderBackend(urlBackend);
    registerReaderBackend(htmlBackend);
    expect(listReaderBackends().map((b) => b.name).sort()).toEqual(['jina-reader', 'local-html']);
  });

  test('pickBackendFor(url) returns a url-capable backend', () => {
    registerReaderBackend(htmlBackend);
    registerReaderBackend(urlBackend);
    expect(pickBackendFor('url')).toBe(urlBackend);
  });

  test('pickBackendFor(html) returns an html-capable backend', () => {
    registerReaderBackend(urlBackend);
    registerReaderBackend(htmlBackend);
    expect(pickBackendFor('html')).toBe(htmlBackend);
  });

  test('pickBackendFor returns undefined when no match', () => {
    registerReaderBackend(urlBackend);
    expect(pickBackendFor('html')).toBeUndefined();
  });

  test('overwrites on re-register (last wins)', () => {
    registerReaderBackend(urlBackend);
    const replacement: ReaderBackend = { ...urlBackend, capabilities: ['url'] };
    registerReaderBackend(replacement);
    expect(getReaderBackend('jina-reader')).toBe(replacement);
  });

  test('rejects backend with missing name', () => {
    expect(() => registerReaderBackend({ name: '', capabilities: ['url'] } as any)).toThrow(TypeError);
  });

  test('rejects backend with empty capabilities', () => {
    expect(() => registerReaderBackend({ name: 'x', capabilities: [] } as any)).toThrow(TypeError);
  });

  test('rejects url capability without fromUrl', () => {
    expect(() => registerReaderBackend({ name: 'x', capabilities: ['url'] } as any)).toThrow(TypeError);
  });

  test('rejects html capability without fromHtml', () => {
    expect(() => registerReaderBackend({ name: 'x', capabilities: ['html'] } as any)).toThrow(TypeError);
  });

  test('backend contract — fromUrl returns ReaderResult', async () => {
    const r = await urlBackend.fromUrl!({ url: 'https://example.com/x' });
    expect(r.backend).toBe('jina-reader');
    expect(r.markdown).toContain('example.com');
    expect(r.resolvedUrl).toBe('https://example.com/x');
  });
});
