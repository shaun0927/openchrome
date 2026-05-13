/// <reference types="jest" />
/**
 * Integration tests for the engine waterfall added to src/tools/crawl.ts and
 * src/tools/crawl-sitemap.ts (Issue #885).
 *
 * The CDP path is mocked via getSessionManager — we assert how many tabs
 * `createTarget` opens for each engine mode. The static path hits a real local
 * HTTP fixture server, so no Chrome is required.
 *
 * @see https://github.com/shaun0927/openchrome/issues/885
 */

import { createMockSessionManager } from '../../utils/mock-session';
import { startFixtureServer, FixtureServer } from '../../helpers/fixture-server';

jest.mock('../../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../../src/session-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolHandler = (
  sessionId: string,
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

async function loadHandler(name: 'crawl' | 'crawl_sitemap'): Promise<ToolHandler> {
  jest.resetModules();
  // Re-mock after resetModules so the dynamic import picks up the mock.
  jest.doMock('../../../src/session-manager', () => ({
    getSessionManager: () => mockSessionManager,
  }));
  const mod = await import(
    name === 'crawl' ? '../../../src/tools/crawl' : '../../../src/tools/crawl-sitemap'
  );
  const tools: Map<string, { handler: ToolHandler }> = new Map();
  const mockServer = {
    registerTool: (toolName: string, handler: ToolHandler) => {
      tools.set(toolName, { handler });
    },
  };
  if (name === 'crawl') {
    (mod as typeof import('../../../src/tools/crawl')).registerCrawlTool(
      mockServer as never,
    );
  } else {
    (mod as typeof import('../../../src/tools/crawl-sitemap')).registerCrawlSitemapTool(
      mockServer as never,
    );
  }
  return tools.get(name)!.handler;
}

// Module-level mock session manager so loadHandler's jest.doMock can capture it.
let mockSessionManager: ReturnType<typeof createMockSessionManager>;

function parseResult(result: { content: Array<{ type: string; text: string }> }): {
  summary: Record<string, unknown>;
  pages: Array<Record<string, unknown>>;
} {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Fixture server — shared across tests in this file.
// ---------------------------------------------------------------------------

const RICH_HTML = (title: string, body: string) =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const PARA = 'word '.repeat(80); // > 200 chars of extracted text

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({
    '/robots.txt': {
      status: 200,
      contentType: 'text/plain',
      body: 'User-agent: *\nDisallow:\n',
    },
    '/index.html': {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML(
        'Index',
        `<h1>Index</h1><p>${PARA}</p>` +
          `<a href="/page-a.html">A</a><a href="/page-b.html">B</a>` +
          `<a href="javascript:void(0)">skip</a>`,
      ),
    },
    '/page-a.html': {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML('Page A', `<h1>Page A</h1><p>${PARA}</p>`),
    },
    '/page-b.html': {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML('Page B', `<h1>Page B</h1><p>${PARA}</p>`),
    },
    '/best-start.html': {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML(
        'Best Start',
        `<h1>Best Start</h1><p>${PARA}</p>` +
          `<a href="/blog/company-update.html">Blog first</a>` +
          `<a href="/pricing/enterprise-limits.html">Pricing second</a>`,
      ),
    },
    '/blog/company-update.html': {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML('Company Update', `<h1>Company Update</h1><p>${PARA}</p>`),
    },
    '/pricing/enterprise-limits.html': {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML('Enterprise Limits', `<h1>Enterprise Limits</h1><p>${PARA}</p>`),
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
    '/sitemap.xml': {
      status: 200,
      contentType: 'application/xml',
      body:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        // Use placeholder; rewritten at request time below — not needed since fixture
        // routes are absolute. We register the absolute URLs in a dedicated route.
        '</urlset>',
    },
  });
  // Register a sitemap that points to absolute URLs on the fixture server.
  server.setRoute('/sitemap.xml', {
    status: 200,
    contentType: 'application/xml',
    body:
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      `<url><loc>${server.origin}/page-a.html</loc></url>` +
      `<url><loc>${server.origin}/page-b.html</loc></url>` +
      '</urlset>',
  });
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  mockSessionManager = createMockSessionManager();
  (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
});

afterEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// crawl({ engine: 'static' }) — zero Chrome tabs
// ---------------------------------------------------------------------------

describe('crawl engine=static', () => {
  test('opens 0 Chrome tabs for an all-HTML site', async () => {
    const handler = await loadHandler('crawl');
    const result = await handler('s1', {
      url: `${server.origin}/index.html`,
      max_pages: 5,
      max_depth: 1,
      delay_ms: 0,
      engine: 'static',
    });
    expect(result.isError).not.toBe(true);
    const parsed = parseResult(result);
    expect(parsed.pages.length).toBeGreaterThanOrEqual(1);
    expect((parsed.summary as { succeeded: number }).succeeded).toBeGreaterThanOrEqual(1);
    for (const page of parsed.pages) {
      expect(page.engine_used).toBe('static');
    }
    expect(mockSessionManager.createTarget).not.toHaveBeenCalled();
  });

  test('paginates returned pages with crawl cursor metadata', async () => {
    const links = Array.from({ length: 29 }, (_, i) => {
      const n = i + 1;
      server.setRoute(`/many-${n}.html`, {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: RICH_HTML(`Many ${n}`, `<h1>Many ${n}</h1><p>${PARA}</p>`),
      });
      return `<a href="/many-${n}.html">Many ${n}</a>`;
    }).join('');
    server.setRoute('/many-start.html', {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML('Many Start', `<h1>Many Start</h1><p>${PARA}</p>${links}`),
    });

    const handler = await loadHandler('crawl');
    const first = await handler('s-cursor-1', {
      url: `${server.origin}/many-start.html`,
      max_pages: 30,
      max_depth: 1,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
    }) as any;

    expect(first.isError).not.toBe(true);
    expect(first.structuredContent.pages).toHaveLength(25);
    expect(first.structuredContent.offset).toBe(0);
    expect(first.structuredContent.total).toBe(30);
    expect(first.structuredContent.hasMore).toBe(true);
    expect(first.structuredContent.nextCursor).toEqual(expect.any(String));
    // Legacy no-cursor text remains the full crawl result.
    expect(parseResult(first).pages).toHaveLength(30);

    const second = await handler('s-cursor-2', {
      url: `${server.origin}/many-start.html`,
      max_pages: 30,
      max_depth: 1,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
      cursor: first.structuredContent.nextCursor,
    }) as any;

    expect(JSON.parse(second.content[0].text)).toEqual(second.structuredContent);
    expect(second.structuredContent.pages).toHaveLength(5);
    expect(second.structuredContent.offset).toBe(25);
    expect(second.structuredContent.total).toBe(30);
    expect(second.structuredContent.hasMore).toBe(false);
  });

  test('rejects malformed and stale crawl cursors', async () => {
    server.setRoute('/stale-start.html', {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML('Stale Start', `<h1>Stale Start</h1><p>${PARA}</p>${Array.from({ length: 25 }, (_, i) => `<a href="/stale-${i}.html">S${i}</a>`).join('')}`),
    });
    for (let i = 0; i < 25; i++) {
      server.setRoute(`/stale-${i}.html`, {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: RICH_HTML(`Stale ${i}`, `<h1>Stale ${i}</h1><p>${PARA}</p>`),
      });
    }

    const handler = await loadHandler('crawl');
    const malformed = await handler('s-cursor-bad', {
      url: `${server.origin}/stale-start.html`,
      max_pages: 26,
      max_depth: 1,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
      cursor: 'bad-cursor',
    }) as any;
    expect(malformed.isError).toBe(true);
    expect(malformed.structuredContent.error.code).toBe('invalid_cursor');

    const first = await handler('s-cursor-stale-1', {
      url: `${server.origin}/stale-start.html`,
      max_pages: 26,
      max_depth: 1,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
    }) as any;
    server.setRoute('/stale-24.html', {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML('Stale changed', `<h1>Stale changed</h1><p>${PARA}</p>`),
    });

    const stale = await handler('s-cursor-stale-2', {
      url: `${server.origin}/stale-start.html`,
      max_pages: 26,
      max_depth: 1,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
      cursor: first.structuredContent.nextCursor,
    }) as any;
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent.error).toEqual({ code: 'stale_cursor', retry: 'restart_from_no_cursor' });
  });


  test('include_metrics adds summary and per-page token estimates without changing default', async () => {
    const handler = await loadHandler('crawl');
    const withMetrics = await handler('s-metrics', {
      url: `${server.origin}/index.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
      include_metrics: true,
    });
    const parsedWithMetrics = parseResult(withMetrics);
    const summaryMetrics = parsedWithMetrics.summary.metrics as Record<string, number>;
    expect(summaryMetrics.returned_chars).toBeGreaterThan(0);
    expect(summaryMetrics.estimated_tokens).toBeGreaterThan(0);
    expect(parsedWithMetrics.pages[0].metrics).toMatchObject({
      mode: 'markdown',
      truncated: false,
    });

    const withoutMetrics = await handler('s-metrics-default', {
      url: `${server.origin}/index.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
    });
    const parsedWithoutMetrics = parseResult(withoutMetrics);
    expect(parsedWithoutMetrics.summary.metrics).toBeUndefined();
    expect(parsedWithoutMetrics.pages[0].metrics).toBeUndefined();
  });

  test('respect_robots:true does not open a Chrome tab for robots.txt', async () => {
    const handler = await loadHandler('crawl');
    await handler('s2', {
      url: `${server.origin}/index.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: true,
    });
    expect(mockSessionManager.createTarget).not.toHaveBeenCalled();
    expect(server.hitCount('/robots.txt')).toBeGreaterThanOrEqual(1);
  });

  test('reports static-insufficient for SPA shell when engine=static', async () => {
    const handler = await loadHandler('crawl');
    const result = await handler('s3', {
      url: `${server.origin}/spa.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
    });
    const parsed = parseResult(result);
    expect(parsed.pages[0].error).toMatch(/static-insufficient: spa-placeholder/);
    expect(parsed.pages[0].engine_used).toBe('static');
    expect(parsed.pages[0].static_reason).toBe('spa-placeholder');
    expect(mockSessionManager.createTarget).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// crawl({ engine: 'cdp' }) — robots.txt still uses static-fetch
// ---------------------------------------------------------------------------

describe('crawl engine=cdp', () => {
  test('robots.txt fetch does not open a Chrome tab even in cdp mode', async () => {
    const handler = await loadHandler('crawl');
    // For the page itself we expect a tab attempt — but we don't care about the
    // outcome, only that robots.txt did NOT create a tab. The page fetch will
    // hit the mock session manager (createMockPage). Track tab URLs.
    await handler('s4', {
      url: `${server.origin}/page-a.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'cdp',
      respect_robots: true,
    });
    const robotsCalls = (
      mockSessionManager.createTarget as jest.Mock
    ).mock.calls.filter((c: unknown[]) => String(c[1]).endsWith('/robots.txt'));
    expect(robotsCalls.length).toBe(0);
    expect(server.hitCount('/robots.txt')).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// crawl({ engine: 'auto' }) — fall back to CDP on insufficient
// ---------------------------------------------------------------------------

describe('crawl engine=auto', () => {
  test('static path serves plain HTML without opening tabs', async () => {
    const handler = await loadHandler('crawl');
    const result = await handler('s5', {
      url: `${server.origin}/index.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'auto',
      respect_robots: false,
    });
    const parsed = parseResult(result);
    expect(parsed.pages[0].engine_used).toBe('static');
    expect(parsed.pages[0].static_reason).toBeUndefined();
    expect(mockSessionManager.createTarget).not.toHaveBeenCalled();
  });

  test('falls back to CDP for SPA placeholder', async () => {
    const handler = await loadHandler('crawl');
    const result = await handler('s6', {
      url: `${server.origin}/spa.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'auto',
      respect_robots: false,
    });
    const parsed = parseResult(result);
    expect(parsed.pages[0].engine_used).toBe('cdp');
    expect(parsed.pages[0].static_reason).toBe('spa-placeholder');
    // mock createTarget called for the SPA page fallback
    expect(mockSessionManager.createTarget).toHaveBeenCalled();
    const calls = (mockSessionManager.createTarget as jest.Mock).mock.calls;
    expect(calls.some((c: unknown[]) => String(c[1]).endsWith('/spa.html'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Default behavior — no engine argument is backward-compatible (no
// engine_used field emitted; CDP path used).
// ---------------------------------------------------------------------------

describe('crawl default behavior (no engine arg)', () => {
  test('does not emit engine_used / static_reason fields', async () => {
    const handler = await loadHandler('crawl');
    const result = await handler('s7', {
      url: `${server.origin}/page-a.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      respect_robots: false,
    });
    const parsed = parseResult(result);
    expect(parsed.pages[0].engine_used).toBeUndefined();
    expect(parsed.pages[0].static_reason).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// crawl({ strategy: 'best_first' }) — URL scoring orders discovered links.
// ---------------------------------------------------------------------------

describe('crawl strategy=best_first', () => {
  test('visits higher-scoring discovered URLs before lower-scoring URLs', async () => {
    const handler = await loadHandler('crawl');
    const result = await handler('s-best', {
      url: `${server.origin}/best-start.html`,
      max_pages: 3,
      max_depth: 1,
      delay_ms: 0,
      concurrency: 1,
      engine: 'static',
      respect_robots: false,
      strategy: 'best_first',
      query: 'enterprise pricing limits',
      url_score: {
        keywords: ['pricing', 'enterprise', 'limits'],
        prefer_paths: ['/pricing'],
        exclude_paths: ['/blog'],
      },
    });
    const parsed = parseResult(result);
    expect(parsed.summary.strategy).toBe('best_first');
    expect(parsed.summary.scored_urls).toBeGreaterThanOrEqual(3);
    expect(parsed.pages.map((p) => p.url)).toEqual([
      `${server.origin}/best-start.html`,
      `${server.origin}/pricing/enterprise-limits.html`,
      `${server.origin}/blog/company-update.html`,
    ]);
    expect(parsed.pages[1].score).toBeGreaterThan(parsed.pages[2].score as number);
    expect(parsed.pages[1].score_reasons).toEqual(expect.arrayContaining([
      'keyword:pricing',
      'keyword:enterprise',
      'keyword:limits',
      'path:/pricing',
    ]));
  });

  test('keeps default crawl output free of strategy metadata', async () => {
    const handler = await loadHandler('crawl');
    const result = await handler('s-best-default', {
      url: `${server.origin}/best-start.html`,
      max_pages: 2,
      max_depth: 1,
      delay_ms: 0,
      concurrency: 1,
      engine: 'static',
      respect_robots: false,
    });
    const parsed = parseResult(result);
    expect(parsed.summary.strategy).toBeUndefined();
    expect(parsed.pages[0].score).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// crawl_sitemap engine plumbing
// ---------------------------------------------------------------------------

describe('crawl_sitemap engine=static', () => {
  test('crawls sitemap pages without opening Chrome tabs', async () => {
    const handler = await loadHandler('crawl_sitemap');
    const result = await handler('s8', {
      url: server.origin,
      max_pages: 5,
      concurrency: 2,
      engine: 'static',
    });
    expect(result.isError).not.toBe(true);
    const parsed = parseResult(result);
    expect(parsed.pages.length).toBe(2);
    for (const page of parsed.pages) {
      expect(page.engine_used).toBe('static');
    }
    expect(mockSessionManager.createTarget).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// crawl content cache modes (#987)
// ---------------------------------------------------------------------------

describe('crawl cache modes', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'openchrome-crawl-cache-'));
    process.env.OPENCHROME_CRAWL_CACHE_DIR = cacheDir;
    server.setRoute('/cache.html', {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML('Cacheable', `<h1>Cacheable</h1><p>${PARA}</p>`),
    });
    server.setRoute('/account.html', {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML('Account Settings', '<form><input type="password" name="password" /></form>' + PARA),
    });
  });

  afterEach(() => {
    delete process.env.OPENCHROME_CRAWL_CACHE_DIR;
    require('fs').rmSync(cacheDir, { recursive: true, force: true });
  });

  test('default cache_mode disabled preserves output shape and does not write files', async () => {
    const handler = await loadHandler('crawl');
    const result = await handler('cache-default', {
      url: `${server.origin}/cache.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
    });
    const parsed = parseResult(result);
    expect(parsed.pages[0].cache).toBeUndefined();
    expect(require('fs').readdirSync(cacheDir)).toEqual([]);
  });

  test('enabled mode stores then serves a hit without fetching the page again', async () => {
    const handler = await loadHandler('crawl');
    const before = server.hitCount('/cache.html');
    const first = parseResult(await handler('cache-enabled', {
      url: `${server.origin}/cache.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
      cache_mode: 'enabled',
      cache_ttl_ms: 60_000,
    }));
    expect(first.pages[0].cache).toMatchObject({ status: 'miss', write: 'stored', hit: false });
    expect(server.hitCount('/cache.html')).toBe(before + 1);

    const second = parseResult(await handler('cache-enabled', {
      url: `${server.origin}/cache.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
      cache_mode: 'enabled',
      cache_ttl_ms: 60_000,
    }));
    expect(second.pages[0].cache).toMatchObject({ status: 'hit', hit: true });
    expect(server.hitCount('/cache.html')).toBe(before + 1);
  });


  test('enabled cache still enforces robots.txt before serving a hit', async () => {
    const handler = await loadHandler('crawl');
    server.setRoute('/robots.txt', {
      status: 200,
      contentType: 'text/plain',
      body: 'User-agent: *\nDisallow:\n',
    });
    parseResult(await handler('cache-robots', {
      url: `${server.origin}/cache.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: true,
      cache_mode: 'enabled',
      cache_ttl_ms: 60_000,
    }));

    server.setRoute('/robots.txt', {
      status: 200,
      contentType: 'text/plain',
      body: 'User-agent: *\nDisallow: /cache.html\n',
    });
    const blocked = parseResult(await handler('cache-robots', {
      url: `${server.origin}/cache.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: true,
      cache_mode: 'enabled',
      cache_ttl_ms: 60_000,
    }));

    expect(blocked.pages[0]).toMatchObject({ error: 'Blocked by robots.txt' });
    expect(blocked.pages[0].cache).toBeUndefined();
  });

  test('read_only does not create entries on miss and write_only never serves hits', async () => {
    const handler = await loadHandler('crawl');
    const before = server.hitCount('/cache.html');
    const readOnly = parseResult(await handler('cache-read-only', {
      url: `${server.origin}/cache.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
      cache_mode: 'read_only',
    }));
    expect(readOnly.pages[0].cache).toMatchObject({ status: 'miss', write: 'disabled' });
    expect(require('fs').readdirSync(cacheDir)).toEqual([]);

    const writeOnlyA = parseResult(await handler('cache-write-only', {
      url: `${server.origin}/cache.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
      cache_mode: 'write_only',
    }));
    const writeOnlyB = parseResult(await handler('cache-write-only', {
      url: `${server.origin}/cache.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
      cache_mode: 'write_only',
    }));
    expect(writeOnlyA.pages[0].cache).toMatchObject({ status: 'write_only', write: 'stored' });
    expect(writeOnlyB.pages[0].cache).toMatchObject({ status: 'write_only', write: 'stored' });
    expect(server.hitCount('/cache.html')).toBe(before + 3);
  });

  test('bypass overwrites and public scope skips auth-sensitive pages', async () => {
    const handler = await loadHandler('crawl');
    const bypass = parseResult(await handler('cache-bypass', {
      url: `${server.origin}/cache.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
      cache_mode: 'bypass',
    }));
    expect(bypass.pages[0].cache).toMatchObject({ status: 'bypass', write: 'stored' });

    const sensitive = parseResult(await handler('cache-sensitive', {
      url: `${server.origin}/account.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
      cache_mode: 'enabled',
    }));
    expect(sensitive.pages[0].cache).toMatchObject({ status: 'miss', write: 'skipped' });
    expect(String((sensitive.pages[0].cache as Record<string, unknown>).write_skipped_reason)).toMatch(/auth-sensitive/);
  });
});

describe('crawl_sitemap cache_mode=enabled', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'openchrome-sitemap-cache-'));
    process.env.OPENCHROME_CRAWL_CACHE_DIR = cacheDir;
  });

  afterEach(() => {
    delete process.env.OPENCHROME_CRAWL_CACHE_DIR;
    require('fs').rmSync(cacheDir, { recursive: true, force: true });
  });

  test('stores sitemap page content and serves later page hits from cache', async () => {
    const handler = await loadHandler('crawl_sitemap');
    const before = server.hitCount('/page-a.html');
    const first = parseResult(await handler('sitemap-cache', {
      url: server.origin,
      max_pages: 1,
      concurrency: 1,
      engine: 'static',
      cache_mode: 'enabled',
      cache_ttl_ms: 60_000,
    }));
    expect(first.pages[0].cache).toMatchObject({ status: 'miss', write: 'stored' });
    expect(server.hitCount('/page-a.html')).toBe(before + 1);

    const second = parseResult(await handler('sitemap-cache', {
      url: server.origin,
      max_pages: 1,
      concurrency: 1,
      engine: 'static',
      cache_mode: 'enabled',
      cache_ttl_ms: 60_000,
    }));
    expect(second.pages[0].cache).toMatchObject({ status: 'hit', hit: true });
    expect(server.hitCount('/page-a.html')).toBe(before + 1);
  });
});
