/// <reference types="jest" />

import {
  normalizeUrl,
  urlGlobToRegex,
  matchesScope,
  passesFilters,
  discoverLinks,
  parseRobotsTxt,
  isAllowedByRobots,
  parseSitemapXml,
  CrawlTracker,
} from '../../src/utils/crawl-utils';

// ─── normalizeUrl ─────────────────────────────────────────────────────────────

describe('normalizeUrl', () => {
  test('removes fragment', () => {
    expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
  });

  test('removes trailing slash (non-root)', () => {
    expect(normalizeUrl('https://example.com/page/')).toBe('https://example.com/page');
  });

  test('preserves root slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  test('sorts query params', () => {
    expect(normalizeUrl('https://example.com/?z=1&a=2')).toBe('https://example.com/?a=2&z=1');
  });

  test('lowercases scheme and host', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });

  test('returns raw string for invalid URLs', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });
});

// ─── urlGlobToRegex / matchesScope ───────────────────────────────────────────

describe('urlGlobToRegex', () => {
  test('** matches path with slashes', () => {
    const re = urlGlobToRegex('https://example.com/**');
    expect(re.test('https://example.com/foo/bar/baz')).toBe(true);
  });

  test('* does not match slash', () => {
    const re = urlGlobToRegex('https://example.com/docs/*');
    expect(re.test('https://example.com/docs/page')).toBe(true);
    expect(re.test('https://example.com/docs/a/b')).toBe(false);
  });

  test('escapes regex special chars in pattern', () => {
    const re = urlGlobToRegex('https://example.com/page.html');
    expect(re.test('https://example.com/pageXhtml')).toBe(false);
    expect(re.test('https://example.com/page.html')).toBe(true);
  });

  test('exact match', () => {
    const re = urlGlobToRegex('https://example.com/about');
    expect(re.test('https://example.com/about')).toBe(true);
    expect(re.test('https://example.com/about/team')).toBe(false);
  });
});

describe('matchesScope', () => {
  test('** scope matches deep paths', () => {
    expect(matchesScope('https://docs.example.com/api/v1/endpoint', 'https://docs.example.com/**')).toBe(true);
  });

  test('* scope matches single segment', () => {
    expect(matchesScope('https://example.com/docs/page', 'https://example.com/docs/*')).toBe(true);
    expect(matchesScope('https://example.com/docs/a/b', 'https://example.com/docs/*')).toBe(false);
  });

  test('non-matching scope returns false', () => {
    expect(matchesScope('https://other.com/page', 'https://example.com/**')).toBe(false);
  });
});

// ─── passesFilters ───────────────────────────────────────────────────────────

describe('passesFilters', () => {
  test('no filters: always passes', () => {
    expect(passesFilters('https://example.com/any')).toBe(true);
  });

  test('include only: passes when matching', () => {
    expect(passesFilters('https://example.com/docs/page', ['https://example.com/docs/**'])).toBe(true);
  });

  test('include only: fails when not matching', () => {
    expect(passesFilters('https://example.com/blog/post', ['https://example.com/docs/**'])).toBe(false);
  });

  test('exclude only: fails when matching', () => {
    expect(passesFilters('https://example.com/admin/panel', undefined, ['https://example.com/admin/**'])).toBe(false);
  });

  test('exclude only: passes when not matching', () => {
    expect(passesFilters('https://example.com/docs/page', undefined, ['https://example.com/admin/**'])).toBe(true);
  });

  test('exclude takes priority over include', () => {
    expect(passesFilters(
      'https://example.com/docs/secret',
      ['https://example.com/docs/**'],
      ['https://example.com/docs/secret*'],
    )).toBe(false);
  });

  test('both filters: passes when include matches and exclude does not', () => {
    expect(passesFilters(
      'https://example.com/docs/public',
      ['https://example.com/docs/**'],
      ['https://example.com/docs/secret*'],
    )).toBe(true);
  });
});

// ─── discoverLinks ───────────────────────────────────────────────────────────

describe('discoverLinks', () => {
  test('extracts basic href links', () => {
    const html = '<a href="https://example.com/page">link</a>';
    expect(discoverLinks(html, 'https://example.com')).toContain('https://example.com/page');
  });

  test('resolves relative URLs against baseUrl', () => {
    const html = '<a href="/about">about</a>';
    const links = discoverLinks(html, 'https://example.com/page');
    expect(links).toContain('https://example.com/about');
  });

  test('skips javascript: hrefs', () => {
    const html = '<a href="javascript:void(0)">click</a>';
    expect(discoverLinks(html, 'https://example.com')).toHaveLength(0);
  });

  test('skips mailto: hrefs', () => {
    const html = '<a href="mailto:test@example.com">email</a>';
    expect(discoverLinks(html, 'https://example.com')).toHaveLength(0);
  });

  test('skips tel: hrefs', () => {
    const html = '<a href="tel:+1234567890">call</a>';
    expect(discoverLinks(html, 'https://example.com')).toHaveLength(0);
  });

  test('skips fragment-only hrefs', () => {
    const html = '<a href="#section">anchor</a>';
    expect(discoverLinks(html, 'https://example.com')).toHaveLength(0);
  });

  test('deduplicates normalized URLs', () => {
    const html = '<a href="/page">1</a><a href="/page/">2</a>';
    const links = discoverLinks(html, 'https://example.com');
    expect(links).toHaveLength(1);
  });

  test('returns empty array for empty HTML', () => {
    expect(discoverLinks('', 'https://example.com')).toHaveLength(0);
  });

  test('skips malformed URLs gracefully', () => {
    const html = '<a href="http://[invalid">bad</a><a href="/good">good</a>';
    const links = discoverLinks(html, 'https://example.com');
    expect(links).toContain('https://example.com/good');
    expect(links).toHaveLength(1);
  });
});

// ─── parseRobotsTxt ──────────────────────────────────────────────────────────

describe('parseRobotsTxt', () => {
  test('parses disallow rules for wildcard agent', () => {
    const txt = 'User-agent: *\nDisallow: /admin\n';
    const rules = parseRobotsTxt(txt);
    expect(rules.disallow).toContain('/admin');
  });

  test('parses allow rules', () => {
    const txt = 'User-agent: *\nAllow: /public\nDisallow: /\n';
    const rules = parseRobotsTxt(txt);
    expect(rules.allow).toContain('/public');
    expect(rules.disallow).toContain('/');
  });

  test('parses crawl-delay', () => {
    const txt = 'User-agent: *\nCrawl-delay: 2\n';
    const rules = parseRobotsTxt(txt);
    expect(rules.crawlDelay).toBe(2);
  });

  test('parses sitemap directives', () => {
    const txt = 'Sitemap: https://example.com/sitemap.xml\n';
    const rules = parseRobotsTxt(txt);
    expect(rules.sitemaps).toContain('https://example.com/sitemap.xml');
  });

  test('uses specific user-agent block when available', () => {
    const txt = [
      'User-agent: *',
      'Disallow: /general',
      '',
      'User-agent: mybot',
      'Disallow: /specific',
    ].join('\n');
    const rules = parseRobotsTxt(txt, 'mybot');
    expect(rules.disallow).toContain('/specific');
    expect(rules.disallow).not.toContain('/general');
  });

  test('falls back to wildcard when specific agent not found', () => {
    const txt = 'User-agent: *\nDisallow: /fallback\n';
    const rules = parseRobotsTxt(txt, 'unknownbot');
    expect(rules.disallow).toContain('/fallback');
  });

  test('strips comments from lines', () => {
    const txt = 'User-agent: * # all bots\nDisallow: /secret # keep out\n';
    const rules = parseRobotsTxt(txt);
    expect(rules.disallow).toContain('/secret');
  });

  test('returns empty rules for empty input', () => {
    const rules = parseRobotsTxt('');
    expect(rules.disallow).toHaveLength(0);
    expect(rules.allow).toHaveLength(0);
    expect(rules.sitemaps).toHaveLength(0);
  });
});

// ─── isAllowedByRobots ───────────────────────────────────────────────────────

describe('isAllowedByRobots', () => {
  test('allow takes precedence over disallow', () => {
    const rules = { disallow: ['/docs'], allow: ['/docs/public'], sitemaps: [] };
    expect(isAllowedByRobots('/docs/public/page', rules)).toBe(true);
  });

  test('disallowed path returns false', () => {
    const rules = { disallow: ['/admin'], allow: [], sitemaps: [] };
    expect(isAllowedByRobots('/admin/panel', rules)).toBe(false);
  });

  test('allowed when no matching rules', () => {
    const rules = { disallow: ['/private'], allow: [], sitemaps: [] };
    expect(isAllowedByRobots('/public/page', rules)).toBe(true);
  });

  test('allowed when rules are empty', () => {
    const rules = { disallow: [], allow: [], sitemaps: [] };
    expect(isAllowedByRobots('/anything', rules)).toBe(true);
  });
});

// ─── parseSitemapXml ─────────────────────────────────────────────────────────

describe('parseSitemapXml', () => {
  test('parses regular sitemap with urls', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;
    const result = parseSitemapXml(xml);
    expect(result.isSitemapIndex).toBe(false);
    expect(result.urls).toHaveLength(2);
    expect(result.urls[0].loc).toBe('https://example.com/page1');
  });

  test('parses sitemap index', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap2.xml</loc></sitemap>
</sitemapindex>`;
    const result = parseSitemapXml(xml);
    expect(result.isSitemapIndex).toBe(true);
    expect(result.sitemapIndexUrls).toHaveLength(2);
    expect(result.sitemapIndexUrls[0]).toBe('https://example.com/sitemap1.xml');
  });

  test('parses priority, lastmod, and changefreq', () => {
    const xml = `<urlset>
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2024-01-01</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;
    const result = parseSitemapXml(xml);
    expect(result.urls[0].lastmod).toBe('2024-01-01');
    expect(result.urls[0].changefreq).toBe('daily');
    expect(result.urls[0].priority).toBe(1.0);
  });

  test('handles namespaced tags', () => {
    const xml = `<ns:urlset>
  <ns:url><ns:loc>https://example.com/ns-page</ns:loc></ns:url>
</ns:urlset>`;
    const result = parseSitemapXml(xml);
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0].loc).toBe('https://example.com/ns-page');
  });
});

// ─── CrawlTracker ────────────────────────────────────────────────────────────

describe('CrawlTracker', () => {
  test('visit marks URL as visited', () => {
    const tracker = new CrawlTracker();
    tracker.visit('https://example.com/page');
    expect(tracker.hasVisited('https://example.com/page')).toBe(true);
  });

  test('hasVisited returns false for unvisited URLs', () => {
    const tracker = new CrawlTracker();
    expect(tracker.hasVisited('https://example.com/new')).toBe(false);
  });

  test('visit deduplication: visitedCount increments once per URL', () => {
    const tracker = new CrawlTracker();
    tracker.visit('https://example.com/page');
    tracker.visit('https://example.com/page');
    expect(tracker.visitedCount).toBe(1);
  });

  test('enqueue/dequeue is FIFO', () => {
    const tracker = new CrawlTracker();
    tracker.enqueue([{ url: 'https://example.com/a', depth: 0 }, { url: 'https://example.com/b', depth: 0 }, { url: 'https://example.com/c', depth: 0 }]);
    expect(tracker.dequeue()?.url).toBe('https://example.com/a');
    expect(tracker.dequeue()?.url).toBe('https://example.com/b');
    expect(tracker.dequeue()?.url).toBe('https://example.com/c');
  });

  test('enqueue skips already visited URLs', () => {
    const tracker = new CrawlTracker();
    tracker.visit('https://example.com/visited');
    tracker.enqueue([{ url: 'https://example.com/visited', depth: 0 }, { url: 'https://example.com/new', depth: 0 }]);
    expect(tracker.pendingCount).toBe(1);
    expect(tracker.dequeue()?.url).toBe('https://example.com/new');
  });

  test('dequeue returns undefined when empty', () => {
    const tracker = new CrawlTracker();
    expect(tracker.dequeue()).toBeUndefined();
  });

  test('getVisitedUrls returns all visited URLs', () => {
    const tracker = new CrawlTracker();
    tracker.visit('https://example.com/a');
    tracker.visit('https://example.com/b');
    const visited = tracker.getVisitedUrls();
    expect(visited).toContain('https://example.com/a');
    expect(visited).toContain('https://example.com/b');
    expect(visited).toHaveLength(2);
  });
});
