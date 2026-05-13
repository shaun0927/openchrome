/**
 * crawl_status — advance a crawl job by up to N pages and return state (issue #886).
 *
 * Strict P1: all fetching happens inside this call. When `advance: 0` the
 * runner is skipped entirely and the call is read-only. Results are capped at
 * `OC_CRAWL_STATUS_MAX_PAGES` (default 200); excess pages remain in the JSONL
 * and the response reports `pagesOmitted`.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext } from '../types/mcp';
import { assertValidJobId, loadJob, isExpired, type JobState } from '../core/crawl/job-store';
import { advanceJob, defaultAdvance, type AdvanceOptions } from '../core/crawl/runner';
import { emitCrawlTrace } from '../core/crawl/trace-emit';

const definition: MCPToolDefinition = {
  name: 'crawl_status',
  description:
    'Advance a crawl job by up to `advance` pages (default 5, env ' +
    'OC_CRAWL_ADVANCE_DEFAULT) and return current state. `advance: 0` is ' +
    'read-only and performs no fetching. Returns { status, completed, total, ' +
    'errors, pages?, pagesOmitted?, startedAt, finishedAt? }. Pages array is ' +
    'capped at OC_CRAWL_STATUS_MAX_PAGES (default 200).',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'REQUIRED Job id returned by crawl_start.' },
      advance: {
        type: 'number',
        description: 'Max pages to fetch in this call. Default OC_CRAWL_ADVANCE_DEFAULT (5). Use 0 for read-only.',
      },
      includePages: { type: 'boolean', description: 'Include `pages` in the response. Default false.' },
    },
    required: ['jobId'],
  },
};

function statusMaxPages(): number {
  const raw = process.env.OC_CRAWL_STATUS_MAX_PAGES;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 200;
}

interface StatusResponse {
  jobId: string;
  status: JobState['status'];
  completed: number;
  total: number;
  errors: JobState['errors'];
  pages?: JobState['pages'];
  pagesOmitted?: number;
  startedAt?: number;
  finishedAt?: number;
}

let runnerOptionsOverride: AdvanceOptions | undefined;
/** Test hook — substitute fetcher / spy on the runner. */
export function _setAdvanceOptionsForTests(opts: AdvanceOptions | undefined): void {
  runnerOptionsOverride = opts;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  const jobId = args.jobId as string;
  if (!jobId || typeof jobId !== 'string') {
    return errorResult('jobId is required and must be a string');
  }
  // Validate BEFORE any disk access so a caller cannot use a malformed
  // jobId (e.g. `../../../etc/passwd`) to make `loadJob` read attacker-
  // chosen files. Mirrors the defence-in-depth in job-store.
  try {
    assertValidJobId(jobId);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
  const advance =
    args.advance != null && Number.isFinite(Number(args.advance))
      ? Math.max(0, Math.floor(Number(args.advance)))
      : defaultAdvance();
  const includePages = args.includePages === true;

  let state: JobState;
  try {
    state = loadJob(jobId);
  } catch (err) {
    return errorResult(`failed to load job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const beforeCompleted = state.pages.length;

  if (advance > 0) {
    // Runner handles expiry, cancel-sticky, and lifecycle transitions
    // atomically under the job lock. Letting it own the transition keeps
    // this caller free of lock churn.
    try {
      state = await advanceJob(jobId, advance, sessionId, context, runnerOptionsOverride);
    } catch (err) {
      return errorResult(
        `advance failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (
    state.status !== 'expired' &&
    state.status !== 'completed' &&
    state.status !== 'cancelled' &&
    isExpired(state, Date.now())
  ) {
    // advance: 0 path — still surface `expired` for the host, but the
    // status event itself goes through the runner so the same lock owns
    // it.  Calling advanceJob(0) is a no-op write-wise yet performs the
    // expired transition for us under the lock.
    try {
      state = await advanceJob(jobId, 0, sessionId, context, runnerOptionsOverride);
    } catch (err) {
      return errorResult(
        `expired-transition failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const max = statusMaxPages();
  const completedDelta = state.pages.length - beforeCompleted;

  const response: StatusResponse = {
    jobId,
    status: state.status,
    completed: state.pages.length,
    total: state.config.max_pages,
    errors: state.errors,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };

  if (includePages) {
    if (state.pages.length > max) {
      response.pages = state.pages.slice(0, max);
      response.pagesOmitted = state.pages.length - max;
    } else {
      response.pages = state.pages;
    }
  }

  await emitCrawlTrace(sessionId, 'crawl_status', {
    jobId,
    advance,
    completed_delta: completedDelta,
    status: state.status,
  });

  // strip undefined for clean JSON
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(response)) {
    if (v !== undefined) cleaned[k] = v;
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(cleaned) }],
    ...cleaned,
  };
};

function errorResult(message: string): MCPResult {
  return {
    content: [{ type: 'text', text: `crawl_status error: ${message}` }],
    isError: true,
  };
}

export function registerCrawlStatusTool(server: MCPServer): void {
  server.registerTool('crawl_status', handler, definition);
}
