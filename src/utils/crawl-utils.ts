/**
 * Crawl Utilities - URL normalization, scope matching, link discovery,
 * robots.txt parsing, and sitemap XML parsing for web crawling tools.
 *
 * @see https://github.com/shaun0927/openchrome/issues/576
 */

// ---------------------------------------------------------------------------
// URL Normalization
// ---------------------------------------------------------------------------

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    const params = Array.from(url.searchParams.entries());
    params.sort(([a], [b]) => a.localeCompare(b));
    url.search = '';
    for (const [key, value] of params) {
      url.searchParams.append(key, value);
    }
    let result = url.toString();
    if (result.endsWith('/') && url.pathname !== '/') {
      result = result.slice(0, -1);
    }
    return result;
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Scope Matching
// ---------------------------------------------------------------------------

export function urlGlobToRegex(pattern: string): RegExp {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  escaped = escaped.replace(/\*\*/g, '___DOUBLESTAR___');
  escaped = escaped.replace(/\*/g, '[^/]*');
  escaped = escaped.replace(/___DOUBLESTAR___/g, '.*');
  escaped = escaped.replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function matchesScope(url: string, scopePattern: string): boolean {
  return urlGlobToRegex(scopePattern).test(url);
}

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

export function discoverLinks(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  const hrefRegex = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1];
    if (!href) continue;
    if (
      href.startsWith('javascript:') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:') ||
      href.startsWith('data:') ||
      href.startsWith('#')
    ) continue;
    try {
      const resolved = new URL(href, baseUrl).toString();
      const normalized = normalizeUrl(resolved);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        results.push(normalized);
      }
    } catch {
      // skip malformed
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Robots.txt Parser
// ---------------------------------------------------------------------------

export interface RobotsRules {
  disallow: string[];
  allow: string[];
  sitemaps: string[];
  crawlDelay?: number;
}

export function parseRobotsTxt(robotsTxt: string, userAgent = '*'): RobotsRules {
  const result: RobotsRules = { disallow: [], allow: [], sitemaps: [] };
  const lines = robotsTxt.split('\n').map((l) => l.trim());
  let currentAgents: string[] = [];
  let isRelevant = false;
  let foundSpecific = false;
  let inDirectiveBlock = false;
  const wildcardRules: RobotsRules = { disallow: [], allow: [], sitemaps: [] };

  for (const line of lines) {
    if (line.startsWith('#') || line === '') continue;
    // Strip inline comments (e.g., "Disallow: /path # comment")
    const commentIdx = line.indexOf(' #');
    const cleanLine = commentIdx >= 0 ? line.slice(0, commentIdx).trim() : line;
    const sitemapMatch = cleanLine.match(/^sitemap:\s*(.+)$/i);
    if (sitemapMatch) { result.sitemaps.push(sitemapMatch[1].trim()); continue; }
    const uaMatch = cleanLine.match(/^user-agent:\s*(.+)$/i);
    if (uaMatch) {
      const agent = uaMatch[1].trim().toLowerCase();
      if (foundSpecific && inDirectiveBlock) break;
      if (inDirectiveBlock) { currentAgents = []; isRelevant = false; inDirectiveBlock = false; }
      currentAgents.push(agent);
      if (agent === userAgent.toLowerCase()) { isRelevant = true; foundSpecific = true; }
      else if (agent === '*') { isRelevant = true; }
      continue;
    }
    inDirectiveBlock = true;
    if (currentAgents.length > 0 && isRelevant) {
      const target = foundSpecific && currentAgents.includes(userAgent.toLowerCase())
        ? result : currentAgents.includes('*') ? wildcardRules : null;
      if (target) {
        const disallowMatch = cleanLine.match(/^disallow:\s*(.*)$/i);
        if (disallowMatch) { const p = disallowMatch[1].trim(); if (p) target.disallow.push(p); }
        const allowMatch = cleanLine.match(/^allow:\s*(.*)$/i);
        if (allowMatch) { const p = allowMatch[1].trim(); if (p) target.allow.push(p); }
        const delayMatch = cleanLine.match(/^crawl-delay:\s*(\d+\.?\d*)$/i);
        if (delayMatch) target.crawlDelay = parseFloat(delayMatch[1]);
      }
    }
  }
  if (!foundSpecific) {
    result.disallow = wildcardRules.disallow;
    result.allow = wildcardRules.allow;
    if (wildcardRules.crawlDelay !== undefined) result.crawlDelay = wildcardRules.crawlDelay;
  }
  return result;
}

export function isAllowedByRobots(urlPath: string, rules: RobotsRules): boolean {
  for (const a of rules.allow) { if (urlPath.startsWith(a)) return true; }
  for (const d of rules.disallow) { if (urlPath.startsWith(d)) return false; }
  return true;
}

// ---------------------------------------------------------------------------
// Sitemap XML Parser
// ---------------------------------------------------------------------------

export interface SitemapUrl { loc: string; lastmod?: string; changefreq?: string; priority?: number; }
export interface SitemapParseResult { urls: SitemapUrl[]; sitemapIndexUrls: string[]; isSitemapIndex: boolean; }

export function parseSitemapXml(xml: string): SitemapParseResult {
  const result: SitemapParseResult = { urls: [], sitemapIndexUrls: [], isSitemapIndex: false };
  if (xml.includes('<sitemapindex') || xml.includes(':sitemapindex')) {
    result.isSitemapIndex = true;
    const re = /<(?:\w+:)?sitemap[^>]*>([\s\S]*?)<\/(?:\w+:)?sitemap>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const loc = m[1].match(/<(?:\w+:)?loc[^>]*>\s*([\s\S]*?)\s*<\/(?:\w+:)?loc>/i);
      if (loc) result.sitemapIndexUrls.push(loc[1].trim());
    }
  } else {
    const re = /<(?:\w+:)?url[^>]*>([\s\S]*?)<\/(?:\w+:)?url>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const block = m[1];
      const loc = block.match(/<(?:\w+:)?loc[^>]*>\s*([\s\S]*?)\s*<\/(?:\w+:)?loc>/i);
      if (!loc) continue;
      const entry: SitemapUrl = { loc: loc[1].trim() };
      const lm = block.match(/<(?:\w+:)?lastmod[^>]*>\s*([\s\S]*?)\s*<\/(?:\w+:)?lastmod>/i);
      if (lm) entry.lastmod = lm[1].trim();
      const cf = block.match(/<(?:\w+:)?changefreq[^>]*>\s*([\s\S]*?)\s*<\/(?:\w+:)?changefreq>/i);
      if (cf) entry.changefreq = cf[1].trim();
      const pr = block.match(/<(?:\w+:)?priority[^>]*>\s*([\s\S]*?)\s*<\/(?:\w+:)?priority>/i);
      if (pr) { const p = parseFloat(pr[1].trim()); if (!isNaN(p)) entry.priority = p; }
      result.urls.push(entry);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Crawl State Tracker
// ---------------------------------------------------------------------------

export class CrawlTracker {
  private visited = new Set<string>();
  private pending: Array<{ url: string; depth: number }> = [];

  visit(url: string): boolean {
    const n = normalizeUrl(url);
    if (this.visited.has(n)) return false;
    this.visited.add(n);
    return true;
  }
  hasVisited(url: string): boolean { return this.visited.has(normalizeUrl(url)); }
  enqueue(urls: Array<{ url: string; depth: number }>): void {
    for (const e of urls) {
      const n = normalizeUrl(e.url);
      if (!this.visited.has(n)) this.pending.push({ url: n, depth: e.depth });
    }
  }
  dequeue(): { url: string; depth: number } | undefined {
    while (this.pending.length > 0) {
      const next = this.pending.shift()!;
      if (!this.visited.has(next.url)) return next;
    }
    return undefined;
  }
  get visitedCount(): number { return this.visited.size; }
  get pendingCount(): number { return this.pending.length; }
  getVisitedUrls(): string[] { return Array.from(this.visited); }
}
