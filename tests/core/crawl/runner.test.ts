/// <reference types="jest" />

/**
 * Integration tests for the resumable crawl runner (issue #886).
 *
 * Drives the runner end-to-end against a real HTTP fixture server using the
 * spy fetcher from `tests/helpers/http-fetcher.ts`. Verifies the strict P1
 * contract: no work happens between `crawl_status` calls.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendEvent,
  clearJobRuntimeSecrets,
  createJob,
  jobFilePath,
  loadJob,
  setStatus,
  type JobConfig,
} from '../../../src/core/crawl/job-store';
import { CrawlContentCache } from '../../../src/core/crawl/content-cache';
import { advanceJob } from '../../../src/core/crawl/runner';
import { MAX_OUTPUT_CHARS } from '../../../src/config/defaults';
import type { FetchOnePageResult } from '../../../src/tools/crawl';
import { startFixtureServer, type FixtureServer } from '../../helpers/fixture-server';
import { makeSpyFetcher, type SpyState } from '../../helpers/http-fetcher';

let server: FixtureServer | undefined;

function mkTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-runner-test-'));
  process.env.OC_JOBS_ROOT = dir;
  return dir;
}

function makeConfig(overrides: Partial<JobConfig>): JobConfig {
  const url = overrides.url ?? 'http://127.0.0.1/';
  let scope: string;
  try {
    scope = `${new URL(url).origin}/**`;
  } catch {
    scope = 'http://127.0.0.1/**';
  }
  return {
    url,
    max_depth: 2,
    max_pages: 20,
    scope,
    output_format: 'markdown',
    respect_robots: false,
    delay_ms: 0,
    concurrency: 1,
    ...overrides,
  };
}

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  delete process.env.OC_JOBS_ROOT;
  delete process.env.OC_CRAWL_ADVANCE_DEFAULT;
  delete process.env.OC_CRAWL_STATUS_MAX_PAGES;
  delete process.env.OC_JOB_RETENTION_MS;
  delete process.env.OC_CRAWL_PAGE_BYTES;
  delete process.env.OPENCHROME_CRAWL_CACHE_DIR;
});

describe('runner: lifecycle integration', () => {
  test('crawl_start -> repeated advance -> completed', async () => {
    mkTmpRoot();
    // 8-page linear chain a -> b -> c -> d -> e -> f -> g -> h
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    server = await startFixtureServer(
      names.map((n, i) => ({
        name: n,
        links: i + 1 < names.length ? [names[i + 1]] : [],
      })),
    );
    const config = makeConfig({
      url: server.url('a'),
      max_pages: 8,
      max_depth: 8,
    });
    const jobId = await createJob(config);
    const spy: SpyState = { calls: [] };
    const fetcher = makeSpyFetcher(spy);

    let state = await advanceJob(jobId, 3, 'sess1', undefined, { fetcher });
    expect(state.pages.length).toBe(3);
    expect(state.status).toBe('running');

    state = await advanceJob(jobId, 3, 'sess1', undefined, { fetcher });
    expect(state.pages.length).toBe(6);
    expect(state.status).toBe('running');

    state = await advanceJob(jobId, 5, 'sess1', undefined, { fetcher });
    expect(state.pages.length).toBe(8);
    expect(state.status).toBe('completed');

    // Each URL fetched exactly once.
    const fetchedUrls = spy.calls.map((c) => c.url);
    expect(new Set(fetchedUrls).size).toBe(fetchedUrls.length);
  });

  test('advance bounded by argument N', async () => {
    mkTmpRoot();
    const names = ['p', 'q', 'r', 's', 't'];
    server = await startFixtureServer(
      names.map((n, i) => ({ name: n, links: i + 1 < names.length ? [names[i + 1]] : [] })),
    );
    const jobId = await createJob(
      makeConfig({ url: server.url('p'), max_pages: 10, max_depth: 5 }),
    );
    const spy: SpyState = { calls: [] };
    const state = await advanceJob(jobId, 2, 's', undefined, { fetcher: makeSpyFetcher(spy) });
    expect(spy.calls.length).toBe(2);
    expect(state.pages.length).toBe(2);
  });
});

describe('runner: advance 0 is read-only', () => {
  test('advance=0 does not invoke fetcher', async () => {
    mkTmpRoot();
    server = await startFixtureServer([{ name: 'a' }]);
    const jobId = await createJob(makeConfig({ url: server.url('a'), max_pages: 5 }));
    const spy: SpyState = { calls: [] };
    const state = await advanceJob(jobId, 0, 's', undefined, { fetcher: makeSpyFetcher(spy) });
    expect(spy.calls.length).toBe(0);
    expect(state.pages.length).toBe(0);
    expect(state.status).toBe('pending');
  });
});

describe('runner: cancel sticky', () => {
  test('cancelled job rejects further fetches', async () => {
    mkTmpRoot();
    server = await startFixtureServer([
      { name: 'a', links: ['b'] },
      { name: 'b', links: ['c'] },
      { name: 'c' },
    ]);
    const jobId = await createJob(
      makeConfig({ url: server.url('a'), max_pages: 3, max_depth: 3 }),
    );
    await setStatus(jobId, 'cancelled');
    const spy: SpyState = { calls: [] };
    const state = await advanceJob(jobId, 10, 's', undefined, { fetcher: makeSpyFetcher(spy) });
    expect(spy.calls.length).toBe(0);
    expect(state.status).toBe('cancelled');
  });
});

describe('runner: concurrency lock serialises advances', () => {
  test('two parallel advanceJob calls do not double-fetch', async () => {
    mkTmpRoot();
    const names = ['a', 'b', 'c', 'd'];
    server = await startFixtureServer(
      names.map((n, i) => ({ name: n, links: i + 1 < names.length ? [names[i + 1]] : [] })),
    );
    const jobId = await createJob(
      makeConfig({ url: server.url('a'), max_pages: 4, max_depth: 4 }),
    );
    const spy: SpyState = { calls: [], delayMs: 25 };
    const fetcher = makeSpyFetcher(spy);

    // Two parallel callers each ask for 4 pages — total max 4 fetches.
    const [s1, s2] = await Promise.all([
      advanceJob(jobId, 4, 's1', undefined, { fetcher }),
      advanceJob(jobId, 4, 's2', undefined, { fetcher }),
    ]);

    // Lock serialises them: first call drains queue, second is a no-op.
    expect(spy.calls.length).toBe(4);
    const urls = spy.calls.map((c) => c.url);
    expect(new Set(urls).size).toBe(4);
    expect(s1.pages.length + s2.pages.length).toBeGreaterThanOrEqual(4);
    const final = loadJob(jobId);
    expect(final.pages.length).toBe(4);
    expect(final.status).toBe('completed');
  });
});

describe('runner: resume after process death', () => {
  test('replay JSONL resumes from last persisted page', async () => {
    mkTmpRoot();
    const names = ['a', 'b', 'c', 'd', 'e'];
    server = await startFixtureServer(
      names.map((n, i) => ({ name: n, links: i + 1 < names.length ? [names[i + 1]] : [] })),
    );
    const jobId = await createJob(
      makeConfig({ url: server.url('a'), max_pages: 5, max_depth: 5 }),
    );

    // Run 2 fetches successfully via first advance.
    const spy1: SpyState = { calls: [] };
    let state = await advanceJob(jobId, 2, 's', undefined, { fetcher: makeSpyFetcher(spy1) });
    expect(state.pages.length).toBe(2);
    expect(spy1.calls.length).toBe(2);

    // Simulate process death: rebuild state purely from the JSONL on disk.
    const reloaded = loadJob(jobId);
    expect(reloaded.pages.length).toBe(2);

    // Resume from a fresh runner invocation with a separate spy.
    const spy2: SpyState = { calls: [] };
    state = await advanceJob(jobId, 10, 's', undefined, { fetcher: makeSpyFetcher(spy2) });
    expect(state.pages.length).toBe(5);
    expect(state.status).toBe('completed');

    // Resumed runner only fetches the remaining 3 URLs.
    expect(spy2.calls.length).toBe(3);
    const allFetched = [...spy1.calls, ...spy2.calls].map((c) => c.url);
    expect(new Set(allFetched).size).toBe(5);
  });
});

describe('runner: expired jobs', () => {
  test('createdAt older than retention yields status=expired, 0 fetches', async () => {
    mkTmpRoot();
    server = await startFixtureServer([{ name: 'a' }]);
    const jobId = await createJob(makeConfig({ url: server.url('a') }));
    // Rewrite header so createdAt is 25h in the past.
    const file = jobFilePath(jobId);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const header = JSON.parse(lines[0]);
    header.createdAt = Date.now() - 25 * 60 * 60 * 1000;
    lines[0] = JSON.stringify(header);
    fs.writeFileSync(file, lines.join('\n'));

    const spy: SpyState = { calls: [] };
    const state = await advanceJob(jobId, 5, 's', undefined, { fetcher: makeSpyFetcher(spy) });
    expect(state.status).toBe('expired');
    expect(spy.calls.length).toBe(0);
  });
});

describe('runner: scope and filters honoured during BFS', () => {
  test('off-scope links not enqueued', async () => {
    mkTmpRoot();
    server = await startFixtureServer([
      { name: 'a', links: ['b', 'c'] },
      { name: 'b' },
      { name: 'c' },
    ]);
    const jobId = await createJob(
      makeConfig({
        url: server.url('a'),
        max_pages: 5,
        max_depth: 2,
        exclude_patterns: [`${server.url('c')}*`],
      }),
    );
    const spy: SpyState = { calls: [] };
    const state = await advanceJob(jobId, 5, 's', undefined, { fetcher: makeSpyFetcher(spy) });
    expect(state.status).toBe('completed');
    const fetchedNames = spy.calls.map((c) => new URL(c.url).pathname.replace(/^\//, ''));
    expect(fetchedNames.sort()).toEqual(['a', 'b']);
  });
});

describe('runner: enqueue history is durable', () => {
  test('enqueue events survive an unrelated load/reload cycle', async () => {
    mkTmpRoot();
    server = await startFixtureServer([
      { name: 'a', links: ['b'] },
      { name: 'b' },
    ]);
    const jobId = await createJob(
      makeConfig({ url: server.url('a'), max_pages: 5, max_depth: 2 }),
    );
    await appendEvent(jobId, {
      kind: 'enqueue',
      urls: [{ url: server.url('a'), depth: 0 }],
      t: Date.now(),
    });
    const reloaded = loadJob(jobId);
    expect(reloaded.queue.length).toBe(1);
  });
});

describe('runner: markdown projection persistence', () => {
  test('does not read or write public cache entries when raw markdown is requested', async () => {
    mkTmpRoot();
    process.env.OC_CRAWL_PAGE_BYTES = '4096';
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-raw-cache-test-'));
    process.env.OPENCHROME_CRAWL_CACHE_DIR = cacheDir;
    server = await startFixtureServer([{ name: 'a' }]);

    const config = makeConfig({
      url: server.url('a'),
      max_pages: 1,
      output_format: 'markdown-clean',
      onlyMainContent: true,
      includeLinks: true,
      content_filter: 'none',
      return_raw: true,
      return_fit: false,
      cache_mode: 'enabled',
      cache_scope: 'public',
    });
    const cache = new CrawlContentCache<FetchOnePageResult>();
    const cacheKey = cache.key({
      url: config.url,
      outputFormat: config.output_format,
      engine: 'crawl_job',
      cacheScope: 'public',
      sessionFingerprint: 's',
      dimensions: {
        onlyMainContent: config.onlyMainContent,
        includeLinks: config.includeLinks,
        scope: config.scope,
        includePatterns: config.include_patterns,
        excludePatterns: config.exclude_patterns,
        contentFilter: 'none',
        query: undefined,
        returnRaw: true,
        returnFit: false,
        pageByteCap: 4096,
      },
    });
    expect(cache.write({
      key: cacheKey,
      sourceUrl: config.url,
      finalUrl: config.url,
      page: {
        url: config.url,
        title: 'Cached',
        content: 'cached fit',
        raw_markdown: 'cached raw',
        depth: 0,
        links_found: 0,
        _links: [],
      },
      links: [],
      cacheScope: 'public',
    }).stored).toBe(true);

    const jobId = await createJob(config);
    let fetchCalls = 0;
    const state = await advanceJob(jobId, 1, 's', undefined, {
      fetcher: async (_sessionId, url, depth) => {
        fetchCalls++;
        return {
          url,
          title: 'Fresh',
          content: 'fresh fit',
          raw_markdown: 'fresh raw',
          depth,
          links_found: 0,
          _links: [],
        };
      },
    });

    expect(fetchCalls).toBe(1);
    expect(state.pages[0]).toMatchObject({
      content: 'fresh fit',
      raw_markdown: 'fresh raw',
      cache: {
        status: 'miss',
        write: 'skipped',
        write_skipped_reason: 'raw-markdown-requires-session-scope',
      },
    });
    expect(cache.read(cacheKey)?.entry.page.content).toBe('cached fit');
  });

  test('keeps raw markdown caching available inside the session scope', async () => {
    mkTmpRoot();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-session-raw-cache-test-'));
    process.env.OPENCHROME_CRAWL_CACHE_DIR = cacheDir;
    server = await startFixtureServer([{ name: 'a' }]);

    const config = makeConfig({
      url: server.url('a'),
      max_pages: 1,
      output_format: 'markdown-clean',
      content_filter: 'none',
      return_raw: true,
      return_fit: false,
      cache_mode: 'enabled',
      cache_scope: 'session',
    });
    let fetchCalls = 0;
    const fetcher = async (_sessionId: string, url: string, depth: number) => {
      fetchCalls++;
      return {
        url,
        title: 'A',
        content: 'fit body',
        raw_markdown: 'raw body',
        depth,
        links_found: 0,
        _links: [],
      };
    };

    await advanceJob(await createJob(config), 1, 's', undefined, { fetcher });
    const cached = await advanceJob(await createJob(config), 1, 's', undefined, { fetcher });

    expect(fetchCalls).toBe(1);
    expect(cached.pages[0]).toMatchObject({
      content: 'fit body',
      raw_markdown: 'raw body',
      cache: { status: 'hit', hit: true, scope: 'session' },
    });
  });

  test('resumes with the persisted BM25 query after runtime state is cleared', async () => {
    mkTmpRoot();
    server = await startFixtureServer([{ name: 'a' }]);
    const jobId = await createJob(makeConfig({
      url: server.url('a'),
      max_pages: 1,
      output_format: 'markdown-clean',
      content_filter: 'bm25',
      query: 'enterprise pricing',
      return_fit: true,
    }));
    clearJobRuntimeSecrets(jobId);
    const queries: Array<string | undefined> = [];

    await advanceJob(jobId, 1, 's', undefined, {
      fetcher: async (_sessionId, url, depth, opts) => {
        queries.push(opts.query);
        return {
          url,
          title: 'A',
          content: 'enterprise pricing',
          fit_markdown: 'enterprise pricing',
          filter: {
            type: 'bm25',
            raw_chars: 18,
            fit_chars: 18,
            reduction_ratio: 0,
            sections_seen: 1,
            sections_kept: 1,
            query: opts.query,
          },
          depth,
          links_found: 0,
          _links: [],
        };
      },
    });

    expect(queries).toEqual(['enterprise pricing']);
  });

  test('separates cache entries by markdown projection options', async () => {
    mkTmpRoot();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-cache-key-test-'));
    process.env.OPENCHROME_CRAWL_CACHE_DIR = cacheDir;
    server = await startFixtureServer([{ name: 'a' }]);

    const base = {
      url: server.url('a'),
      max_pages: 1,
      output_format: 'markdown-clean',
      content_filter: 'bm25' as const,
      return_fit: true,
      cache_mode: 'write_only' as const,
      cache_scope: 'session' as const,
    };
    const firstJob = await createJob(makeConfig({ ...base, query: 'alpha' }));
    const secondJob = await createJob(makeConfig({ ...base, query: 'beta' }));
    const fetcher = async (_sessionId: string, url: string, depth: number) => ({
      url,
      title: 'A',
      content: 'fit body',
      fit_markdown: 'fit body',
      filter: {
        type: 'bm25' as const,
        raw_chars: 12,
        fit_chars: 8,
        reduction_ratio: 0.333,
        sections_seen: 1,
        sections_kept: 1,
      },
      depth,
      links_found: 0,
      _links: [],
    });

    await advanceJob(firstJob, 1, 's', undefined, { fetcher });
    await advanceJob(secondJob, 1, 's', undefined, { fetcher });

    expect(fs.readdirSync(cacheDir).filter((name) => name.endsWith('.json'))).toHaveLength(2);
  });

  test('separates cache entries by the effective page byte cap', async () => {
    mkTmpRoot();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-byte-cap-key-test-'));
    process.env.OPENCHROME_CRAWL_CACHE_DIR = cacheDir;
    server = await startFixtureServer([{ name: 'a' }]);

    const config = makeConfig({
      url: server.url('a'),
      max_pages: 1,
      output_format: 'markdown',
      onlyMainContent: true,
      includeLinks: true,
      cache_mode: 'enabled',
      cache_scope: 'session',
    });
    let fetchCalls = 0;
    const fetcher = async (_sessionId: string, url: string, depth: number) => {
      fetchCalls++;
      return {
        url,
        title: 'A',
        content: 'x'.repeat(100),
        depth,
        links_found: 0,
        _links: [],
      };
    };

    process.env.OC_CRAWL_PAGE_BYTES = '16';
    const first = await advanceJob(await createJob(config), 1, 's', undefined, { fetcher });
    process.env.OC_CRAWL_PAGE_BYTES = '64';
    const second = await advanceJob(await createJob(config), 1, 's', undefined, { fetcher });

    expect(fetchCalls).toBe(2);
    expect(Buffer.byteLength(first.pages[0].content, 'utf8')).toBe(16);
    expect(Buffer.byteLength(second.pages[0].content, 'utf8')).toBe(64);
    expect(fs.readdirSync(cacheDir).filter((name) => name.endsWith('.json'))).toHaveLength(2);
  });

  test('redacts and aggregate-bounds distinct content before cache and JSONL writes', async () => {
    mkTmpRoot();
    process.env.OC_CRAWL_PAGE_BYTES = '48';
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-cache-test-'));
    process.env.OPENCHROME_CRAWL_CACHE_DIR = cacheDir;
    server = await startFixtureServer([{ name: 'a' }]);
    const query = 'enterprise pricing '.repeat(80).trim();
    const jobId = await createJob(makeConfig({
      url: server.url('a'),
      max_pages: 1,
      output_format: 'markdown-clean',
      content_filter: 'prune',
      query,
      return_raw: true,
      return_fit: true,
      cache_mode: 'write_only',
      cache_scope: 'session',
    }));

    const state = await advanceJob(jobId, 1, 's', undefined, {
      fetcher: async (_sessionId, url, depth) => ({
        url,
        title: 'token=super-secret-value',
        content: `fit token=super-secret-value ${'가'.repeat(40)}`,
        raw_markdown: `raw token=super-secret-value ${'나'.repeat(40)}`,
        fit_markdown: `fit token=super-secret-value ${'가'.repeat(40)}`,
        filter: {
          type: 'prune',
          raw_chars: 200,
          fit_chars: 100,
          reduction_ratio: 0.5,
          sections_seen: 2,
          sections_kept: 1,
          query,
        },
        depth,
        links_found: 0,
        _links: [],
      }),
    });

    const page = state.pages[0];
    expect(JSON.stringify(page)).not.toContain('super-secret-value');
    expect(page.filter?.query).toBeUndefined();
    expect(Buffer.byteLength(page.content, 'utf8') + Buffer.byteLength(page.raw_markdown ?? '', 'utf8')).toBeLessThanOrEqual(48);
    expect(page.truncated_fields).toEqual(expect.arrayContaining(['content', 'fit_markdown', 'raw_markdown']));

    const cacheFiles = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.json'));
    expect(cacheFiles).toHaveLength(1);
    const cached = fs.readFileSync(path.join(cacheDir, cacheFiles[0]), 'utf8');
    expect(cached).not.toContain('super-secret-value');
    const cachedEntry = JSON.parse(cached);
    expect(cachedEntry.page.filter.query).toBeUndefined();
    expect(Buffer.byteLength(cachedEntry.page.content, 'utf8') + Buffer.byteLength(cachedEntry.page.raw_markdown ?? '', 'utf8')).toBeLessThanOrEqual(48);

    const jobLog = fs.readFileSync(jobFilePath(jobId), 'utf8');
    expect(jobLog.split(query)).toHaveLength(2);
  });

  test('reports shared fetch truncation for canonical fit content', async () => {
    mkTmpRoot();
    process.env.OC_CRAWL_PAGE_BYTES = '100000';
    server = await startFixtureServer([{ name: 'a' }]);
    const jobId = await createJob(makeConfig({
      url: server.url('a'),
      max_pages: 1,
      output_format: 'markdown-clean',
      content_filter: 'prune',
      return_fit: true,
    }));
    const cappedContent = `${'X'.repeat(MAX_OUTPUT_CHARS)}...[truncated]`;

    const state = await advanceJob(jobId, 1, 's', undefined, {
      fetcher: async (_sessionId, url, depth) => ({
        url,
        title: 'A',
        content: cappedContent,
        fit_markdown: `${'X'.repeat(MAX_OUTPUT_CHARS + 100)}`,
        filter: {
          type: 'prune',
          raw_chars: MAX_OUTPUT_CHARS + 100,
          fit_chars: MAX_OUTPUT_CHARS + 100,
          reduction_ratio: 0,
          sections_seen: 1,
          sections_kept: 1,
        },
        depth,
        links_found: 0,
        _links: [],
      }),
    });

    expect(state.pages[0]).toMatchObject({
      content: cappedContent,
      truncated: true,
      truncated_fields: expect.arrayContaining(['content', 'fit_markdown']),
    });
  });
});
