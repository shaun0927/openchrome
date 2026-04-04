/// <reference types="jest" />
/**
 * Tests for crawl-utils: URL normalization, scope matching, link discovery,
 * robots.txt parsing, sitemap XML parsing, and CrawlTracker.
 *
 * @see https://github.com/shaun0927/openchrome/issues/576
 */

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

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------

describe('normalizeUrl', () => {
  test('removes URL fragments (#section)', () => {
    expect(normalizeUrl('https://example.com/page#section')).toBe(
      'https://example.com/page',
    );
    expect(normalizeUrl('https://example.com/page#')).toBe(
      'https://example.com/page',
    );
  });

  test('removes trailing slash except for root path "/"', () => {
    expect(normalizeUrl('https://example.com/docs/')).toBe(
      'https://example.com/docs',
    );
    // Root path should keep the trailing slash
    expect(normalizeUrl('https://example.com/')).toBe(
      'https://example.com/',
    );
  });

  test('sorts query parameters alphabetically', () => {
    expect(normalizeUrl('https://example.com/search?z=1&a=2&m=3')).toBe(
      'https://example.com/search?a=2&m=3&z=1',
    );
  });

  test('lowercases scheme and hostname', () => {
    expect(normalizeUrl('HTTPS://EXAMPLE.COM/Path')).toBe(
      'https://example.com/Path',
    );
    expect(normalizeUrl('HTTP://Foo.BAR.com/')).toBe(
      'http://foo.bar.com/',
    );
  });

  test('returns original string for invalid URLs', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl('://missing-scheme')).toBe('://missing-scheme');
  });
});

// ---------------------------------------------------------------------------
// urlGlobToRegex / matchesScope
// ---------------------------------------------------------------------------

describe('urlGlobToRegex', () => {
  test('** matches anything including slashes', () => {
    const regex = urlGlobToRegex('https://example.com/**');
    expect(regex.test('https://example.com/a/b/c')).toBe(true);
    expect(regex.test('https://example.com/')).toBe(true);
    expect(regex.test('https://example.com/deep/nested/path/page.html')).toBe(true);
  });

  test('* matches anything except slashes', () => {
    const regex = urlGlobToRegex('https://example.com/docs/*');
    expect(regex.test('https://example.com/docs/page')).toBe(true);
    expect(regex.test('https://example.com/docs/page/sub')).toBe(false);
  });

  test('escapes regex special characters', () => {
    const regex = urlGlobToRegex('https://example.com/path.html');
    expect(regex.test('https://example.com/path.html')).toBe(true);
    // The dot should be literal, not match any char
    expect(regex.test('https://example.com/pathXhtml')).toBe(false);
  });
});

describe('matchesScope', () => {
  test('exact URL match', () => {
    expect(
      matchesScope(
        'https://example.com/page',
        'https://example.com/page',
      ),
    ).toBe(true);
  });

  test('origin + path glob matches subpaths', () => {
    expect(
      matchesScope(
        'https://example.com/docs/api/v2/reference',
        'https://example.com/docs/**',
      ),
    ).toBe(true);
    expect(
      matchesScope(
        'https://example.com/docs/getting-started',
        'https://example.com/docs/**',
      ),
    ).toBe(true);
  });

  test('non-matching URLs return false', () => {
    expect(
      matchesScope(
        'https://other.com/docs/page',
        'https://example.com/docs/**',
      ),
    ).toBe(false);
    expect(
      matchesScope(
        'https://example.com/blog/post',
        'https://example.com/docs/**',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// passesFilters
// ---------------------------------------------------------------------------

describe('passesFilters', () => {
  test('no filters = everything passes', () => {
    expect(passesFilters('https://example.com/anything')).toBe(true);
    expect(passesFilters('https://example.com/anything', undefined, undefined)).toBe(true);
    expect(passesFilters('https://example.com/anything', [], [])).toBe(true);
  });

  test('includePatterns: only matching URLs pass', () => {
    const include = ['https://example.com/docs/**'];
    expect(passesFilters('https://example.com/docs/page', include)).toBe(true);
    expect(passesFilters('https://example.com/blog/post', include)).toBe(false);
  });

  test('excludePatterns: matching URLs are excluded', () => {
    const exclude = ['https://example.com/private/**'];
    expect(passesFilters('https://example.com/public/page', undefined, exclude)).toBe(true);
    expect(passesFilters('https://example.com/private/secret', undefined, exclude)).toBe(false);
  });

  test('both include and exclude: exclude takes precedence', () => {
    const include = ['https://example.com/docs/**'];
    const exclude = ['https://example.com/docs/internal/**'];

    expect(passesFilters('https://example.com/docs/public', include, exclude)).toBe(true);
    expect(passesFilters('https://example.com/docs/internal/secret', include, exclude)).toBe(false);
    // Not in include list at all
    expect(passesFilters('https://example.com/blog/post', include, exclude)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// discoverLinks
// ---------------------------------------------------------------------------

describe('discoverLinks', () => {
  const baseUrl = 'https://example.com/page';

  test('extracts href from anchor tags', () => {
    const html = `
      <a href="https://example.com/about">About</a>
      <a href="https://example.com/contact">Contact</a>
    `;
    const links = discoverLinks(html, baseUrl);
    expect(links).toContain('https://example.com/about');
    expect(links).toContain('https://example.com/contact');
    expect(links).toHaveLength(2);
  });

  test('resolves relative URLs against base URL', () => {
    const html = `
      <a href="/about">About</a>
      <a href="sub/page">Sub Page</a>
    `;
    const links = discoverLinks(html, baseUrl);
    expect(links).toContain('https://example.com/about');
    expect(links).toContain('https://example.com/sub/page');
  });

  test('skips javascript:, mailto:, tel:, data:, and # links', () => {
    const html = `
      <a href="javascript:void(0)">JS</a>
      <a href="mailto:test@example.com">Email</a>
      <a href="tel:+1234567890">Phone</a>
      <a href="data:text/html,test">Data</a>
      <a href="#section">Anchor</a>
      <a href="https://example.com/real">Real</a>
    `;
    const links = discoverLinks(html, baseUrl);
    expect(links).toHaveLength(1);
    expect(links[0]).toBe('https://example.com/real');
  });

  test('deduplicates results after normalization', () => {
    const html = `
      <a href="https://example.com/page">Page 1</a>
      <a href="https://example.com/page#section">Page 2</a>
      <a href="https://example.com/page/">Page 3</a>
    `;
    const links = discoverLinks(html, baseUrl);
    // All three should normalize to the same URL
    expect(links).toHaveLength(1);
  });

  test('handles missing or malformed hrefs gracefully', () => {
    const html = `
      <a>No href</a>
      <a href="">Empty href</a>
      <a href="https://example.com/valid">Valid</a>
    `;
    const links = discoverLinks(html, baseUrl);
    // Empty href resolves to the base URL
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links).toContain('https://example.com/valid');
  });

  test('returns empty array for HTML with no links', () => {
    const html = '<p>No links here</p>';
    const links = discoverLinks(html, baseUrl);
    expect(links).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseRobotsTxt
// ---------------------------------------------------------------------------

describe('parseRobotsTxt', () => {
  test('parses Disallow directives for User-agent: *', () => {
    const robotsTxt = `
User-agent: *
Disallow: /private
Disallow: /admin
`;
    const rules = parseRobotsTxt(robotsTxt);
    expect(rules.disallow).toContain('/private');
    expect(rules.disallow).toContain('/admin');
  });

  test('parses Allow directives', () => {
    const robotsTxt = `
User-agent: *
Disallow: /private
Allow: /private/public
`;
    const rules = parseRobotsTxt(robotsTxt);
    expect(rules.disallow).toContain('/private');
    expect(rules.allow).toContain('/private/public');
  });

  test('parses Crawl-delay', () => {
    const robotsTxt = `
User-agent: *
Crawl-delay: 10
`;
    const rules = parseRobotsTxt(robotsTxt);
    expect(rules.crawlDelay).toBe(10);
  });

  test('parses Sitemap directives', () => {
    const robotsTxt = `
User-agent: *
Disallow: /tmp
Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap2.xml
`;
    const rules = parseRobotsTxt(robotsTxt);
    expect(rules.sitemaps).toContain('https://example.com/sitemap.xml');
    expect(rules.sitemaps).toContain('https://example.com/sitemap2.xml');
    expect(rules.sitemaps).toHaveLength(2);
  });

  test('handles specific user-agent matching', () => {
    const robotsTxt = `
User-agent: *
Disallow: /all

User-agent: mybot
Disallow: /mybot-specific
Allow: /mybot-allowed
`;
    const rules = parseRobotsTxt(robotsTxt, 'mybot');
    expect(rules.disallow).toContain('/mybot-specific');
    expect(rules.allow).toContain('/mybot-allowed');
    // Should NOT contain the wildcard rules
    expect(rules.disallow).not.toContain('/all');
  });

  test('handles empty and comment lines', () => {
    const robotsTxt = `
# This is a comment
User-agent: *

# Another comment
Disallow: /secret

`;
    const rules = parseRobotsTxt(robotsTxt);
    expect(rules.disallow).toContain('/secret');
    expect(rules.disallow).toHaveLength(1);
  });

  test('falls back to wildcard rules when no specific agent match', () => {
    const robotsTxt = `
User-agent: *
Disallow: /general
`;
    const rules = parseRobotsTxt(robotsTxt, 'unknownbot');
    expect(rules.disallow).toContain('/general');
  });
});

// ---------------------------------------------------------------------------
// isAllowedByRobots
// ---------------------------------------------------------------------------

describe('isAllowedByRobots', () => {
  test('allow rules take precedence over disallow', () => {
    const rules = {
      disallow: ['/private'],
      allow: ['/private/public'],
      sitemaps: [],
    };
    expect(isAllowedByRobots('/private/public/page', rules)).toBe(true);
  });

  test('disallowed path prefix blocks matching paths', () => {
    const rules = {
      disallow: ['/admin'],
      allow: [],
      sitemaps: [],
    };
    expect(isAllowedByRobots('/admin', rules)).toBe(false);
    expect(isAllowedByRobots('/admin/dashboard', rules)).toBe(false);
  });

  test('no matching rules = allowed', () => {
    const rules = {
      disallow: ['/private'],
      allow: [],
      sitemaps: [],
    };
    expect(isAllowedByRobots('/public/page', rules)).toBe(true);
  });

  test('empty rules = allowed', () => {
    const rules = {
      disallow: [],
      allow: [],
      sitemaps: [],
    };
    expect(isAllowedByRobots('/anything', rules)).toBe(true);
    expect(isAllowedByRobots('/', rules)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSitemapXml
// ---------------------------------------------------------------------------

describe('parseSitemapXml', () => {
  test('parses regular sitemap with <url> entries (loc, lastmod, changefreq, priority)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://example.com/page2</loc>
    <lastmod>2024-02-20</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
</urlset>`;

    const result = parseSitemapXml(xml);
    expect(result.isSitemapIndex).toBe(false);
    expect(result.urls).toHaveLength(2);

    expect(result.urls[0].loc).toBe('https://example.com/page1');
    expect(result.urls[0].lastmod).toBe('2024-01-15');
    expect(result.urls[0].changefreq).toBe('weekly');
    expect(result.urls[0].priority).toBe(0.8);

    expect(result.urls[1].loc).toBe('https://example.com/page2');
    expect(result.urls[1].lastmod).toBe('2024-02-20');
    expect(result.urls[1].changefreq).toBe('monthly');
    expect(result.urls[1].priority).toBe(0.5);
  });

  test('parses sitemap index file with <sitemap> entries', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap1.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap2.xml</loc>
  </sitemap>
</sitemapindex>`;

    const result = parseSitemapXml(xml);
    expect(result.isSitemapIndex).toBe(true);
    expect(result.sitemapIndexUrls).toHaveLength(2);
    expect(result.sitemapIndexUrls[0]).toBe('https://example.com/sitemap1.xml');
    expect(result.sitemapIndexUrls[1]).toBe('https://example.com/sitemap2.xml');
    expect(result.urls).toHaveLength(0);
  });

  test('sets isSitemapIndex flag correctly', () => {
    const regularXml = `<urlset><url><loc>https://example.com/</loc></url></urlset>`;
    const indexXml = `<sitemapindex><sitemap><loc>https://example.com/sitemap.xml</loc></sitemap></sitemapindex>`;

    expect(parseSitemapXml(regularXml).isSitemapIndex).toBe(false);
    expect(parseSitemapXml(indexXml).isSitemapIndex).toBe(true);
  });

  test('handles empty sitemap', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;

    const result = parseSitemapXml(xml);
    expect(result.urls).toHaveLength(0);
    expect(result.isSitemapIndex).toBe(false);
    expect(result.sitemapIndexUrls).toHaveLength(0);
  });

  test('handles namespaced tags', () => {
    // The implementation checks for `:sitemapindex` to detect namespace prefixes
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ns:sitemapindex xmlns:ns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-ns.xml</loc>
  </sitemap>
</ns:sitemapindex>`;

    const result = parseSitemapXml(xml);
    expect(result.isSitemapIndex).toBe(true);
    expect(result.sitemapIndexUrls).toHaveLength(1);
  });

  test('parses url entries with only loc (optional fields absent)', () => {
    const xml = `<urlset>
  <url><loc>https://example.com/minimal</loc></url>
</urlset>`;

    const result = parseSitemapXml(xml);
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0].loc).toBe('https://example.com/minimal');
    expect(result.urls[0].lastmod).toBeUndefined();
    expect(result.urls[0].changefreq).toBeUndefined();
    expect(result.urls[0].priority).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CrawlTracker
// ---------------------------------------------------------------------------

describe('CrawlTracker', () => {
  let tracker: CrawlTracker;

  beforeEach(() => {
    tracker = new CrawlTracker();
  });

  test('visit() returns true first time, false for duplicates', () => {
    expect(tracker.visit('https://example.com/page')).toBe(true);
    expect(tracker.visit('https://example.com/page')).toBe(false);
    // Normalized duplicate (with fragment)
    expect(tracker.visit('https://example.com/page#section')).toBe(false);
  });

  test('hasVisited() returns correct state', () => {
    expect(tracker.hasVisited('https://example.com/page')).toBe(false);
    tracker.visit('https://example.com/page');
    expect(tracker.hasVisited('https://example.com/page')).toBe(true);
    // Normalized variant should also be considered visited
    expect(tracker.hasVisited('https://example.com/page#anchor')).toBe(true);
  });

  test('enqueue() adds only unvisited URLs', () => {
    tracker.visit('https://example.com/visited');

    tracker.enqueue([
      { url: 'https://example.com/visited', depth: 1 },
      { url: 'https://example.com/new1', depth: 1 },
      { url: 'https://example.com/new2', depth: 2 },
    ]);

    // Only the unvisited URLs should be in the queue
    expect(tracker.pendingCount).toBe(2);
  });

  test('dequeue() skips already-visited URLs', () => {
    tracker.enqueue([
      { url: 'https://example.com/a', depth: 1 },
      { url: 'https://example.com/b', depth: 1 },
    ]);

    // Visit 'a' before dequeuing
    tracker.visit('https://example.com/a');

    const next = tracker.dequeue();
    expect(next).toBeDefined();
    expect(next!.url).toBe('https://example.com/b');
  });

  test('dequeue() returns undefined when queue is empty', () => {
    expect(tracker.dequeue()).toBeUndefined();
  });

  test('visitedCount and pendingCount are accurate', () => {
    expect(tracker.visitedCount).toBe(0);
    expect(tracker.pendingCount).toBe(0);

    tracker.visit('https://example.com/a');
    tracker.visit('https://example.com/b');
    expect(tracker.visitedCount).toBe(2);

    tracker.enqueue([
      { url: 'https://example.com/c', depth: 1 },
      { url: 'https://example.com/d', depth: 1 },
      { url: 'https://example.com/e', depth: 2 },
    ]);
    expect(tracker.pendingCount).toBe(3);
  });

  test('getVisitedUrls() returns all visited URLs', () => {
    tracker.visit('https://example.com/a');
    tracker.visit('https://example.com/b');
    tracker.visit('https://example.com/c');

    const visited = tracker.getVisitedUrls();
    expect(visited).toHaveLength(3);
    expect(visited).toContain('https://example.com/a');
    expect(visited).toContain('https://example.com/b');
    expect(visited).toContain('https://example.com/c');
  });

  test('dequeue() returns entries in FIFO order', () => {
    tracker.enqueue([
      { url: 'https://example.com/first', depth: 0 },
      { url: 'https://example.com/second', depth: 1 },
      { url: 'https://example.com/third', depth: 2 },
    ]);

    const first = tracker.dequeue();
    const second = tracker.dequeue();
    const third = tracker.dequeue();

    expect(first!.url).toBe('https://example.com/first');
    expect(second!.url).toBe('https://example.com/second');
    expect(third!.url).toBe('https://example.com/third');
  });
});
