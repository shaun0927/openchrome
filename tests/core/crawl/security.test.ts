/// <reference types="jest" />

/**
 * Security regression tests for the resumable crawl tools (issue #886 PR #937
 * security review). Covers:
 *
 *   - Finding 1 (critical): assertValidJobId rejects path-traversal and other
 *     non-ULID jobIds; tool entry points refuse to touch disk for bad ids.
 *   - Finding 2 (high): redactor wraps URLs/titles/content before they hit the
 *     JSONL job log on disk.
 *   - Finding 3 (high): page content exceeding OC_CRAWL_PAGE_BYTES is
 *     truncated and marked with `truncated: true`.
 *   - Finding 5 (medium): crawl_cancel issued during a delay_ms sleep is
 *     observed by the runner within one page-fetch slot rather than after the
 *     full advance window.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  assertValidJobId,
  createJob,
  getOriginalQueuedUrl,
  getOriginalStartUrl,
  jobFilePath,
  loadJob,
  type JobConfig,
} from '../../../src/core/crawl/job-store';
import { registerCrawlStartTool } from '../../../src/tools/crawl-start';
import {
  registerCrawlStatusTool,
  _setAdvanceOptionsForTests,
} from '../../../src/tools/crawl-status';
import { registerCrawlCancelTool } from '../../../src/tools/crawl-cancel';
import type {
  MCPToolDefinition,
  MCPResult,
  ToolHandler,
} from '../../../src/types/mcp';

import { startFixtureServer, type FixtureServer } from '../../helpers/fixture-server';
import { makeSpyFetcher, type SpyState } from '../../helpers/http-fetcher';

interface FakeServer {
  registerTool(name: string, handler: ToolHandler, def: MCPToolDefinition): void;
  handlers: Map<string, ToolHandler>;
}

function makeFakeServer(): FakeServer {
  const handlers = new Map<string, ToolHandler>();
  return {
    handlers,
    registerTool(name, handler) {
      handlers.set(name, handler);
    },
  };
}

let server: FixtureServer | undefined;
let crawlStart: ToolHandler | undefined;
let crawlStatus: ToolHandler | undefined;
let crawlCancel: ToolHandler | undefined;
let jobsRoot: string;

function mkTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-security-test-'));
  process.env.OC_JOBS_ROOT = dir;
  jobsRoot = dir;
  return dir;
}

function bootTools(): void {
  const fake = makeFakeServer();
  registerCrawlStartTool(fake as unknown as Parameters<typeof registerCrawlStartTool>[0]);
  registerCrawlStatusTool(fake as unknown as Parameters<typeof registerCrawlStatusTool>[0]);
  registerCrawlCancelTool(fake as unknown as Parameters<typeof registerCrawlCancelTool>[0]);
  crawlStart = fake.handlers.get('crawl_start')!;
  crawlStatus = fake.handlers.get('crawl_status')!;
  crawlCancel = fake.handlers.get('crawl_cancel')!;
}

function parseResult(res: MCPResult): Record<string, unknown> {
  return JSON.parse((res.content?.[0] as { text: string }).text);
}

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    url: 'http://example.test/',
    max_depth: 1,
    max_pages: 5,
    scope: 'http://example.test/**',
    output_format: 'markdown',
    respect_robots: false,
    delay_ms: 0,
    concurrency: 1,
    ...overrides,
  };
}

afterEach(async () => {
  _setAdvanceOptionsForTests(undefined);
  if (server) {
    await server.close();
    server = undefined;
  }
  delete process.env.OC_JOBS_ROOT;
  delete process.env.OC_CRAWL_PAGE_BYTES;
});

// ---------------------------------------------------------------------------
// Finding 1 — assertValidJobId
// ---------------------------------------------------------------------------

describe('assertValidJobId (finding 1)', () => {
  test('rejects ".." path-traversal segment', () => {
    expect(() => assertValidJobId('..')).toThrow(/not a valid ULID/);
    expect(() => assertValidJobId('../../../etc/passwd')).toThrow(/not a valid ULID/);
  });

  test('rejects absolute paths', () => {
    expect(() => assertValidJobId('/etc/passwd')).toThrow(/not a valid ULID/);
    expect(() => assertValidJobId('/abs/path')).toThrow(/not a valid ULID/);
  });

  test('rejects empty string', () => {
    expect(() => assertValidJobId('')).toThrow(/non-empty string/);
  });

  test('rejects non-ULID characters (lowercase, I/L/O/U, separators)', () => {
    expect(() => assertValidJobId('abcdefghijklmnopqrstuvwxyz')).toThrow(/not a valid ULID/);
    expect(() => assertValidJobId('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toThrow(/not a valid ULID/);
    expect(() => assertValidJobId('01ARZ3NDEKTSV4RRFFQ69G5FAL')).toThrow(/not a valid ULID/);
    expect(() => assertValidJobId('01ARZ3NDEKTSV4RRFFQ69G5FAO')).toThrow(/not a valid ULID/);
    expect(() => assertValidJobId('01ARZ3NDEKTSV4RRFFQ69G5FAU')).toThrow(/not a valid ULID/);
    expect(() => assertValidJobId('01ARZ3NDEKTSV/RRFFQ69G5FA8')).toThrow(/not a valid ULID/);
    expect(() => assertValidJobId('01ARZ3NDEKTSV\0RRFFQ69G5FA8')).toThrow(/not a valid ULID/);
  });

  test('accepts a freshly generated ULID round-trip', async () => {
    mkTmpRoot();
    const id = await createJob(makeConfig());
    expect(() => assertValidJobId(id)).not.toThrow();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('tool handlers reject bad jobId without disk access (finding 1)', () => {
  test('crawl_status with traversal jobId returns isError and writes nothing', async () => {
    mkTmpRoot();
    bootTools();
    const before = fs.readdirSync(jobsRoot);
    const res = await crawlStatus!('s', { jobId: '../../../etc/passwd', advance: 1 });
    expect(res.isError).toBe(true);
    const after = fs.readdirSync(jobsRoot);
    expect(after).toEqual(before);
  });

  test('crawl_cancel with traversal jobId returns isError and writes nothing', async () => {
    mkTmpRoot();
    bootTools();
    const before = fs.readdirSync(jobsRoot);
    const res = await crawlCancel!('s', { jobId: '../../../etc/passwd' });
    expect(res.isError).toBe(true);
    const after = fs.readdirSync(jobsRoot);
    expect(after).toEqual(before);
  });

  test('crawl_status with absolute-path jobId returns isError', async () => {
    mkTmpRoot();
    bootTools();
    const res = await crawlStatus!('s', { jobId: '/tmp/evil', advance: 1 });
    expect(res.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — redactor applied to JSONL
// ---------------------------------------------------------------------------

describe('redactor scrubs secrets before they hit the JSONL log (finding 2)', () => {
  test('a URL with ?token=… is stored as ?token=[REDACTED]', async () => {
    mkTmpRoot();
    // Fixture page whose name happens to carry a credential-looking query
    // string when the runner records it. The fixture server itself ignores
    // the query string (it strips ?… from the URL path), so the page is
    // still served correctly.
    server = await startFixtureServer([{ name: 'leaky', links: [] }]);
    bootTools();
    const spy: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy) });

    const sensitiveUrl = `${server.url('leaky')}?token=secret123`;
    const startBody = parseResult(
      await crawlStart!('s', { url: sensitiveUrl, max_pages: 1, max_depth: 0 }),
    );
    const jobId = startBody.jobId as string;
    await crawlStatus!('s', { jobId, advance: 5 });

    const file = jobFilePath(jobId);
    const raw = fs.readFileSync(file, 'utf8');
    // The secret value must NOT appear anywhere in the log.
    expect(raw).not.toContain('secret123');
    // Token marker is preserved with [REDACTED] sentinel.
    expect(raw).toContain('token=[REDACTED]');
    // Header config.url was scrubbed by createJob.
    const header = JSON.parse(raw.split('\n')[0]);
    expect(header.config.url).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — page-content byte cap
// ---------------------------------------------------------------------------

describe('OC_CRAWL_PAGE_BYTES truncates oversize page content (finding 3)', () => {
  test('content exceeding the cap is truncated with truncated:true marker', async () => {
    mkTmpRoot();
    process.env.OC_CRAWL_PAGE_BYTES = '128';
    // Use non-hex characters (`X` is not in [a-fA-F0-9]) so the credential
    // scrubber's `hex_token` regex does not preemptively redact this body
    // to `[REDACTED]` — we specifically want to exercise the byte-cap path.
    const giantBody = '<p>' + 'X'.repeat(4096) + '</p>';
    server = await startFixtureServer([{ name: 'big', body: giantBody }]);
    bootTools();
    const spy: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy) });

    const startBody = parseResult(
      await crawlStart!('s', { url: server.url('big'), max_pages: 1, max_depth: 0 }),
    );
    const jobId = startBody.jobId as string;
    const body = parseResult(
      await crawlStatus!('s', { jobId, advance: 5, includePages: true }),
    );
    const pages = body.pages as Array<{ content: string; truncated?: boolean }>;
    expect(pages.length).toBe(1);
    expect(Buffer.byteLength(pages[0].content, 'utf8')).toBeLessThanOrEqual(128);
    expect(pages[0].truncated).toBe(true);
  });

  test('content under the cap is NOT marked truncated', async () => {
    mkTmpRoot();
    process.env.OC_CRAWL_PAGE_BYTES = '4096';
    server = await startFixtureServer([{ name: 'small', body: '<p>tiny</p>' }]);
    bootTools();
    const spy: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy) });

    const startBody = parseResult(
      await crawlStart!('s', { url: server.url('small'), max_pages: 1, max_depth: 0 }),
    );
    const jobId = startBody.jobId as string;
    const body = parseResult(
      await crawlStatus!('s', { jobId, advance: 5, includePages: true }),
    );
    const pages = body.pages as Array<{ content: string; truncated?: boolean }>;
    expect(pages[0].truncated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Finding 3 (continued) — max_pages clamp
// ---------------------------------------------------------------------------

describe('crawl_start clamps max_pages to [1, 10_000] (finding 3)', () => {
  test('Number.MAX_SAFE_INTEGER is clamped to 10_000', async () => {
    mkTmpRoot();
    bootTools();
    const res = parseResult(
      await crawlStart!('s', {
        url: 'http://example.test/',
        max_pages: Number.MAX_SAFE_INTEGER,
      }),
    );
    const jobId = res.jobId as string;
    const state = loadJob(jobId);
    expect(state.config.max_pages).toBe(10_000);
  });

  test('value of 0 is clamped to 1', async () => {
    mkTmpRoot();
    bootTools();
    const res = parseResult(
      await crawlStart!('s', { url: 'http://example.test/', max_pages: 0 }),
    );
    const state = loadJob(res.jobId as string);
    expect(state.config.max_pages).toBe(1);
  });

  test('negative max_depth is clamped to 0', async () => {
    mkTmpRoot();
    bootTools();
    const res = parseResult(
      await crawlStart!('s', { url: 'http://example.test/', max_depth: -5 }),
    );
    const state = loadJob(res.jobId as string);
    expect(state.config.max_depth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Finding 5 — cancel observed mid-advance
// ---------------------------------------------------------------------------

describe('crawl_cancel is observed mid-advance (finding 5)', () => {
  test('cancel after first page truncates advance ≤ 2 pages', async () => {
    mkTmpRoot();
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    server = await startFixtureServer(
      names.map((n, i) => ({
        name: n,
        links: i + 1 < names.length ? [names[i + 1]] : [],
      })),
    );
    bootTools();
    const spy: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy) });

    const startBody = parseResult(
      await crawlStart!('s', {
        url: server.url('a'),
        max_pages: 6,
        max_depth: 6,
        delay_ms: 100,
      }),
    );
    const jobId = startBody.jobId as string;

    // Kick off an advance with delay_ms: 100, advance: 5. The first page
    // fetches fast; while the runner is sleeping between pages we issue
    // crawl_cancel. The runner must observe `cancelled` either before the
    // sleep or right after, so ≤ 2 pages are fetched in total.
    const advancePromise = crawlStatus!('s', { jobId, advance: 5 });
    // Give the runner enough time to fetch one page and start its first
    // inter-page sleep (delay_ms=100). 30ms is comfortably inside the
    // sleep window for the first iteration.
    await new Promise((r) => setTimeout(r, 30));
    await crawlCancel!('s', { jobId });

    const advBody = parseResult(await advancePromise);
    expect(advBody.status).toBe('cancelled');
    expect((advBody.completed as number)).toBeLessThanOrEqual(2);
    expect(spy.calls.length).toBeLessThanOrEqual(2);

    // A subsequent advance must remain cancelled and perform no further
    // fetches.
    const post = parseResult(await crawlStatus!('s', { jobId, advance: 5 }));
    expect(post.status).toBe('cancelled');
  });
});


// ---------------------------------------------------------------------------
// Follow-up review regressions — robots, signed start URL, duplicate queue
// ---------------------------------------------------------------------------

describe('crawl review follow-ups', () => {
  test('same-process jobs fetch the original signed start URL while persisting a redacted header', async () => {
    mkTmpRoot();
    server = await startFixtureServer([{ name: 'signed', links: [] }]);
    bootTools();
    const spy: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy) });

    const signedUrl = `${server.url('signed')}?token=secret123`;
    const startBody = parseResult(
      await crawlStart!('s', { url: signedUrl, max_pages: 1, max_depth: 0 }),
    );
    await crawlStatus!('s', { jobId: startBody.jobId, advance: 1 });

    expect(spy.calls[0]?.url).toBe(signedUrl);
    const raw = fs.readFileSync(jobFilePath(startBody.jobId as string), 'utf8');
    expect(raw).not.toContain('secret123');
    expect(raw.split('\n')[0]).toContain('token=[REDACTED]');
  });

  test('same-process jobs fetch original signed discovered URLs while persisting redacted queue entries', async () => {
    mkTmpRoot();
    server = await startFixtureServer({
      '/root': {
        body:
          '<!doctype html><html><head><title>root</title></head><body>' +
          '<a href="/child?token=child-secret">child</a>' +
          '</body></html>',
      },
      '/child': {
        body: '<!doctype html><html><head><title>child</title></head><body>child</body></html>',
      },
    });
    bootTools();
    const spy: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy) });

    const signedChildUrl = `${server.origin}/child?token=child-secret`;
    const startBody = parseResult(
      await crawlStart!('s', { url: `${server.origin}/root`, max_pages: 2, max_depth: 1 }),
    );
    await crawlStatus!('s', { jobId: startBody.jobId, advance: 2 });

    expect(spy.calls.map((c) => c.url)).toEqual([`${server.origin}/root`, signedChildUrl]);
    const raw = fs.readFileSync(jobFilePath(startBody.jobId as string), 'utf8');
    expect(raw).not.toContain('child-secret');
    expect(raw).toContain('token=[REDACTED]');
    expect(getOriginalStartUrl(startBody.jobId as string)).toBeUndefined();
    expect(
      getOriginalQueuedUrl(
        startBody.jobId as string,
        `${server.origin}/child?token=%5BREDACTED%5D`,
      ),
    ).toBeUndefined();
  });

  test('respect_robots blocks disallowed pages before the fetcher runs', async () => {
    mkTmpRoot();
    server = await startFixtureServer({
      '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nDisallow: /blocked\n' },
      '/blocked': { body: '<html><body>blocked</body></html>' },
    });
    bootTools();
    const spy: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy) });

    const startBody = parseResult(
      await crawlStart!('s', { url: `${server.origin}/blocked`, max_pages: 1, max_depth: 0 }),
    );
    const body = parseResult(
      await crawlStatus!('s', { jobId: startBody.jobId, advance: 1, includePages: true }),
    );

    expect(spy.calls).toHaveLength(0);
    const pages = body.pages as Array<{ error?: string }>;
    expect(pages[0]?.error).toBe('Blocked by robots.txt');
  });
});
