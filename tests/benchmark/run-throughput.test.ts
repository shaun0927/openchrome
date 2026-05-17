/// <reference types="jest" />

import {
  parseThroughputArgs,
  runThroughputBenchmark,
} from './run-throughput';

describe('run-throughput competitor selection', () => {
  test('defaults to OpenChrome stub only for CI-safe runs', () => {
    const opts = parseThroughputArgs(['--ci']);
    expect(opts.library).toBe('openchrome');
    expect(opts.live).toBe(false);
    expect(opts.includeLiveCompetitors).toBe(false);
  });

  test('parses --library and --include-live-competitors flags', () => {
    const opts = parseThroughputArgs([
      '--library=all',
      '--include-live-competitors=false',
      '--concurrency=1,5',
      '--iterations=5',
    ]);
    expect(opts.library).toBe('all');
    expect(opts.includeLiveCompetitors).toBe(false);
    expect(opts.concurrencies).toEqual([1, 5]);
    expect(opts.iterations).toBe(5);
    expect(opts.sessionMode).toBe('reuse');
    expect(opts.cdpEndpoint).toBe('http://127.0.0.1:9222');
  });

  test('parses CDP endpoint flag', () => {
    const opts = parseThroughputArgs(['--cdp-endpoint=http://127.0.0.1:9444']);
    expect(opts.cdpEndpoint).toBe('http://127.0.0.1:9444');
    expect(opts.openChromePort).toBe('9444');
  });

  test('parses cold session mode', () => {
    const opts = parseThroughputArgs(['--session-mode=cold']);
    expect(opts.sessionMode).toBe('cold');
  });

  test('can run the no-Chrome Crawlee competitor cell against local fixtures', async () => {
    const rows = await runThroughputBenchmark(
      parseThroughputArgs([
        '--library=crawlee',
        '--concurrency=1',
        '--iterations=4',
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].library).toBe('Crawlee');
    expect(rows[0].sessionMode).toBe('reuse');
    expect(rows[0].sampleCount).toBe(1);
    expect(rows[0].pagesPerPass).toBeGreaterThan(0);
  }, 30000);

  test('library=all omits Chrome-gated competitors unless explicitly live-enabled', async () => {
    const rows = await runThroughputBenchmark(
      parseThroughputArgs([
        '--library=all',
        '--include-live-competitors=false',
        '--concurrency=1',
        '--iterations=4',
      ]),
    );
    expect(rows.map((row) => row.library).sort()).toEqual(['Crawlee', 'OpenChrome']);
  }, 30000);
});


test('cold session mode records cold-start rows for each concurrency cell', async () => {
  const rows = await runThroughputBenchmark(
    parseThroughputArgs([
      '--library=crawlee',
      '--session-mode=cold',
      '--concurrency=1,2',
      '--iterations=4',
    ]),
  );
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.sessionMode === 'cold')).toBe(true);
}, 30000);
