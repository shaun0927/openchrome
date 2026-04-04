/**
 * Crawl Tool - Recursive link-following web crawler with depth/scope controls.
 *
 * Server-side execution eliminates LLM round-trips per page. Uses the existing
 * session manager and worker pool for parallel page processing.
 *
 * @see https://github.com/shaun0927/openchrome/issues/576
 */

import { MCPServer } from '../mcp-server';
import {
  MCPToolDefinition,
  MCPResult,
  ToolHandler,
  ToolContext,
  hasBudget,
} from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { MAX_OUTPUT_CHARS } from '../config/defaults';
import { withTimeout } from '../utils/with-timeout';
import {
  normalizeUrl,
  matchesScope,
  passesFilters,
  discoverLinks,
  CrawlTracker,
  parseRobotsTxt,
  isAllowedByRobots,
  RobotsRules,
} from '../utils/crawl-utils';

const definition: MCPToolDefinition = {
  name: 'crawl',
  description:
    'Recursively crawl a website by following links. Server-side execution — no LLM round-trip per page. Returns content from each page visited.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Starting URL to crawl from',
      },
      max_depth: {
        type: 'number',
        description: 'Maximum link-following depth from start URL. Default: 2',
      },
      max_pages: {
        type: 'number',
        description: 'Maximum total pages to visit. Default: 20',
      },
      scope: {
        type: 'string',
        description:
          'URL glob pattern to stay within (e.g., "https://docs.example.com/**"). Default: same origin as start URL.',
      },
      include_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'URL glob patterns to include',
      },
      exclude_patterns: {
        type: 'array',
        items: { type: 'string' },
        description:
          'URL glob patterns to skip (e.g., "*/login*", "*/admin*")',
      },
      output_format: {
        type: 'string',
        enum: ['markdown', 'text', 'structured'],
        description: 'Content format per page. Default: "markdown"',
      },
      respect_robots: {
        type: 'boolean',
        description: 'Respect robots.txt rules. Default: true',
      },
      delay_ms: {
        type: 'number',
        description:
          'Delay between requests in milliseconds. Default: 1000',
      },
      concurrency: {
        type: 'number',
        description: 'Maximum concurrent page fetches. Default: 3',
      },
    },
    required: ['url'],
  },
};

interface CrawlPageResult {
  url: string;
  title: string;
  content: string;
  depth: number;
  links_found: number;
  error?: string;
}

/** Internal result that also carries discovered links for the BFS queue. */
interface InternalCrawlResult extends CrawlPageResult {
  discoveredLinks: string[];
}

/**
 * Simple concurrency limiter (same pattern as batch-paginate.ts)
 */
function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      if (queue.length > 0) {
        const next = queue.shift()!;
        next();
      }
    }
  };
}

/**
 * Fetch and extract content + links from a single page in one tab open.
 */
async function crawlSinglePage(
  sessionId: string,
  url: string,
  depth: number,
  outputFormat: string,
  context?: ToolContext,
): Promise<InternalCrawlResult> {
  const sessionManager = getSessionManager();
  let targetId: string | null = null;

  try {
    const { targetId: tid, page } = await sessionManager.createTarget(
      sessionId,
      url,
    );
    targetId = tid;

    // Wait for page to settle
    await new Promise((r) => setTimeout(r, 500));

    // Extract title, content, and HTML for link discovery in one evaluate call
    const extracted = await withTimeout(
      page.evaluate((fmt: string) => {
        const title = document.title || '';
        const html = document.body?.innerHTML || '';

        let content: string;
        if (fmt === 'text') {
          content = document.body?.innerText || '';
        } else {
          // markdown — extract headings + text
          const body = document.body;
          if (!body) {
            content = '';
          } else {
            const parts: string[] = [];
            const headings = body.querySelectorAll('h1, h2, h3, h4, h5, h6');
            headings.forEach((h) => {
              const level = parseInt(h.tagName[1]);
              const prefix = '#'.repeat(level);
              parts.push(`${prefix} ${h.textContent?.trim()}`);
            });
            parts.push(body.innerText || '');
            content = parts.join('\n\n');
          }
        }

        return { title, content, html };
      }, outputFormat),
      15000,
      'crawl.extract',
      context,
    );

    // Close the tab immediately after extraction
    await sessionManager.closeTarget(sessionId, tid);
    targetId = null;

    // Trim content
    let content = extracted.content;
    if (content.length > MAX_OUTPUT_CHARS) {
      content = content.slice(0, MAX_OUTPUT_CHARS) + '...[truncated]';
    }

    // Discover links from HTML (runs in Node, not in browser)
    const discoveredLinks = discoverLinks(extracted.html, url);

    return {
      url,
      title: extracted.title,
      content,
      depth,
      links_found: discoveredLinks.length,
      discoveredLinks,
    };
  } catch (err) {
    if (targetId) {
      try {
        await sessionManager.closeTarget(sessionId, targetId);
      } catch {
        // ignore cleanup errors
      }
    }
    return {
      url,
      title: '',
      content: '',
      depth,
      links_found: 0,
      error: err instanceof Error ? err.message : String(err),
      discoveredLinks: [],
    };
  }
}

/**
 * Fetch robots.txt for a given origin.
 */
async function fetchRobotsTxt(
  sessionId: string,
  origin: string,
  context?: ToolContext,
): Promise<RobotsRules | null> {
  const sessionManager = getSessionManager();
  let targetId: string | null = null;

  try {
    const robotsUrl = `${origin}/robots.txt`;
    const { targetId: tid, page } = await sessionManager.createTarget(
      sessionId,
      robotsUrl,
    );
    targetId = tid;

    await new Promise((r) => setTimeout(r, 500));

    const text = await withTimeout(
      page.evaluate(() => document.body?.innerText || ''),
      5000,
      'crawl.robots',
      context,
    );

    await sessionManager.closeTarget(sessionId, tid);
    targetId = null;

    if (!text || text.includes('404') || text.includes('Not Found')) {
      return null;
    }

    return parseRobotsTxt(text);
  } catch {
    if (targetId) {
      try {
        await sessionManager.closeTarget(sessionId, targetId);
      } catch {
        // ignore
      }
    }
    return null;
  }
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  const url = args.url as string;
  if (!url) {
    return {
      content: [{ type: 'text', text: 'Error: url is required' }],
      isError: true,
    };
  }

  const maxDepth = args.max_depth != null ? Number(args.max_depth) : 2;
  const maxPages = args.max_pages != null ? Number(args.max_pages) : 20;
  const outputFormat = (args.output_format as string) || 'markdown';
  const respectRobots = args.respect_robots !== false;
  const delayMs = args.delay_ms != null ? Number(args.delay_ms) : 1000;
  const concurrency = args.concurrency != null ? Number(args.concurrency) : 3;

  // Derive scope from URL if not provided
  let scope = args.scope as string | undefined;
  if (!scope) {
    try {
      const parsed = new URL(url);
      scope = `${parsed.origin}/**`;
    } catch {
      return {
        content: [{ type: 'text', text: `Error: Invalid URL: ${url}` }],
        isError: true,
      };
    }
  }

  const includePatterns = args.include_patterns as string[] | undefined;
  const excludePatterns = args.exclude_patterns as string[] | undefined;

  // Validate params
  if (maxDepth < 0 || maxDepth > 10) {
    return {
      content: [
        { type: 'text', text: 'Error: max_depth must be between 0 and 10' },
      ],
      isError: true,
    };
  }
  if (maxPages < 1 || maxPages > 100) {
    return {
      content: [
        { type: 'text', text: 'Error: max_pages must be between 1 and 100' },
      ],
      isError: true,
    };
  }

  const startTime = Date.now();
  const tracker = new CrawlTracker();
  const results: CrawlPageResult[] = [];
  const limiter = createLimiter(concurrency);

  // Fetch robots.txt if needed
  let robotsRules: RobotsRules | null = null;
  if (respectRobots) {
    try {
      const origin = new URL(url).origin;
      robotsRules = await fetchRobotsTxt(sessionId, origin, context);
    } catch {
      // Continue without robots.txt
    }
  }

  // BFS crawl loop
  tracker.enqueue([{ url: normalizeUrl(url), depth: 0 }]);

  while (results.length < maxPages) {
    // Check budget
    if (context && !hasBudget(context, 15_000)) {
      console.error('[crawl] Budget exhausted, stopping crawl');
      break;
    }

    const next = tracker.dequeue();
    if (!next) break;

    const { url: currentUrl, depth: currentDepth } = next;

    // Depth check
    if (currentDepth > maxDepth) continue;

    // Scope check
    if (!matchesScope(currentUrl, scope)) continue;

    // Include/exclude filter check
    if (!passesFilters(currentUrl, includePatterns, excludePatterns)) continue;

    // Robots.txt check
    if (robotsRules) {
      try {
        const urlPath = new URL(currentUrl).pathname;
        if (!isAllowedByRobots(urlPath, robotsRules)) {
          console.error(
            `[crawl] Skipping ${currentUrl} — disallowed by robots.txt`,
          );
          continue;
        }
      } catch {
        continue;
      }
    }

    // Mark as visited
    if (!tracker.visit(currentUrl)) continue;

    // Crawl the page with concurrency control
    const internalResult = await limiter(() =>
      crawlSinglePage(
        sessionId,
        currentUrl,
        currentDepth,
        outputFormat,
        context,
      ),
    );

    // Enqueue discovered links for further crawling
    if (currentDepth < maxDepth && !internalResult.error) {
      tracker.enqueue(
        internalResult.discoveredLinks.map((link) => ({
          url: link,
          depth: currentDepth + 1,
        })),
      );
    }

    // Strip internal field before adding to results
    const { discoveredLinks: _, ...pageResult } = internalResult;
    results.push(pageResult);

    // Apply crawl delay
    if (delayMs > 0 && results.length < maxPages) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  const durationMs = Date.now() - startTime;
  const successCount = results.filter((r) => !r.error).length;
  const failedCount = results.filter((r) => r.error).length;

  const output = {
    summary: {
      total_pages: results.length,
      succeeded: successCount,
      failed: failedCount,
      max_depth_reached: Math.max(0, ...results.map((r) => r.depth)),
      duration_ms: durationMs,
      scope,
    },
    pages: results,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
  };
};

export function registerCrawlTool(server: MCPServer): void {
  server.registerTool('crawl', handler, definition);
}
