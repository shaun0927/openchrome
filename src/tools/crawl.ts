/**
 * Crawl Tool - Recursive link-following web crawler with depth/scope controls.
 * Server-side BFS execution eliminates LLM round-trips per page.
 * @see https://github.com/shaun0927/openchrome/issues/576
 */
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, hasBudget } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { MAX_OUTPUT_CHARS } from '../config/defaults';
import { withTimeout } from '../utils/with-timeout';
import {
  normalizeUrl, matchesScope, passesFilters, discoverLinks,
  CrawlTracker, parseRobotsTxt, isAllowedByRobots, RobotsRules,
} from '../utils/crawl-utils';

const definition: MCPToolDefinition = {
  name: 'crawl',
  description: 'Recursively crawl a website by following links. Server-side execution — no LLM round-trip per page.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Starting URL to crawl from' },
      max_depth: { type: 'number', description: 'Maximum link-following depth. Default: 2' },
      max_pages: { type: 'number', description: 'Maximum total pages to visit. Default: 20' },
      scope: { type: 'string', description: 'URL glob pattern to stay within. Default: same origin.' },
      include_patterns: { type: 'array', items: { type: 'string' }, description: 'URL glob patterns to include' },
      exclude_patterns: { type: 'array', items: { type: 'string' }, description: 'URL glob patterns to skip' },
      output_format: { type: 'string', enum: ['markdown', 'text', 'structured'], description: 'Content format. Default: markdown' },
      respect_robots: { type: 'boolean', description: 'Respect robots.txt. Default: true' },
      delay_ms: { type: 'number', description: 'Delay between requests in ms. Default: 1000' },
      concurrency: { type: 'number', description: 'Max concurrent fetches. Default: 3' },
    },
    required: ['url'],
  },
};

interface CrawlPageResult {
  url: string; title: string; content: string; depth: number; links_found: number; error?: string;
}
interface InternalCrawlResult extends CrawlPageResult { discoveredLinks: string[]; }

function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try { return await fn(); }
    finally { active--; if (queue.length > 0) queue.shift()!(); }
  };
}

async function crawlSinglePage(
  sessionId: string, url: string, depth: number, outputFormat: string, context?: ToolContext,
): Promise<InternalCrawlResult> {
  const sessionManager = getSessionManager();
  let targetId: string | null = null;
  try {
    const { targetId: tid, page } = await sessionManager.createTarget(sessionId, url);
    targetId = tid;
    await new Promise((r) => setTimeout(r, 500));
    const extracted = await withTimeout(
      page.evaluate((fmt: string) => {
        const title = document.title || '';
        const html = document.body?.innerHTML || '';
        let content: string;
        if (fmt === 'text') { content = document.body?.innerText || ''; }
        else {
          const body = document.body;
          if (!body) { content = ''; }
          else {
            const parts: string[] = [];
            body.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
              parts.push(`${'#'.repeat(parseInt(h.tagName[1]))} ${h.textContent?.trim()}`);
            });
            parts.push(body.innerText || '');
            content = parts.join('\n\n');
          }
        }
        return { title, content, html };
      }, outputFormat), 15000, 'crawl.extract', context,
    );
    await sessionManager.closeTarget(sessionId, tid);
    targetId = null;
    let content = extracted.content;
    if (content.length > MAX_OUTPUT_CHARS) content = content.slice(0, MAX_OUTPUT_CHARS) + '...[truncated]';
    const discoveredLinks = discoverLinks(extracted.html, url);
    return { url, title: extracted.title, content, depth, links_found: discoveredLinks.length, discoveredLinks };
  } catch (err) {
    if (targetId) { try { await sessionManager.closeTarget(sessionId, targetId); } catch { /* ignore */ } }
    return { url, title: '', content: '', depth, links_found: 0, error: err instanceof Error ? err.message : String(err), discoveredLinks: [] };
  }
}

async function fetchRobotsTxt(sessionId: string, origin: string, context?: ToolContext): Promise<RobotsRules | null> {
  const sessionManager = getSessionManager();
  let targetId: string | null = null;
  try {
    const { targetId: tid, page } = await sessionManager.createTarget(sessionId, `${origin}/robots.txt`);
    targetId = tid;
    await new Promise((r) => setTimeout(r, 500));
    const text = await withTimeout(page.evaluate(() => document.body?.innerText || ''), 5000, 'crawl.robots', context);
    await sessionManager.closeTarget(sessionId, tid); targetId = null;
    if (!text || text.includes('404') || text.includes('Not Found')) return null;
    return parseRobotsTxt(text);
  } catch {
    if (targetId) { try { await sessionManager.closeTarget(sessionId, targetId); } catch { /* ignore */ } }
    return null;
  }
}

const handler: ToolHandler = async (sessionId: string, args: Record<string, unknown>, context?: ToolContext): Promise<MCPResult> => {
  const url = args.url as string;
  if (!url) return { content: [{ type: 'text', text: 'Error: url is required' }], isError: true };

  const maxDepth = args.max_depth != null ? Number(args.max_depth) : 2;
  const maxPages = args.max_pages != null ? Number(args.max_pages) : 20;
  const outputFormat = (args.output_format as string) || 'markdown';
  const respectRobots = args.respect_robots !== false;
  const delayMs = args.delay_ms != null ? Number(args.delay_ms) : 1000;
  const concurrency = args.concurrency != null ? Number(args.concurrency) : 3;

  let scope = args.scope as string | undefined;
  if (!scope) {
    try { scope = `${new URL(url).origin}/**`; }
    catch { return { content: [{ type: 'text', text: `Error: Invalid URL: ${url}` }], isError: true }; }
  }
  const includePatterns = args.include_patterns as string[] | undefined;
  const excludePatterns = args.exclude_patterns as string[] | undefined;

  if (maxDepth < 0 || maxDepth > 10) return { content: [{ type: 'text', text: 'Error: max_depth must be between 0 and 10' }], isError: true };
  if (maxPages < 1 || maxPages > 100) return { content: [{ type: 'text', text: 'Error: max_pages must be between 1 and 100' }], isError: true };

  const startTime = Date.now();
  const tracker = new CrawlTracker();
  const results: CrawlPageResult[] = [];
  const limiter = createLimiter(concurrency);

  let robotsRules: RobotsRules | null = null;
  if (respectRobots) { try { robotsRules = await fetchRobotsTxt(sessionId, new URL(url).origin, context); } catch { /* continue */ } }

  tracker.enqueue([{ url: normalizeUrl(url), depth: 0 }]);

  while (results.length < maxPages) {
    if (context && !hasBudget(context, 15_000)) { console.error('[crawl] Budget exhausted'); break; }
    const next = tracker.dequeue();
    if (!next) break;
    const { url: currentUrl, depth: currentDepth } = next;
    if (currentDepth > maxDepth) continue;
    if (!matchesScope(currentUrl, scope)) continue;
    if (!passesFilters(currentUrl, includePatterns, excludePatterns)) continue;
    if (robotsRules) {
      try { if (!isAllowedByRobots(new URL(currentUrl).pathname, robotsRules)) { console.error(`[crawl] Blocked by robots.txt: ${currentUrl}`); continue; } }
      catch { continue; }
    }
    if (!tracker.visit(currentUrl)) continue;
    const internalResult = await limiter(() => crawlSinglePage(sessionId, currentUrl, currentDepth, outputFormat, context));
    if (currentDepth < maxDepth && !internalResult.error) {
      tracker.enqueue(internalResult.discoveredLinks.map((link) => ({ url: link, depth: currentDepth + 1 })));
    }
    const { discoveredLinks: _, ...pageResult } = internalResult;
    results.push(pageResult);
    if (delayMs > 0 && results.length < maxPages) await new Promise((r) => setTimeout(r, delayMs));
  }

  const durationMs = Date.now() - startTime;
  const output = {
    summary: {
      total_pages: results.length,
      succeeded: results.filter((r) => !r.error).length,
      failed: results.filter((r) => r.error).length,
      max_depth_reached: Math.max(0, ...results.map((r) => r.depth)),
      duration_ms: durationMs,
      scope,
    },
    pages: results,
  };
  return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
};

export function registerCrawlTool(server: MCPServer): void {
  server.registerTool('crawl', handler, definition);
}
