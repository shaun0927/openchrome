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

import type { ToolContext } from '../../types/mcp';
import { hasBudget } from '../../types/mcp';
import {
  normalizeUrl,
  matchesScope,
  passesFilters,
  CrawlTracker,
} from '../../utils/crawl-utils';
import {
  fetchOnePage as defaultFetchOnePage,
  type FetchOnePageOptions,
  type FetchOnePageResult,
} from '../../tools/crawl';

import {
  appendEventUnlocked,
  isExpired,
  loadJob,
  setStatusUnlocked,
  withJobLock,
  type CrawledPage,
  type JobState,
  type QueueEntry,
} from './job-store';

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

  // Single critical section per advance call — concurrent crawl_status calls
  // on the same jobId queue up here, which is what the spec requires (no
  // double-fetch).
  return withJobLock(jobId, async () => {
    let state = loadJob(jobId);

    // Terminal statuses are inert — no fetching, no transitions.
    if (state.status === 'cancelled' || state.status === 'completed') {
      return state;
    }

    const now = Date.now();
    if (isExpired(state, now) && state.status !== 'expired') {
      setStatusUnlocked(jobId, 'expired');
      state = loadJob(jobId);
      return state;
    }
    if (state.status === 'expired') {
      return state;
    }

    if (advance <= 0) {
      // Read-only — no transitions, no fetches.
      return state;
    }

    // Seed the queue with the start URL on the first non-zero advance.
    if (state.pages.length === 0 && state.queue.length === 0) {
      const seed: QueueEntry = { url: normalizeUrl(state.config.url), depth: 0 };
      appendEventUnlocked(jobId, { kind: 'enqueue', urls: [seed], t: Date.now() });
      state = loadJob(jobId);
    }

    // Promote to running. Status events are deduplicated by the replay
    // (terminal sticky), but `running` is not terminal so it's fine to
    // re-emit when resuming from a crashed run.
    if (state.status !== 'running') {
      setStatusUnlocked(jobId, 'running');
      state = loadJob(jobId);
    }

    const maxPages = state.config.max_pages;
    const maxDepth = state.config.max_depth;
    const scope = state.config.scope;
    const includePatterns = state.config.include_patterns;
    const excludePatterns = state.config.exclude_patterns;
    const outputFormat = state.config.output_format;
    const delayMs = state.config.delay_ms;

    // Build an in-memory tracker from the replayed state so the BFS dedup
    // logic matches the legacy `crawl` tool's behavior.
    const tracker = new CrawlTracker();
    for (const v of state.visited) tracker.visit(v);
    for (const q of state.queue) tracker.enqueue([q]);

    let fetched = 0;
    while (fetched < advance && state.pages.length < maxPages) {
      if (context && !hasBudget(context, PER_PAGE_BUDGET_MS)) {
        // Stop early — the tool wrapper will report `running` (resumable).
        break;
      }
      const next = tracker.dequeue();
      if (!next) break;
      if (next.depth > maxDepth) continue;

      // Mark visited up-front so a crash after fetch but before the
      // `fetched` event still records the visit on the next replay (the
      // `fetched` event itself adds to visited). This isn't perfect — a
      // mid-fetch crash will re-attempt the URL — but legacy `crawl`
      // already has this behavior and the test suite accepts dedup by URL.
      let result: FetchOnePageResult;
      try {
        result = await fetcher(sessionId, next.url, next.depth, { outputFormat }, context);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendEventUnlocked(jobId, { kind: 'error', url: next.url, message, t: Date.now() });
        appendEventUnlocked(jobId, {
          kind: 'fetched',
          url: next.url,
          depth: next.depth,
          page: {
            url: next.url,
            title: '',
            content: '',
            depth: next.depth,
            links_found: 0,
            error: message,
          },
          t: Date.now(),
        });
        fetched++;
        continue;
      }

      const links = result._links ?? [];
      const page: CrawledPage = {
        url: result.url,
        title: result.title,
        content: result.content,
        depth: result.depth,
        links_found: result.links_found,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
      appendEventUnlocked(jobId, {
        kind: 'fetched',
        url: next.url,
        depth: next.depth,
        page,
        t: Date.now(),
      });
      fetched++;

      // Enqueue discovered links one depth level below.
      if (next.depth < maxDepth && !page.error) {
        const newEntries: QueueEntry[] = [];
        for (const link of links) {
          const normalized = normalizeUrl(link);
          if (!matchesScope(normalized, scope)) continue;
          if (!passesFilters(normalized, includePatterns, excludePatterns)) continue;
          if (tracker.hasVisited(normalized)) continue;
          newEntries.push({ url: normalized, depth: next.depth + 1 });
        }
        if (newEntries.length > 0) {
          tracker.enqueue(newEntries);
          appendEventUnlocked(jobId, { kind: 'enqueue', urls: newEntries, t: Date.now() });
        }
      }

      if (delayMs > 0 && fetched < advance && state.pages.length + fetched < maxPages) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // Re-load to compute final status based on persisted state.
    state = loadJob(jobId);

    const queueEmpty = state.queue.length === 0;
    const reachedMax = state.pages.length >= maxPages;
    if (queueEmpty || reachedMax) {
      setStatusUnlocked(jobId, 'completed');
      state = loadJob(jobId);
    }

    return state;
  });
}
