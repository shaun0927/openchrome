/// <reference types="jest" />

/**
 * Tool-handler integration tests for crawl_start / crawl_status / crawl_cancel
 * (issue #886).
 *
 * To keep tests fast and self-contained we bypass the full MCPServer wire-up
 * (which spins memory-pressure timers, dashboards, etc.) and use a tiny
 * fake server that just captures the (name, handler) pairs the register
 * functions hand it. The handlers themselves are exercised end-to-end against
 * a real HTTP fixture server via the spy fetcher hook.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { registerCrawlStartTool } from '../../../src/tools/crawl-start';
import {
  registerCrawlStatusTool,
  _setAdvanceOptionsForTests,
} from '../../../src/tools/crawl-status';
import { registerCrawlCancelTool } from '../../../src/tools/crawl-cancel';
import { jobFilePath, loadJob, type CrawledPage } from '../../../src/core/crawl/job-store';
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

function mkTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-tools-test-'));
  process.env.OC_JOBS_ROOT = dir;
  return dir;
}

function bootTools(): void {
  // Cast to satisfy the register*Tool signatures — they only call
  // `server.registerTool(...)`, so a structural fake is sufficient.
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

afterEach(async () => {
  _setAdvanceOptionsForTests(undefined);
  if (server) {
    await server.close();
    server = undefined;
  }
  delete process.env.OC_JOBS_ROOT;
  delete process.env.OC_CRAWL_ADVANCE_DEFAULT;
  delete process.env.OC_CRAWL_STATUS_MAX_PAGES;
  delete process.env.OC_JOB_RETENTION_MS;
});

describe('crawl_start', () => {
  test('returns jobId + pending status, performs no fetches', async () => {
    mkTmpRoot();
    server = await startFixtureServer([{ name: 'a' }]);
    bootTools();
    const spy: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy) });

    const res = await crawlStart!('sess', { url: server.url('a'), max_pages: 5 });
    expect(res.isError).toBeUndefined();
    const body = parseResult(res);
    expect(typeof body.jobId).toBe('string');
    expect(body.status).toBe('pending');
    expect(body.queued).toBe(1);
    expect(body.plannedMax).toBe(5);
    expect(spy.calls.length).toBe(0);
  });

  test('rejects invalid URL', async () => {
    mkTmpRoot();
    bootTools();
    const res = await crawlStart!('s', { url: 'not-a-url' });
    expect(res.isError).toBe(true);
  });

  test('rejects non-http(s) scheme', async () => {
    mkTmpRoot();
    bootTools();
    const res = await crawlStart!('s', { url: 'file:///etc/passwd' });
    expect(res.isError).toBe(true);
  });
});

describe('crawl_status', () => {
  test('advance: 0 is read-only — runner spy sees zero calls', async () => {
    mkTmpRoot();
    server = await startFixtureServer([{ name: 'a' }]);
    bootTools();
    const spy: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy) });

    const startBody = parseResult(
      await crawlStart!('s', { url: server.url('a'), max_pages: 3 }),
    );
    const jobId = startBody.jobId as string;
    const body = parseResult(await crawlStatus!('s', { jobId, advance: 0 }));
    expect(spy.calls.length).toBe(0);
    expect(body.status).toBe('pending');
    expect(body.completed).toBe(0);
  });

  test('lifecycle: start -> status*N -> completed', async () => {
    mkTmpRoot();
    const names = ['a', 'b', 'c', 'd', 'e'];
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
        max_pages: 5,
        max_depth: 5,
      }),
    );
    const jobId = startBody.jobId as string;

    let body: Record<string, unknown> | undefined;
    for (let i = 0; i < 3; i++) {
      body = parseResult(await crawlStatus!('s', { jobId, advance: 2, includePages: true }));
    }
    expect(body!.status).toBe('completed');
    expect(body!.completed).toBe(5);
    expect((body!.pages as CrawledPage[]).length).toBe(5);
    expect(spy.calls.length).toBe(5);
  });

  test('includePages caps at OC_CRAWL_STATUS_MAX_PAGES with pagesOmitted', async () => {
    mkTmpRoot();
    process.env.OC_CRAWL_STATUS_MAX_PAGES = '10';
    const names = Array.from({ length: 25 }, (_, i) => `p${i}`);
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
        url: server.url('p0'),
        max_pages: 25,
        max_depth: 25,
        delay_ms: 0,
      }),
    );
    const jobId = startBody.jobId as string;
    // Drain the whole crawl.
    for (let i = 0; i < 6; i++) {
      await crawlStatus!('s', { jobId, advance: 25 });
    }
    const body = parseResult(
      await crawlStatus!('s', { jobId, advance: 0, includePages: true }),
    );
    expect(body.status).toBe('completed');
    expect(body.completed).toBe(25);
    expect((body.pages as CrawledPage[]).length).toBe(10);
    expect(body.pagesOmitted).toBe(15);
  });

  test('expired job reports status=expired, performs zero fetches', async () => {
    mkTmpRoot();
    server = await startFixtureServer([{ name: 'a' }]);
    bootTools();
    const startBody = parseResult(
      await crawlStart!('s', { url: server.url('a'), max_pages: 3 }),
    );
    const jobId = startBody.jobId as string;

    // Rewrite header createdAt to 25h ago.
    const file = jobFilePath(jobId);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const header = JSON.parse(lines[0]);
    header.createdAt = Date.now() - 25 * 60 * 60 * 1000;
    lines[0] = JSON.stringify(header);
    fs.writeFileSync(file, lines.join('\n'));

    const spy: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy) });

    const body = parseResult(await crawlStatus!('s', { jobId, advance: 5 }));
    expect(body.status).toBe('expired');
    expect(spy.calls.length).toBe(0);
    // File is reported as expired but NOT deleted.
    expect(fs.existsSync(file)).toBe(true);
  });

  test('missing jobId returns error', async () => {
    mkTmpRoot();
    bootTools();
    const res = await crawlStatus!('s', { jobId: 'no-such-job', advance: 1 });
    expect(res.isError).toBe(true);
  });
});

describe('crawl_cancel', () => {
  test('cancel + subsequent status with advance: 10 → 0 fetches, status cancelled', async () => {
    mkTmpRoot();
    server = await startFixtureServer([
      { name: 'a', links: ['b'] },
      { name: 'b', links: ['c'] },
      { name: 'c' },
    ]);
    bootTools();
    const spy: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy) });

    const startBody = parseResult(
      await crawlStart!('s', {
        url: server.url('a'),
        max_pages: 3,
        max_depth: 3,
      }),
    );
    const jobId = startBody.jobId as string;

    const cancelRes = await crawlCancel!('s', { jobId });
    expect(cancelRes.isError).toBeUndefined();
    const cancelBody = parseResult(cancelRes);
    expect(cancelBody.ok).toBe(true);
    expect(cancelBody.status).toBe('cancelled');

    const statusBody = parseResult(await crawlStatus!('s', { jobId, advance: 10 }));
    expect(statusBody.status).toBe('cancelled');
    expect(spy.calls.length).toBe(0);
  });

  test('cancel on unknown job returns error', async () => {
    mkTmpRoot();
    bootTools();
    const res = await crawlCancel!('s', { jobId: 'nope' });
    expect(res.isError).toBe(true);
  });
});

describe('process-death resume via tool layer', () => {
  test('replay JSONL across simulated death — each URL fetched once', async () => {
    mkTmpRoot();
    const names = ['a', 'b', 'c', 'd', 'e'];
    server = await startFixtureServer(
      names.map((n, i) => ({ name: n, links: i + 1 < names.length ? [names[i + 1]] : [] })),
    );
    bootTools();
    const spy1: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy1) });

    const startBody = parseResult(
      await crawlStart!('s', {
        url: server.url('a'),
        max_pages: 5,
        max_depth: 5,
      }),
    );
    const jobId = startBody.jobId as string;

    await crawlStatus!('s', { jobId, advance: 2 });
    expect(spy1.calls.length).toBe(2);

    // Simulate process death — drop the in-process spy state, reload via the
    // JSONL replay path.
    _setAdvanceOptionsForTests(undefined);
    const spy2: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy2) });

    const state = loadJob(jobId);
    expect(state.pages.length).toBe(2);

    const body = parseResult(
      await crawlStatus!('s', { jobId, advance: 10, includePages: true }),
    );
    expect(body.status).toBe('completed');
    expect(body.completed).toBe(5);
    expect(spy2.calls.length).toBe(3);
    const allUrls = [...spy1.calls, ...spy2.calls].map((c) => c.url);
    expect(new Set(allUrls).size).toBe(5);
  });
});

describe('legacy crawl snapshot — runner CrawledPage shape', () => {
  /**
   * The legacy `crawl` tool's behaviour must not change. Real `crawl` uses
   * puppeteer (mocked in test setup), so a true byte snapshot would require
   * a live browser. Instead we snapshot the resumable runner's CrawledPage
   * output and ensure each field matches the legacy interface exactly.
   */
  test('runner output keys exactly match the legacy CrawledPage interface', async () => {
    mkTmpRoot();
    server = await startFixtureServer([
      { name: 'a', links: ['b'] },
      { name: 'b' },
    ]);
    bootTools();
    const spy: SpyState = { calls: [] };
    _setAdvanceOptionsForTests({ fetcher: makeSpyFetcher(spy) });

    const startBody = parseResult(
      await crawlStart!('s', {
        url: server.url('a'),
        max_pages: 2,
        max_depth: 2,
      }),
    );
    const jobId = startBody.jobId as string;
    await crawlStatus!('s', { jobId, advance: 5 });
    const body = parseResult(
      await crawlStatus!('s', { jobId, advance: 0, includePages: true }),
    );
    const pages = body.pages as CrawledPage[];
    expect(pages.length).toBe(2);
    const allowed = ['url', 'title', 'content', 'depth', 'links_found', 'error', 'truncated'];
    for (const p of pages) {
      expect(typeof p.url).toBe('string');
      expect(typeof p.title).toBe('string');
      expect(typeof p.content).toBe('string');
      expect(typeof p.depth).toBe('number');
      expect(typeof p.links_found).toBe('number');
      for (const k of Object.keys(p)) {
        expect(allowed).toContain(k);
      }
    }
  });
});


describe('crawl cache root resolution', () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
    jest.resetModules();
  });

  test('uses OPENCHROME_HOME as the OpenChrome root, not the user home', async () => {
    jest.resetModules();
    process.env = { ...OLD_ENV, OPENCHROME_HOME: '/tmp/openchrome-home-test' };
    delete process.env.OPENCHROME_CRAWL_CACHE_DIR;
    const { defaultCrawlCacheRootDir } = await import('../../../src/core/crawl/content-cache');

    expect(defaultCrawlCacheRootDir()).toBe('/tmp/openchrome-home-test/cache/crawl');
  });
});
