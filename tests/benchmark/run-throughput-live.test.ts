/// <reference types="jest" />
import { runLiveThroughputExecutor } from './run-throughput-live';

describe('live throughput executor', () => {
  test('launches and closes managed Chrome around live run failures', async () => {
    const close = jest.fn(async () => undefined);
    const runBenchmark = jest.fn(async () => [{ library: 'OpenChrome', mode: 'dom-live', sessionMode: 'reuse' as const, concurrency: 1, pagesPerPass: 1, sampleCount: 1, warmupDiscarded: 0, rawPagesPerSecond: 1, successRate: 1, effectivePagesPerSecond: 1, meanWallMs: 1, p50WallMs: 1, p95WallMs: 1 }]);
    const result = await runLiveThroughputExecutor({ argv: ['--library=openchrome', '--concurrency=1', '--iterations=4'], launchChrome: true, port: 9444, launcher: async () => ({ endpoint: 'http://127.0.0.1:9444', userDataDir: '/tmp/p', close }), runBenchmark });
    expect(result.launchedChrome).toBe(true);
    expect(runBenchmark).toHaveBeenCalledWith(expect.objectContaining({ cdpEndpoint: 'http://127.0.0.1:9444', openChromePort: '9444' }));
    expect(close).toHaveBeenCalled();
    // No live OpenChrome server is expected in CI, so the failure is explicit.
    expect(result.rows).toHaveLength(1);
  }, 30000);

  test('preserves selected CDP endpoint on benchmark failure', async () => {
    const close = jest.fn(async () => undefined);
    const result = await runLiveThroughputExecutor({
      argv: ['--library=openchrome'],
      launchChrome: true,
      port: 9555,
      launcher: async () => ({ endpoint: 'http://127.0.0.1:9555', userDataDir: '/tmp/p', close }),
      runBenchmark: async () => { throw new Error('benchmark failed'); },
    });

    expect(result.rows).toEqual([]);
    expect(result.cdpEndpoint).toBe('http://127.0.0.1:9555');
    expect(result.failureCategory).toMatch(/benchmark failed/);
    expect(close).toHaveBeenCalled();
  });

  test('sets CHROME_PORT for OpenChrome live adapter subprocesses', async () => {
    const seen: Array<string | undefined> = [];
    await runLiveThroughputExecutor({
      argv: ['--library=openchrome'],
      launchChrome: false,
      port: 9666,
      runBenchmark: async () => { seen.push(process.env.CHROME_PORT); return []; },
    });
    expect(seen).toEqual(['9666']);
    expect(process.env.CHROME_PORT).toBeUndefined();
  });

});
