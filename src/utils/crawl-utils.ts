/**
 * Crawl utilities - URL normalization, scope matching, link discovery,
 * robots.txt parsing, and BFS queue tracking for the crawl tool.
 *
 * @see https://github.com/shaun0927/openchrome/issues/576
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface RobotsRules {
  disallow: string[];
  allow: string[];
}

/* ------------------------------------------------------------------ */
/*  URL helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Normalize a URL by removing the fragment and collapsing trailing slashes
 * so visited-set comparisons are consistent.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.href;
  } catch {
    return raw;
  }
}

/**
 * Check whether `url` falls within a glob-style `scope` pattern.
 * Supports `*` (any segment chars) and `**` (any path depth).
 */
export function matchesScope(url: string, scope: string): boolean {
  try {
    const escaped = scope
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '<<GLOBSTAR>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<GLOBSTAR>>/g, '.*');
    return new RegExp(`^${escaped}$`).test(url);
  } catch {
    return true;
  }
}

/**
 * Return true when `url` passes both the include and exclude filters.
 * If no include patterns are supplied every URL is included by default.
 */
export function passesFilters(
  url: string,
  includePatterns?: string[],
  excludePatterns?: string[],
): boolean {
  if (excludePatterns) {
    for (const pat of excludePatterns) {
      if (matchesScope(url, pat)) return false;
    }
  }
  if (includePatterns && includePatterns.length > 0) {
    return includePatterns.some((pat) => matchesScope(url, pat));
  }
  return true;
}

/* ------------------------------------------------------------------ */
/*  Link discovery                                                     */
/* ------------------------------------------------------------------ */

/**
 * Extract absolute HTTP(S) links from an HTML string.
 * Runs in Node (not in the browser) so we use a simple regex approach
 * rather than a full DOM parser.
 */
export function discoverLinks(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  const re = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(html)) !== null) {
    try {
      const resolved = new URL(match[1], baseUrl).href;
      const normalized = normalizeUrl(resolved);
      if (
        !seen.has(normalized) &&
        (normalized.startsWith('http://') || normalized.startsWith('https://'))
      ) {
        seen.add(normalized);
        results.push(normalized);
      }
    } catch {
      // skip malformed URLs
    }
  }

  return results;
}

/* ------------------------------------------------------------------ */
/*  BFS Crawl Tracker                                                  */
/* ------------------------------------------------------------------ */

interface QueueItem {
  url: string;
  depth: number;
}

export class CrawlTracker {
  private visited = new Set<string>();
  private queue: QueueItem[] = [];

  enqueue(items: QueueItem[]): void {
    for (const item of items) {
      if (!this.visited.has(item.url)) {
        this.queue.push(item);
      }
    }
  }

  dequeue(): QueueItem | undefined {
    return this.queue.shift();
  }

  visit(url: string): boolean {
    if (this.visited.has(url)) return false;
    this.visited.add(url);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/*  robots.txt                                                         */
/* ------------------------------------------------------------------ */

/**
 * Parse a robots.txt body into allow/disallow path lists.
 * Only considers rules for `User-agent: *`.
 */
export function parseRobotsTxt(text: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [] };
  let inWildcardSection = false;

  for (const raw of text.split('\n')) {
    const line = raw.trim().toLowerCase();

    if (line.startsWith('user-agent:')) {
      const agent = line.slice('user-agent:'.length).trim();
      inWildcardSection = agent === '*';
      continue;
    }

    if (!inWildcardSection) continue;

    if (line.startsWith('disallow:')) {
      const path = line.slice('disallow:'.length).trim();
      if (path) rules.disallow.push(path);
    } else if (line.startsWith('allow:')) {
      const path = line.slice('allow:'.length).trim();
      if (path) rules.allow.push(path);
    }
  }

  return rules;
}

/**
 * Check whether a given URL path is allowed by robots.txt rules.
 * Allow rules take precedence over Disallow when both match.
 */
export function isAllowedByRobots(
  urlPath: string,
  rules: RobotsRules,
): boolean {
  const path = urlPath.toLowerCase();

  for (const allowed of rules.allow) {
    if (path.startsWith(allowed)) return true;
  }

  for (const disallowed of rules.disallow) {
    if (path.startsWith(disallowed)) return false;
  }

  return true;
}
