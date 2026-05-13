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

  test('dispatcher=adaptive includes dispatcher stats without changing fixed default', async () => {
    const handler = await loadHandler('crawl');
    const adaptive = await handler('s-adaptive', {
      url: `${server.origin}/index.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
      dispatcher: 'adaptive',
      dispatcher_options: { min_concurrency: 1, max_concurrency: 3 },
    });
    const parsedAdaptive = parseResult(adaptive);
    expect(parsedAdaptive.summary.dispatcher).toMatchObject({
      mode: 'adaptive',
      min_concurrency: 1,
    });

    const fixed = await handler('s-fixed', {
      url: `${server.origin}/index.html`,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      engine: 'static',
      respect_robots: false,
    });
    const parsedFixed = parseResult(fixed);
    expect(parsedFixed.summary.dispatcher).toBeUndefined();
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

  test('size-fallback summary metrics align with emitted per-page metrics', async () => {
    // Force the minimal-pages fallback (content omitted) by serving large pages
    // that overflow MAX_OUTPUT_CHARS even after the per-page-truncation step.
    const BIG = 'x'.repeat(60_000); // each page > MAX_OUTPUT_CHARS / 2
    server.setRoute('/big-a.html', {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML('Big A', `<h1>Big A</h1><p>${BIG}</p>`),
    });
    server.setRoute('/big-b.html', {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML('Big B', `<h1>Big B</h1><p>${BIG}</p>`),
    });
    server.setRoute('/sitemap.xml', {
      status: 200,
      contentType: 'application/xml',
      body:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        `<url><loc>${server.origin}/big-a.html</loc></url>` +
        `<url><loc>${server.origin}/big-b.html</loc></url>` +
        '</urlset>',
    });

    const handler = await loadHandler('crawl_sitemap');
    const result = await handler('s-fallback-metrics', {
      url: server.origin,
      max_pages: 5,
      concurrency: 2,
      engine: 'static',
      include_metrics: true,
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content[0].text) as {
      summary: { metrics?: Record<string, number> };
      pages: Array<{ metrics?: Record<string, number>; content?: string }>;
      note?: string;
    };
    expect(parsed.note).toBe('Content omitted due to size constraints');

    // Per-page content is omitted; per-page metrics are derived from empty
    // strings — so summary metrics must mirror what is actually emitted.
    const perPageCharsSum = parsed.pages.reduce(
      (sum, p) => sum + (p.metrics?.returned_chars ?? 0),
      0,
    );
    const perPageTokensSum = parsed.pages.reduce(
      (sum, p) => sum + (p.metrics?.estimated_tokens ?? 0),
      0,
    );
    expect(parsed.summary.metrics).toBeDefined();
    expect(parsed.summary.metrics!.returned_chars).toBe(perPageCharsSum);
    expect(parsed.summary.metrics!.estimated_tokens).toBe(perPageTokensSum);
    // Per-page metrics built from empty strings yield 0 returned_chars.
    expect(parsed.summary.metrics!.returned_chars).toBe(0);
  });
});
