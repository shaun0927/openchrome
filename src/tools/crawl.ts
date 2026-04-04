/**
 * Crawl Tool - Recursive web crawling via BFS traversal
 *
 * Opens pages in new tabs, extracts content and links, respects robots.txt
 * and scope constraints. Uses CrawlTracker from crawl-utils for deduplication.
 *
 * @see https://github.com/shaun0927/openchrome/issues/576
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, hasBudget } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { MAX_OUTPUT_CHARS } from '../config/defaults';
import { withTimeout } from '../utils/with-timeout';
import {
  normalizeUrl,
  matchesScope,
  passesFilters,
  parseRobotsTxt,
  isAllowedByRobots,
  CrawlTracker,
  RobotsRules,
} from '../utils/crawl-utils';

const definition: MCPToolDefinition = {
  name: 'crawl',
  description:
    'Recursively crawl a website via BFS. Opens each page in a new tab, extracts text content and discovers links, then follows them up to max_depth. Respects robots.txt and scope constraints.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Starting URL to crawl',
      },
      max_depth: {
        type: 'number',
        description: 'Maximum link-follow depth (0 = start page only). Default: 2',
      },
      max_pages: {
        type: 'number',
        description: 'Maximum number of pages to crawl. Default: 20',
      },
      scope: {
        type: 'string',
        description:
          'URL glob pattern limiting which URLs to follow (e.g. "https://docs.example.com/**"). Default: same origin as start URL.',
      },
      include_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'URL glob patterns — only follow links matching at least one',
      },
      exclude_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'URL glob patterns — skip links matching any of these',
      },
      output_format: {
        type: 'string',
        enum: ['markdown', 'text', 'structured'],
        description: 'Content format per page. Default: markdown',
      },
      respect_robots: {
        type: 'boolean',
        description: 'Whether to fetch and obey robots.txt. Default: true',
      },
      delay_ms: {
        type: 'number',
        description: 'Delay between page fetches in milliseconds. Default: 1000',
      },
      concurrency: {
        type: 'number',
        description: 'Max parallel tab fetches. Default: 3',
      },
    },
    required: ['url'],
  },
};

// ---------------------------------------------------------------------------
// Concurrency limiter (same pattern as batch-paginate.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CrawledPage {
  url: string;
  title: string;
  content: string;
  depth: number;
  links_found: number;
  error?: string;
}

interface CrawlSummary {
  total_pages: number;
  succeeded: number;
  failed: number;
  max_depth_reached: number;
  duration_ms: number;
  scope: string;
}

// ---------------------------------------------------------------------------
// Robots.txt cache (per-origin, within a single crawl invocation)
// ---------------------------------------------------------------------------

async function fetchRobotsTxt(
  sessionId: string,
  origin: string,
  context?: ToolContext,
): Promise<RobotsRules | null> {
  const sessionManager = getSessionManager();
  const robotsUrl = `${origin}/robots.txt`;
  let targetId: string | null = null;

  try {
    const { targetId: tid, page } = await sessionManager.createTarget(sessionId, robotsUrl);
    targetId = tid;

    // Wait for page load with a short timeout
    await withTimeout(
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
      10000,
      'crawl.robots.waitForNavigation',
      context,
    );

    const bodyText = await withTimeout(
      page.evaluate(() => document.body?.innerText || ''),
      5000,
      'crawl.robots.evaluate',
      context,
    );

    await sessionManager.closeTarget(sessionId, tid);
    targetId = null;

    // If the response looks like robots.txt (has User-agent or Disallow), parse it
    if (bodyText && (bodyText.toLowerCase().includes('user-agent') || bodyText.toLowerCase().includes('disallow'))) {
      return parseRobotsTxt(bodyText);
    }

    return null;
  } catch (err) {
    console.error(`[crawl] Failed to fetch robots.txt from ${origin}: ${err instanceof Error ? err.message : String(err)}`);
    if (targetId) {
      try {
        await sessionManager.closeTarget(sessionId, targetId);
      } catch {
        // ignore cleanup errors
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Single page fetch
// ---------------------------------------------------------------------------

async function fetchPage(
  sessionId: string,
  url: string,
  depth: number,
  outputFormat: string,
  context?: ToolContext,
): Promise<CrawledPage> {
  const sessionManager = getSessionManager();
  let targetId: string | null = null;

  try {
    const { targetId: tid, page } = await sessionManager.createTarget(sessionId, url);
    targetId = tid;

    // Wait for the page to be mostly loaded
    await withTimeout(
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
      15000,
      'crawl.page.waitForNavigation',
      context,
    );

    // Small settle delay for dynamic content
    await new Promise((r) => setTimeout(r, 500));

    // Extract content and links in one page.evaluate call
    const result = await withTimeout(
      page.evaluate((format: string) => {
        const title = document.title || '';

        // Collect links
        const links: string[] = [];
        const anchors = document.querySelectorAll('a[href]');
        anchors.forEach((a) => {
          const href = (a as HTMLAnchorElement).href;
          if (href && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
            links.push(href);
          }
        });

        // Extract content based on format
        let content = '';
        if (format === 'markdown') {
          // Build a markdown-like representation
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          const parts: string[] = [];
          let node: Node | null = walker.currentNode;

          while (node) {
            const el = node as HTMLElement;
            const tag = el.tagName?.toLowerCase();

            if (tag === 'script' || tag === 'style' || tag === 'noscript') {
              node = walker.nextSibling() || walker.parentNode();
              continue;
            }

            if (tag === 'h1') parts.push(`\n# ${el.textContent?.trim()}\n`);
            else if (tag === 'h2') parts.push(`\n## ${el.textContent?.trim()}\n`);
            else if (tag === 'h3') parts.push(`\n### ${el.textContent?.trim()}\n`);
            else if (tag === 'h4') parts.push(`\n#### ${el.textContent?.trim()}\n`);
            else if (tag === 'h5') parts.push(`\n##### ${el.textContent?.trim()}\n`);
            else if (tag === 'h6') parts.push(`\n###### ${el.textContent?.trim()}\n`);
            else if (tag === 'p') {
              const text = el.textContent?.trim();
              if (text) parts.push(`\n${text}\n`);
            }
            else if (tag === 'li') {
              const text = el.textContent?.trim();
              if (text) parts.push(`- ${text}`);
            }
            else if (tag === 'pre' || tag === 'code') {
              const text = el.textContent?.trim();
              if (text && tag === 'pre') parts.push(`\n\`\`\`\n${text}\n\`\`\`\n`);
            }
            else if (tag === 'a') {
              // Skip — links handled separately
            }
            else if (tag === 'blockquote') {
              const text = el.textContent?.trim();
              if (text) parts.push(`\n> ${text}\n`);
            }

            node = walker.nextNode();
          }

          content = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();

          // Fallback to innerText if markdown extraction is empty
          if (!content) {
            content = document.body.innerText || '';
          }
        } else if (format === 'text') {
          content = document.body.innerText || '';
        } else {
          // structured — return raw HTML body
          content = document.body.innerHTML || '';
        }

        return { title, content, links };
      }, outputFormat),
      15000,
      'crawl.page.evaluate',
      context,
    );

    await sessionManager.closeTarget(sessionId, tid);
    targetId = null;

    // Truncate content if too large
    let content = result.content;
    if (content.length > MAX_OUTPUT_CHARS) {
      content = content.slice(0, MAX_OUTPUT_CHARS) + '...[truncated]';
    }

    return {
      url,
      title: result.title,
      content,
      depth,
      links_found: result.links.length,
      // Store links transiently — caller uses them for BFS
      ...(result.links.length > 0 ? { _links: result.links } as Record<string, unknown> : {}),
    } as CrawledPage & { _links?: string[] };
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
    };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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

  // Validate URL
  let startUrl: URL;
  try {
    startUrl = new URL(url);
  } catch {
    return {
      content: [{ type: 'text', text: `Error: Invalid URL "${url}"` }],
      isError: true,
    };
  }

  const maxDepth = args.max_depth != null ? Number(args.max_depth) : 2;
  const maxPages = args.max_pages != null ? Number(args.max_pages) : 20;
  const scope = (args.scope as string) || `${startUrl.origin}/**`;
  const includePatterns = args.include_patterns as string[] | undefined;
  const excludePatterns = args.exclude_patterns as string[] | undefined;
  const outputFormat = (args.output_format as string) || 'markdown';
  const respectRobots = args.respect_robots !== false;
  const delayMs = args.delay_ms != null ? Number(args.delay_ms) : 1000;
  const concurrency = args.concurrency != null ? Math.max(1, Math.min(10, Number(args.concurrency))) : 3;

  const startTime = Date.now();
  const tracker = new CrawlTracker();
  const pages: CrawledPage[] = [];
  let maxDepthReached = 0;

  // Fetch robots.txt if needed
  const robotsCache = new Map<string, RobotsRules | null>();

  async function getRobotsRules(pageUrl: string): Promise<RobotsRules | null> {
    if (!respectRobots) return null;
    try {
      const origin = new URL(pageUrl).origin;
      if (robotsCache.has(origin)) return robotsCache.get(origin)!;
      const rules = await fetchRobotsTxt(sessionId, origin, context);
      robotsCache.set(origin, rules);
      return rules;
    } catch {
      return null;
    }
  }

  // Check if a URL should be crawled
  function shouldCrawl(candidateUrl: string): boolean {
    // Must match scope
    if (!matchesScope(candidateUrl, scope)) return false;

    // Must pass include/exclude filters
    if (!passesFilters(candidateUrl, includePatterns, excludePatterns)) return false;

    // Must not already be visited
    if (tracker.hasVisited(candidateUrl)) return false;

    return true;
  }

  // Check robots.txt compliance
  async function isRobotsAllowed(candidateUrl: string): Promise<boolean> {
    if (!respectRobots) return true;
    try {
      const rules = await getRobotsRules(candidateUrl);
      if (!rules) return true;
      const parsedUrl = new URL(candidateUrl);
      return isAllowedByRobots(parsedUrl.pathname, rules);
    } catch {
      return true;
    }
  }

  try {
    // Seed the BFS queue with the start URL
    const normalizedStart = normalizeUrl(url);
    tracker.enqueue([{ url: normalizedStart, depth: 0 }]);

    const limiter = createLimiter(concurrency);

    // BFS loop
    while (pages.length < maxPages) {
      // Check budget
      if (context && !hasBudget(context, 15_000)) {
        console.error('[crawl] Deadline approaching, stopping crawl');
        break;
      }

      // Collect a batch of URLs to fetch in parallel
      const batch: Array<{ url: string; depth: number }> = [];
      const batchSize = Math.min(concurrency, maxPages - pages.length);

      for (let i = 0; i < batchSize; i++) {
        const next = tracker.dequeue();
        if (!next) break;

        // Skip if exceeds max depth
        if (next.depth > maxDepth) continue;

        batch.push(next);
      }

      if (batch.length === 0) {
        // Check if there are still items in the queue beyond max_depth
        const probe = tracker.dequeue();
        if (!probe) break; // Queue is truly empty
        // If it's beyond depth, we're done
        if (probe.depth > maxDepth) break;
        // Otherwise put it back and try again — shouldn't happen but be safe
        tracker.enqueue([probe]);
        break;
      }

      // Fetch batch in parallel with concurrency limiter
      const batchResults = await Promise.all(
        batch.map((item) =>
          limiter(async () => {
            // Check robots.txt before fetching
            const allowed = await isRobotsAllowed(item.url);
            if (!allowed) {
              console.error(`[crawl] Blocked by robots.txt: ${item.url}`);
              return {
                page: {
                  url: item.url,
                  title: '',
                  content: '',
                  depth: item.depth,
                  links_found: 0,
                  error: 'Blocked by robots.txt',
                } as CrawledPage,
                links: [] as string[],
                depth: item.depth,
              };
            }

            // Mark as visited
            tracker.visit(item.url);

            const result = await fetchPage(sessionId, item.url, item.depth, outputFormat, context);

            // Extract discovered links (stored transiently)
            const links = ((result as CrawledPage & { _links?: string[] })._links || []);
            delete (result as CrawledPage & { _links?: string[] })._links;

            // Apply delay between fetches
            if (delayMs > 0) {
              await new Promise((r) => setTimeout(r, delayMs));
            }

            return { page: result, links, depth: item.depth };
          }),
        ),
      );

      // Process results and enqueue discovered links
      for (const { page, links, depth } of batchResults) {
        pages.push(page);
        if (depth > maxDepthReached) maxDepthReached = depth;

        // Enqueue discovered links for next depth level
        if (depth < maxDepth && !page.error) {
          const nextDepth = depth + 1;
          const newUrls: Array<{ url: string; depth: number }> = [];

          for (const link of links) {
            const normalized = normalizeUrl(link);
            if (shouldCrawl(normalized)) {
              newUrls.push({ url: normalized, depth: nextDepth });
            }
          }

          if (newUrls.length > 0) {
            tracker.enqueue(newUrls);
          }
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const succeeded = pages.filter((p) => !p.error).length;
    const failed = pages.filter((p) => p.error).length;

    const summary: CrawlSummary = {
      total_pages: pages.length,
      succeeded,
      failed,
      max_depth_reached: maxDepthReached,
      duration_ms: durationMs,
      scope,
    };

    const output = { summary, pages };

    // Ensure output fits within limits
    let outputJson = JSON.stringify(output, null, 2);
    if (outputJson.length > MAX_OUTPUT_CHARS) {
      // Truncate page contents progressively to fit
      const truncatedPages = pages.map((p) => ({
        ...p,
        content: p.content.length > 2000
          ? p.content.slice(0, 2000) + '...[truncated]'
          : p.content,
      }));
      outputJson = JSON.stringify({ summary, pages: truncatedPages }, null, 2);

      // If still too large, remove content entirely
      if (outputJson.length > MAX_OUTPUT_CHARS) {
        const minimalPages = pages.map((p) => ({
          url: p.url,
          title: p.title,
          depth: p.depth,
          links_found: p.links_found,
          content_length: p.content.length,
          error: p.error,
        }));
        outputJson = JSON.stringify({ summary, pages: minimalPages, note: 'Content omitted due to size constraints' }, null, 2);
      }
    }

    return {
      content: [{ type: 'text', text: outputJson }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `crawl error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerCrawlTool(server: MCPServer): void {
  server.registerTool('crawl', handler, definition);
}
