/**
 * crawl_start — initialise a resumable crawl job (issue #886).
 *
 * Strict P1: performs NO network I/O before returning. The runner only
 * advances inside subsequent `crawl_status({ advance > 0 })` calls.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import {
  assertPersistableCrawlQuery,
  createJob,
  MAX_CRAWL_QUERY_CHARS,
  type JobConfig,
} from '../core/crawl/job-store';
import { parseCrawlCacheMode, parseCrawlCacheScope } from '../core/crawl/content-cache';
import type { ContentFilterType } from '../core/extract/content-filter';
import { emitCrawlTrace } from '../core/crawl/trace-emit';

const definition: MCPToolDefinition = {
  name: 'crawl_start',
  description:
    'Initialise a resumable crawl job. Returns { jobId, status: "pending" } ' +
    'immediately — performs NO network I/O. Drive progress with crawl_status' +
    '({ jobId, advance: N }) which fetches up to N pages per call. Supports ' +
    'the crawl subset listed in this schema; use crawl_cancel to stop.',
  annotations: TOOL_ANNOTATIONS.crawl_start,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'REQUIRED Starting URL to crawl' },
      max_depth: { type: 'number', description: 'Max link-follow depth. Default: 2' },
      max_pages: { type: 'number', description: 'Max pages to crawl. Default: 20' },
      scope: { type: 'string', description: 'URL glob limiting which URLs to follow. Default: same origin.' },
      include_patterns: { type: 'array', items: { type: 'string' }, description: 'URL globs — follow only links matching at least one.' },
      exclude_patterns: { type: 'array', items: { type: 'string' }, description: 'URL globs — skip links matching any.' },
      output_format: { type: 'string', enum: ['markdown', 'text', 'structured', 'markdown-clean'], description: 'Content format. Default: markdown' },
      onlyMainContent: { type: 'boolean', description: 'For markdown-clean, remove nav/footer/ads before conversion. Default: true' },
      includeLinks: { type: 'boolean', description: 'For markdown-clean, include link destinations in markdown. Default: true' },
      content_filter: { type: 'string', enum: ['none', 'prune', 'bm25'], description: 'markdown-clean only: deterministic fit_markdown filter. Default: none.' },
      query: {
        type: 'string',
        maxLength: MAX_CRAWL_QUERY_CHARS,
        description: 'markdown-clean only: query terms required by content_filter="bm25".',
      },
      return_raw: { type: 'boolean', description: 'markdown-clean only: include raw_markdown in each returned page. Default: false.' },
      return_fit: { type: 'boolean', description: 'markdown-clean only: include fit_markdown and use it as content. Defaults to true when filtering.' },
      respect_robots: { type: 'boolean', description: 'Whether to obey robots.txt. Default: true' },
      delay_ms: { type: 'number', description: 'Delay between page fetches (ms). Default: 1000' },
      concurrency: { type: 'number', description: 'Max parallel fetches. Default: 3' },
      cache_mode: { type: 'string', enum: ['disabled', 'enabled', 'read_only', 'write_only', 'bypass'], description: 'Opt-in crawl content cache mode. Default: disabled.' },
      cache_ttl_ms: { type: 'number', description: 'Maximum age for enabled/read_only cache hits. Omit for no TTL expiry.' },
      cache_scope: { type: 'string', enum: ['public', 'session'], description: 'Cache namespace/safety scope. Default: public.' },
    },
    required: ['url'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const url = args.url as string;
  if (!url || typeof url !== 'string') {
    return errorResult('url is required and must be a string');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return errorResult(`Invalid URL "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return errorResult('url must use http or https scheme');
  }

  const outputFormat = (args.output_format as string) || 'markdown';
  const usesMarkdownProjection = outputFormat === 'markdown-clean';
  let contentFilter: ContentFilterType | undefined;
  let query: string | undefined;
  if (usesMarkdownProjection) {
    try {
      contentFilter = parseResumableContentFilter(args.content_filter);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
    if (args.query !== undefined && typeof args.query !== 'string') {
      return errorResult('query must be a string');
    }
    query = args.query as string | undefined;
    try {
      assertPersistableCrawlQuery(query);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
    if (contentFilter === 'bm25' && !query?.trim()) {
      return errorResult('content_filter="bm25" requires a non-empty query');
    }
  }

  // Clamp `max_pages` to [1, 10_000]. The legacy crawl tool accepted up to
  // `Number.MAX_SAFE_INTEGER`, which combined with the (now-capped) per-page
  // content size lets a caller fill the entire jobs directory. 10_000 pages
  // at the 256 KiB content cap caps a single job at ~2.5 GiB on disk.
  const rawMaxPages = args.max_pages != null ? Number(args.max_pages) : 20;
  const clampedMaxPages = Number.isFinite(rawMaxPages)
    ? Math.min(10_000, Math.max(1, Math.floor(rawMaxPages)))
    : 20;

  const rawMaxDepth = args.max_depth != null ? Number(args.max_depth) : 2;
  const clampedMaxDepth = Number.isFinite(rawMaxDepth)
    ? Math.max(0, Math.floor(rawMaxDepth))
    : 2;

  let cacheMode;
  let cacheScope;
  try {
    cacheMode = parseCrawlCacheMode(args.cache_mode);
    cacheScope = parseCrawlCacheScope(args.cache_scope);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }

  const config: JobConfig = {
    url,
    max_depth: clampedMaxDepth,
    max_pages: clampedMaxPages,
    scope: (args.scope as string) || `${parsed.origin}/**`,
    include_patterns: args.include_patterns as string[] | undefined,
    exclude_patterns: args.exclude_patterns as string[] | undefined,
    output_format: outputFormat,
    onlyMainContent: args.onlyMainContent !== false,
    includeLinks: args.includeLinks !== false,
    content_filter: contentFilter,
    query,
    return_raw:
      usesMarkdownProjection && typeof args.return_raw === 'boolean'
        ? args.return_raw
        : undefined,
    return_fit:
      usesMarkdownProjection && typeof args.return_fit === 'boolean'
        ? args.return_fit
        : undefined,
    respect_robots: args.respect_robots !== false,
    delay_ms: args.delay_ms != null ? Number(args.delay_ms) : 1000,
    concurrency:
      args.concurrency != null
        ? Math.max(1, Math.min(10, Number(args.concurrency)))
        : 3,
    cache_mode: cacheMode,
    cache_ttl_ms: typeof args.cache_ttl_ms === 'number' ? args.cache_ttl_ms : undefined,
    cache_scope: cacheScope,
  };

  let jobId: string;
  try {
    jobId = await createJob(config);
  } catch (err) {
    return errorResult(`failed to create job: ${err instanceof Error ? err.message : String(err)}`);
  }

  const createdAt = Date.now();
  await emitCrawlTrace(sessionId, 'crawl_start', { jobId, plannedMax: config.max_pages });

  const payload = {
    jobId,
    status: 'pending' as const,
    queued: 1,
    plannedMax: config.max_pages,
    createdAt,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...payload,
  };
};

function parseResumableContentFilter(value: unknown): ContentFilterType | undefined {
  if (value === undefined) return undefined;
  if (value === 'none' || value === 'prune' || value === 'bm25') return value;
  throw new Error('content_filter must be one of none, prune, bm25');
}

function errorResult(message: string): MCPResult {
  return {
    content: [{ type: 'text', text: `crawl_start error: ${message}` }],
    isError: true,
  };
}

export function registerCrawlStartTool(server: MCPServer): void {
  server.registerTool('crawl_start', handler, definition);
}
