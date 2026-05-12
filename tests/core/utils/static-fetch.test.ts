/// <reference types="jest" />
/**
 * Unit and integration tests for src/utils/static-fetch.ts.
 *
 * - isStaticSufficient: pure-function tests covering each reason code.
 * - staticFetch: integration tests against a local http.createServer fixture.
 *
 * @see https://github.com/shaun0927/openchrome/issues/885
 */

import {
  isStaticSufficient,
  staticFetch,
  StaticFetchError,
  getBodyText,
  extractBodyText,
  getStaticUserAgent,
  __resetExtractorCacheForTests,
} from '../../../src/utils/static-fetch';
import { startFixtureServer, FixtureServer } from '../../helpers/fixture-server';

// ---------------------------------------------------------------------------
// isStaticSufficient — each reason code
// ---------------------------------------------------------------------------

const richHtml = (body: string) =>
  `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;

const longText = 'word '.repeat(80); // > 200 chars

describe('isStaticSufficient', () => {
  test('returns ok for a well-formed HTML page', () => {
    const html = richHtml(`<main><p>${longText}</p></main>`);
    const result = isStaticSufficient(html, 200, 'text/html; charset=utf-8');
    expect(result).toEqual({ ok: true, reason: 'ok' });
  });

  test('rejects non-2xx status', () => {
    const html = richHtml(`<p>${longText}</p>`);
    expect(isStaticSufficient(html, 404, 'text/html')).toEqual({
      ok: false,
      reason: 'non-2xx',
    });
    expect(isStaticSufficient(html, 500, 'text/html')).toEqual({
      ok: false,
      reason: 'non-2xx',
    });
  });

  test('rejects unsupported content-type', () => {
    const html = richHtml(`<p>${longText}</p>`);
    expect(isStaticSufficient(html, 200, 'application/json')).toEqual({
      ok: false,
      reason: 'non-html',
    });
    expect(isStaticSufficient(html, 200, '')).toEqual({
      ok: false,
      reason: 'non-html',
    });
  });

  test('accepts text/html, application/xhtml+xml, text/plain', () => {
    const html = richHtml(`<p>${longText}</p>`);
    expect(isStaticSufficient(html, 200, 'text/html; charset=utf-8').ok).toBe(true);
    expect(isStaticSufficient(html, 200, 'application/xhtml+xml').ok).toBe(true);
    // text/plain with sufficient body — note: no <body> tag, so extractor uses
    // the whole document. Provide a long string.
    const plain = longText + longText;
    expect(isStaticSufficient(plain, 200, 'text/plain').ok).toBe(true);
  });

  test('rejects too-small body (< 256 bytes raw)', () => {
    const tiny = '<html><body>hi</body></html>';
    expect(isStaticSufficient(tiny, 200, 'text/html')).toEqual({
      ok: false,
      reason: 'too-small',
    });
  });

  test('rejects body whose extracted text < 200 chars', () => {
    // 256+ bytes of HTML but only a few words of visible text.
    const html =
      '<html><body><script>' + 'x'.repeat(300) + '</script><p>hi</p></body></html>';
    expect(isStaticSufficient(html, 200, 'text/html').reason).toBe('too-small');
  });

  test('rejects oversize body when OC_STATIC_MAX_BYTES is set low', () => {
    const prev = process.env.OC_STATIC_MAX_BYTES;
    process.env.OC_STATIC_MAX_BYTES = '512';
    try {
      const big = richHtml('<p>' + 'A'.repeat(5000) + '</p>');
      expect(isStaticSufficient(big, 200, 'text/html').reason).toBe('too-large');
    } finally {
      if (prev === undefined) delete process.env.OC_STATIC_MAX_BYTES;
      else process.env.OC_STATIC_MAX_BYTES = prev;
    }
  });

  test('rejects noscript "requires JavaScript" marker', () => {
    const html = richHtml(
      `<noscript>You need to enable JavaScript to run this app.</noscript><p>${longText}</p>`,
    );
    expect(isStaticSufficient(html, 200, 'text/html').reason).toBe('noscript-required');
  });

  test('rejects SPA placeholders (root / __next / app)', () => {
    for (const id of ['root', '__next', 'app']) {
      const html = `<!DOCTYPE html><html><body><div id="${id}"></div></body></html>`;
      // pad to clear the size floor
      const padded =
        html.slice(0, html.indexOf('</body>')) +
        '<!-- ' + 'x'.repeat(300) + ' -->' +
        html.slice(html.indexOf('</body>'));
      expect(isStaticSufficient(padded, 200, 'text/html').reason).toBe('spa-placeholder');
    }
  });

  test('does not classify a div#root containing element children as SPA', () => {
    const html = richHtml(
      `<div id="root"><article><p>${longText}</p></article></div>`,
    );
    expect(isStaticSufficient(html, 200, 'text/html').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getBodyText fallback — A1-independent
// ---------------------------------------------------------------------------

describe('getBodyText (regex fallback)', () => {
  test('strips scripts, styles, and tags', () => {
    const html =
      '<html><head><style>body{color:red}</style></head>' +
      '<body><script>alert(1)</script>' +
      '<h1>Title</h1><p>Hello&nbsp;world &amp; more</p></body></html>';
    const text = getBodyText(html);
    expect(text).toContain('Title');
    expect(text).toContain('Hello world & more');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
  });

  test('returns empty string for empty input', () => {
    expect(getBodyText('')).toBe('');
  });

  test('extractBodyText falls back to regex when A1 extractor is absent', () => {
    __resetExtractorCacheForTests();
    const html = '<html><body><p>plain content here</p></body></html>';
    const { text, source } = extractBodyText(html);
    expect(text).toBe('plain content here');
    expect(source).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------
// staticFetch — integration against fixture server
// ---------------------------------------------------------------------------

describe('staticFetch', () => {
  let server: FixtureServer;
  let prevTimeoutEnv: string | undefined;

  // Jest workers with heavy global mocks (puppeteer-core, chrome launcher) add
  // multi-second CPU stalls per test, which can collide with the static-fetch
  // 10s AbortController timeout even though the actual HTTP round-trip is fast
  // (<200ms against a local fixture). Bump both the per-test jest timeout and
  // the staticFetch internal timeout so the suite is deterministic in CI.
  jest.setTimeout(60000);

  beforeAll(async () => {
    prevTimeoutEnv = process.env.OC_STATIC_TIMEOUT_MS;
    process.env.OC_STATIC_TIMEOUT_MS = '45000';
    server = await startFixtureServer({
      '/plain.html': {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<html><body><p>plain document</p></body></html>',
      },
      '/redir1': {
        status: 302,
        headers: { location: '/redir2' },
        body: '',
      },
      '/redir2': {
        status: 302,
        headers: { location: '/plain.html' },
        body: '',
      },
      '/loop': {
        status: 302,
        headers: { location: '/loop' },
        body: '',
      },
      '/oversize-declared': {
        handler: (_req, res) => {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/html');
          res.setHeader('content-length', String(10 * 1024 * 1024));
          res.end('<html><body>oversize</body></html>');
        },
      },
      '/oversize-streamed': {
        handler: (_req, res) => {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/html');
          // Stream more than maxBytes (caller sets a small cap).
          res.write('<html><body>');
          res.write('A'.repeat(5000));
          res.write('B'.repeat(5000));
          res.end('</body></html>');
        },
      },
      '/non-html': {
        status: 200,
        contentType: 'application/json',
        body: '{"hello":"world"}',
      },
      '/spa.html': {
        status: 200,
        contentType: 'text/html',
        body:
          '<!DOCTYPE html><html><head><title>app</title></head>' +
          '<body><div id="root"></div><!-- ' +
          'x'.repeat(300) +
          ' --></body></html>',
      },
      '/noscript.html': {
        status: 200,
        contentType: 'text/html',
        body:
          '<html><body><noscript>You need to enable JavaScript to run this app.</noscript>' +
          '<p>' +
          'word '.repeat(80) +
          '</p></body></html>',
      },
      '/slow.html': {
        delayMs: 1000,
        status: 200,
        contentType: 'text/html',
        body: '<html><body>too late</body></html>',
      },
      '/echo-ua': {
        handler: (req, res) => {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/plain');
          res.end(String(req.headers['user-agent'] ?? ''));
        },
      },
    });
  });

  afterAll(async () => {
    await server.close();
    if (prevTimeoutEnv === undefined) delete process.env.OC_STATIC_TIMEOUT_MS;
    else process.env.OC_STATIC_TIMEOUT_MS = prevTimeoutEnv;
  });

  test('fetches a plain document', async () => {
    const result = await staticFetch(`${server.origin}/plain.html`);
    expect(result.status).toBe(200);
    expect(result.contentType).toMatch(/text\/html/);
    expect(result.html).toContain('plain document');
    expect(result.finalUrl).toBe(`${server.origin}/plain.html`);
  });

  test('follows a redirect chain (302 → 302 → 200)', async () => {
    const result = await staticFetch(`${server.origin}/redir1`);
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe(`${server.origin}/plain.html`);
    expect(result.html).toContain('plain document');
  });

  test('throws on too many redirects (loop)', async () => {
    await expect(staticFetch(`${server.origin}/loop`)).rejects.toThrow(
      /too many redirects/,
    );
  });

  test('rejects declared oversize body via Content-Length', async () => {
    await expect(
      staticFetch(`${server.origin}/oversize-declared`, { maxBytes: 1024 }),
    ).rejects.toMatchObject({ reason: 'too-large' });
  });

  test('rejects streamed oversize body', async () => {
    await expect(
      staticFetch(`${server.origin}/oversize-streamed`, { maxBytes: 1024 }),
    ).rejects.toMatchObject({ reason: 'too-large' });
  });

  test('returns non-html response (caller filters via isStaticSufficient)', async () => {
    const result = await staticFetch(`${server.origin}/non-html`);
    expect(result.status).toBe(200);
    expect(result.contentType).toMatch(/application\/json/);
    expect(isStaticSufficient(result.html, result.status, result.contentType).reason).toBe(
      'non-html',
    );
  });

  test('returns SPA shell that isStaticSufficient flags as spa-placeholder', async () => {
    const result = await staticFetch(`${server.origin}/spa.html`);
    expect(isStaticSufficient(result.html, result.status, result.contentType).reason).toBe(
      'spa-placeholder',
    );
  });

  test('returns noscript-required page that isStaticSufficient flags', async () => {
    const result = await staticFetch(`${server.origin}/noscript.html`);
    expect(isStaticSufficient(result.html, result.status, result.contentType).reason).toBe(
      'noscript-required',
    );
  });

  test('aborts when timeoutMs elapses before response', async () => {
    await expect(
      staticFetch(`${server.origin}/slow.html`, { timeoutMs: 100 }),
    ).rejects.toThrow();
  });

  test('honors external AbortSignal', async () => {
    const ac = new AbortController();
    const p = staticFetch(`${server.origin}/slow.html`, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error('client gone')), 50);
    await expect(p).rejects.toThrow();
  });

  test('sends OpenChrome-Static UA by default', async () => {
    const result = await staticFetch(`${server.origin}/echo-ua`);
    expect(result.html.startsWith('OpenChrome-Static/')).toBe(true);
  });

  test('overrides UA via OC_STATIC_USER_AGENT env', async () => {
    const prev = process.env.OC_STATIC_USER_AGENT;
    process.env.OC_STATIC_USER_AGENT = 'TestBot/1.2';
    try {
      // getStaticUserAgent reads env each call, so this picks up override.
      expect(getStaticUserAgent()).toBe('TestBot/1.2');
      const result = await staticFetch(`${server.origin}/echo-ua`);
      expect(result.html).toBe('TestBot/1.2');
    } finally {
      if (prev === undefined) delete process.env.OC_STATIC_USER_AGENT;
      else process.env.OC_STATIC_USER_AGENT = prev;
    }
  });

  test('StaticFetchError carries a reason field', async () => {
    try {
      await staticFetch(`${server.origin}/oversize-declared`, { maxBytes: 256 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StaticFetchError);
      expect((err as StaticFetchError).reason).toBe('too-large');
    }
  });
});
