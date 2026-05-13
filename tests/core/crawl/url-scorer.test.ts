import { buildUrlScoreOptions, scoreUrl } from '../../../src/core/crawl/url-scorer';

describe('url scorer', () => {
  test('scores query keywords found in the URL', () => {
    const scored = scoreUrl('https://docs.example.com/pricing/enterprise-limits', 1, {
      query: 'enterprise pricing limits',
    });
    expect(scored.score).toBeGreaterThan(2);
    expect(scored.reasons).toEqual(expect.arrayContaining([
      'keyword:enterprise',
      'keyword:pricing',
      'keyword:limits',
    ]));
  });

  test('applies prefer and exclude path weights', () => {
    const preferred = scoreUrl('https://docs.example.com/docs/api/auth', 0, {
      preferPaths: ['/docs'],
      excludePaths: ['/blog'],
    });
    const excluded = scoreUrl('https://docs.example.com/blog/api/auth', 0, {
      preferPaths: ['/docs'],
      excludePaths: ['/blog'],
    });
    expect(preferred.score).toBeGreaterThan(excluded.score);
    expect(preferred.reasons).toContain('path:/docs');
    expect(excluded.reasons).toContain('exclude:/blog');
  });

  test('penalizes deeper and low-signal URLs', () => {
    const high = scoreUrl('https://example.com/docs/actions', 1, { query: 'actions' });
    const low = scoreUrl('https://example.com/tag/actions', 3, { query: 'actions' });
    expect(high.score).toBeGreaterThan(low.score);
    expect(low.reasons).toContain('low-signal:tag');
  });


  test('does not throw on malformed percent-encoded pathnames', () => {
    const scored = scoreUrl('https://example.com/docs/%zz-enterprise', 1, {
      query: 'enterprise',
    });

    expect(Number.isFinite(scored.score)).toBe(true);
    expect(scored.reasons).toEqual(expect.arrayContaining(['keyword:enterprise']));
  });

  test('normalizes issue url_score options', () => {
    const opts = buildUrlScoreOptions({
      query: 'workflow secrets',
      startUrl: 'https://docs.example.com/en',
      url_score: {
        keywords: ['actions'],
        prefer_paths: ['/en/actions'],
        exclude_paths: ['/en/billing'],
        same_depth_bias: 0.1,
      },
    });
    expect(opts).toMatchObject({
      query: 'workflow secrets',
      keywords: ['actions'],
      preferPaths: ['/en/actions'],
      excludePaths: ['/en/billing'],
      sameDepthBias: 0.1,
      startUrl: 'https://docs.example.com/en',
    });
  });
});
