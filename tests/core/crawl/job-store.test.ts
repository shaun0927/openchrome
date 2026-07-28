/// <reference types="jest" />

/**
 * Unit tests for the JSONL job-store (issue #886).
 *
 * Each test points `OC_JOBS_ROOT` at a unique tmp dir for filesystem isolation.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendEvent,
  createJob,
  defaultRetentionMs,
  isExpired,
  jobFilePath,
  loadJob,
  setStatus,
  type JobConfig,
} from '../../../src/core/crawl/job-store';

function mkTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-jobs-test-'));
  process.env.OC_JOBS_ROOT = dir;
  return dir;
}

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    url: 'http://example.test/',
    max_depth: 2,
    max_pages: 20,
    scope: 'http://example.test/**',
    output_format: 'markdown',
    respect_robots: true,
    delay_ms: 0,
    concurrency: 1,
    ...overrides,
  };
}

describe('job-store: createJob + loadJob', () => {
  beforeEach(() => mkTmpRoot());
  afterEach(() => {
    delete process.env.OC_JOBS_ROOT;
  });

  test('createJob writes a header line and returns a 26-char ULID', async () => {
    const jobId = await createJob(makeConfig());
    expect(jobId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const file = jobFilePath(jobId);
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const header = JSON.parse(lines[0]);
    expect(header.kind).toBe('header');
    expect(header.config.url).toBe('http://example.test/');
    expect(typeof header.createdAt).toBe('number');
  });

  test('createJob persists safe projection options without mutating operational patterns', async () => {
    const scope = 'http://example.test/**?token=scope-value';
    const includePatterns = ['http://example.test/docs/**?token=include-value'];
    const excludePatterns = ['http://example.test/private/**?token=exclude-value'];
    const jobId = await createJob(makeConfig({
      output_format: 'markdown-clean',
      content_filter: 'bm25',
      query: 'enterprise pricing',
      return_raw: true,
      return_fit: true,
      scope,
      include_patterns: includePatterns,
      exclude_patterns: excludePatterns,
    }));
    const header = JSON.parse(fs.readFileSync(jobFilePath(jobId), 'utf8').trim());
    expect(header.config).toMatchObject({
      output_format: 'markdown-clean',
      content_filter: 'bm25',
      query: 'enterprise pricing',
      return_raw: true,
      return_fit: true,
      scope,
      include_patterns: includePatterns,
      exclude_patterns: excludePatterns,
    });
  });

  test('createJob rejects unsafe or oversized queries before writing a job', async () => {
    await expect(createJob(makeConfig({
      output_format: 'markdown-clean',
      content_filter: 'bm25',
      query: 'token=super-secret-value',
    }))).rejects.toThrow(/credential-like material/);
    await expect(createJob(makeConfig({
      output_format: 'markdown-clean',
      content_filter: 'bm25',
      query: 'x'.repeat(2049),
    }))).rejects.toThrow(/at most 2048 characters/);
    expect(fs.readdirSync(process.env.OC_JOBS_ROOT!).filter((name) => name.endsWith('.jsonl')))
      .toEqual([]);
  });

  test('loadJob replays empty state for a fresh job', async () => {
    const jobId = await createJob(makeConfig());
    const state = loadJob(jobId);
    expect(state.status).toBe('pending');
    expect(state.queue).toEqual([]);
    expect(state.pages).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(state.visited.size).toBe(0);
  });

  test('appendEvent + loadJob: enqueue rebuilds queue, fetched rebuilds visited+pages', async () => {
    const jobId = await createJob(makeConfig());
    await appendEvent(jobId, {
      kind: 'enqueue',
      urls: [{ url: 'http://example.test/a', depth: 0 }],
      t: 1,
    });
    await appendEvent(jobId, {
      kind: 'fetched',
      url: 'http://example.test/a',
      depth: 0,
      page: {
        url: 'http://example.test/a',
        title: 'A',
        content: 'hi',
        raw_markdown: 'raw hi',
        filter: {
          type: 'prune',
          raw_chars: 6,
          fit_chars: 2,
          reduction_ratio: 0.667,
          sections_seen: 2,
          sections_kept: 1,
          query: 'enterprise pricing',
        },
        truncated_fields: ['raw_markdown'],
        depth: 0,
        links_found: 0,
      },
      t: 2,
    });
    const state = loadJob(jobId);
    expect(state.queue).toEqual([]);
    expect(state.visited.has('http://example.test/a')).toBe(true);
    expect(state.pages).toHaveLength(1);
    expect(state.pages[0].title).toBe('A');
    expect(state.pages[0].raw_markdown).toBe('raw hi');
    expect(state.pages[0].filter?.type).toBe('prune');
    expect(state.pages[0].filter?.query).toBeUndefined();
    expect(state.pages[0].truncated_fields).toEqual(['raw_markdown']);
  });

  test('loads pre-option JSONL headers with legacy defaults', () => {
    const jobId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const header = {
      kind: 'header',
      config: makeConfig(),
      createdAt: Date.now(),
    };
    fs.writeFileSync(jobFilePath(jobId), `${JSON.stringify(header)}\n`, 'utf8');

    const state = loadJob(jobId);
    expect(state.config.content_filter).toBeUndefined();
    expect(state.config.query).toBeUndefined();
    expect(state.config.return_raw).toBeUndefined();
    expect(state.config.return_fit).toBeUndefined();
  });

  test('setStatus: terminal cancelled is sticky across later running events', async () => {
    const jobId = await createJob(makeConfig());
    await setStatus(jobId, 'cancelled');
    await setStatus(jobId, 'running');
    const state = loadJob(jobId);
    expect(state.status).toBe('cancelled');
  });

  test('setStatus: terminal completed is sticky too', async () => {
    const jobId = await createJob(makeConfig());
    await setStatus(jobId, 'completed');
    await setStatus(jobId, 'running');
    expect(loadJob(jobId).status).toBe('completed');
  });

  test('loadJob skips malformed event lines', async () => {
    const jobId = await createJob(makeConfig());
    fs.appendFileSync(jobFilePath(jobId), 'not-json\n');
    await appendEvent(jobId, { kind: 'status', status: 'running', t: 1 });
    expect(loadJob(jobId).status).toBe('running');
  });
});

describe('job-store: isExpired', () => {
  beforeEach(() => mkTmpRoot());
  afterEach(() => {
    delete process.env.OC_JOBS_ROOT;
    delete process.env.OC_JOB_RETENTION_MS;
  });

  test('returns false when within retention window', () => {
    const now = Date.now();
    expect(isExpired({ createdAt: now - 1000 }, now)).toBe(false);
  });

  test('returns true when older than retention window', () => {
    const now = Date.now();
    expect(isExpired({ createdAt: now - (25 * 60 * 60 * 1000) }, now)).toBe(true);
  });

  test('respects OC_JOB_RETENTION_MS override', () => {
    process.env.OC_JOB_RETENTION_MS = '5000';
    expect(defaultRetentionMs()).toBe(5000);
    const now = Date.now();
    expect(isExpired({ createdAt: now - 6000 }, now)).toBe(true);
    expect(isExpired({ createdAt: now - 4000 }, now)).toBe(false);
  });
});
