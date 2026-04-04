/**
 * Crawl Sitemap Tool - Sitemap-based web crawling via sitemap.xml discovery
 *
 * Discovers sitemaps from robots.txt or well-known locations, parses sitemap XML,
 * and crawls listed pages. Supports sitemap index files with recursive resolution.
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
  parseSitemapXml,
  parseRobotsTxt,
  CrawlTracker,
  urlGlobToRegex,
} from '../utils/crawl-utils';

const definition: MCPToolDefinition = {
  name: 'crawl_sitemap',
  description:
    'Crawl a website using its sitemap.xml. Auto-discovers sitemaps from robots.txt or well-known URLs (/sitemap.xml, /sitemap_index.xml). Supports sitemap index files and URL filtering.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Website URL (auto-discovers /sitemap.xml, /sitemap_index.xml)',
      },
      sitemap_url: {
        type: 'string',
        description: 'Explicit sitemap URL (skips auto-discovery)',
      },
      filter: {
        type: 'string',
        description: 'URL glob pattern to filter which sitemap URLs to visit',
      },
      max_pages: {
        type: 'number',
        description: 'Maximum number of pages to visit. Default: 50',
      },
      output_format: {
        type: 'string',
        enum: ['markdown', 'text', 'structured'],
        description: 'Content format per page. Default: markdown',
      },
      concurrency: {
        type: 'number',
        description: 'Max concurrent page fetches. Default: 3',
      },
    },
    required: ['url'],
  },
};

// ---------------------------------------------------------------------------
// Concurrency limiter (same pattern as crawl.ts / batch-paginate.ts)
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
  links_found: number;
  error?: string;
}

interface CrawlSitemapSummary {
  total_pages: number;
  succeeded: number;
  failed: number;
  duration_ms: number;
  sitemap_source: string;
}

// ---------------------------------------------------------------------------
// Fetch raw text from a URL via browser target
// ---------------------------------------------------------------------------

async function fetchRawText(
  sessionId: string,
  url: string,
  context?: ToolContext,
): Promise<string | null> {
  const sessionManager = getSessionManager();
  let targetId: string | null = null;

  try {
    const { targetId: tid, page } = await sessionManager.createTarget(sessionId, url);
    targetId = tid;

    const bodyText = await withTimeout(
      page.evaluate(() => {
        // For XML documents (sitemaps), Chrome XSLT-renders the content.
        // Use XMLSerializer to get the raw XML source.
        if (document.contentType && document.contentType.includes('xml')) {
          return new XMLSerializer().serializeToString(document);
        }
        // For HTML documents (robots.txt served as HTML, error pages), use innerText
        return document.body?.innerText || '';
      }),
      5000,
      'crawl_sitemap.fetchRawText.evaluate',
      context,
    );

    await sessionManager.closeTarget(sessionId, tid);
    targetId = null;

    return bodyText || null;
  } catch (err) {
    console.error(
      `[crawl_sitemap] Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
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
// Sitemap discovery: robots.txt -> /sitemap.xml -> /sitemap_index.xml
// ---------------------------------------------------------------------------

async function discoverSitemapUrls(
  sessionId: string,
  origin: string,
  context?: ToolContext,
): Promise<{ urls: string[]; source: string }> {
  // Step 1: Try robots.txt
  const robotsText = await fetchRawText(sessionId, `${origin}/robots.txt`, context);
  if (robotsText && (robotsText.toLowerCase().includes('user-agent') || robotsText.toLowerCase().includes('sitemap'))) {
    const rules = parseRobotsTxt(robotsText);
    if (rules.sitemaps.length > 0) {
      console.error(`[crawl_sitemap] Found ${rules.sitemaps.length} sitemap(s) in robots.txt`);
      return { urls: rules.sitemaps, source: `${origin}/robots.txt` };
    }
  }

  // Step 2: Try /sitemap.xml
  const sitemapXml = await fetchRawText(sessionId, `${origin}/sitemap.xml`, context);
  if (sitemapXml && (sitemapXml.includes('<urlset') || sitemapXml.includes('<sitemapindex'))) {
    console.error(`[crawl_sitemap] Found sitemap at ${origin}/sitemap.xml`);
    return { urls: [`${origin}/sitemap.xml`], source: `${origin}/sitemap.xml` };
  }

  // Step 3: Try /sitemap_index.xml
  const indexXml = await fetchRawText(sessionId, `${origin}/sitemap_index.xml`, context);
  if (indexXml && (indexXml.includes('<urlset') || indexXml.includes('<sitemapindex'))) {
    console.error(`[crawl_sitemap] Found sitemap at ${origin}/sitemap_index.xml`);
    return { urls: [`${origin}/sitemap_index.xml`], source: `${origin}/sitemap_index.xml` };
  }

  return { urls: [], source: 'none' };
}

// ---------------------------------------------------------------------------
// Resolve sitemap URLs (handles sitemap index recursion up to 2 levels)
// ---------------------------------------------------------------------------

async function resolveSitemapPageUrls(
  sessionId: string,
  sitemapUrls: string[],
  filterPattern: string | undefined,
  maxPages: number,
  context?: ToolContext,
  depth = 0,
): Promise<string[]> {
  const pageUrls: string[] = [];
  const filterRegex = filterPattern ? urlGlobToRegex(filterPattern) : null;

  for (const sitemapUrl of sitemapUrls) {
    if (pageUrls.length >= maxPages) break;

    // Check budget before fetching each sitemap
    if (context && !hasBudget(context, 10_000)) {
      console.error('[crawl_sitemap] Budget limit approaching, stopping sitemap resolution');
      break;
    }

    const xml = await fetchRawText(sessionId, sitemapUrl, context);
    if (!xml) {
      console.error(`[crawl_sitemap] Could not fetch sitemap: ${sitemapUrl}`);
      continue;
    }

    const parsed = parseSitemapXml(xml);

    if (parsed.isSitemapIndex) {
      // Recurse into child sitemaps (up to 2 levels deep)
      if (depth < 2) {
        console.error(
          `[crawl_sitemap] Sitemap index with ${parsed.sitemapIndexUrls.length} child sitemaps (depth=${depth})`,
        );
        const childUrls = await resolveSitemapPageUrls(
          sessionId,
          parsed.sitemapIndexUrls,
          filterPattern,
          maxPages - pageUrls.length,
          context,
          depth + 1,
        );
        pageUrls.push(...childUrls);
      } else {
        console.error(`[crawl_sitemap] Max sitemap index depth reached, skipping: ${sitemapUrl}`);
      }
    } else {
      // Regular sitemap — collect page URLs
      for (const entry of parsed.urls) {
        if (pageUrls.length >= maxPages) break;

        const normalized = normalizeUrl(entry.loc);

        // Apply filter if provided
        if (filterRegex && !filterRegex.test(normalized)) continue;

        pageUrls.push(normalized);
      }
    }
  }

  return pageUrls;
}

// ---------------------------------------------------------------------------
// Single page fetch (same pattern as crawl.ts)
// ---------------------------------------------------------------------------

async function fetchPage(
  sessionId: string,
  url: string,
  outputFormat: string,
  context?: ToolContext,
): Promise<CrawledPage> {
  const sessionManager = getSessionManager();
  let targetId: string | null = null;

  try {
    const { targetId: tid, page } = await sessionManager.createTarget(sessionId, url);
    targetId = tid;

    // Small settle delay for dynamic content
    await new Promise((r) => setTimeout(r, 500));

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
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
            acceptNode(n: Node) {
              const t = (n as HTMLElement).tagName?.toLowerCase();
              if (t === 'script' || t === 'style' || t === 'noscript') return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            },
          });
          const parts: string[] = [];
          let node: Node | null = walker.currentNode;

          while (node) {
            const el = node as HTMLElement;
            const tag = el.tagName?.toLowerCase();

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
            else if (tag === 'blockquote') {
              const text = el.textContent?.trim();
              if (text) parts.push(`\n> ${text}\n`);
            }

            node = walker.nextNode();
          }

          content = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();

          if (!content) {
            content = document.body.innerText || '';
          }
        } else if (format === 'text') {
          content = document.body.innerText || '';
        } else {
          content = document.body.innerHTML || '';
        }

        return { title, content, linksCount: links.length };
      }, outputFormat),
      15000,
      'crawl_sitemap.page.evaluate',
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
      links_found: result.linksCount,
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
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      content: [{ type: 'text', text: `Error: Invalid URL "${url}"` }],
      isError: true,
    };
  }

  const sitemapUrlArg = args.sitemap_url as string | undefined;
  const filterPattern = args.filter as string | undefined;
  const maxPages = args.max_pages != null ? Number(args.max_pages) : 50;
  const outputFormat = (args.output_format as string) || 'markdown';
  const concurrency = args.concurrency != null ? Math.max(1, Math.min(10, Number(args.concurrency))) : 3;

  const startTime = Date.now();
  const tracker = new CrawlTracker();
  const pages: CrawledPage[] = [];
  let sitemapSource = '';

  try {
    // -----------------------------------------------------------------------
    // Step 1: Discover or use provided sitemap URL(s)
    // -----------------------------------------------------------------------
    let sitemapUrls: string[];

    if (sitemapUrlArg) {
      // Explicit sitemap URL provided
      sitemapUrls = [sitemapUrlArg];
      sitemapSource = sitemapUrlArg;
      console.error(`[crawl_sitemap] Using explicit sitemap: ${sitemapUrlArg}`);
    } else {
      // Auto-discover from robots.txt -> /sitemap.xml -> /sitemap_index.xml
      const origin = parsedUrl.origin;
      const discovery = await discoverSitemapUrls(sessionId, origin, context);
      sitemapUrls = discovery.urls;
      sitemapSource = discovery.source;

      if (sitemapUrls.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: 'No sitemap found',
                  tried: [
                    `${origin}/robots.txt`,
                    `${origin}/sitemap.xml`,
                    `${origin}/sitemap_index.xml`,
                  ],
                  suggestion:
                    'Provide an explicit sitemap_url parameter or use the crawl tool for BFS-based crawling.',
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    }

    // -----------------------------------------------------------------------
    // Step 2: Resolve all page URLs from sitemap(s)
    // -----------------------------------------------------------------------
    const pageUrls = await resolveSitemapPageUrls(
      sessionId,
      sitemapUrls,
      filterPattern,
      maxPages,
      context,
    );

    if (pageUrls.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'Sitemap found but no matching URLs',
                sitemap_source: sitemapSource,
                filter: filterPattern || 'none',
                suggestion: 'Check the filter pattern or try without a filter.',
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    console.error(`[crawl_sitemap] Resolved ${pageUrls.length} page URLs from sitemap`);

    // -----------------------------------------------------------------------
    // Step 3: Crawl pages with concurrency limiter
    // -----------------------------------------------------------------------
    const limiter = createLimiter(concurrency);
    const urlsToVisit = pageUrls.slice(0, maxPages);

    // Process in batches to allow budget checking between batches
    const batchSize = concurrency;
    for (let i = 0; i < urlsToVisit.length; i += batchSize) {
      // Check budget before each batch
      if (context && !hasBudget(context, 15_000)) {
        console.error('[crawl_sitemap] Deadline approaching, stopping page crawl');
        break;
      }

      const batch = urlsToVisit.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((pageUrl) =>
          limiter(async () => {
            // Skip already visited URLs (deduplication)
            if (tracker.hasVisited(pageUrl)) {
              return null;
            }
            tracker.visit(pageUrl);

            return fetchPage(sessionId, pageUrl, outputFormat, context);
          }),
        ),
      );

      for (const result of batchResults) {
        if (result) {
          pages.push(result);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step 4: Build output
    // -----------------------------------------------------------------------
    const durationMs = Date.now() - startTime;
    const succeeded = pages.filter((p) => !p.error).length;
    const failed = pages.filter((p) => p.error).length;

    const summary: CrawlSitemapSummary = {
      total_pages: pages.length,
      succeeded,
      failed,
      duration_ms: durationMs,
      sitemap_source: sitemapSource,
    };

    const output = { summary, pages };

    // Ensure output fits within limits
    let outputJson = JSON.stringify(output, null, 2);
    if (outputJson.length > MAX_OUTPUT_CHARS) {
      // Truncate page contents progressively to fit
      const truncatedPages = pages.map((p) => ({
        ...p,
        content:
          p.content.length > 2000
            ? p.content.slice(0, 2000) + '...[truncated]'
            : p.content,
      }));
      outputJson = JSON.stringify({ summary, pages: truncatedPages }, null, 2);

      // If still too large, remove content entirely
      if (outputJson.length > MAX_OUTPUT_CHARS) {
        const minimalPages = pages.map((p) => ({
          url: p.url,
          title: p.title,
          links_found: p.links_found,
          content_length: p.content.length,
          error: p.error,
        }));
        outputJson = JSON.stringify(
          { summary, pages: minimalPages, note: 'Content omitted due to size constraints' },
          null,
          2,
        );
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
          text: `crawl_sitemap error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerCrawlSitemapTool(server: MCPServer): void {
  server.registerTool('crawl_sitemap', handler, definition);
}
