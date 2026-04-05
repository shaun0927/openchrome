/**
 * Crawl Sitemap Tool - Sitemap-based page crawler.
 *
 * Discovers URLs via sitemap.xml (or robots.txt → sitemap) and crawls them
 * in parallel, returning content from each page.
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
  parseSitemapXml,
  parseRobotsTxt,
  urlGlobToRegex,
} from '../utils/crawl-utils';

const definition: MCPToolDefinition = {
  name: 'crawl_sitemap',
  description:
    'Crawl pages listed in a website sitemap. Discovers URLs via sitemap.xml (auto-detected from robots.txt or well-known paths) and fetches content from each page.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Website base URL (e.g. "https://docs.example.com")',
      },
      sitemap_url: {
        type: 'string',
        description:
          'Explicit sitemap URL. If omitted, auto-discovered via robots.txt and /sitemap.xml',
      },
      filter: {
        type: 'string',
        description:
          'Glob pattern to filter sitemap URLs (e.g., "https://docs.example.com/api/**")',
      },
      max_pages: {
        type: 'number',
        description: 'Maximum pages to crawl from sitemap. Default: 50',
      },
      output_format: {
        type: 'string',
        enum: ['markdown', 'text', 'structured'],
        description: 'Content format per page. Default: "markdown"',
      },
      concurrency: {
        type: 'number',
        description: 'Maximum concurrent page fetches. Default: 3',
      },
    },
    required: ['url'],
  },
};

interface SitemapPageResult {
  url: string;
  title: string;
  content: string;
  error?: string;
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
 * Fetch raw text/XML from a URL via a browser tab.
 */
async function fetchRawText(
  sessionId: string,
  url: string,
  context?: ToolContext,
): Promise<string> {
  const sessionManager = getSessionManager();
  let targetId: string | null = null;

  try {
    const { targetId: tid, page } = await sessionManager.createTarget(sessionId, url);
    targetId = tid;

    await new Promise((r) => setTimeout(r, 500));

    const text = await withTimeout(
      page.evaluate(() => {
        // For XML documents, use XMLSerializer to get the raw content
        if (document.contentType && document.contentType.includes('xml')) {
          return new XMLSerializer().serializeToString(document);
        }
        return document.body?.innerText || document.documentElement?.innerText || '';
      }),
      10000,
      'crawl_sitemap.fetchRaw',
      context,
    );

    await sessionManager.closeTarget(sessionId, tid);
    targetId = null;

    return text;
  } catch (err) {
    if (targetId) {
      try {
        await sessionManager.closeTarget(sessionId, targetId);
      } catch {
        // ignore cleanup errors
      }
    }
    throw err;
  }
}

/**
 * Fetch a page and extract its title and content.
 */
async function fetchPage(
  sessionId: string,
  url: string,
  outputFormat: string,
  context?: ToolContext,
): Promise<SitemapPageResult> {
  const sessionManager = getSessionManager();
  let targetId: string | null = null;

  try {
    const { targetId: tid, page } = await sessionManager.createTarget(sessionId, url);
    targetId = tid;

    await new Promise((r) => setTimeout(r, 500));

    const extracted = await withTimeout(
      page.evaluate((fmt: string) => {
        const title = document.title || '';
        let content: string;

        if (fmt === 'text') {
          content = document.body?.innerText || '';
        } else {
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

        return { title, content };
      }, outputFormat),
      15000,
      'crawl_sitemap.extract',
      context,
    );

    await sessionManager.closeTarget(sessionId, tid);
    targetId = null;

    let content = extracted.content;
    if (content.length > MAX_OUTPUT_CHARS) {
      content = content.slice(0, MAX_OUTPUT_CHARS) + '...[truncated]';
    }

    return { url, title: extracted.title, content };
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
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Auto-discover the sitemap URL from robots.txt or well-known paths.
 */
async function discoverSitemapUrl(
  sessionId: string,
  baseUrl: string,
  context?: ToolContext,
): Promise<string | null> {
  // 1. Try robots.txt
  try {
    const robotsUrl = `${baseUrl.replace(/\/$/, '')}/robots.txt`;
    const robotsText = await fetchRawText(sessionId, robotsUrl, context);
    const rules = parseRobotsTxt(robotsText);
    if (rules.sitemaps.length > 0) {
      return rules.sitemaps[0];
    }
  } catch {
    // continue to fallback
  }

  // 2. Try /sitemap.xml
  try {
    const sitemapUrl = `${baseUrl.replace(/\/$/, '')}/sitemap.xml`;
    const text = await fetchRawText(sessionId, sitemapUrl, context);
    if (text && (text.includes('<urlset') || text.includes('<sitemapindex'))) {
      return sitemapUrl;
    }
  } catch {
    // continue to fallback
  }

  // 3. Try /sitemap_index.xml
  try {
    const sitemapIndexUrl = `${baseUrl.replace(/\/$/, '')}/sitemap_index.xml`;
    const text = await fetchRawText(sessionId, sitemapIndexUrl, context);
    if (text && (text.includes('<urlset') || text.includes('<sitemapindex'))) {
      return sitemapIndexUrl;
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Resolve all page URLs from a sitemap (handles sitemap index recursion up to 2 levels).
 * Applies the optional filter glob pattern.
 */
async function resolveSitemapPageUrls(
  sessionId: string,
  sitemapUrl: string,
  filter: string | undefined,
  maxPages: number,
  context?: ToolContext,
): Promise<string[]> {
  const filterRegex = filter ? urlGlobToRegex(filter) : null;
  const pageUrls: string[] = [];

  async function processSitemap(url: string, depth: number): Promise<void> {
    if (pageUrls.length >= maxPages) return;

    let text: string;
    try {
      text = await fetchRawText(sessionId, url, context);
    } catch (err) {
      console.error(`[crawl_sitemap] Failed to fetch sitemap ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const result = parseSitemapXml(text);

    if (result.isSitemapIndex && depth < 2) {
      for (const indexUrl of result.sitemapIndexUrls) {
        if (pageUrls.length >= maxPages) break;
        await processSitemap(indexUrl, depth + 1);
      }
    } else {
      for (const sitemapEntry of result.urls) {
        if (pageUrls.length >= maxPages) break;
        const loc = sitemapEntry.loc;
        if (!filterRegex || filterRegex.test(loc)) {
          pageUrls.push(loc);
        }
      }
    }
  }

  await processSitemap(sitemapUrl, 0);
  return pageUrls;
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

  const sitemapUrlArg = args.sitemap_url as string | undefined;
  const filter = args.filter as string | undefined;
  const maxPages = args.max_pages != null ? Number(args.max_pages) : 50;
  const outputFormat = (args.output_format as string) || 'markdown';
  const concurrency = args.concurrency != null ? Number(args.concurrency) : 3;

  // Discover or use explicit sitemap URL
  let sitemapUrl = sitemapUrlArg;
  if (!sitemapUrl) {
    if (context && !hasBudget(context, 30_000)) {
      return {
        content: [{ type: 'text', text: 'Error: Insufficient budget for sitemap discovery' }],
        isError: true,
      };
    }
    sitemapUrl = await discoverSitemapUrl(sessionId, url, context) ?? undefined;
    if (!sitemapUrl) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Could not discover sitemap for ${url}. Try providing sitemap_url explicitly.`,
          },
        ],
        isError: true,
      };
    }
    console.error(`[crawl_sitemap] Discovered sitemap: ${sitemapUrl}`);
  }

  // Resolve page URLs from the sitemap
  const pageUrls = await resolveSitemapPageUrls(sessionId, sitemapUrl, filter, maxPages, context);

  if (pageUrls.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: {
              sitemap_url: sitemapUrl,
              total_pages: 0,
              succeeded: 0,
              failed: 0,
              filter: filter ?? null,
            },
            pages: [],
          }, null, 2),
        },
      ],
    };
  }

  // Crawl pages in parallel batches
  const startTime = Date.now();
  const limiter = createLimiter(concurrency);
  const results = await Promise.all(
    pageUrls.map((pageUrl) =>
      limiter(() => {
        if (context && !hasBudget(context, 10_000)) {
          return Promise.resolve<SitemapPageResult>({
            url: pageUrl,
            title: '',
            content: '',
            error: 'budget exhausted',
          });
        }
        return fetchPage(sessionId, pageUrl, outputFormat, context);
      }),
    ),
  );

  const durationMs = Date.now() - startTime;
  const successCount = results.filter((r) => !r.error).length;
  const failedCount = results.filter((r) => r.error).length;

  const output = {
    summary: {
      sitemap_url: sitemapUrl,
      total_pages: results.length,
      succeeded: successCount,
      failed: failedCount,
      duration_ms: durationMs,
      filter: filter ?? null,
    },
    pages: results,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
  };
};

export function registerCrawlSitemapTool(server: MCPServer): void {
  server.registerTool('crawl_sitemap', handler, definition);
}
