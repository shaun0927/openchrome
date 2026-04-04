/**
 * Crawl Utilities - URL normalization, scope matching, link discovery,
 * robots.txt parsing, and sitemap XML parsing for web crawling tools.
 *
 * @see https://github.com/shaun0927/openchrome/issues/576
 */

// ---------------------------------------------------------------------------
// URL Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a URL for deduplication:
 * - Remove fragment (#...)
 * - Remove trailing slash (except root path "/")
 * - Sort query parameters alphabetically
 * - Lowercase scheme and hostname
 */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);

    // Lowercase scheme and host
    url.hash = '';

    // Sort query parameters
    const params = Array.from(url.searchParams.entries());
    params.sort(([a], [b]) => a.localeCompare(b));
    url.search = '';
    for (const [key, value] of params) {
      url.searchParams.append(key, value);
    }

    let result = url.toString();

    // Remove trailing slash unless it's just the root
    if (result.endsWith('/') && url.pathname !== '/') {
      result = result.slice(0, -1);
    }

    return result;
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Scope Matching (glob-style URL patterns)
// ---------------------------------------------------------------------------

/**
 * Convert a URL glob pattern to a RegExp.
 * Supports `**` (match anything including `/`) and `*` (match anything except `/`).
 *
 * Example: `https://docs.example.com/**` matches all pages under that origin.
 */
export function urlGlobToRegex(pattern: string): RegExp {
  // Escape regex special chars except * and ?
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // ** matches anything (including slashes)
  escaped = escaped.replace(/\*\*/g, '___DOUBLESTAR___');
  // * matches anything except slash
  escaped = escaped.replace(/\*/g, '[^/]*');
  escaped = escaped.replace(/___DOUBLESTAR___/g, '.*');
  // ? matches single char
  escaped = escaped.replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Check if a URL matches a scope pattern (glob).
 */
export function matchesScope(url: string, scopePattern: string): boolean {
  const regex = urlGlobToRegex(scopePattern);
  return regex.test(url);
}

/**
 * Check if a URL passes include/exclude filters.
 * - If includePatterns is provided, URL must match at least one.
 * - If excludePatterns is provided, URL must not match any.
 */
export function passesFilters(
  url: string,
  includePatterns?: string[],
  excludePatterns?: string[],
): boolean {
  if (excludePatterns && excludePatterns.length > 0) {
    for (const pattern of excludePatterns) {
      if (matchesScope(url, pattern)) return false;
    }
  }
  if (includePatterns && includePatterns.length > 0) {
    for (const pattern of includePatterns) {
      if (matchesScope(url, pattern)) return true;
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Link Discovery
// ---------------------------------------------------------------------------

/**
 * Extract all `<a href>` links from HTML content and resolve them
 * against a base URL. Returns deduplicated absolute URLs.
 */
export function discoverLinks(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  // Match href attributes in anchor tags
  const hrefRegex = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1];
    if (!href) continue;

    // Skip non-http links
    if (
      href.startsWith('javascript:') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:') ||
      href.startsWith('data:') ||
      href.startsWith('#')
    ) {
      continue;
    }

    try {
      const resolved = new URL(href, baseUrl).toString();
      const normalized = normalizeUrl(resolved);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        results.push(normalized);
      }
    } catch {
      // Skip malformed URLs
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Robots.txt Parser
// ---------------------------------------------------------------------------

export interface RobotsRules {
  /** Disallowed path prefixes for the matched user-agent */
  disallow: string[];
  /** Explicitly allowed path prefixes (override disallow) */
  allow: string[];
  /** Sitemap URLs declared in robots.txt */
  sitemaps: string[];
  /** Crawl-delay in seconds (if specified) */
  crawlDelay?: number;
}

/**
 * Parse a robots.txt file and extract rules for a given user-agent.
 * Falls back to `*` rules if no specific match is found.
 */
export function parseRobotsTxt(
  robotsTxt: string,
  userAgent = '*',
): RobotsRules {
  const result: RobotsRules = { disallow: [], allow: [], sitemaps: [] };
  const lines = robotsTxt.split('\n').map((l) => l.trim());

  let currentAgents: string[] = [];
  let isRelevant = false;
  let foundSpecific = false;

  // Collect wildcard rules separately
  const wildcardRules: RobotsRules = { disallow: [], allow: [], sitemaps: [] };

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith('#') || line === '') {
      continue;
    }

    // Extract sitemap directives (global, not agent-specific)
    const sitemapMatch = line.match(/^sitemap:\s*(.+)$/i);
    if (sitemapMatch) {
      result.sitemaps.push(sitemapMatch[1].trim());
      continue;
    }

    const uaMatch = line.match(/^user-agent:\s*(.+)$/i);
    if (uaMatch) {
      const agent = uaMatch[1].trim().toLowerCase();
      // If we were in a relevant block and encounter a new UA, stop collecting
      if (isRelevant && foundSpecific) {
        break; // Already got specific rules
      }
      currentAgents.push(agent);
      if (agent === userAgent.toLowerCase()) {
        isRelevant = true;
        foundSpecific = true;
      } else if (agent === '*') {
        isRelevant = true;
      } else {
        isRelevant = false;
      }
      continue;
    }

    // Reset agent list on non-UA directives
    if (currentAgents.length > 0 && !uaMatch) {
      const target =
        foundSpecific && currentAgents.includes(userAgent.toLowerCase())
          ? result
          : currentAgents.includes('*')
            ? wildcardRules
            : null;

      if (target && isRelevant) {
        const disallowMatch = line.match(/^disallow:\s*(.*)$/i);
        if (disallowMatch) {
          const path = disallowMatch[1].trim();
          if (path) target.disallow.push(path);
        }

        const allowMatch = line.match(/^allow:\s*(.*)$/i);
        if (allowMatch) {
          const path = allowMatch[1].trim();
          if (path) target.allow.push(path);
        }

        const delayMatch = line.match(/^crawl-delay:\s*(\d+\.?\d*)$/i);
        if (delayMatch) {
          target.crawlDelay = parseFloat(delayMatch[1]);
        }
      }
    }
  }

  // If no specific rules found, use wildcard rules
  if (!foundSpecific) {
    result.disallow = wildcardRules.disallow;
    result.allow = wildcardRules.allow;
    if (wildcardRules.crawlDelay !== undefined) {
      result.crawlDelay = wildcardRules.crawlDelay;
    }
  }

  return result;
}

/**
 * Check if a URL path is allowed by robots.txt rules.
 * Allow rules take precedence over disallow rules (per spec).
 */
export function isAllowedByRobots(
  urlPath: string,
  rules: RobotsRules,
): boolean {
  // Check allow rules first (more specific wins)
  for (const allowPath of rules.allow) {
    if (urlPath.startsWith(allowPath)) return true;
  }
  for (const disallowPath of rules.disallow) {
    if (urlPath.startsWith(disallowPath)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sitemap XML Parser
// ---------------------------------------------------------------------------

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface SitemapParseResult {
  /** URLs found in a regular sitemap */
  urls: SitemapUrl[];
  /** Child sitemap URLs found in a sitemap index */
  sitemapIndexUrls: string[];
  /** Whether this was a sitemap index file */
  isSitemapIndex: boolean;
}

/**
 * Parse a sitemap XML string. Supports both regular sitemaps and sitemap index files.
 * Uses regex parsing to avoid XML library dependencies.
 */
export function parseSitemapXml(xml: string): SitemapParseResult {
  const result: SitemapParseResult = {
    urls: [],
    sitemapIndexUrls: [],
    isSitemapIndex: false,
  };

  // Check if this is a sitemap index
  if (xml.includes('<sitemapindex') || xml.includes(':sitemapindex')) {
    result.isSitemapIndex = true;

    // Extract sitemap locations from index
    const sitemapRegex = /<sitemap[^>]*>([\s\S]*?)<\/sitemap>/gi;
    let sitemapMatch: RegExpExecArray | null;

    while ((sitemapMatch = sitemapRegex.exec(xml)) !== null) {
      const block = sitemapMatch[1];
      const locMatch = block.match(/<loc[^>]*>\s*([\s\S]*?)\s*<\/loc>/i);
      if (locMatch) {
        result.sitemapIndexUrls.push(locMatch[1].trim());
      }
    }
  } else {
    // Regular sitemap — extract URLs
    const urlRegex = /<url[^>]*>([\s\S]*?)<\/url>/gi;
    let urlMatch: RegExpExecArray | null;

    while ((urlMatch = urlRegex.exec(xml)) !== null) {
      const block = urlMatch[1];
      const locMatch = block.match(/<loc[^>]*>\s*([\s\S]*?)\s*<\/loc>/i);
      if (!locMatch) continue;

      const entry: SitemapUrl = { loc: locMatch[1].trim() };

      const lastmodMatch = block.match(
        /<lastmod[^>]*>\s*([\s\S]*?)\s*<\/lastmod>/i,
      );
      if (lastmodMatch) entry.lastmod = lastmodMatch[1].trim();

      const changefreqMatch = block.match(
        /<changefreq[^>]*>\s*([\s\S]*?)\s*<\/changefreq>/i,
      );
      if (changefreqMatch) entry.changefreq = changefreqMatch[1].trim();

      const priorityMatch = block.match(
        /<priority[^>]*>\s*([\s\S]*?)\s*<\/priority>/i,
      );
      if (priorityMatch) {
        const p = parseFloat(priorityMatch[1].trim());
        if (!isNaN(p)) entry.priority = p;
      }

      result.urls.push(entry);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Crawl State Tracker
// ---------------------------------------------------------------------------

/**
 * Tracks visited URLs during a crawl to prevent duplicates.
 * Uses a Set with normalized URLs for O(1) lookup.
 */
export class CrawlTracker {
  private visited = new Set<string>();
  private pending: Array<{ url: string; depth: number }> = [];

  /** Mark a URL as visited. Returns false if already visited. */
  visit(url: string): boolean {
    const normalized = normalizeUrl(url);
    if (this.visited.has(normalized)) return false;
    this.visited.add(normalized);
    return true;
  }

  /** Check if URL has been visited. */
  hasVisited(url: string): boolean {
    return this.visited.has(normalizeUrl(url));
  }

  /** Add URLs to the pending queue if not already visited. */
  enqueue(urls: Array<{ url: string; depth: number }>): void {
    for (const entry of urls) {
      const normalized = normalizeUrl(entry.url);
      if (!this.visited.has(normalized)) {
        this.pending.push({ url: normalized, depth: entry.depth });
      }
    }
  }

  /** Get the next unvisited URL from the queue. Returns undefined if empty. */
  dequeue(): { url: string; depth: number } | undefined {
    while (this.pending.length > 0) {
      const next = this.pending.shift()!;
      if (!this.visited.has(next.url)) {
        return next;
      }
    }
    return undefined;
  }

  /** Number of URLs visited so far. */
  get visitedCount(): number {
    return this.visited.size;
  }

  /** Number of URLs still pending. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Get all visited URLs. */
  getVisitedUrls(): string[] {
    return Array.from(this.visited);
  }
}
