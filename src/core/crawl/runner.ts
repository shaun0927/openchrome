/**
 * runner — drives a resumable crawl job by up to N pages per call (issue #886).
 *
 * Strict P1: all work happens inside the calling `crawl_status` tool. No
 * background timers, no worker threads, no scheduled tasks. When this function
 * returns the runner has no live promises and no I/O outlives the call.
 *
 * Persistence: state lives in the JSONL job file (`job-store.ts`). Every
 * fetched page or error is appended as an event before the next page is
 * attempted, so a process death between fetches leaves a consistent log that
 * the next `advanceJob` call resumes from.
 */

import { TextDecoder } from 'node:util';
import { MAX_OUTPUT_CHARS } from '../../config/defaults';
import type { ToolContext } from '../../types/mcp';
import { hasBudget } from '../../types/mcp';
import {
  normalizeUrl,
  matchesScope,
  passesFilters,
  parseRobotsTxt,
  isAllowedByRobots,
  CrawlTracker,
  type RobotsRules,
} from '../../utils/crawl-utils';
import { staticFetch } from '../../utils/static-fetch';
import {
  fetchOnePage as defaultFetchOnePage,
  type FetchOnePageOptions,
  type FetchOnePageResult,
} from '../../tools/crawl';

import {
  appendEventUnlocked,
  getOriginalStartUrl,
  isExpired,
  loadJob,
  queueEntryKey,
  rememberOriginalQueuedUrls,
  setStatusUnlocked,
  takeOriginalQueuedUrl,
  withJobLock,
  type CrawledPage,
  type CrawledPageTextField,
  type JobState,
  type QueueEntry,
} from './job-store';
import { redactValue } from '../trace/redactor';
import { canReadCache, canWriteCache, CrawlContentCache } from './content-cache';

/** Default `advance` value when callers omit it. */
export function defaultAdvance(): number {
  const raw = process.env.OC_CRAWL_ADVANCE_DEFAULT;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 5;
}

/** Per-page budget used to decide whether another fetch fits in the tool deadline. */
const PER_PAGE_BUDGET_MS = 15_000;

/**
 * Hard upper bound on `page.content` bytes (UTF-8) written to the JSONL log.
 * Default 256 KiB — generous for prose pages, restrictive enough that a
 * pathological 100 MiB single-page response cannot blow up the on-disk
 * job file. Tunable via `OC_CRAWL_PAGE_BYTES`.
 */
function pageContentByteCap(): number {
  const raw = process.env.OC_CRAWL_PAGE_BYTES;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 262_144;
}

/**
 * Truncate a UTF-8 string to at most `maxBytes` bytes. Returns the original
 * string when already small enough plus a `truncated` flag. We cut on the
 * byte boundary and back off until the slice ends on a complete code point.
 */
function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return { value, truncated: false };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let end = maxBytes;
  while (end > 0) {
    try {
      return { value: decoder.decode(buf.subarray(0, end)), truncated: true };
    } catch {
      end--;
    }
  }
  return { value: '', truncated: true };
}

/**
 * String scrubber that handles the `string | undefined` shape used by the
 * page record fields. Preserves the `undefined` branch so the on-the-wire
 * type does not change.
 */
function scrubString(value: string): string {
  const out = redactValue(value);
  return typeof out === 'string' ? out : value;
}

const SHARED_OUTPUT_TRUNCATION_SUFFIX = '...[truncated]';

function wasSharedOutputTruncated(value: string): boolean {
  return value.length === MAX_OUTPUT_CHARS + SHARED_OUTPUT_TRUNCATION_SUFFIX.length &&
    value.endsWith(SHARED_OUTPUT_TRUNCATION_SUFFIX);
}

function filterWithoutQuery(
  filter: FetchOnePageResult['filter'],
): FetchOnePageResult['filter'] {
  if (!filter) return undefined;
  const copy = { ...filter };
  delete copy.query;
  return copy;
}

interface PageProjectionOptions {
  returnRaw: boolean;
  projectFit: boolean;
  includeFilter: boolean;
}

interface PreparedPage {
  page: CrawledPage;
  cachePage: FetchOnePageResult;
  links: string[];
}

function preparePageForPersistence(
  result: FetchOnePageResult,
  byteCap: number,
  options: PageProjectionOptions,
): PreparedPage {
  const safeResult = redactValue({
    url: result.url,
    title: result.title,
    content: result.content,
    raw_markdown: options.returnRaw ? result.raw_markdown : undefined,
    filter: options.includeFilter ? filterWithoutQuery(result.filter) : undefined,
    error: result.error,
    _links: result._links ?? [],
  }) as {
    url: string;
    title: string;
    content: string;
    raw_markdown?: string;
    filter?: FetchOnePageResult['filter'];
    error?: string;
    _links: string[];
  };

  const distinctRaw =
    options.returnRaw &&
    safeResult.raw_markdown !== undefined &&
    safeResult.raw_markdown !== safeResult.content
      ? safeResult.raw_markdown
      : undefined;
  const contentBytes = Buffer.byteLength(safeResult.content, 'utf8');
  const rawBytes = distinctRaw === undefined ? 0 : Buffer.byteLength(distinctRaw, 'utf8');

  let contentBudget = byteCap;
  let rawBudget = 0;
  if (distinctRaw !== undefined) {
    contentBudget = Math.min(contentBytes, Math.ceil(byteCap / 2));
    rawBudget = Math.min(rawBytes, Math.floor(byteCap / 2));
    let remaining = byteCap - contentBudget - rawBudget;
    const contentRemainder = Math.min(Math.max(0, contentBytes - contentBudget), remaining);
    contentBudget += contentRemainder;
    remaining -= contentRemainder;
    rawBudget += Math.min(Math.max(0, rawBytes - rawBudget), remaining);
  }

  const boundedContent = truncateUtf8(safeResult.content, contentBudget);
  const boundedRaw = distinctRaw === undefined
    ? undefined
    : truncateUtf8(distinctRaw, rawBudget);
  const truncatedFields = new Set<CrawledPageTextField>();
  for (const field of result.truncated_fields ?? []) {
    if (
      field === 'content' ||
      (field === 'raw_markdown' && options.returnRaw) ||
      (field === 'fit_markdown' && options.projectFit)
    ) {
      truncatedFields.add(field);
    }
  }
  const contentWasTruncated =
    result.truncated === true ||
    wasSharedOutputTruncated(result.content) ||
    boundedContent.truncated;
  if (contentWasTruncated) {
    truncatedFields.add('content');
    if (options.projectFit) truncatedFields.add('fit_markdown');
    if (options.returnRaw && distinctRaw === undefined) truncatedFields.add('raw_markdown');
  }
  if (boundedRaw?.truncated) truncatedFields.add('raw_markdown');

  const page: CrawledPage = {
    url: safeResult.url,
    title: safeResult.title,
    content: boundedContent.value,
    ...(boundedRaw !== undefined ? { raw_markdown: boundedRaw.value } : {}),
    ...(safeResult.filter !== undefined ? { filter: safeResult.filter } : {}),
    depth: result.depth,
    links_found: result.links_found,
    ...(contentWasTruncated ? { truncated: true } : {}),
    ...(truncatedFields.size > 0 ? { truncated_fields: Array.from(truncatedFields) } : {}),
    ...(safeResult.error !== undefined ? { error: safeResult.error } : {}),
  };
  const cachePage: FetchOnePageResult = {
    ...page,
    ...(safeResult._links.length > 0 ? { _links: safeResult._links } : {}),
  };
  return { page, cachePage, links: safeResult._links };
}

/**
 * Injection point for tests — substitutes the puppeteer-based `fetchOnePage`
 * with a plain HTTP fetcher. Default is the real CDP-backed implementation.
 */
export type PageFetcher = (
  sessionId: string,
  url: string,
  depth: number,
  opts: FetchOnePageOptions,
  context?: ToolContext,
) => Promise<FetchOnePageResult>;

export interface AdvanceOptions {
  fetcher?: PageFetcher;
}

async function fetchRobotsRulesForUrl(
  pageUrl: string,
  cache: Map<string, RobotsRules | null>,
  context?: ToolContext,
): Promise<RobotsRules | null> {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }
  const cached = cache.get(parsed.origin);
  if (cached !== undefined) return cached;
  try {
    const { html, status } = await staticFetch(`${parsed.origin}/robots.txt`, {
      signal: context?.signal,
    });
    const rules = status >= 200 && status < 300 ? parseRobotsTxt(html) : null;
    cache.set(parsed.origin, rules);
    return rules;
  } catch {
    cache.set(parsed.origin, null);
    return null;
  }
}

function robotsPathFor(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}

/**
 * Advance the job by up to `advance` pages.
 *
 * Returns the post-advance JobState. Status transitions handled here:
 *   pending → running on first fetch
 *   running → completed when queue drains or max_pages reached
 *   any → expired when retention TTL elapsed (no fetches performed)
 *   any → cancelled is sticky; if already cancelled we return without fetching
 */
export async function advanceJob(
  jobId: string,
  advance: number,
  sessionId: string,
  context?: ToolContext,
  options: AdvanceOptions = {},
): Promise<JobState> {
  const fetcher = options.fetcher ?? defaultFetchOnePage;

  // Per-page critical section — we acquire the per-job lock around each
  // fetch+persist step and release it during the inter-page `delay_ms` sleep.
  // Holding the lock for the whole advance call would block `crawl_cancel`
  // for `advance * delay_ms` (#886 security finding 5); releasing around the
  // sleep keeps cancel observable within one page-fetch slot.  Two concurrent
  // `crawl_status({ advance })` callers serialise per-page rather than
  // per-advance, which is still "no double-fetch" because the lock owns the
  // queue/visited persistence transition.
  let state: JobState = await withJobLock(jobId, async () => loadJob(jobId));

  // Terminal statuses are inert — no fetching, no transitions.
  if (state.status === 'cancelled' || state.status === 'completed') {
    return state;
  }

  const now = Date.now();
  if (isExpired(state, now) && state.status !== 'expired') {
    await withJobLock(jobId, async () => {
      // Re-check inside the lock to avoid a TOCTOU promotion to expired
      // when a concurrent caller has already finalised the job.
      const fresh = loadJob(jobId);
      if (
        fresh.status !== 'expired' &&
        fresh.status !== 'cancelled' &&
        fresh.status !== 'completed'
      ) {
        setStatusUnlocked(jobId, 'expired');
      }
    });
    return loadJob(jobId);
  }
  if (state.status === 'expired') {
    return state;
  }

  if (advance <= 0) {
    // Read-only — no transitions, no fetches.
    return state;
  }

  await withJobLock(jobId, async () => {
    // Seed the queue with the start URL on the first non-zero advance.
    const fresh = loadJob(jobId);
    if (fresh.pages.length === 0 && fresh.queue.length === 0) {
      const startUrl = getOriginalStartUrl(jobId) ?? fresh.config.url;
      const seed: QueueEntry = { url: normalizeUrl(startUrl), depth: 0 };
      appendEventUnlocked(jobId, { kind: 'enqueue', urls: [seed], t: Date.now() });
    }
    // Promote to running. Status events are deduplicated by the replay
    // (terminal sticky), but `running` is not terminal so it's fine to
    // re-emit when resuming from a crashed run.
    const afterSeed = loadJob(jobId);
    if (
      afterSeed.status !== 'running' &&
      afterSeed.status !== 'cancelled' &&
      afterSeed.status !== 'completed' &&
      afterSeed.status !== 'expired'
    ) {
      setStatusUnlocked(jobId, 'running');
    }
  });
  state = loadJob(jobId);

  const maxPages = state.config.max_pages;
  const maxDepth = state.config.max_depth;
  const scope = state.config.scope;
  const includePatterns = state.config.include_patterns;
  const excludePatterns = state.config.exclude_patterns;
  const outputFormat = state.config.output_format;
  const onlyMainContent = state.config.onlyMainContent;
  const includeLinks = state.config.includeLinks;
  const usesMarkdownProjection = outputFormat === 'markdown-clean';
  const contentFilter = usesMarkdownProjection
    ? (state.config.content_filter ?? 'none')
    : 'none';
  const query = usesMarkdownProjection
    ? state.config.query
    : undefined;
  const returnRaw = usesMarkdownProjection && state.config.return_raw === true;
  const returnFit = usesMarkdownProjection &&
    (state.config.return_fit ?? contentFilter !== 'none');
  const projectFit = contentFilter !== 'none' && returnFit;
  const includeFilter = usesMarkdownProjection &&
    (contentFilter !== 'none' || returnRaw || returnFit);
  const delayMs = state.config.delay_ms;
  const respectRobots = state.config.respect_robots;
  const cacheMode = state.config.cache_mode ?? 'disabled';
  const cacheScope = state.config.cache_scope ?? 'public';
  const rawMarkdownRequiresSessionScope = returnRaw && cacheScope === 'public';
  const cacheTtlMs = state.config.cache_ttl_ms;
  const crawlCache = new CrawlContentCache<FetchOnePageResult>();
  const robotsCache = new Map<string, RobotsRules | null>();

  let fetched = 0;
  const byteCap = pageContentByteCap();
  while (fetched < advance && state.pages.length < maxPages) {
    if (context && !hasBudget(context, PER_PAGE_BUDGET_MS)) {
      // Stop early — the tool wrapper will report `running` (resumable).
      break;
    }

    // Per-page critical section: pick the next URL, fetch (still inside
    // the lock so concurrent advancers don't double-fetch), and persist
    // the events. Then release the lock for the inter-page sleep so
    // `crawl_cancel` can promote the status while we wait.
    const pageOutcome = await withJobLock(jobId, async (): Promise<'continue' | 'break'> => {
      const fresh = loadJob(jobId);
      if (fresh.status === 'cancelled' || fresh.status === 'completed') {
        return 'break';
      }
      // Rebuild the BFS tracker from the persisted state — it might have
      // grown since the last iteration (this caller's own enqueue events,
      // or a concurrent advance in another process).
      const tracker = new CrawlTracker();
      for (const v of fresh.visited) tracker.visit(v, v);
      for (const q of fresh.queue) tracker.enqueue([q]);

      if (fresh.pages.length >= maxPages) return 'break';

      const next = tracker.dequeue();
      if (!next) return 'break';
      if (next.depth > maxDepth) return 'continue';

      const originalStartUrl = getOriginalStartUrl(jobId);
      const originalQueuedUrl = takeOriginalQueuedUrl(jobId, next.key);
      const fetchUrl =
        next.depth === 0 && originalStartUrl
          ? originalStartUrl
          : (originalQueuedUrl ?? next.url);
      tracker.visit(next.url, next.key);

      if (respectRobots) {
        const rules = await fetchRobotsRulesForUrl(fetchUrl, robotsCache, context);
        if (rules && !isAllowedByRobots(robotsPathFor(fetchUrl), rules)) {
          const safeUrl = scrubString(next.url);
          const message = 'Blocked by robots.txt';
          appendEventUnlocked(jobId, { kind: 'error', url: safeUrl, message, t: Date.now() });
          appendEventUnlocked(jobId, {
            kind: 'fetched',
            url: safeUrl,
            depth: next.depth,
            page: {
              url: safeUrl,
              title: '',
              content: '',
              depth: next.depth,
              links_found: 0,
              error: message,
            },
            t: Date.now(),
            ...(next.key ? { key: next.key } : {}),
          });
          fetched++;
          return 'continue';
        }
      }

      const cacheKey = crawlCache.key({
        url: fetchUrl,
        outputFormat,
        engine: 'crawl_job',
        cacheScope,
        sessionFingerprint: sessionId,
        dimensions: {
          onlyMainContent,
          includeLinks,
          scope,
          includePatterns,
          excludePatterns,
          contentFilter,
          query,
          returnRaw,
          returnFit,
          pageByteCap: byteCap,
        },
      });

      let result: FetchOnePageResult;
      let cacheMeta: CrawledPage['cache'];
      const cached = canReadCache(cacheMode) && !rawMarkdownRequiresSessionScope
        ? crawlCache.read(cacheKey, cacheTtlMs)
        : null;
      if (cached && !cached.stale) {
        result = {
          ...cached.entry.page,
          depth: next.depth,
          _links: cached.entry.page._links ?? cached.entry.links,
        };
        cacheMeta = crawlCache.metadata('hit', {
          key: cacheKey,
          scope: cacheScope,
          hit: true,
          createdAt: cached.entry.createdAt,
          content_length: cached.entry.contentLength,
        });
      } else try {
        result = await fetcher(
          sessionId,
          fetchUrl,
          next.depth,
          {
            outputFormat,
            onlyMainContent,
            includeLinks,
            contentFilter,
            query,
            returnRaw,
            returnFit,
          },
          context,
        );
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        // Scrub the error message: a fetch failure can quote a URL with
        // `?token=…`, a basic-auth header, etc.
        const message = scrubString(rawMessage);
        const safeUrl = scrubString(next.url);
        appendEventUnlocked(jobId, { kind: 'error', url: safeUrl, message, t: Date.now() });
        appendEventUnlocked(jobId, {
          kind: 'fetched',
          url: safeUrl,
          depth: next.depth,
          page: {
            url: safeUrl,
            title: '',
            content: '',
            depth: next.depth,
            links_found: 0,
            error: message,
          },
          t: Date.now(),
          ...(next.key ? { key: next.key } : {}),
        });
        fetched++;
        return 'continue';
      }

      const links = result._links ?? [];
      const prepared = preparePageForPersistence(result, byteCap, {
        returnRaw,
        projectFit,
        includeFilter,
      });
      if (cacheMode !== 'disabled' && !(cached && !cached.stale)) {
        const cacheStatus = cacheMode === 'write_only' ? 'write_only' : cacheMode === 'bypass' ? 'bypass' : 'miss';
        const writeBlockedReason = rawMarkdownRequiresSessionScope
          ? 'raw-markdown-requires-session-scope'
          : undefined;
        cacheMeta = crawlCache.metadata(cacheStatus, {
          key: cacheKey,
          scope: cacheScope,
          hit: false,
          write: writeBlockedReason && canWriteCache(cacheMode) ? 'skipped' : 'disabled',
          ...(writeBlockedReason ? { write_skipped_reason: writeBlockedReason } : {}),
        });
        if (canWriteCache(cacheMode) && !writeBlockedReason && !result.error) {
          const written = crawlCache.write({
            key: cacheKey,
            sourceUrl: scrubString(fetchUrl),
            finalUrl: prepared.page.url,
            page: prepared.cachePage,
            links: prepared.links,
            cacheScope,
          });
          cacheMeta = crawlCache.metadata(cacheStatus, {
            key: cacheKey,
            scope: cacheScope,
            hit: false,
            write: written.stored ? 'stored' : 'skipped',
            write_skipped_reason: written.reason,
            createdAt: written.entry?.createdAt,
            content_length: prepared.page.content.length,
          });
        }
      }
      const page: CrawledPage = {
        ...prepared.page,
        ...(cacheMeta ? { cache: cacheMeta } : {}),
      };
      appendEventUnlocked(jobId, {
        kind: 'fetched',
        url: page.url,
        depth: next.depth,
        page,
        t: Date.now(),
        ...(next.key ? { key: next.key } : {}),
      });
      fetched++;

      // Enqueue discovered links one depth level below.
      if (next.depth < maxDepth && !page.error) {
        const newEntries: QueueEntry[] = [];
        for (const link of links) {
          const normalized = normalizeUrl(link);
          if (!matchesScope(normalized, scope)) continue;
          if (!passesFilters(normalized, includePatterns, excludePatterns)) continue;
          const key = queueEntryKey(normalized);
          if (tracker.hasVisited(normalized, key)) continue;
          newEntries.push({ url: normalized, depth: next.depth + 1, key });
        }
        if (newEntries.length > 0) {
          rememberOriginalQueuedUrls(jobId, newEntries);
          appendEventUnlocked(jobId, { kind: 'enqueue', urls: newEntries, t: Date.now() });
        }
      }
      return 'continue';
    });

    if (pageOutcome === 'break') break;

    // Re-load OUTSIDE the lock so the next iteration's `state.pages.length`
    // bound reflects the page we just persisted.
    state = loadJob(jobId);

    if (delayMs > 0 && fetched < advance && state.pages.length < maxPages) {
      // Cancel observability: check status, then sleep without the lock so
      // `crawl_cancel` can write its status event during the wait.
      if (state.status === 'cancelled') break;
      await new Promise((r) => setTimeout(r, delayMs));
      // Re-check after the sleep — a cancel may have landed.
      state = loadJob(jobId);
      if (state.status === 'cancelled') break;
    }
  }

  // Final status transition under the lock.
  await withJobLock(jobId, async () => {
    const fresh = loadJob(jobId);
    if (fresh.status === 'cancelled' || fresh.status === 'completed' || fresh.status === 'expired') {
      return;
    }
    const queueEmpty = fresh.queue.length === 0;
    const reachedMax = fresh.pages.length >= maxPages;
    if (queueEmpty || reachedMax) {
      setStatusUnlocked(jobId, 'completed');
    }
  });
  return loadJob(jobId);
}
