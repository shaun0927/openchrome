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
  createJob,
  jobFilePath,
  loadJob,
  setStatus,
  type JobConfig,
} from '../../../src/core/crawl/job-store';
import { advanceJob } from '../../../src/core/crawl/runner';
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
