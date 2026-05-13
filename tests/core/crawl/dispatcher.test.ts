import { AdaptiveCrawlDispatcher, parseAdaptiveDispatcherOptions } from '../../../src/core/crawl/dispatcher';

describe('AdaptiveCrawlDispatcher', () => {
  test('reduces concurrency on memory pressure', async () => {
    const dispatcher = new AdaptiveCrawlDispatcher(6, { memoryProvider: () => 1, memoryPressureBytes: 10, minConcurrency: 1 });
    await dispatcher.run('https://example.com', async () => 'ok');
    expect(dispatcher.stats().throttle_events.some((e) => e.reason === 'memory_pressure' && e.from === 6 && e.to === 3)).toBe(true);
  });

  test('records origin backoff for rate-limited statuses', () => {
    const dispatcher = new AdaptiveCrawlDispatcher(4, { originBackoffMs: 1234 });
    dispatcher.recordResponse('https://example.com', 429);
    expect(dispatcher.stats().throttle_events).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'origin_backoff', origin: 'https://example.com', status: 429, backoff_ms: 1234 }),
    ]));
  });

  test('parses issue-shaped options', () => {
    expect(parseAdaptiveDispatcherOptions({ min_concurrency: 2, max_concurrency: 8, memory_pressure_mb: 256, origin_backoff_ms: 2000, rate_limit_statuses: [429] }, 6)).toMatchObject({
      minConcurrency: 2,
      maxConcurrency: 8,
      memoryPressureBytes: 256 * 1024 * 1024,
      originBackoffMs: 2000,
      rateLimitStatuses: [429],
    });
  });
});
