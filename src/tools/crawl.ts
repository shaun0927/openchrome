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
import {
  staticFetch,
  isStaticSufficient,
  extractBodyText,
  StaticFetchError,
  StaticReason,
} from '../utils/static-fetch';
import { buildTextMetrics } from '../core/metrics/token-estimate';
import { AdaptiveCrawlDispatcher, DispatcherMode, parseAdaptiveDispatcherOptions } from '../core/crawl/dispatcher';

const definition: MCPToolDefinition = {
  name: 'crawl',
  description:
    'Recursively crawl a website via BFS. Opens pages in new tabs, extracts text and links, follows them up to max_depth. Respects robots.txt and scope constraints.\n\nWhen to use: Extracting content from multiple pages of a site when the URL structure is not known in advance.\nWhen NOT to use: Use crawl_sitemap when the site has a sitemap.xml, or navigate for a single page.',
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
      engine: {
        type: 'string',
        enum: ['auto', 'static', 'cdp'],
        description:
          'Fetch engine: "cdp" (default, opens a Chrome tab per page), "static" (Node fetch only, fails closed on insufficient pages), or "auto" (static first, fall back to CDP when static is insufficient).',
      },
      include_metrics: {
        type: 'boolean',
        description: 'When true, include approximate output size/token metrics in the JSON result. Default: false.',
      },
      dispatcher: {
        type: 'string',
        enum: ['fixed', 'adaptive'],
        description: 'Crawl concurrency dispatcher. Default: fixed. adaptive reduces concurrency on memory/error pressure and records origin backoff for 429/503 responses.',
      },
      dispatcher_options: {
        type: 'object',
        description: 'dispatcher=adaptive options: min_concurrency, max_concurrency, memory_pressure_mb, origin_backoff_ms, rate_limit_statuses.',
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
  engine_used?: 'static' | 'cdp';
  static_reason?: StaticReason;
}

type EngineMode = 'auto' | 'static' | 'cdp';

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
  _sessionId: string,
  origin: string,
  context?: ToolContext,
): Promise<RobotsRules | null> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const { html: bodyText, status } = await staticFetch(robotsUrl, {
      signal: context?.signal,
    });
    if (status < 200 || status >= 300) return null;
    if (
      bodyText &&
      (bodyText.toLowerCase().includes('user-agent') ||
        bodyText.toLowerCase().includes('disallow'))
    ) {
      return parseRobotsTxt(bodyText);
    }
    return null;
  } catch (err) {
    console.error(
      `[crawl] Failed to fetch robots.txt from ${origin}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Single page fetch
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Static engine — Node fetch path. Returns null + reason on insufficiency so
// the caller (auto mode) can fall back to CDP.
// ---------------------------------------------------------------------------

function buildMarkdownFromHtml(html: string): { title: string; content: string } {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const { text } = extractBodyText(html);
  return { title, content: text };
}

function extractLinksFromHtml(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const re = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;
    if (
      href.startsWith('javascript:') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:')
    ) {
      continue;
    }
    try {
      const resolved = new URL(href, baseUrl).toString();
      if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
        links.push(resolved);
      }
    } catch {
      // skip malformed
    }
  }
  return links;
}

async function fetchPageStatic(
  url: string,
  depth: number,
  outputFormat: string,
  context?: ToolContext,
): Promise<
  | { ok: true; page: CrawledPage & { _links?: string[] } }
  | { ok: false; reason: StaticReason; error?: string }
> {
  try {
    const { html, status, contentType, finalUrl } = await staticFetch(url, {
      signal: context?.signal,
    });
    const sufficiency = isStaticSufficient(html, status, contentType);
    if (!sufficiency.ok) {
      return { ok: false, reason: sufficiency.reason };
    }

    const links = extractLinksFromHtml(html, finalUrl);

    let title = '';
    let content = '';
    if (outputFormat === 'structured') {
      const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
      title = titleMatch ? titleMatch[1].trim() : '';
      const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
      content = bodyMatch ? bodyMatch[1] : html;
    } else {
      const built = buildMarkdownFromHtml(html);
      title = built.title;
      content = built.content;
    }

    if (content.length > MAX_OUTPUT_CHARS) {
      content = content.slice(0, MAX_OUTPUT_CHARS) + '...[truncated]';
    }

    return {
      ok: true,
      page: {
        url,
        title,
        content,
        depth,
        links_found: links.length,
        ...(links.length > 0 ? { _links: links } : {}),
      },
    };
  } catch (err) {
    const reason: StaticReason =
      err instanceof StaticFetchError ? err.reason : 'fetch-error';
    return {
      ok: false,
      reason,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}


/** Options for `fetchOnePage`, shared by legacy crawl and host-driven crawl jobs. */
export interface FetchOnePageOptions {
  outputFormat: string;
  /** When true (default), strip nav/footer/ads from extracted content. */
  onlyMainContent?: boolean;
  /** When true, include outgoing links in the result for BFS expansion. */
  includeLinks?: boolean;
}

/** Single-page crawl result plus transient links for BFS/job queue expansion. */
export interface FetchOnePageResult extends CrawledPage {
  _links?: string[];
}

/**
 * Fetch a single page with the same CDP extraction path used by legacy `crawl`.
 * The async crawl runner imports this instead of duplicating browser behavior.
 */
export async function fetchOnePage(
  sessionId: string,
  url: string,
  depth: number,
  opts: FetchOnePageOptions,
  context?: ToolContext,
): Promise<FetchOnePageResult> {
  return fetchPage(sessionId, url, depth, opts.outputFormat, context) as Promise<FetchOnePageResult>;
}

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
  if (startUrl.protocol !== 'http:' && startUrl.protocol !== 'https:') {
    return {
      content: [{ type: 'text', text: 'Error: url must use http or https scheme' }],
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

  const includeMetrics = args.include_metrics === true;
  const engineArg = args.engine as string | undefined;
  let engine: EngineMode = 'cdp';
  if (engineArg === 'static' || engineArg === 'auto' || engineArg === 'cdp') {
    engine = engineArg;
  } else if (engineArg !== undefined) {
    return {
      content: [{ type: 'text', text: `Error: engine must be one of "auto", "static", "cdp"` }],
      isError: true,
    };
  }
  const engineExplicit = engineArg !== undefined;

  const dispatcherArg = args.dispatcher as string | undefined;
  let dispatcherMode: DispatcherMode = 'fixed';
  if (dispatcherArg === 'fixed' || dispatcherArg === 'adaptive') {
    dispatcherMode = dispatcherArg;
  } else if (dispatcherArg !== undefined) {
    return {
      content: [{ type: 'text', text: 'Error: dispatcher must be one of "fixed", "adaptive"' }],
      isError: true,
    };
  }
  const adaptiveDispatcher = dispatcherMode === 'adaptive'
    ? new AdaptiveCrawlDispatcher(concurrency, parseAdaptiveDispatcherOptions(args.dispatcher_options, concurrency))
    : null;

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
            const runFetch = async () => {
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

            let result: CrawledPage & { _links?: string[] };
            let staticReason: StaticReason | undefined;
            let engineUsed: 'static' | 'cdp' | undefined;

            if (engine === 'static' || engine === 'auto') {
              const staticResult = await fetchPageStatic(
                item.url,
                item.depth,
                outputFormat,
                context,
              );
              if (staticResult.ok) {
                result = staticResult.page;
                engineUsed = 'static';
              } else if (engine === 'static') {
                result = {
                  url: item.url,
                  title: '',
                  content: '',
                  depth: item.depth,
                  links_found: 0,
                  error: `static-insufficient: ${staticResult.reason}`,
                };
                engineUsed = 'static';
                staticReason = staticResult.reason;
              } else {
                // auto: fall through to CDP
                result = await fetchPage(
                  sessionId,
                  item.url,
                  item.depth,
                  outputFormat,
                  context,
                );
                engineUsed = 'cdp';
                staticReason = staticResult.reason;
              }
            } else {
              result = await fetchPage(
                sessionId,
                item.url,
                item.depth,
                outputFormat,
                context,
              );
              if (engineExplicit) engineUsed = 'cdp';
            }

            // Extract discovered links (stored transiently)
            const links = result._links || [];
            delete result._links;

            if (engineExplicit && engineUsed) {
              result.engine_used = engineUsed;
            }
            if (staticReason) {
              result.static_reason = staticReason;
            }

            // Apply delay between fetches
            if (delayMs > 0) {
              await new Promise((r) => setTimeout(r, delayMs));
            }

            return { page: result, links, depth: item.depth };
            };
            const origin = new URL(item.url).origin;
            const output = adaptiveDispatcher
              ? await adaptiveDispatcher.run(origin, runFetch)
              : await runFetch();
            if (adaptiveDispatcher) {
              const statusMatch = output.page.error?.match(/status\s+(\d{3})/i);
              adaptiveDispatcher.recordResponse(origin, statusMatch ? Number(statusMatch[1]) : undefined);
            }
            return output;
          }),
        ),
      );

      // Process results and enqueue discovered links
      for (const { page, links, depth } of batchResults) {
        pages.push(page);
        if (depth > maxDepthReached) maxDepthReached = depth;

        // #869 — emit progress per page (no-op when no progressToken supplied).
        context?.reportProgress?.({
          progress: pages.length,
          total: maxPages,
          message: page.url,
        });

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
      ...(adaptiveDispatcher ? { dispatcher: adaptiveDispatcher.stats() } : {}),
    };

    const buildOutput = (outputPages: CrawledPage[]) => includeMetrics
      ? {
          summary: {
            ...summary,
            metrics: {
              returned_chars: outputPages.reduce((sum, p) => sum + p.content.length, 0),
              estimated_tokens: outputPages.reduce((sum, p) => sum + buildTextMetrics(p.content).estimated_tokens, 0),
              truncated_pages: outputPages.filter((p) => p.content.includes('...[truncated]')).length,
              mode: `crawl:${outputFormat}`,
            },
          },
          pages: outputPages.map((p) => ({
            ...p,
            metrics: buildTextMetrics(p.content, { mode: outputFormat }),
          })),
        }
      : { summary, pages: outputPages };

    // Ensure output fits within limits
    let outputJson = JSON.stringify(buildOutput(pages), null, 2);
    if (outputJson.length > MAX_OUTPUT_CHARS) {
      // Truncate page contents progressively to fit
      const truncatedPages = pages.map((p) => ({
        ...p,
        content: p.content.length > 2000
          ? p.content.slice(0, 2000) + '...[truncated]'
          : p.content,
      }));
      outputJson = JSON.stringify(buildOutput(truncatedPages), null, 2);

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
        const minimalOutput = includeMetrics
          ? {
              summary: {
                ...summary,
                metrics: {
                  returned_chars: 0,
                  estimated_tokens: 0,
                  truncated_pages: minimalPages.length,
                  mode: `crawl:${outputFormat}`,
                },
              },
              pages: minimalPages.map((p) => ({
                ...p,
                metrics: buildTextMetrics('', { mode: outputFormat }),
              })),
              note: 'Content omitted due to size constraints',
            }
          : { summary, pages: minimalPages, note: 'Content omitted due to size constraints' };
        outputJson = JSON.stringify(minimalOutput, null, 2);
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
